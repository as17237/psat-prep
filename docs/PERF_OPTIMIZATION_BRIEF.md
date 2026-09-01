# Brief: PSAT `/v2/` page-performance optimization (WI-13 Phase 6)

**You are an implementing agent working on the `psat-prep` repo. Read this whole brief, then read `CLAUDE.md` and `docs/WI-13_PROGRESS.md` before writing any code. You start cold — do not assume prior context.**

## 0. Context

- **Repo:** `~/dev/psat-prep`. **Branch:** `wi-13-student-rebuild` (do NOT create a new branch; commit here). Prod root is untouched; all work is validated on the `/v2/` staging lane.
- **Live staging URL:** https://psatprep4915.z13.web.core.windows.net/v2/index.html
- **Goal:** raise the Lighthouse **desktop Performance score from 58 toward ≥ 90** on `/v2/index.html`, WITHOUT changing behavior or breaking the test suite.
- **The student uses this daily.** `/v2/` writes to the LIVE Cosmos student (`default_student`). You are only changing front-end asset delivery + how heavy scripts load — you must not touch student data, question content, or scoring logic.

## 1. Binding rules (from `CLAUDE.md` — non-negotiable)

1. **Run the real code path and paste real numbers.** "Tests pass" is not enough. After each change, run the affected Playwright spec and the Node suites, and paste counts.
2. **Question content is frozen:** `data/*.json`, `data/questions_data.js`, `data/images/**`. `git diff --stat -- data/` MUST be empty after your work. You may change how the bundle is *delivered* (compression/caching) but NEVER its bytes/content.
3. **No new storage keys, no engine/scoring changes.**
4. **Watch a new test fail before it passes** (red-first) for any test you add; paste the red output.
5. **Deploy-script changes are preflight-gated at merge:** anything touching `scripts/` deploy files requires `./scripts/preflight_backup.sh` immediately before a merge to `main` (not required for `/v2/` staging deploys, which touch no data). Cite the `PREFLIGHT_BACKUP_OK` line if you merge.
6. **Traps:** `scripts/deploy_v2.sh` pins exact counts ("4 image references absolutised, 5 pages versioned") — do not change them. `tests/test_deploy_scripts.js` has a hand-written expected blob list (additive only). `tests/test_html_syntax.js` forbids logic in inline `<script>` blocks (≤5 lines each). `scripts/lib/deploy_common.sh` `APP_FILES` must list every `js/`/`styles/`/`vendor/` file on disk or all three deploy scripts hard-fail.
7. **Playwright is flaky under full-project load** (single-threaded local server). Use `--workers=1`; re-run a failing spec in isolation before treating it as real; `pkill -9 -f "http.server"; pkill -9 -f chromium` between runs.

## 2. Baseline (measured 2026-09-01, desktop preset)

Perf **58**. LCP **7.7s** · TTI **8.2s** · FCP **2.2s** · TBT 40ms (good) · CLS 0.13 (ok). Page = **8.2 MB, of which 7.36 MB is JavaScript.**

| Resource | Size | How loaded | Needed for first paint? |
| :-- | --: | :-- | :-- |
| `data/questions_data.js` | **5.9 MB** | eager `<script>`, **uncompressed** (`Content-Length: 6080994`, no `Content-Encoding`), **`Cache-Control: no-cache, no-store`** | no |
| Desmos `calculator.js` (external) | **794 KB** | eager `<script>` in `<head>` (index.html line ~16) | no — only when the graphing calc is opened |
| Chart.js (`vendor/chart.min.js`) | **205 KB** | eager `<script>` in `<head>` (line ~12) | no — only on the My Progress tab |
| lucide (external, unpkg) | 97 KB | eager `<script>` in `<head>` (line ~14) | icons |
| `/api/sync` fetch | 321 KB | on load | yes (leave as-is) |
| favicon.ico | — | requested → **404** | add a tiny inline favicon |

**Root causes:** (a) the 5.9 MB bundle is shipped uncompressed and uncached; (b) ~1 MB of JS (Desmos + Chart.js) is loaded eagerly in `<head>` but only used on demand, blocking first paint.

## 3. Tasks (do in this order; commit + verify after each)

### Task A — Compress + cache the question bundle (BIGGEST win; deploy-script only)

Azure Blob static hosting does not compress on the fly. Fix by uploading text assets **pre-gzipped** with `Content-Encoding: gzip`, and long-caching the frozen bundle.

