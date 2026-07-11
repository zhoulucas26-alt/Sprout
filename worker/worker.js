// Sprout OCR + Solve + Flashcards + Practice proxy (Cloudflare Worker)
// Keeps API keys server-side. The browser sends
//   { image: "<base64>", mimeType: "image/jpeg", prompt?: "..." }
// for the study-plan scan flow, and gets back
//   { text, summary, subjects } or { error }.
// For the "Solve a question" flow it sends
//   { mode: "solve", image: "<base64>", mimeType: "image/jpeg" }
// and gets back { question, answer, steps: [...] } or { error }.
// For "Flashcards" it sends the text already extracted by a previous scan
// (no new photo needed):
//   { mode: "flashcards", text: "<extracted study text>" }
// and gets back { cards: [{front, back}, ...] } or { error }.
// For "Practice quiz" it sends material pulled from something already done
// (a past scan, a solved question, or a flashcard set - no new photo):
//   { mode: "practice", text: "<study material>" }
// and gets back { questions: [{question, options:[4], correctIndex, explanation}] } or { error }.
//
// Scan/OCR and Practice use Gemini. Solve and Flashcards use Meta's Llama 4
// model (a separate key) per explicit request to use Meta's model for those
// features. Meta's own Llama API isn't available in every region, so this
// calls Llama 4 hosted on Groq instead - same underlying Meta model,
// different host.
//
// Keys are stored as Worker secrets (never in this file):
//   npx wrangler secret put GEMINI_API_KEY
//   npx wrangler secret put GROQ_API_KEY   (from https://console.groq.com/keys)
//
// GET /test runs a built-in self-test against Gemini (the scan flow).
// GET /test?provider=groq runs the same kind of self-test against Groq
// (the solve flow), so you can see exactly what each service says
// without involving the app or a camera.

const MODEL = "gemini-2.5-flash";
const GROQ_MODEL = "meta-llama/llama-4-maverick-17b-128e-instruct";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// 1x1 red pixel PNG, ~70 bytes. Used only by /test.
const TEST_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Canonical school-subject categories. Gemini is asked to classify into
// exactly these; the frontend maps each one to a fixed color so a subject
// always looks the same across scans.
const SUBJECT_CATEGORIES = [
  "Math", "Biology", "Chemistry", "Physics", "English", "History",
  "Geography", "Computer Science", "Foreign Language", "Arts", "Other",
];

// Keeps only subjects Gemini could confidently map to a known category,
// normalizes casing to the canonical spelling, drops duplicates, and pulls
// through the per-subject study details used to build the actual plan.
function normalizeSubjects(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item.subject !== "string") continue;
    const match = SUBJECT_CATEGORIES.find(
      (c) => c.toLowerCase() === item.subject.trim().toLowerCase()
    );
    if (!match || seen.has(match)) continue;
    seen.add(match);
    const tasks = Array.isArray(item.tasks)
      ? item.tasks.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()).slice(0, 4)
      : [];
    out.push({
      subject: match,
      topic: typeof item.topic === "string" ? item.topic.trim() : "",
      how: typeof item.how === "string" ? item.how.trim() : "",
      tasks,
    });
    if (out.length >= 4) break;
  }
  return out;
}

async function callGemini(env, parts, generationConfig) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const body = { contents: [{ parts }] };
  if (generationConfig) body.generationConfig = generationConfig;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });
  const raw = await resp.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) {}
  return { resp, raw, data };
}

