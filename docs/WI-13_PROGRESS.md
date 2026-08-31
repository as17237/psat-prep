# WI-13 (Student portal rebuild) — progress checkpoint

**Branch:** `wi-13-student-rebuild` (pushed to origin; **not** merged to `main`, **not** deployed to `/v2/` — prod untouched).
**As of:** 2026-08-30. **Full spec:** `REFACTOR_PLAN.md` §WI-13. **Detailed plan:** was drafted in `~/.claude/plans/greedy-booping-newell.md` (machine-local).

## Approach (important)
- Rebuild is **incremental**, one small verified commit per element, on the WI-12 design system (`styles/tokens.css` + `components.css` + `js/components/*` classes).
- **Tailwind CDN stays until Phase 6.** It cannot be removed incrementally — the page is saturated with its utilities — so removal is the *last* step, after every tab's markup is ported. Design-system CSS (class-only + `:root` vars) loads safely alongside it.
- Every commit: change → run affected Node suites + Playwright specs → commit only when green. `#id` hooks and behavior preserved throughout (pure class/markup swaps), so no test coupling broke.

## Done (10 commits, all green)
- **Phase 1 (shell/nav):** design-system CSS + vendored `vendor/chart.min.js` on index.html; 4-tab IA nav **Practice · Review · Exams · My Progress** (stable `#tab-*` IDs kept for the e2e suite); `#view-review` scaffold; `switchTab` handles `review`.
- **Phase 2 (Practice, clean re-skins):** MCQ options→`.question-option`; difficulty/SRS badges→`.badge-*`; feedback banner→`.banner-*`; filter-bar + palette panels→`.card`; **question bank folded under Practice** ("Browse all questions" ↔ "Back to Practice") — it was previously unreachable; added its first Playwright test.
- **Phase 3 (Review) — COMPLETE:** `renderReview()` (real due count off `srsState` + "Start review (N)"; honest empty state; high-yield drill card) + `startSrsReview()` (applies due filter → jumps to Practice). Tests in `srs-review-queue.spec.js` (empty + fixture-4-due).
- **Phase 4 (Exams, clean re-skins):** lobby mode cards→`.card`; exam answer options→`.question-option`; module-review/report/custom-test panels→`.card`.

## Deferred to Phase 6 (no clean design-system drop-in → do in the wholesale Tailwind removal)
- Practice: filter `<select>`s, question **palette** buttons, question-stem container chrome.
- Exams: timer bar, palette pills, break screen (dark `bg-white/10` panels), zoom controls, `#exam-active` question container (has min-h/overflow + pre-padded inner sections — `.card` would double-pad).
- Reason: the design system intentionally ships **no `input`/`select`/`palette`/layout classes**; styling these now would create mixed-system half-states Phase 6 rewrites anyway.

## Done (cont.)
- **Phase 5 (My Progress) — COMPLETE:** analytics header/stat-tiles/breakdown/bank panels→`.card` (`8a4af56`); **Data & Sync section** added (Sync now / Restore my real data / Reset all progress) — reset is mode-7 safe (confirm + transactional pre-reset snapshot) + test (`3847864`). Charts already on vendored Chart.js.
- **Phase 6 (in progress):** ✅ **mobile-nav fix** (`878cc7a`) — tab nav moved to its own full-width horizontally-scrollable strip below the top bar; all four tabs reachable at 390px; the `known-defects` #5 canary was flipped from pinning the bug to asserting the fix.

## Remaining (Phase 6)
- **Empty-state pass:** confirm a fresh profile shows no non-zero number on any tab (analytics + Review already covered by tests; spot-check Practice/Exams).
- **⚠️ Remove the Tailwind CDN** (`index.html:8`) + convert ALL deferred elements (Practice selects/palette, exam timer/palette-pills/break/zoom/#exam-active container, and any remaining utility-styled bits). **This is the single largest/riskiest task** — pulling the CDN unstyles every not-yet-ported element at once, so it is best done with visual verification (run the app / screenshots), not blind.
- Extend Playwright + **2 consecutive green runs**; Lighthouse ≥90 on `/v2/index.html`; `bash scripts/deploy_v2.sh`; then merge to `main`.

## Stat-tile note (optional polish)
The 4 analytics stat tiles are `.card`-wrapped with JS-set value/label divs; converting to the full `.stat`/`statCard` structure is optional and can ride along with the Tailwind-removal pass.

## How to verify on resume
```bash
cd ~/dev/psat-prep && git checkout wi-13-student-rebuild
for t in test_html_syntax test_ui_rendering test_buttons_and_interactions; do node tests/$t.js && echo OK $t; done
npx playwright test practice-flow.spec.js srs-review-queue.spec.js exam-flow.spec.js known-defects.spec.js --project=chromium-desktop --workers=1
```

## Known flake (not a real failure)
Playwright over the single-threaded local `python http.server` intermittently trips `page.goto`/`reload` **15s load timeouts** — worsened by stray servers and by external CDN resources (Google Fonts `@import`, unpkg lucide, Desmos) that `waitUntil:'load'` waits on. It hits pages this work never touched (e.g. `parent.html`). Mitigation: `pkill -9 -f "http.server"; pkill -9 -f chromium` between runs, and use `--workers=1`. Always re-run before treating a `page.goto` timeout as real.

## Also parked (separate from WI-13)
- WI-11.5 API deploy is **live + verified** on prod (done earlier today; see `CONTINUE_HERE.md` §10). `default_student` shard migration remains owner-gated.
- The BSD-sed `deploy_v2.sh` fix is merged to `main` (commit `3d8613c`).