- **Where:** the upload path in `scripts/deploy_v2.sh` (see its `upload_blob` calls, ~line 248) and the shared helper `scripts/lib/deploy_common.sh` (function `upload_blob`). Read both first.
- **Change `upload_blob`** so that for text assets (`*.js`, `*.css`, `*.html`, `*.json`) it: gzips the source to a temp file, and uploads with `az storage blob upload ... --content-encoding gzip --content-type <correct type> --overwrite`. Keep the blob NAME unchanged (e.g. `v2/data/questions_data.js`). Browsers decompress transparently; every modern browser sends `Accept-Encoding: gzip`, so serving gzip unconditionally is safe. Preserve the existing `--content-type` per extension (`application/javascript`, `text/css`, `text/html`, `application/json`).
- **Caching:** keep HTML and the small JS/CSS on the current `no-cache` policy (dev churn — avoid stale). For the **frozen** `data/questions_data.js` ONLY, set `--content-cache-control 'public, max-age=31536000, immutable'` (its content never changes per CLAUDE.md; if it ever does, the `?v=` bumps). Optionally also long-cache `vendor/chart.min.js` (pinned).
- **Verify:**
  ```bash
  bash scripts/deploy_v2.sh --dry-run   # must still print "4 image references absolutised, 5 pages versioned", exit 0
  bash scripts/deploy_v2.sh             # real deploy to /v2/
  curl -sI 'https://psatprep4915.z13.web.core.windows.net/v2/data/questions_data.js?v=20260829-7' \
    | grep -iE 'content-encoding|content-length|cache-control'
  # EXPECT: Content-Encoding: gzip ; Content-Length ~1.1–1.4 MB (was 6080994) ; Cache-Control: ...immutable
  # And confirm the page still loads + questions work:
  curl -s 'https://psatprep4915.z13.web.core.windows.net/v2/index.html' -o /dev/null -w '%{http_code}\n'
  ```
- **DoD:** bundle served gzip (~5× smaller transfer) + immutable cache; `/v2/` still serves and functions; `node tests/test_deploy_scripts.js` passes (update its expected blob list only if you added a new file — you should not need to).

### Task B — Lazy-load Desmos (−794 KB off first paint; code)

- **Remove** the eager Desmos `<script src="https://www.desmos.com/api/v1.9/...calculator.js...">` from `index.html` `<head>` (~line 16).
- **In `js/shared/math_tools.js`**, add a one-time loader and call it before init. Reference implementation:
  ```js
  let desmosLoading = null;
  function loadDesmos() {
    if (window.Desmos && typeof window.Desmos.GraphingCalculator === 'function') return Promise.resolve();
    if (desmosLoading) return desmosLoading;
    desmosLoading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://www.desmos.com/api/v1.9/calculator.js?apiKey=dcb31709b452b1cf9dc26972add0fda6';
      s.onload = () => resolve();
      s.onerror = () => resolve(); // initDesmosCalculator() already falls back to an iframe
      document.head.appendChild(s);
    });
    return desmosLoading;
  }
  ```
  `initDesmosCalculator()` already guards on `window.Desmos` and calls `fallbackDesmosIframe()` otherwise. Change `toggleDesmosCalculator()` so that when it OPENS the modal it does `loadDesmos().then(() => initDesmosCalculator())` instead of calling `initDesmosCalculator()` synchronously. Keep the iframe fallback path.
- **Verify:** `node tests/test_math_tools_and_reference.js`; then a Playwright check that opening the Desmos calculator in Practice still shows a calculator (extend an existing spec or write a small one — red-first). Manually confirm on `/v2/` after deploy.
- **DoD:** Desmos script is NOT in the network waterfall on initial load; opening the graphing calc loads + shows it (or the iframe fallback); no console errors.

### Task C — Lazy-load Chart.js (−205 KB off first paint; code)

