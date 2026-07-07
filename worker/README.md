# Sprout OCR proxy (Cloudflare Worker)

A tiny serverless proxy that holds the Gemini API key server-side so it is
never exposed in the browser. The static site (GitHub Pages) calls this Worker;
the Worker calls Gemini and returns the extracted text.

## Deploy (run these on your machine, from inside this `worker/` folder)

```powershell
npx wrangler login                    # once, authorizes Cloudflare
npx wrangler secret put GEMINI_API_KEY # paste your Gemini key when prompted
npx wrangler deploy                    # prints your https://sprout-ocr.<you>.workers.dev URL
```

## API

`POST` JSON:

```json
{ "image": "<base64 image data>", "mimeType": "image/jpeg", "prompt": "optional" }
```

Response:

```json
{ "text": "extracted text" }
```
