# Sprout — project guide for Claude

Sprout is a study-planner web app: the user photographs a worksheet, Gemini
reads it, and the app shows the extracted text, a summary, and detected
subject cards, then builds a study plan from the real scan. Camera scan
(study plan) and Practice quiz run on Gemini; Solve a question and
Flashcards run on Meta's Llama 4 (hosted on Groq) — **two separate API
keys are required for the app to fully work**, see "The Worker" below.

- **Live site**: https://zhoulucas26-alt.github.io/Sprout/ (GitHub Pages)
- **Repo**: zhoulucas26-alt/Sprout, default branch `main`
- **OCR/AI backend**: Cloudflare Worker at
  `https://sprout-ocr.sprout-zhoulucas26.workers.dev` (source in `worker/`)

## Repo layout

| Path | What it is |
|---|---|
| `index.html` | The entire app, as a single self-contained "bundled page" (~500KB). See editing rules below — this file is fragile. |
| `worker/worker.js` | Cloudflare Worker: holds both the Gemini and Groq keys. Scan (study plan) and Practice quiz call Gemini; Solve a question and Flashcards call Groq (Llama 4). Returns mode-specific JSON or `{error}`. `GET /test` self-tests Gemini; `GET /test?provider=groq` self-tests Groq — both report the raw upstream verdict. |
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

## The Worker (Gemini + Groq proxy)

**Two independent secrets are required — the app is only half-working if
either one is missing, and there's no error banner in the UI warning the
user of this, only a per-feature "reported a problem" message.** This bit
Sprout once already: Solve and Flashcards silently 500'd on every single
use because GROQ_API_KEY was never set, and this file only ever documented
GEMINI_API_KEY. If a user reports "the AI bugs out a lot" or specific
features (especially Solve/Flashcards) always fail, check secrets FIRST
before debugging anything else.

- **Gemini** (`gemini-2.5-flash`, `generativelanguage.googleapis.com`
  v1beta `generateContent`, key in header `x-goog-api-key`, structured
  output via `generationConfig.response_mime_type: "application/json"`)
  powers the **scan → study plan flow** and **Practice quiz**.
  Secret `GEMINI_API_KEY`, self-test at `/test`.
- **Groq** (hosting Meta's `meta-llama/llama-4-maverick-17b-128e-instruct`,
  OpenAI-compatible chat-completions API, Bearer auth, structured output
  via `response_format: {type:"json_object"}`) powers **Solve a question**
  and **Flashcards**. Secret `GROQ_API_KEY` (get one free at
  console.groq.com/keys), self-test at `/test?provider=groq`.
- Both secrets are set by the USER on their machine with
  `npx wrangler secret put GEMINI_API_KEY` / `npx wrangler secret put GROQ_API_KEY`.
  Claude never sees either key. Each self-test endpoint reports `keyLength`
  and the raw upstream response — have the user open the relevant one when
  a feature "bugs out". (A past outage: keyLength was 1 because a paste
  into the hidden prompt failed. Real keys are much longer than that.)
- CORS is locked to `https://zhoulucas26-alt.github.io` (the Pages origin).
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

Working end to end, each with its own failure screen and Retake/Retry path:
camera scan → study plan built from the real detected subjects, Solve a
question, Flashcards (from a scan), Practice quiz (from a scan/solve/
flashcards), History, coins/Shop cosmetics (frames/backgrounds/accessories),
Achievements with unlock toasts, and tiered Plans (free/plus/pro).

Still mock/demo:
1. Pricing-tier gating (scan cap, streak multipliers) and the fast demo
   session timer are real logic but tuned for demoing, not tested pricing.
2. No in-app warning if a Worker secret is missing — each affected feature
   just shows its own "reported a problem" error per attempt. If a whole
   feature (not just one bad scan) always fails, check the relevant
   self-test endpoint (`/test` or `/test?provider=groq`) before assuming
   it's a frontend bug.
