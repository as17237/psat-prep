# Agent task (parallel, START NOW): WI-14 current inventory + test oracle

**You are an agent on the `psat-prep` repo. This task is READ-ONLY — you produce ONE markdown doc and change NO code.** That keeps you fully parallel with the rebuild happening in `parent.html` / `js/pages/parent.js` (do not touch those or any other source file). Work on branch `main` (or a fresh branch); the only file you create is the deliverable below.

## Why
WI-14 rebuilds the parent portal on the design system (5-tab IA). Two things are needed up front and can be produced without touching the rebuild: (1) an exhaustive inventory of what the CURRENT parent portal does (so nothing is dropped), and (2) hand-computed test-oracle values (so the Playwright suite asserts real, hand-derived numbers per CLAUDE.md mode 4 — never values produced by calling the code under test).

## Deliverable
Create **`docs/WI-14_INVENTORY_AND_ORACLE.md`** with these two sections. Commit + push it. Do not modify anything else.

### Section 1 — Current parent-portal feature inventory
Read `parent.html` and `js/pages/parent.js` in full. Produce a table of EVERY user-facing feature/function, one row each:
`function name` · what it renders/does · which DOM element ids it reads/writes · which of the 5 target tabs it belongs to (**Overview · Score & History · Mistakes & Action Plan · Exam Builder · Data & Backups**). Flag anything that looks dead/unused. This is the feature-parity raw material.

### Section 2 — Hand-computed test oracle (the hard part)
Read `js/engine/scoring.js` and `js/engine/examgen.js` to UNDERSTAND the rules, then compute expected values BY HAND (do NOT just call the functions and paste output — the test must be an independent oracle):
1. **Score gate:** `MIN_PER_SECTION` (find its value in `js/engine/scoring.js`). State exactly what the parent Overview should display for a section with **14 attempts** vs **15 attempts** (below threshold → an em-dash "—"/"not enough data"; at/above → a scaled score). Give the boundary precisely.
2. **Adaptive full-mock module sizes:** confirm from `examgen.js` that a standard adaptive PSAT 8/9 mock produces modules of **27 / 27 / 22 / 22** questions (RW mod1/mod2, Math mod1/mod2 — verify the exact mapping). Cite the code that determines these counts.
3. **A fixture profile's mastery numbers:** using the existing Playwright fixture (`tests/e2e/fixtures.js` — `seedFixtureProfile`, `FIXTURE`), state the hand-computed RW-vs-Math mastery / accuracy the Overview tab should show for that profile. Show your arithmetic.
4. **Score-estimate labeling rule:** confirm the roadmap/plan requirement that the projected score is labeled a **"Practice score estimate"** with a confidence interval and is NEVER labeled "Official"/"Actual" (quote where this rule lives — `REFACTOR_PLAN.md` §WI-14 and `docs/FEATURE_AND_RELIABILITY_ROADMAP.md`).

## Rules
- **Read-only.** No edits to `parent.html`, `parent.js`, or any code. Only create the one doc.
- Hand-derive Section 2 values; cite the source file + line for each rule. If you can't determine one, say so explicitly rather than guessing.
- Do NOT touch `data/**`, the live student, or run any deploy.

## Hand back
Push `docs/WI-14_INVENTORY_AND_ORACLE.md`. The coordinating agent (me) will cross-check Section 2's numbers against the engine and fold Section 1 into the parity checklist, then these oracle values drive the WI-14 Playwright suite.
