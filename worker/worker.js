// Sprout OCR proxy (Cloudflare Worker)
// Keeps the Gemini API key server-side. The browser sends
//   { image: "<base64>", mimeType: "image/jpeg", prompt?: "..." }
// and gets back { text: "<extracted text>" }.
//
// The key is stored as a Worker secret named GEMINI_API_KEY (never in this file):
//   npx wrangler secret put GEMINI_API_KEY

const MODEL = "gemini-2.5-flash";

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
    if (request.method !== "POST") {
      return json({ error: "Send a POST request." }, 405, cors);
    }

    try {
      const { image, mimeType, prompt } = await request.json();
      if (!image) {
        return json({ error: "Missing 'image' (base64) in request body." }, 400, cors);
      }

      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

      const body = {
        contents: [{
          parts: [
            { text: prompt || "Extract all the text from this image exactly as written. Return only the extracted text." },
            { inline_data: { mime_type: mimeType || "image/jpeg", data: image } },
          ],
        }],
      };

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify(body),
      });

      const data = await resp.json();
      if (!resp.ok) {
        return json({ error: "Gemini request failed", details: data }, resp.status, cors);
      }

      const text = (data.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || "")
        .join("");

      return json({ text }, 200, cors);
    } catch (err) {
      return json({ error: String(err) }, 500, cors);
    }
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
