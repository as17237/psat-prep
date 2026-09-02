# WI-14 (Parent portal rebuild) — continuation state

**Entry point for continuing WI-14.** Read this, then `CLAUDE.md` (binding rules), `docs/WI-14_DOM_CONTRACT.md` (stable ids), and `docs/WI-13_PROGRESS.md` (the proven pattern this mirrors). **As of 2026-09-01.**

## 1. Current state
- **Branch:** `wi-14-parent-rebuild` (off `main` `d755aa1`; pushed). WI-13 is **merged to `main`** and its student portal is live+validated on `/v2/`. Prod root untouched (cutover is owner-run `promote_to_prod.sh`).
- **Committed on this branch:**
  - `a314642` — design-system CSS (tokens + components) loaded on `parent.html`, alongside the still-present Tailwind CDN (safe, class-only). buttons.css predates it. `utilities.css` NOT added yet (see task 7).
  - `6138359` — **lucide gap-focus icon fix**: added `applyClass()` to `js/shared/dom.js` (setAttribute-based, works on SVG) and switched parent.js's 5 `setClassName(focusIcon,…)` no-ops to it. `setClassName` left unchanged (other pages rely on its no-op-on-SVG behaviour).
- **On `main` (docs, for the parallel agent):** `docs/WI-14_DOM_CONTRACT.md`, `docs/WI-14_AGENT_TASK_inventory_and_oracle.md`.
- **Not yet done:** shell + 5-tab nav, the 5 tab ports, Tailwind removal, the Playwright suite, deploy, merge.

## 2. What WI-14 is
Rebuild `parent.html` (1,199 lines, ~577 Tailwind class attrs) + `js/pages/parent.js` (1,444 lines) on the WI-12 design system with the **5-tab IA: Overview · Score & History · Mistakes & Action Plan · Exam Builder · Data & Backups**. Same buildless, incremental, bite-size-commit approach as WI-13. Spec: `REFACTOR_PLAN.md` §WI-14.

## 3. parent.html structure map (research done 2026-09-01)
It's currently a **single scroll page** (no top-level tabs). The shell step is a **markup reorg** — wrap existing section-groups into 5 `#pview-*` containers + add a nav strip — NOT a rewrite. Current sections → target tab, with the must-preserve ids:

| Current section (line) | Preserve these ids | → Tab |
|---|---|---|
| Hero card (~148) | `#hero-scaled-score` (score gate → "—"), `#hero-srs-due`, `#hero-streak`, `#hero-scale-denom`, `#hero-study-time`, `#hero-progress-bar` | Overview |
| Stat tiles (194–224) | `#stat-total-attempted`, `#stat-overall-accuracy`, `#stat-top-weakness`, `#stat-flagged-count` | Overview |
| Section mastery (238–253) | `#ela-section-score`, `#math-section-score`, `#ela-domain-bars`, `#math-domain-bars` | Overview |
| Exam history (317–320) | `#parent-exam-count-badge`, `#parent-exam-history-container` | Score & History |
| Gap alerts (367–373) | `#gap-due-srs`, `#gap-weak-skills` | Mistakes & Action Plan |
| Gap-test/mock builder (382+) | `#gap-c-{10,20,30,50}`, `#gap-focus-*`, `#gap-diff-filter`, `#gap-type-filter`, builder sub-tabs `#btab-{gap,mini,psat89}` | Exam Builder |
| Header backup dropdown (53–66) `#data-settings-menu` + banner (103) `#backup-status-*` | backup pill/banner, export/import/reset | Data & Backups |

**One judgment call:** the gap ALERTS (`#gap-due-srs`, `#gap-weak-skills`) go to *Mistakes & Action Plan*; the gap-TEST BUILDER UI goes to *Exam Builder*. Confirm against the parallel agent's inventory before splitting, since they're adjacent in the current markup.

## 4. Correctness bar (NON-NEGOTIABLE — parent shows scores to a parent)
- **Mode 1 (invented numbers) is the #1 project defect.** `#hero-scaled-score`, `#ela-section-score`, `#math-section-score` render a number ONLY at/above `MIN_PER_SECTION` (=15) attempts/section; below → em-dash `—`. Label reads **"Practice score estimate"** with a confidence interval; the strings "Official"/"Actual"/"Projected" are FORBIDDEN.
- **Zero inline thresholds** — import every threshold from `js/engine/scoring.js`. DoD grep: `grep -c 'MIN_PER_SECTION\|>= *15' parent.html js/pages/parent.js` must hit only imports.
- **Exam Builder:** adaptive full mock → module sizes **27/27/22/22** (assert in tests). Filtered drills are non-adaptive.
- **Data & Backups (mode 7):** import/reset go through WI-11's snapshot-first transactional path; confirm dialogs state what is **erased**. Backup-freshness widget green < 26 h else red, from `/api/backup-status`.

