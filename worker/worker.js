// Sprout OCR proxy (Cloudflare Worker)
// Keeps the Gemini API key server-side. The browser sends
//   { image: "<base64>", mimeType: "image/jpeg", prompt?: "..." }
// and gets back { text: "<extracted text>" } or { error: "<what went wrong>" }.
//
// The key is stored as a Worker secret named GEMINI_API_KEY (never in this file):
//   npx wrangler secret put GEMINI_API_KEY
//
// GET /test runs a built-in self-test: it sends a tiny embedded image to
// Gemini and returns the raw result, so you can see exactly what Gemini
// says without involving the app or a camera.

const MODEL = "gemini-2.5-flash";

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
      return json({ error: "Send a POST request (or GET /test for a self-test)." }, 405, cors);
    }

    if (request.method !== "POST") {
      return json({ error: "Send a POST request." }, 405, cors);
    }

    if (!env.GEMINI_API_KEY) {
      return json({ error: "Server misconfigured: the GEMINI_API_KEY secret is not set on this Worker. Run: npx wrangler secret put GEMINI_API_KEY, then redeploy." }, 500, cors);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (err) {
      return json({ error: "The photo upload arrived empty or corrupted (invalid request body). This usually means the upload was interrupted - retake the photo and try again." }, 400, cors);
    }

    const { image, mimeType, prompt } = payload || {};
    if (!image || typeof image !== "string") {
      return json({ error: "No image data was received. Retake the photo and try again." }, 400, cors);
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

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
