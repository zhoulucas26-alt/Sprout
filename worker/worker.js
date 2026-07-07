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

async function callGemini(env, parts) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  const raw = await resp.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) {}
  return { resp, raw, data };
}

export default {
  async fetch(request, env) {
    // CORS. "*" is convenient for a demo. For production, lock this to your
    // site's origin, e.g. "https://zhoulucas26-alt.github.io".
    const cors = {
      "Access-Control-Allow-Origin": "*",
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
      const { resp, raw, data } = await callGemini(env, [
        { text: prompt || "Extract all the text from this image exactly as written. Return only the extracted text." },
        { inline_data: { mime_type: mimeType || "image/jpeg", data: image } },
      ]);

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

      const text = (cand.content && cand.content.parts || [])
        .map((p) => p.text || "")
        .join("");

      return json({ text }, 200, cors);
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