// Groq's API is OpenAI-compatible: chat completions with an image_url
// content part for vision input, Bearer auth.
async function callGroq(env, textPrompt, image, mimeType) {
  const content = [{ type: "text", text: textPrompt }];
  if (image) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${mimeType || "image/jpeg"};base64,${image}` },
    });
  }
  const resp = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "user", content }],
      response_format: { type: "json_object" },
    }),
  });
  const raw = await resp.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) {}
  return { resp, raw, data };
}

// Pulls the model's text out of an OpenAI-shaped chat completion response.
function extractGroqText(data) {
  if (!data) return "";
  const choice = data.choices && data.choices[0];
  if (choice) {
    if (typeof choice.message?.content === "string") return choice.message.content;
    if (Array.isArray(choice.message?.content)) {
      return choice.message.content.map((p) => p.text || "").join("");
    }
    if (typeof choice.text === "string") return choice.text;
  }
  return "";
}

export default {
  async fetch(request, env) {
    // CORS locked to the Pages origin - the Origin header browsers send is
    // just scheme+host, so this covers the site regardless of subpath.
    const cors = {
      "Access-Control-Allow-Origin": "https://zhoulucas26-alt.github.io",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (request.method === "GET") {
      const url = new URL(request.url);
      if (url.pathname === "/test" && url.searchParams.get("provider") === "groq") {
        if (!env.GROQ_API_KEY) {
          return json({ selftest: "FAIL", reason: "GROQ_API_KEY secret is not set on this Worker" }, 200, cors);
        }
        try {
          const { resp, raw } = await callGroq(env, 'Reply with exactly this JSON and nothing else: {"ok":true}');
          return json({
            selftest: resp.ok ? "OK" : "FAIL",
            model: GROQ_MODEL,
            keyLength: env.GROQ_API_KEY.length,
            groqStatus: resp.status,
            groqStatusText: resp.statusText,
            groqContentType: resp.headers.get("content-type"),
            groqBodyFirst800: raw.slice(0, 800),
          }, 200, cors);
        } catch (err) {
          return json({ selftest: "FAIL", reason: "fetch to Groq threw: " + String(err) }, 200, cors);
        }
      }
      if (url.pathname === "/test") {
        if (!env.GEMINI_API_KEY) {
          return json({ selftest: "FAIL", reason: "GEMINI_API_KEY secret is not set on this Worker" }, 200, cors);
        }
        try {
          const { resp, raw } = await callGemini(env, [
            { text: "What color is this image? Answer in one word." },
            { inline_data: { mime_type: "image/png", data: TEST_PNG } },
          ]);
          return json({
            selftest: resp.ok ? "OK" : "FAIL",
            model: MODEL,
            keyLength: env.GEMINI_API_KEY.length,
            geminiStatus: resp.status,
            geminiStatusText: resp.statusText,
            geminiContentType: resp.headers.get("content-type"),
            geminiBodyFirst800: raw.slice(0, 800),
          }, 200, cors);
        } catch (err) {
          return json({ selftest: "FAIL", reason: "fetch to Gemini threw: " + String(err) }, 200, cors);
        }
      }
      return json({ error: "Send a POST request (or GET /test, or GET /test?provider=groq, for a self-test)." }, 405, cors);
    }

    if (request.method !== "POST") {
      return json({ error: "Send a POST request." }, 405, cors);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (err) {
      return json({ error: "The photo upload arrived empty or corrupted (invalid request body). This usually means the upload was interrupted - retake the photo and try again." }, 400, cors);
    }

    const { image, mimeType, prompt, mode, text } = payload || {};

    if (mode === "flashcards") {
      return handleFlashcards(env, text, cors);
    }

    if (mode === "practice") {
      return handlePractice(env, text, cors);
    }

    if (!image || typeof image !== "string") {
      return json({ error: "No image data was received. Retake the photo and try again." }, 400, cors);
    }

    if (mode === "solve") {
      return handleSolve(env, image, mimeType, cors);
    }

    if (!env.GEMINI_API_KEY) {
      return json({ error: "Server misconfigured: the GEMINI_API_KEY secret is not set on this Worker. Run: npx wrangler secret put GEMINI_API_KEY, then redeploy." }, 500, cors);
    }

    try {
      const ANALYZE_PROMPT = [
        "You are checking whether a photo is school study material (a worksheet, homework, class notes, a textbook page, or slides) and, if it is, building a study plan from it.",
        "Respond with JSON only, exactly matching this schema:",
        '{"extractedText": string, "summary": string, "subjects": [{"subject": string, "topic": string, "how": string, "tasks": [string]}]}',
        "- extractedText: all text visible in the image, exactly as written. Empty string if there is no legible text.",
        "- summary: 1-2 friendly sentences (addressing the student as you) about what this material covers and what to focus on. Empty string if this is not study material.",
        "- subjects: 1-4 entries, ONLY if this is genuinely school/study material tied to an actual academic subject.",
        `  "subject" must be exactly one of: ${SUBJECT_CATEGORIES.join(", ")}. Use "Other" only if it is study material but truly fits none of the rest.`,
        '  "topic" is a short, specific topic drawn from the real content (e.g. "Photosynthesis", "Quadratic equations"), not a generic label.',
        '  "how" is one sentence on the best way to study this exact material (e.g. active recall, worked examples, timed practice), based on what it actually contains.',
        '  "tasks" is 2-4 short, specific, actionable study tasks that reference the real questions/content in the image (e.g. "Answer Q1-6 on organelle functions"). Do not invent tasks the image does not support.',
        "Do NOT force a subject onto unrelated content. If the photo is not school study material at all (a random object, a person, a receipt, a meme, an unrelated document, etc.) or you cannot confidently tie it to any school subject, return exactly:",
        '{"extractedText":"","summary":"","subjects":[]}',
      ].join("\n");
      const { resp, raw, data } = await callGemini(env, [
        { text: prompt || ANALYZE_PROMPT },
        { inline_data: { mime_type: mimeType || "image/jpeg", data: image } },
      ], { response_mime_type: "application/json" });

      if (!resp.ok) {
        const detail = data && data.error && data.error.message
          ? data.error.message
          : (raw ? raw.slice(0, 200) : "empty body, statusText=" + resp.statusText + ", content-type=" + (resp.headers.get("content-type") || "none"));
        return json({ error: `Gemini rejected the request (HTTP ${resp.status}): ${detail}` }, 502, cors);
      }
      if (!data) {
        return json({ error: `Gemini returned an unreadable reply: ${raw.slice(0, 200)}` }, 502, cors);
      }

      const cand = data.candidates && data.candidates[0];
      if (!cand) {
        const block = data.promptFeedback && data.promptFeedback.blockReason;
        return json({ error: block ? `Gemini declined to process the image (${block}).` : "Gemini returned no result for this image." }, 502, cors);
      }

      const modelText = (cand.content && cand.content.parts || [])
        .map((p) => p.text || "")
        .join("");

      // The model was asked for JSON; parse it and pass structure through.
      // If parsing fails, fall back to treating its output as plain text so
      // the app still gets something usable.
      let parsed = null;
      try { parsed = JSON.parse(modelText); } catch (e) {}
      if (parsed && typeof parsed.extractedText === "string") {
        return json({
          text: parsed.extractedText,
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          subjects: normalizeSubjects(parsed.subjects),
        }, 200, cors);
      }
      return json({ text: modelText }, 200, cors);
    } catch (err) {
      return json({ error: "Worker error: " + String(err) }, 500, cors);
    }
  },
};

// "Solve a question" - takes a photo of a single question a student is
// stuck on, asks Meta's Llama 4 (hosted on Groq) to identify it and solve
// it with a short step-by-step explanation.
async function handleSolve(env, image, mimeType, cors) {
  if (!env.GROQ_API_KEY) {
    return json({ error: "Server misconfigured: the GROQ_API_KEY secret is not set on this Worker. Run: npx wrangler secret put GROQ_API_KEY, then redeploy." }, 500, cors);
  }

  const SOLVE_PROMPT = [
    "A student photographed a question they're stuck on. Read the photo, find the single main question in it, and solve it.",
    "Respond with JSON only, exactly matching this schema:",
    '{"question": string, "answer": string, "steps": [string]}',
    "- question: the question exactly as written in the photo, cleaned up (fix obvious OCR noise, keep the actual wording/numbers).",
    "- answer: the final answer, short and direct (a number, a short phrase, or a sentence - whatever fits the question).",
    "- steps: 2-6 short steps showing how to get from the question to the answer, in plain language a student can follow.",
    "If the photo does not contain a clear, legible question (blank page, unrelated photo, too blurry to read), return exactly:",
    '{"question":"","answer":"","steps":[]}',
  ].join("\n");

  try {
    const { resp, raw, data } = await callGroq(env, SOLVE_PROMPT, image, mimeType || "image/jpeg");

    if (!resp.ok) {
      const detail = data && data.error && (data.error.message || data.error)
        ? (data.error.message || JSON.stringify(data.error))
        : (raw ? raw.slice(0, 200) : "empty body, statusText=" + resp.statusText);
      return json({ error: `Groq rejected the request (HTTP ${resp.status}): ${detail}` }, 502, cors);
    }
    if (!data) {
      return json({ error: `Groq returned an unreadable reply: ${raw.slice(0, 200)}` }, 502, cors);
    }

    const modelText = extractGroqText(data);
    let parsed = null;
    try { parsed = JSON.parse(modelText); } catch (e) {}

    if (parsed && typeof parsed.question === "string" && typeof parsed.answer === "string") {
      const steps = Array.isArray(parsed.steps)
        ? parsed.steps.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()).slice(0, 6)
        : [];
      return json({ question: parsed.question.trim(), answer: parsed.answer.trim(), steps }, 200, cors);
    }
    return json({ error: `Groq's reply didn't match the expected format: ${modelText.slice(0, 200)}` }, 502, cors);
  } catch (err) {
    return json({ error: "Worker error while solving: " + String(err) }, 500, cors);
  }
}

// "Flashcards" - takes the text already extracted from a worksheet scan
// (no new photo) and asks Meta's Llama 4 (hosted on Groq) to turn it into
// a short set of front/back study flashcards.
async function handleFlashcards(env, text, cors) {
  if (!env.GROQ_API_KEY) {
    return json({ error: "Server misconfigured: the GROQ_API_KEY secret is not set on this Worker. Run: npx wrangler secret put GROQ_API_KEY, then redeploy." }, 500, cors);
  }
  if (!text || typeof text !== "string" || !text.trim()) {
    return json({ error: "No study text to build flashcards from yet - scan a worksheet first." }, 400, cors);
  }

  const FLASHCARDS_PROMPT = [
    "A student scanned a worksheet, and this is the text extracted from it. Turn it into a set of study flashcards.",
    "Respond with JSON only, exactly matching this schema:",
    '{"cards": [{"front": string, "back": string}]}',
    "- 6-10 cards, each testing one key fact, term, or concept actually present in the text below.",
    "- front: a short question or term (e.g. \"What is photosynthesis?\", \"Define mitosis\").",
    "- back: a short, direct answer or definition (1-2 sentences max).",
    "Do not invent facts that aren't supported by the text. If the text is too short or unclear to make good flashcards, return exactly:",
    '{"cards":[]}',
    "",
    "STUDY MATERIAL:",
    text.slice(0, 8000),
  ].join("\n");

  try {
    const { resp, raw, data } = await callGroq(env, FLASHCARDS_PROMPT);

    if (!resp.ok) {
      const detail = data && data.error && (data.error.message || data.error)
        ? (data.error.message || JSON.stringify(data.error))
        : (raw ? raw.slice(0, 200) : "empty body, statusText=" + resp.statusText);
      return json({ error: `Groq rejected the request (HTTP ${resp.status}): ${detail}` }, 502, cors);
    }
    if (!data) {
      return json({ error: `Groq returned an unreadable reply: ${raw.slice(0, 200)}` }, 502, cors);
    }

    const modelText = extractGroqText(data);
    let parsed = null;
    try { parsed = JSON.parse(modelText); } catch (e) {}

    if (parsed && Array.isArray(parsed.cards)) {
      const cards = parsed.cards
        .filter((c) => c && typeof c.front === "string" && typeof c.back === "string" && c.front.trim() && c.back.trim())
        .map((c) => ({ front: c.front.trim(), back: c.back.trim() }))
        .slice(0, 10);
      return json({ cards }, 200, cors);
    }
    return json({ error: `Groq's reply didn't match the expected format: ${modelText.slice(0, 200)}` }, 502, cors);
  } catch (err) {
    return json({ error: "Worker error while building flashcards: " + String(err) }, 500, cors);
  }
}

// "Practice quiz" - takes material pulled from something already done (a
// past scan's extracted text, a solved question, or a flashcard set - no
// new photo) and asks Gemini to build a short multiple-choice quiz from it.
async function handlePractice(env, text, cors) {
  if (!env.GEMINI_API_KEY) {
    return json({ error: "Server misconfigured: the GEMINI_API_KEY secret is not set on this Worker. Run: npx wrangler secret put GEMINI_API_KEY, then redeploy." }, 500, cors);
  }
  if (!text || typeof text !== "string" || !text.trim()) {
    return json({ error: "Not enough material to build a quiz from yet." }, 400, cors);
  }

  const QUIZ_PROMPT = [
    "A student wants to be quizzed on material from something they already did (a scanned worksheet, a solved question, or a set of flashcards). Build a short multiple-choice quiz from the text below.",
    "Respond with JSON only, exactly matching this schema:",
    '{"questions": [{"question": string, "options": [string, string, string, string], "correctIndex": number, "explanation": string}]}',
    "- 4-6 questions, each testing understanding of one fact, term, or concept actually present in the text below - do not invent facts it doesn't support.",
    "- options: exactly 4 plausible answers, only one clearly correct.",
    "- correctIndex: the 0-based index (0-3) of the correct option.",
    "- explanation: one short sentence on why that answer is correct.",
    "If the text is too short or unclear to make a real quiz from, return exactly:",
    '{"questions":[]}',
    "",
    "MATERIAL:",
    text.slice(0, 8000),
  ].join("\n");

  try {
    const { resp, raw, data } = await callGemini(env, [
      { text: QUIZ_PROMPT },
    ], { response_mime_type: "application/json" });

    if (!resp.ok) {
      const detail = data && data.error && data.error.message
        ? data.error.message
        : (raw ? raw.slice(0, 200) : "empty body, statusText=" + resp.statusText);
      return json({ error: `Gemini rejected the request (HTTP ${resp.status}): ${detail}` }, 502, cors);
    }
    if (!data) {
      return json({ error: `Gemini returned an unreadable reply: ${raw.slice(0, 200)}` }, 502, cors);
    }

    const cand = data.candidates && data.candidates[0];
    if (!cand) {
      const block = data.promptFeedback && data.promptFeedback.blockReason;
      return json({ error: block ? `Gemini declined to process the request (${block}).` : "Gemini returned no result for this material." }, 502, cors);
    }

    const modelText = (cand.content && cand.content.parts || []).map((p) => p.text || "").join("");
    let parsed = null;
    try { parsed = JSON.parse(modelText); } catch (e) {}

    if (parsed && Array.isArray(parsed.questions)) {
      const questions = parsed.questions
        .filter((q) =>
          q && typeof q.question === "string" && q.question.trim() &&
          Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 &&
          q.options.every((o) => typeof o === "string" && o.trim()) &&
          Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < q.options.length
        )
        .map((q) => ({
          question: q.question.trim(),
          options: q.options.map((o) => o.trim()),
          correctIndex: q.correctIndex,
          explanation: typeof q.explanation === "string" ? q.explanation.trim() : "",
        }))
        .slice(0, 6);
      return json({ questions }, 200, cors);
    }
    return json({ error: `Gemini's reply didn't match the expected format: ${modelText.slice(0, 200)}` }, 502, cors);
  } catch (err) {
    return json({ error: "Worker error while building the quiz: " + String(err) }, 500, cors);
  }
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
