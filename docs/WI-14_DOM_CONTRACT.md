# WI-14 DOM contract (parent portal rebuild)

**Purpose:** the stable structure the rebuild MUST produce, so the Playwright suite can be authored in parallel against it. The rebuild (`parent.html` + `js/pages/parent.js`) implements exactly these ids; the test agent asserts against them. Mirrors how WI-13 kept `#tab-*` ids stable.

## Top-level nav — 5 tabs (full-width scrollable strip, like the WI-13 student nav)
Tab buttons carry stable ids; view containers likewise. `switchParentTab(tab)` toggles `.hidden` + active class (same shape as student `switchTab`).

| Tab | button id | view container id |
|---|---|---|
| Overview | `#ptab-overview` | `#pview-overview` |
| Score & History | `#ptab-scores` | `#pview-scores` |
| Mistakes & Action Plan | `#ptab-mistakes` | `#pview-mistakes` |
| Exam Builder | `#ptab-builder` | `#pview-builder` |
| Data & Backups | `#ptab-data` | `#pview-data` |

## MUST-PRESERVE element ids (existing parent-portal.spec.js depends on these — do NOT rename)
| id | meaning | lands in tab |
|---|---|---|
| `#hero-scaled-score` | projected **Practice score estimate** (never "Official"); em-dash below `MIN_PER_SECTION` | Overview |
| `#hero-srs-due` · `#hero-streak` | hero stats | Overview |
| `#stat-total-attempted` · `#stat-overall-accuracy` · `#stat-flagged-count` · `#stat-top-weakness` | stat tiles (→ `statCard`) | Overview |
| `#ela-section-score` · `#math-section-score` | RW / Math section scaled scores (em-dash below gate) | Overview |
| `#gap-due-srs` · `#gap-weak-skills` | knowledge-gap alerts | Mistakes & Action Plan |
| `#parent-exam-count-badge` · `#parent-exam-history-container` | test-history list | Score & History |

Any NEW element the tests need gets a `data-testid` (preferred for new hooks) or a documented `#id` added here first.

## Correctness rules baked into the contract (mode-1 / mode-2)
- **Score estimate:** `#hero-scaled-score`, `#ela-section-score`, `#math-section-score` render a number ONLY at/above `MIN_PER_SECTION` (15) attempts/section; below → em-dash `—`. The label text must read "Practice score estimate" with a confidence interval; the strings "Official"/"Actual"/"Projected" are forbidden.
- **Zero inline thresholds:** every threshold imported from `js/engine/scoring.js`. DoD grep: `grep -c 'MIN_PER_SECTION\|>= *15' parent.html js/pages/parent.js` hits only imports.
- **Exam Builder:** adaptive full mock → module sizes **27/27/22/22** (assert in tests). Filtered drills are non-adaptive.
- **Data & Backups:** import/reset go through the snapshot-first transactional path; confirm dialogs say what is **erased** (mode 7). Backup-freshness widget: green < 26 h, red otherwise, from `/api/backup-status`.
- **Fix the 5 lucide `className`-on-SVG assignments** (strict-mode no-ops) via `setClassName`/`setAttribute` during the rebuild.

## Design-system + build notes
- Same as WI-13: link `styles/tokens.css` + `components.css` + `utilities.css`; lazy-load Chart.js (parent has charts) + Desmos; defer lucide + guard every `lucide.createIcons()`; add the inline favicon; **remove the Tailwind Play CDN** from `parent.html` LAST (Task 7).
- `scripts/gen_utilities.js` must be extended to also scan `parent.html` + `js/pages/parent.js` before Tailwind is removed there (delegatable tooling task), then regenerate `styles/utilities.css`.

## Reconciliation
The parallel agent's `docs/WI-14_INVENTORY_AND_ORACLE.md` (Section 1 feature inventory) feeds the full parity checklist; Section 2 oracle values (score gate 14-vs-15, module sizes, fixture mastery) become the test constants. I cross-check both before wiring.