## 5. Next steps, in order
1. **Shell + 5-tab nav** (~30 min): add the full-width scrollable nav strip below the header (`#ptab-overview/scores/mistakes/builder/data`) — copy the WI-13 student nav pattern (index.html header, a nav row with stable-id buttons + whitespace-nowrap + overflow-x-auto). Wrap sections in `#pview-*` per §3. Add `switchParentTab(tab)` to parent.js (mirror student `switchTab`: toggle `.hidden` + active class; call per-tab render on show). Default Overview visible. Preserve all ids in §3.
2. **Overview tab** (mode-1 critical): re-skin hero/stats/mastery to design-system (`statCard`, `.card`, `.badge`); confirm the score-gate em-dash logic imports from scoring.js.
3. **Score & History**, **Mistakes & Action Plan**, **Exam Builder** (module sizes!), **Data & Backups** (mode-7 guards) — one bite each.
4. **Tailwind removal** (last): extend `scripts/gen_utilities.js` `collectClasses()` to ALSO scan `parent.html` + `js/pages/parent.js`; `node scripts/gen_utilities.js` (it hard-fails on any unhandled class from HTML — add family/keyword coverage if parent uses utilities index didn't); add `styles/utilities.css` link to parent.html + remove the Tailwind CDN + lazy-load Chart.js/Desmos + defer lucide + guard `lucide.createIcons()` + favicon (mirror WI-13). Update `test_deploy_scripts.js` expected list only if a new file is added (utilities.css already listed).
5. **Deploy `/v2/`**, 2 green Playwright runs, grep proves no inline thresholds, then **merge to `main`** (preflight-gated — deploy scripts touched: run `./scripts/preflight_backup.sh`, cite `PREFLIGHT_BACKUP_OK`).

## 6. Parallel work (delegatable now)
- **`docs/WI-14_AGENT_TASK_inventory_and_oracle.md`** (on `main`) — hand to another agent: read-only, produces `WI-14_INVENTORY_AND_ORACLE.md` (current feature inventory + hand-computed oracle: score gate 14-vs-15, module sizes 27/27/22/22, fixture mastery). Zero file conflict with the rebuild.
- **Then** the Playwright parent suite (`tests/e2e/parent-portal.spec.js`, a separate file) can be authored against the DOM contract + oracle in parallel with the markup rebuild (opus — hand-computed score math). Extends the existing 2 tests. DoD: score gate at 14-vs-15, history matches fixture, builder module sizes, export→wipe→import round-trip, backup-freshness red on stale.
- `gen_utilities.js` parent-scan extension (task 4) is a bounded delegatable tooling change (sonnet); I own the generator so light coordination.

## 7. Verify / gates (run before commit; full set before merge)
```bash
for t in tests/test_*.js; do node "$t" >/dev/null 2>&1 && echo OK $t || echo FAIL $t; done   # 19 suites
pkill -9 -f "http.server"; pkill -9 -f chromium; sleep 2
npx playwright test parent-portal.spec.js nav-crawl.spec.js --project=chromium-desktop --workers=1
git diff --stat -- data/        # MUST be empty (question content frozen)
python3 rebuild_bundle.py && git diff --stat data/questions_data.js   # no drift
grep -c 'MIN_PER_SECTION\|>= *15' parent.html js/pages/parent.js       # imports only
# before merge to main (deploy scripts touched):
./scripts/preflight_backup.sh   # cite PREFLIGHT_BACKUP_OK
```
Playwright flakiness: single-threaded local server → different specs time out per run; re-run a failing spec in isolation; `--workers=1`; `pkill` between runs.

## 8. Pointers
`docs/WI-14_DOM_CONTRACT.md` (ids) · `docs/WI-13_PROGRESS.md` (the pattern + known flake) · `REFACTOR_PLAN.md` §WI-14 (spec) · `CLAUDE.md` (7 defect modes) · `docs/PERF_OPTIMIZATION_BRIEF.md` (the lazy-load/gzip pattern to mirror for parent) · `CONTINUE_HERE.md` (whole-project map).

## 9. Remaining beyond WI-14 (context)
WI-15 (mistakes/feedback rebuild, sonnet) · WI-16 (adaptive-exam verification, opus) · WI-17 (parity suites, sonnet) · then owner-gated: prod cutover, `default_student` shard migration, WI-18 parallel run, WI-19 cutover. Lighthouse→90 needs the bundle-split project (opus, touches frozen bundle, own approval). Models: opus for correctness-critical/large/deploy, sonnet for bounded, haiku for repetitive; **no fable** (owner credit-constrained).
