# WI-16 — Adaptive full-mock verification: progress & resume

Branch: `wi-16-adaptive-verification` (pushed). All work below is committed,
green, and deployed to `/v2/`. Prod untouched.

## Done

- **Bite 1 — routing verification (`8a6de67`).** `tests/test_adaptive_routing.js`
  (test-first, watched RED) pins routing boundaries (hand-derived: RW 16/27,
  Math 13/22 at threshold 0.58), the scaled-score curve (hand-computed), and a
  real-bundle module-gen check (27/27/22/22, FR=5, 0 repeats); prints the routing
  matrix. Added pure `routeAdaptiveTrack(rawRatio)` to `js/engine/scoring.js` and
  wired both exam-runner routing sites in `js/pages/student.js` to call it (was
  inline `>= threshold` duplicated). Manifest + api-surface count → 68.

- **Bite 2 — Estimate labelling, mode 1 (`1558c0d`).** The scaled score is a
  hand-authored estimate, not a CB published table. Relabelled
  "Projected PSAT 8/9 Scaled Score" → "Practice Score Estimate (PSAT 8/9)" and
  "Practice-Based Scaled Projection" → "…Scaled Estimate" on parent + student.
  Added a parent-portal spec asserting the label shows and the page contains no
  "Projected". ("Official Reference"/"official blueprint" left as-is — real CB
  materials, not score claims.)

- **Bite 3 — config extraction (`7408666`).** Lifted `SCALING_ASSUMPTIONS`,
  `OFFICIAL_BLUEPRINTS`, `PSAT_89_SPECS` verbatim into a documented single source
  of record `js/engine/adaptive_config.js` (no-dep UMD part; header separates
  MEASURED/published values from hand-authored UNVALIDATED estimates). `scoring.js`
  gains it as its first DEP and re-exports the same objects (frozen PSAT_ENGINE
  API unchanged — examgen reads them via `scoring.OFFICIAL_BLUEPRINTS`). 8 twin
  sites updated: config file, scoring.js, 3 HTML `<script>` tags, `APP_FILES`,
  `test_deploy_scripts` dest list, `test_engine_api_surface` LOAD_ORDER + its two
  negative-load assertions. New `tests/test_adaptive_config.js` pins identity-
  equivalence + a hand-written value lock (watched RED via 0.58→0.59).

Verified across bites: **21/21 Node suites**, **17/17 Playwright** on the 4
engine-loading pages, `rebuild_bundle` drift = 0, real-data run → 27/27/22/22
modules / 98 Q / routing boundary exactly at 0.58 / scale 1.0→720.

## Remaining — Part (c): `tests/e2e/adaptive.spec.js` (researched, ready to write)

Goal: prove the routing WIRING (`js/pages/student.js:1591–1621` — pool swap +
"(Upper/Standard Difficulty Track)" label) **end-to-end in the browser**, per
branch (upper/lower × RW/Math). This wiring is the one adaptive layer not yet
executed by a test (the pure `routeAdaptiveTrack` + module-gen are unit-covered).

Mechanism discovered (no production test seam needed):
- Bank is the page global `window.QUESTIONS_DATA` — `{id, type, correct_answer}`.
- `psat_active_exam_state` (persisted on every `loadExamQuestion`) exposes each
  module's **ordered** `questionIds` and, after a module submit + one persist,
  `activeExamMeta.routingTracks.{rw,math}` and `activeExamMeta.modules[i].name`.
- MCQ options render A,B,C,D in fixed order as `#exam-mcq-options .question-option`
  (nth index = letter); free-response uses `#exam-spr-input`.
- Standard flow: modules [RW-M1, RW-M2, Math-M1, Math-M2]; the **only** break is
  after module index 1 (`startBreakTimer(10*60)` → `#exam-break`, "Resume Exam
  Early"). Routing runs in `submitCurrentExamModule` at moduleIndex 0 (RW) and 2
  (Math). Finish → `#exam-report`, `#report-total-score`.

Plan:
- **Test UPPER (both sections Hard).** Start "Start Full PSAT 8/9 Exam"
  (`startStandardExam`). Answer Q1 (any) to force a persist; read the module-0
  ordered `questionIds` + build `id→correct_answer` from `QUESTIONS_DATA`; answer
  all 27 RW-M1 **MCQ** questions correctly (MCQ alone clears 16/27; FR is
  math-only-ish, fill best-effort). Submit → enter RW-M2, answer Q1, assert
  `routingTracks.rw==='Hard'` + `modules[1].name` contains "Upper Difficulty
  Track". Jump to last palette pill (`#exam-palette-pills button:last`) → "Review
  Module →" → submit → break → "Resume Exam Early". Repeat correct-answers for
  Math-M1 (22, clears 13/22 via MCQ) → assert `routingTracks.math==='Hard'` +
  "Upper Difficulty Track". Finish → `#exam-report` visible, `#report-total-score`
  non-empty and not the "1390" template placeholder.
- **Test LOWER (both Standard).** Same skeleton but **leave M1 unanswered**
  (0 correct → Easy): jump last pill → review → submit each M1. Assert
  `routingTracks.{rw,math}==='Easy'` + name contains "Standard Difficulty Track".
- `test.setTimeout(180000)`; `--workers=1`; import the safety fixture; two
  consecutive green runs (known local-server flakiness). Kill stray
  `http.server`/`chromium` before running.

After (c) green → **merge WI-16 to main** with `--no-ff`. NOTE: this branch
touched a deploy script (`scripts/lib/deploy_common.sh` APP_FILES), so the
refactor-period gate applies at merge: run `./scripts/preflight_backup.sh` and
cite its `PREFLIGHT_BACKUP_OK` line in the merge/completion report.

## Do NOT (owner-gated)
Prod cutover (`promote_to_prod.sh`), `default_student` shard migration
(needs `--i-have-owner-approval-for-default-student`), WI-18/19.