- **Remove** the eager `<script src="vendor/chart.min.js?v=...">` from `index.html` `<head>` (~line 12). **Keep** `vendor/chart.min.js` in `APP_FILES` (it's still deployed, just loaded on demand).
- **In `js/pages/student.js`**, `renderCharts()` (~line 957) already checks `if (typeof Chart === 'undefined')`. Add a loader and make `renderCharts` load Chart first:
  ```js
  let chartLoading = null;
  function loadChartJs() {
    if (typeof Chart !== 'undefined') return Promise.resolve();
    if (chartLoading) return chartLoading;
    chartLoading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'vendor/chart.min.js?v=20260830-1';
      s.onload = () => resolve(); s.onerror = () => resolve();
      document.head.appendChild(s);
    });
    return chartLoading;
  }
  // then, at the top of renderCharts(...): await loadChartJs(); if (typeof Chart === 'undefined') return;
  ```
  Make `renderCharts` `async`. Its caller (`renderAnalytics`) can call it fire-and-forget; charts appear a beat later — that's fine. `renderCharts` is re-exported on `window` via the `Object.assign(window, {...})` block — keep it there.
- **Verify:** `npx playwright test analytics.spec.js --project=chromium-desktop --workers=1` — the empty-profile (no non-zero stat) and fixture-profile (70% / 20-attempt) tests must stay green, and charts must render on the My Progress tab.
- **DoD:** Chart.js not in the initial waterfall; My Progress charts still render; analytics tests green.

### Task D — Defer lucide + add a favicon (smaller FCP win; code)

- **lucide** (`index.html` ~line 14): add the `defer` attribute to the `<script>`. Then ensure EVERY `lucide.createIcons()` call site is guarded with `if (typeof lucide !== 'undefined') lucide.createIcons();` (grep `index.html` + `js/**` for `lucide.createIcons`). Verify icons still render across all tabs (Playwright `nav-crawl` + a manual `/v2/` check).
- **favicon:** add to `<head>` a zero-request inline favicon so the 404 goes away:
  ```html
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎓</text></svg>">
  ```
- **DoD:** `<head>` has no render-blocking app scripts left (Chart + Desmos removed by B/C, lucide deferred); favicon request no longer 404s.

### Task E — (Optional) Minify engine/page JS (−109 KB; only if time)

- Add a repo-local minify step (e.g. `esbuild`/`terser` as a dev-only tool) that minifies `js/**/*.js` + `srs.js` into the deploy staging, OR skip. **Do NOT** minify `data/questions_data.js` content (frozen) — gzip (Task A) already handles its transfer. If unsure, SKIP this task; A–D deliver the bulk of the win.

## 4. Full verification (run before handing back)

```bash
cd ~/dev/psat-prep
git diff --stat -- data/            # MUST be empty (question content frozen)
python3 rebuild_bundle.py && git diff --stat data/questions_data.js   # no drift
for t in tests/test_*.js; do node "$t" >/dev/null 2>&1 && echo "OK $t" || echo "FAIL $t"; done   # all pass
node tests/integrity/test_merge_pins.js && node tests/integrity/test_datamodel.js   # pass
pkill -9 -f "http.server"; pkill -9 -f chromium; sleep 2
npx playwright test --project=chromium-desktop --workers=1   # expect 45/45 (re-run any single flaky spec in isolation)
bash scripts/deploy_v2.sh           # deploy to /v2/
```

Then the OWNER re-runs Lighthouse (desktop preset) on `https://psatprep4915.z13.web.core.windows.net/v2/index.html` and saves `lighthouse-report.json`.

## 5. Definition of done

- All 19 Node suites green; desktop Playwright 45/45 (flaky mobile suite excluded — pre-existing infra).
- `git diff --stat -- data/` empty; `rebuild_bundle.py` shows no drift.
- On `/v2/`: bundle served **gzip + immutable**; Desmos + Chart.js absent from the initial network waterfall (loaded on demand and still work); favicon no longer 404s.
- **Target: Lighthouse desktop Performance ≥ 90** (or, if the 5.9 MB parse cost still caps it, a large measured jump from 58 with LCP/TTI roughly halved — report the exact new numbers).
- Commit each task separately with a descriptive message ending `Co-Authored-By: <model> <noreply@…>`, and push `wi-13-student-rebuild`.

## 6. Hand back to the reviewing agent (me) for validation

Provide: (1) `git log --oneline main..HEAD` for your new commits; (2) the `curl -sI` header output for the bundle (proving gzip + cache); (3) the Playwright + Node suite result lines; (4) the NEW `lighthouse-report.json` (or its category + metric numbers); (5) confirmation `git diff --stat -- data/` is empty. I will independently re-verify these before the work is accepted.

## 7. Notes / gotchas

- **Do NOT** remove `vendor/chart.min.js` or the Desmos usage — you are changing WHEN they load, not whether. Keep `vendor/chart.min.js` in `APP_FILES`.
- The 5.9 MB bundle's **parse** cost (separate from transfer) may keep Perf below 90 even after gzip; that's expected and is a deeper architectural change (splitting/lazy-loading question data) that is OUT OF SCOPE here — report the ceiling if you hit it rather than touching the frozen bundle.
- Keep changes on `/v2/` only; never deploy to `$web` root (that's `promote_to_prod.sh`, owner-only).
- If any deploy-script change is to be merged to `main`, run `./scripts/preflight_backup.sh` first and cite `PREFLIGHT_BACKUP_OK`.
