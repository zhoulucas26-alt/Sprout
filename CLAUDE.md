# Sprout — project guide for Claude

Sprout is a study-planner web app: the user photographs a worksheet, Gemini
reads it, and the app shows the extracted text, a summary, and detected
subject cards, then builds a (currently still hardcoded) study plan.

- **Live site**: https://zhoulucas26-alt.github.io/Sprout/ (GitHub Pages)
- **Repo**: zhoulucas26-alt/Sprout, default branch `main`
- **OCR backend**: Cloudflare Worker at
  `https://sprout-ocr.sprout-zhoulucas26.workers.dev` (source in `worker/`)

## Repo layout

| Path | What it is |
|---|---|
| `index.html` | The entire app, as a single self-contained "bundled page" (~500KB). See editing rules below — this file is fragile. |
| `worker/worker.js` | Cloudflare Worker: holds the Gemini key, accepts a base64 photo, returns `{text, summary, subjects}` or `{error}`. `GET /test` is a built-in self-test that reports Gemini's raw verdict. |
| `worker/wrangler.toml` | Worker config (name `sprout-ocr`). |
| `manifest.json`, `icons/` | PWA/homescreen support (iOS Add to Home Screen works). |
| `.github/workflows/static.yml` | Deploys repo root to GitHub Pages on every push to `main`. |

## CRITICAL: how index.html works and how to edit it safely

`index.html` is generated output from an app-builder. It contains three
`<script type="__bundler/...">` blocks. The app itself lives in
`__bundler/template` as a **JSON-encoded string** containing HTML plus a
`<script type="text/x-dc">` component (class `Component extends DCLogic`,
with `sc-if` / `sc-for` / `{{ }}` template bindings). At runtime it loads
React 18.3.1, ReactDOM, and @babel/standalone 7.29.0 from unpkg.com.

**Editing rules (violating these has already broken production once):**

1. Decode the template with `json.loads`, edit the decoded string with
   exact-match replacements (assert count == 1), re-encode with:
   ```python
   json.dumps(tpl, ensure_ascii=False).replace('</', '<\\u002F')
   ```
   **Every `</` must be escaped as `</`, not just `</script`.** The
   runtime re-fetches its own HTML (`fetch(location.href)`) and re-parses
   it; if closing tags are left literal, the re-parse double-escapes the
   template and every binding breaks (symptom: page flashes correct, then
   renders literal `\n` text everywhere).
2. Always round-trip validate (`json.loads` the new block) before writing.
3. Work on a copy, render-verify it, then write the real file and confirm
   `cmp` byte-identical to the verified copy.
4. Past patch scripts with the full working pattern live in the session
   scratchpad as `patch.py` / `patch2.py` / `patch3.py` — recreate that
   pattern if gone.

## CRITICAL: how to test (a file:// test will lie to you)

- **Never trust `file://` rendering** — the runtime's self-refetch fails
  silently on file:// (CORS) so the code path that broke production never
  runs. Serve over HTTP: `python3 -m http.server 8099` and load
  `http://localhost:8099/index.html`.
- The remote sandbox blocks unpkg.com, workers.dev, github.io, and
  google.com domains. To render the app headless: `npm install react@18.3.1
  react-dom@18.3.1 @babel/standalone@7.29.0` (npm registry IS reachable),
  then use Playwright route interception to fulfill the three unpkg URLs
  from node_modules. Chromium is at `/opt/pw-browsers/chromium`; launch with
  `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` and
  camera permission for the scan flow.
- Mock the Worker with route interception (include CORS headers and an
  OPTIONS 204 for preflight). Test success, `{text:""}`, HTTP 5xx with
  `{error}`, and empty-body responses — the app has distinct UX per case.
- Click path for the scan flow: "Tap to begin" → button "Start free" →
  "Scan my work" → shutter is `button[style*="78px"]` (force:true clicks;
  animations make elements "unstable" to Playwright).

## The Worker (Gemini proxy)

- Model: `gemini-2.5-flash` via `generativelanguage.googleapis.com`
  v1beta `generateContent`, key in header `x-goog-api-key`, structured
  output via `generationConfig.response_mime_type: "application/json"`.
- Secret `GEMINI_API_KEY` — set by the USER on their machine with
  `npx wrangler secret put GEMINI_API_KEY`. Claude never sees the key.
  If OCR fails oddly, have the user open `/test` — it reports `keyLength`
  and Gemini's raw response. (A past outage: keyLength was 1 because a
  paste into the hidden prompt failed. Real keys are ~39 chars.)
- CORS is currently `*` (fine for demo; locking to the Pages origin is a
  known TODO).
- Claude cannot deploy or call the Worker from the sandbox. The user
  deploys from **Windows PowerShell** in their local `sprout-ocr` folder:
  ```powershell
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/zhoulucas26-alt/Sprout/<BRANCH>/worker/worker.js" -OutFile worker.js
  npx wrangler deploy
  ```
  Use `npx` (not global install) — PowerShell execution policy was fixed
  with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, but npx is
  safer to recommend. Raw GitHub URLs cache ~1 min.

## Workflow with the user

- The user is not a professional developer; give copy-pasteable PowerShell
  commands and say exactly what output to expect.
- Claude pushes to a feature branch; the **user merges PRs to `main`**
  (usually via the Claude Code UI). Pages redeploys automatically in ~1-2
  min. Changes to `worker/worker.js` additionally need the user to
  redeploy the Worker (steps above) — say so explicitly every time.
- When the user reports a visual bug, ask which URL they're on and get the
  browser console output early — it resolved every mystery so far.

## Current state / known TODOs

Working end to end: camera scan → downscale to 1600px → Worker → Gemini →
extracted text + summary + real detected subject cards; failure shows a
"Failed to read the photo" screen with the specific reason and a Retake
photo button.

Still mock/demo:
1. **The study plan blocks** (Biology/Algebra/History sequence in
   `content(kind)` / `seq(h)` in the template component) ignore the scan.
   Next feature: generate plan blocks from the detected subjects (likely a
   second Gemini call or an extended schema in the existing one).
2. Pricing plans, streaks, and fast demo timer are demo furniture.
3. CORS lockdown on the Worker (one line, needs Worker redeploy).
