# PSAT 8/9 Prep — Refactor Execution Plan

**Date:** 2026-08-29 · **Author:** Claude (planning agent) · **Implementers:** AI sub-agents, one work item each
**Cutover authority:** Human (Ashutosh) — see WI-19.

This plan was produced after direct analysis of the codebase **and live queries against the production Azure resources**. Every number in §0 is a measurement taken today, not an assumption. Sub-agents: §0 is your ground truth; do not re-derive it from docs (some project docs describe aspirational architecture that does not match production).

---

## 0. Verified ground truth (measured 2026-08-29)

### 0.1 Azure resources (resource group `rg-psat-prep`, subscription `580d0d70-855b-45b2-b471-3024eefa2bb7`)

| Resource | Name | Role |
| :-- | :-- | :-- |
| Cosmos DB account (serverless, Core SQL) | `psat-cosmos-15958` | Student progress + question mirror |
| Storage account | `psatprep4915` | Static site (`$web`), backups (`cosmos-backups`) |
| Functions app | `psat-api-4915` | `/api/sync`, `/api/backup`, `/api/feedback` (all `authLevel: anonymous`) |

### 0.2 Cosmos DB `psat-prep-db` — live contents

| Container | Partition key | Docs (today) | Contents |
| :-- | :-- | :-- | :-- |
| `Questions` | `/domain` | **3,059** | Full question mirror. **Not read by the running app** — no API endpoint serves it. `image_url` points at `https://psatprep4915.z13.web.core.windows.net/data/images/<id>_question.png` (the `$web` static site, not a separate blob container). |
| `UATStudentAnswers` | `/student_name` | **10** | 1 × `student_master_profile` (`id: student_default_student`) + 9 × immutable `exam_session` docs. |
| `UATFeedback` | `/category` | **0** | Feedback form submissions. |

Master profile `student_default_student`, measured today: **406 progress entries** (matches "~400 completed"), **392 SRS cards**, 4 session days, 9 exam history entries, **228 KB document size**, `updatedAt = 2026-08-29T12:45Z` (the student used the app *today* — constraint 2 is live).

### 0.3 Question screenshots — answering the open question in the brief

The 3,059 question-card PNGs live in **three places**, none of which is the nightly backup:

1. `data/images/` in the git repo — 3,059 files, **tracked in git**, pushed to `github.com/as17237/psat-prep`.
2. `$web/data/images/` on `psatprep4915` — 3,059 blobs (verified count), served to the app.
3. Referenced (by URL only) from the Cosmos `Questions` container.

So images are reasonably durable (git + GitHub + `$web`) but have **no immutable backup copy** — a bad `$web` deploy plus a bad git operation is a two-failure loss scenario. WI-02 closes this.

### 0.4 Data flow of the running app

- Questions load **client-side** from `data/questions_data.js` (6,080,994 bytes; local and deployed copies verified byte-identical today). Cosmos `Questions` is a write-only mirror.
- Student state lives in `localStorage` (`psat_progress`, `psat_srs`, `psat_sessions`, `psat_exam_history`, `psat_active_exam_state`) and syncs to Cosmos via `srs.js:2226` → `https://psat-api-4915.azurewebsites.net/api/sync`. The server (`api/src/functions/sync.js`) does a **non-destructive field-level merge** (newer-timestamp-wins per question/card, max-wins per session, dedupe-by-examId) — this is what makes the parallel-branch strategy in §3 safe.
- Beta site exists at `$web/beta/` — but `promote_beta.sh` uploads the **same six files to prod root and `beta/` in the same run**, so beta is not currently an isolation lane (see §1, root cause 4).

### 0.5 Backups — current state

- Nightly timer (02:00 UTC) in `api/src/functions/backup.js` → `cosmos-backups` container, JSON + `.sha256` sidecar + `latest` pointer. Ran successfully today (~512 KB). Zero-document guard present.
- **Scope gap:** backs up only `UATStudentAnswers` + `UATFeedback`. Not `Questions`, not images, not the site bundle.
- **Silent-failure gap:** the timer handler catches errors and only `context.error()`s them — a failing nightly backup would go unnoticed (CLAUDE.md failure mode 5).
- **Broken tool:** `scripts/backup_cosmos.js:54` uses `backupPayload`, which is **never defined** — the local CLI backup crashes with a ReferenceError on every run. (The cloud function has its own correct copy of this logic.)
- `scripts/restore_cosmos.js` is well-guarded (checksum verify, zero-doc hard fail, dry-run default, pre-restore snapshot) but a **restore has never been verified end-to-end into a scratch environment**.

### 0.6 Code inventory

| File | Size | Notes |
| :-- | :-- | :-- |
| `index.html` (student) | 4,193 lines, ~2,700 inline JS | Monolith |
| `parent.html` | 2,862 lines, ~1,709 inline JS | Monolith, duplicates student logic |
| `mistakes.html` | 853 lines, ~654 inline JS | |
| `feedback.html` | 358 lines | |
| `srs.js` | 3,429 lines | UMD, no DOM — the one well-factored module. Contains grading, SM-2, **existing adaptive MST exam generation** (`adaptivePools`, module-2 routing, hand-authored difficulty curves), scoring with `MIN_PER_SECTION = 15`, cloud sync client. |
| Styling | Tailwind **Play CDN** (runtime JIT, non-production), per-page `<style>` blocks, `styles/buttons.css` (nascent component system) | |
| Tests | 11 Node suites + `test_extractor.py` — **all passing today** | String/jsdom-level; **zero real-browser automation**. CI (`.github/workflows`) runs only 3 of the 11 Node suites. |

---

## 1. Root-cause analysis — why regressions recur and coverage is weak

1. **~5,100 lines of untestable inline JS across four HTML monoliths.** Logic in `<script>` blocks can't be imported by a test, so tests resort to regex/string checks against the HTML — which is why six review rounds of defects (see `CLAUDE.md`) all shipped past a green suite. This is the primary root cause.
2. **Twin-page duplication.** Student and parent pages reimplement the same display rules (score gating, thresholds, storage access). Every rule change must be applied twice; historically it was applied once (CLAUDE.md failure mode 2, cited in rounds 2–6).
3. **No browser-level tests.** Nothing ever clicks a real button in a real browser. Placeholder answer buttons, broken feeds, and layout regressions were all human-discovered.
4. **No true staging lane.** `promote_beta.sh` deploys identical artifacts to prod and beta simultaneously, and never deploys `data/` at all. There is no environment where a change can soak without touching prod.
5. **Silent failure channels.** Nightly backup failures are logged and swallowed; `safeSetStorage`'s return flag history (CLAUDE.md mode 5) shows the same pattern client-side.
6. **Unbounded document growth.** Full-profile sync pushes a 228 KB master doc on every sync, growing with every attempt (406/3,059 questions in). At full-bank completion this document will be ~1.5 MB+, approaching Cosmos' 2 MB item limit — a hard failure waiting mid-course.
7. **Play-CDN styling.** Runtime Tailwind JIT means every page carries its own ad-hoc utility soup; nothing enforces visual consistency, and the CDN script is a production liability (FOUC, external dependency).

The refactor addresses these root causes directly, not just the UX symptoms.

---

## 2. Target architecture & design system

### 2.1 Architecture (unchanged backbone, restructured code)

Keep: static hosting on `$web`, Azure Functions API, Cosmos DB as single source of truth, `localStorage`-first client, no framework, no build step. These are appropriate for a single-student app and minimize migration risk.

Change:

```
/v2/  (new parallel deployment lane in $web — see WI-06)
├── index.html, parent.html, mistakes.html, feedback.html   ← thin shells: markup + <script type="module">
├── js/
│   ├── engine/          ← srs.js decomposed: grading.js, scheduler.js, examgen.js, scoring.js, sync.js, storage.js
│   │                       (an srs.js UMD facade re-exports everything; existing tests keep passing)
│   ├── components/      ← shared DOM components (statCard, banner, modal, progressBar, questionCard, navTabs)
│   └── pages/           ← per-page controllers (student.js, parent.js, mistakes.js, feedback.js)
├── styles/
│   ├── tokens.css       ← design tokens (color, type scale, space, radius, shadow) as CSS custom properties
│   ├── components.css   ← component classes (extends the existing buttons.css pattern)
│   └── buttons.css      ← existing, absorbed into the system
└── data/ → ../data/     ← same bundle and images as prod; no data duplication
```

- **ES modules, no bundler.** Native `<script type="module">` keeps the zero-build deploy while making every line of page logic importable by tests. This single change converts the untestable 5,100 inline lines into testable modules.
- **One rule, one module.** Shared thresholds/display rules live in `js/engine/` and are imported by both portals — mode-2 twin drift becomes structurally impossible.
- **Same Cosmos, same API, same student document.** The v2 client calls the existing `/api/sync` with the existing merge semantics. No schema fork, no migration, no second source of truth.

### 2.2 Design system recommendation

**Recommended: a self-hosted token + component CSS system (no framework, no build).** Rationale: the app has exactly four pages and two audiences; the current inconsistency comes from unconstrained per-page utilities, and the fix is a constrained vocabulary, not a bigger toolkit. `styles/buttons.css` already proves the pattern works here.

- `tokens.css`: one palette (primary/accent/semantic + neutral ramp), one type scale (5 sizes), one spacing scale (4/8-based), radii, shadows. Both portals use the same tokens; the parent portal gets a distinct accent hue, nothing else.
- `components.css`: `.card`, `.stat`, `.btn` (existing), `.banner`, `.badge`, `.progress`, `.table`, `.modal`, `.tabs`, `.empty-state`. Every page composes these; page-level CSS is limited to layout grid.
- `js/components/`: small render helpers so both portals emit *identical markup* for the same concept — consistency by construction (the brief's requirement) rather than by convention.
- Tailwind Play CDN is **removed** at page-migration time (WI-13–15); Chart.js is pinned and self-hosted.
- Information architecture: each portal collapses to a fixed top-level nav (Student: **Practice · Review (SRS) · Exams · My Progress**; Parent: **Overview · Score & History · Mistakes & Action Plan · Exam Builder · Data & Backups**). Every existing feature maps into exactly one of these — nothing is dropped; clutter is reduced by grouping, progressive disclosure (collapsed cards), and empty-state discipline (CLAUDE.md mode 1: empty means empty).

*Alternative considered and rejected:* Vite + Tailwind proper. It would fix the Play-CDN problem but introduces a build pipeline into a deliberately buildless deploy chain mid-refactor — more risk than benefit at this scale.

---

## 3. Data-safety strategy

- **Single source of truth throughout:** both prod and `/v2/` read/write the *same* Cosmos documents through the *same* API. The server-side merge in `sync.js` (newer-wins per key, never whole-document replace) is the mechanism that makes concurrent old/new clients safe. WI-07 adds tests that pin these merge semantics so no sub-agent can weaken them unnoticed.
- **Backup before anything:** WI-01→WI-05 are blocking. No other work item may start until WI-03 (restore verified) is done.
- **Per-work-item gate:** every work item that touches `api/`, `js/engine/storage|sync`, or any deploy script must run `scripts/preflight_backup.sh` (WI-05) immediately before merge and record the produced backup filename in its completion report.
- **Protected objects (no work item may modify without its own explicit say-so):**
  - Cosmos docs: `student_default_student`, all `exam_*` docs (immutable by design)
  - `$web` root files (prod) — only WI-19 (human) touches these
  - `cosmos-backups` container contents (append-only; nothing deletes a backup)
  - `data/images/**`, `data/*.json`, `data/questions_data.js` (content-frozen for the whole refactor; bundle regeneration only via `rebuild_bundle.py` and only if a data defect is found, with its own backup first)
- **E2E writes are quarantined:** all automated tests sync as `student_name=e2e_test_student` (or run with sync disabled). Writing to `default_student` from a test is a build-failing offense, enforced by an assertion in the Playwright fixture (WI-08).

---

## 4. Testing strategy

Layers, from inner to outer — "humans never discover bugs" requires all four:

1. **Unit (Node, existing + extended):** engine modules tested directly; the 11 existing suites keep passing throughout (they are the regression floor).
2. **Real-data execution (Node):** any change to generation/filtering/scoring/storage must run against the real `data/questions_data.js` and assert real counts (CLAUDE.md's prime rule — now enforced as a per-work-item DoD clause, not a norm).
3. **Data integrity (Node + live Cosmos):** reconciliation suite (WI-07) comparing live DB ↔ latest backup ↔ schema invariants; run at every checkpoint and before cutover.
4. **Browser E2E (Playwright, WI-08 + per-page additions):** every link, button, and flow in both portals, both viewports (mobile/desktop), against a local server and against the deployed `/v2/` lane. Adaptive routing gets a dedicated matrix (WI-16).

**Test-quality rules binding on every sub-agent** (from CLAUDE.md mode 4, now DoD clauses): expected values written by hand, never derived by reusing the code under test; every new test demonstrated red (break the code, watch it fail, restore) with the red run's output pasted in the completion report; no monkeypatching module exports for time/randomness — pass parameters.

---

## 5. Work items

Format per item: **Objective · Dependencies · Touches · Data safety · Verification · Rollback · Definition of done.**

---

### Phase 0 — Data-safety foundation (blocking; nothing else starts)

---

#### WI-01 — Fix the broken local backup CLI

- **Objective:** `scripts/backup_cosmos.js` crashes on every run: line 54 stringifies `backupPayload`, which is never defined. Reconstruct the payload exactly as `api/src/functions/backup.js:performCosmosBackup` does (same `backupMetadata` fields, `studentAnswers`, `feedback` arrays, same sha256 sidecar format) so local and cloud backups are format-identical and `restore_cosmos.js` accepts both. Also add the `UATFeedback` fetch the CLI currently lacks.
- **Dependencies:** none (first item).
- **Touches:** `scripts/backup_cosmos.js` only. Reads Cosmos `psat-prep-db/UATStudentAnswers` + `UATFeedback` (read-only). Reference (do not modify): `api/src/functions/backup.js`, `scripts/restore_cosmos.js`.
- **Data safety:** script is read-only against Cosmos; writes only to local `backups/` (gitignored). Must keep the zero-document abort guard.
- **Verification:** (a) new test `tests/test_backup_cli.js` that requires the module with an injected fake Cosmos client and asserts payload shape + sidecar format by hand-written expectation; demonstrated red first. (b) Real run: execute `node scripts/backup_cosmos.js` against live Cosmos; paste output doc counts (expect 10 student docs today) and verify `node scripts/restore_cosmos.js backups/cosmos_backup_latest.json` (dry-run) validates it with checksum OK.
- **Rollback:** git revert; no data risk.
- **DoD (machine-verifiable):** `node scripts/backup_cosmos.js && node scripts/restore_cosmos.js backups/cosmos_backup_latest.json` exits 0, dry-run reports ≥10 valid documents and `Integrity Verified`; `node tests/test_backup_cli.js` exits 0; all 11 existing suites still exit 0.

---

#### WI-02 — Full-scope baseline snapshot (the emergency recovery point)

- **Objective:** produce one complete, immutable, checksummed snapshot of *everything*: all three Cosmos containers (3,059 + 10 + 0 docs), all 3,059 images, `data/questions_data.js`, `data/ela_questions.json`, `data/math_questions.json`, and a manifest (git SHA of repo, blob inventory with per-file MD5 from Azure, doc counts, sha256 of every JSON export). Upload to a **new** blob container `refactor-baseline` in `psatprep4915`. Script it as `scripts/full_baseline_snapshot.sh` (rerunnable; each run writes under a timestamped virtual folder `baseline_<ISO>/`).
- **Dependencies:** WI-01 (reuses its fixed export logic for the student container).
- **Touches:** new `scripts/full_baseline_snapshot.sh`, new `scripts/export_questions_container.js` (reads Cosmos `Questions`). Creates blob container `refactor-baseline`. Reads `$web/data/images/*` (server-side `az storage blob copy` — do not round-trip 3,059 files through the workstation).
- **Data safety:** strictly read-only on all sources. `refactor-baseline` container must be **private** (no public access — CLAUDE.md mode 7 round-1 regression) and additive-only. Verify privacy in-script: `az storage container show-permission --name refactor-baseline` must return `publicAccess: null/off`.
- **Verification:** script self-verifies and prints: Cosmos export doc counts (expect **3059 / 10 / 0** against live `SELECT VALUE COUNT(1)` at run time), blob copy count = `$web/data/images/` count (expect **3,059 = 3,059**), bundle byte size matches local (6,080,994 today), every sha256 sidecar validates. Paste this output in the completion report.
- **Rollback:** n/a (additive only). A failed run leaves a partial timestamped folder; rerun creates a fresh one; never delete the old.
- **DoD:** `scripts/full_baseline_snapshot.sh` exits 0 and its final `VERIFY` block prints all counts matching live sources; container ACL check prints private; a `baseline_<ts>/MANIFEST.json` blob exists listing every artifact with checksums.

---

#### WI-03 — Prove the baseline restores (restore verification into scratch)

- **Objective:** restore WI-02's snapshot into a scratch database `psat-prep-db-drtest` (same Cosmos account, serverless = negligible cost) and reconcile: recreate the three containers with the same partition keys (`/domain`, `/student_name`, `/category`), restore all docs, deep-compare against the export (doc counts, per-doc JSON equality ignoring `_rid/_self/_etag/_attachments/_ts`), and verify 20 randomly sampled image blobs byte-match their `$web` originals. Then extend `docs/DISASTER_RECOVERY_RUNBOOK.md` with the tested procedure and add a recurring calendar note: re-verify restore after each phase (§6).
- **Dependencies:** WI-02.
- **Touches:** new `scripts/restore_baseline_to_scratch.js`, new `scripts/reconcile_restore.js`, `docs/DISASTER_RECOVERY_RUNBOOK.md`. Creates + deletes `psat-prep-db-drtest`.
- **Data safety:** the restore target name is hardcoded `psat-prep-db-drtest`; the script must **hard-fail if the target database name equals `psat-prep-db`** (assert, not convention). Never runs `restore_cosmos.js --apply` against production. Deletion at the end targets only `psat-prep-db-drtest` by literal name.
- **Verification:** reconcile script prints: containers 3/3, docs 3059/3059 · 10/10 · 0/0, deep-equal failures 0, image samples 20/20 match. Demonstrated red: corrupt one doc in scratch, watch reconcile report exactly 1 mismatch, then re-restore.
- **Rollback:** delete scratch DB; production untouched by construction.
- **DoD:** reconcile exits 0 with the counts above pasted in the report; runbook contains the executed (not theoretical) procedure with timings; scratch DB deleted afterward (verified via `az cosmosdb sql database list` showing only `psat-prep-db`).

**⛔ GATE: WI-03 complete = "backup confirmed complete and restorable". Only now may any other work item start.**

---

#### WI-04 — Close the nightly-backup gaps (scope + silent failure)

- **Objective:** (a) extend `performCosmosBackup` to also export the `Questions` container into the nightly payload (adds ~5 MB — fine); (b) make failures loud: on any backup error, write a `backup_FAILED_<ts>.json` marker blob to `cosmos-backups` and expose `GET /api/backup-status` returning `{lastSuccessAt, lastAttemptAt, ageHours, healthy}` computed from blob listing; (c) surface backup freshness in `parent.html`'s existing Data Management section: green if < 26 h, red warning banner otherwise (a real measurement, labeled — never a hardcoded "backed up ✓"); (d) retention: keep all backups ≤ 30 days plus one per week thereafter, implemented as a dry-run-default prune script, **never** auto-deleting from the timer.
- **Dependencies:** WI-03 (a verified restore exists before touching backup code).
- **Touches:** `api/src/functions/backup.js`, new `api/src/functions/backupStatus.js`, `parent.html` (status widget only), new `scripts/prune_backups.js`, `docs/DISASTER_RECOVERY_RUNBOOK.md`.
- **Data safety:** run `scripts/preflight_backup.sh` (WI-05 — if not yet merged, run `node scripts/backup_cosmos.js`) before deploying the function change. Deploy to `psat-api-4915` is the risky step: `/api/sync` must be verified live immediately after (GET returns the master doc with 406 progress keys). The prune script requires `--apply` and refuses to delete the newest 7 backups regardless of policy.
- **Verification:** trigger `POST /api/backup` after deploy; verify new payload contains `questions` array with 3,059 docs and restore dry-run still accepts the format (backward compatibility with old payloads required — `restore_cosmos.js` `extractBackupDocuments` must handle both). Failure path: temporarily point the function at a bogus DB name in a local `func start`, confirm the FAILED marker logic executes. Update `tests/test_backup_restore.js` accordingly (red first).
- **Rollback:** redeploy previous function app package (keep the pre-change `func azure functionapp publish` package zip; `app-packages` container retains prior releases).
- **DoD:** live `GET /api/backup-status` returns `healthy: true` with `ageHours < 26`; next nightly (or manual) backup blob contains `questionsCount: 3059` in metadata; `node tests/test_backup_restore.js` exits 0; live `/api/sync` GET returns 406 progress keys after deploy.

---

#### WI-05 — Recurring cadence + per-work-item preflight gate

- **Objective:** codify the backup cadence for the refactor: nightly cloud timer (exists) + `scripts/preflight_backup.sh` that (1) calls `POST https://psat-api-4915.azurewebsites.net/api/backup`, (2) polls `cosmos-backups` for the new blob, (3) downloads + checksum-verifies it, (4) prints the blob name for the work-item report; and a weekly `scripts/weekly_restore_check.sh` wrapping WI-03's scratch-restore in one command. Document the rule: preflight before merging any item touching `api/`, storage, sync, or deploy scripts; weekly restore check during the whole refactor.
- **Dependencies:** WI-03, WI-04.
- **Touches:** new `scripts/preflight_backup.sh`, `scripts/weekly_restore_check.sh`, `CLAUDE.md` (add the gate to "Before you commit"), `docs/DISASTER_RECOVERY_RUNBOOK.md`.
- **Data safety:** both scripts read-only on prod data (backup endpoint is server-side read + blob write).
- **Verification:** run both for real; paste outputs (preflight: blob name + checksum OK; weekly check: reconcile counts).
- **Rollback:** n/a.
- **DoD:** both scripts exit 0 against live Azure; `CLAUDE.md` contains the gate text; every subsequent work item's completion report cites a preflight backup blob name.

---

### Phase 1 — Guardrails (before any refactor code)

---

#### WI-06 — Parallel deployment lane `/v2/` + decoupled deploy scripts

- **Objective:** create the isolation prod currently lacks. (a) New `scripts/deploy_v2.sh`: uploads `index.html, parent.html, mistakes.html, feedback.html, srs.js, js/**, styles/**` from the working tree to `$web/v2/` **only** (with `no-cache` headers, as `promote_beta.sh` does). (b) Fix `promote_beta.sh`: it currently pushes identical files to prod root *and* `beta/` in one run and never deploys `data/` — split into `deploy_beta.sh` (beta only) and `promote_to_prod.sh` (prod root only, requires typed `PROMOTE`, runs full test suite, and now also checks deployed-vs-local `data/questions_data.js` byte size and warns on drift). (c) v2 client sends `client_version: "v2-<git-sha>"` in the sync POST body (additive field; `sync.js` server ignores unknown fields — verify, don't assume). `/v2/` initially contains a byte-copy of the current app (proves the lane before any refactor lands in it).
- **Dependencies:** WI-05 (gate exists). Blocks all Phase 2+ items.
- **Touches:** new `scripts/deploy_v2.sh`, `scripts/deploy_beta.sh`, `scripts/promote_to_prod.sh`; `promote_beta.sh` becomes a deprecation stub pointing at the new scripts; `srs.js` (client_version field only).
- **Data safety:** deploy scripts must refuse to write outside their prefix: `deploy_v2.sh` asserts every `--name` starts with `v2/`; `deploy_beta.sh` with `beta/`. Preflight backup before first `/v2/` deploy (v2 clients write to the same student doc). The `$web` root is untouched by everything except `promote_to_prod.sh`.
- **Verification:** deploy, then Playwright-free smoke: `curl -s https://psatprep4915.z13.web.core.windows.net/v2/index.html | head` returns the app; complete one practice question on `/v2/` as `?student=e2e_test_student` (or with sync pointed at the test student) and verify via Cosmos query that a `student_e2e_test_student` doc appears **and** `student_default_student.updatedAt` did not change from the test.
- **Rollback:** delete `$web/v2/*` blobs (prefix-scoped `az storage blob delete-batch --pattern 'v2/*'`); prod never touched.
- **DoD:** `/v2/` serves the app; `student_default_student` doc provably unmodified by the verification run (same `updatedAt`, same 406 progress count unless the real student practiced meanwhile — compare against a fresh pre/post read); the three new scripts refuse out-of-prefix writes in a deliberate negative test; sync POST from v2 stores `client_version` on the master doc.

---

#### WI-07 — Data-integrity & reconciliation suite

- **Objective:** the suite that proves "no data lost or corrupted" at every checkpoint. `tests/integrity/run_integrity.js` (Node, read-only against live Cosmos + latest backup blob) asserting: (1) doc counts per container match expectations (Questions = 3,059 exactly; UATStudentAnswers ≥ last recorded count — it only grows); (2) master doc schema: every progress entry has `{isCorrect, timestamp}`, every SRS card has valid SM-2 fields (`ease_factor ≥ 1.3`, `repetitions ≥ 0`), every examHistory entry has `examId`; (3) every `exam_session` doc's `examId` appears in master `examHistory` (no orphans) and vice-versa count check; (4) master doc size < 400 KB budget (alerts before the 2 MB Cosmos wall); (5) latest backup age < 26 h and checksum valid; (6) **merge-semantics pin tests** (unit, offline): replay `sync.js`'s merge functions on hand-written fixtures proving older-timestamp data never overwrites newer, sessions take max, exams dedupe — the contract that makes dual-version writing safe. Plus `tests/integrity/snapshot_diff.js`: given two backup files, print per-student progress/SRS/exam diffs (used at Phase gates and cutover).
- **Dependencies:** WI-05. Blocks Phase 2+.
- **Touches:** new `tests/integrity/*`; extracts `sync.js` merge functions into `api/src/lib/merge.js` (required so tests can import them — `sync.js` requires the lib; behavior identical, verified by fixture tests written red-first).
- **Data safety:** read-only on live data. The `merge.js` extraction touches the API → preflight backup + post-deploy live `/api/sync` GET check (406+ progress keys), same as WI-04.
- **Verification:** run against live: paste real output (counts 3059 / ≥10 / ≥0, orphans 0, master size ~228 KB, backup age). Red demonstration: feed `snapshot_diff.js` two fixtures differing by one attempt, confirm it reports exactly that attempt.
- **Rollback:** revert `merge.js` extraction commit; redeploy prior function package.
- **DoD:** `node tests/integrity/run_integrity.js` exits 0 against production with real numbers printed; merge pin tests exit 0; suite wired into `.github/workflows` for the offline parts and into `preflight_backup.sh` for the live parts.

---

#### WI-08 — Playwright harness + baseline E2E of the *current* app

- **Objective:** browser-truth regression floor before anything is refactored. Set up Playwright (chromium, mobile + desktop viewports) with: local static server fixture (`python3 -m http.server`), sync interception fixture that **routes `/api/sync` to `student_name=e2e_test_student` and hard-fails any request containing `default_student`**, and localStorage seeding helpers (empty-state and a hand-written 20-question fixture profile). Baseline specs against the current app: student practice flow (load → pick domain → answer MCQ correct/incorrect → rationale renders → free-response entry), SRS review queue, exam start/resume/finish (mini exam), analytics page renders real numbers from the fixture (and **zeros/em-dashes on empty state** — CLAUDE.md mode 1), parent portal (score gate honoured at <15/section, history, gap alerts), mistakes feed, feedback form (network-stubbed), every nav link on all four pages (crawl: no 404s, no console errors).
- **Dependencies:** WI-06 (also runs against deployed `/v2/` copy), WI-07 fixtures conventions.
- **Touches:** new `package.json` (dev-only; app itself stays dependency-free), `playwright.config.js`, `tests/e2e/**`, `.github/workflows/e2e.yml`.
- **Data safety:** the `default_student` interceptor fixture is the enforcement of §3's quarantine — it must be in the shared fixture file every spec imports, with a unit test proving it rejects.
- **Verification:** full suite green locally against current code twice (flake check), and against `https://…/v2/`. Red demonstration: rename one button id, watch the relevant spec fail, restore.
- **Rollback:** n/a (additive).
- **DoD:** `npx playwright test` exits 0 (2 consecutive runs) locally and against `/v2/`; spec count and per-page coverage table pasted in report; CI workflow runs it on PRs; interceptor negative-test present and green.

**⛔ GATE: Phases 2–4 may begin only when WI-01…WI-08 are all done.** (This satisfies the brief's mandated pre-UI sequence 1→5.)

---

### Phase 2 — Code architecture (in `/v2/`, behavior-frozen)

---

#### WI-09 — Extract inline JS into ES modules (no behavior change)

- **Objective:** move the ~5,100 inline JS lines out of the four HTML files into `js/pages/{student,parent,mistakes,feedback}.js` loaded via `<script type="module">`, extracting on the way every function duplicated between pages into shared modules (`js/shared/`). Produce, as a deliverable, the duplication ledger: `grep`-derived list of every rule found in 2+ pages (score gating, storage access, formatting, thresholds) and the single module each now lives in — CLAUDE.md mode 2 requires stating "how many sites found and changed".
- **Dependencies:** WI-08 (the safety net this item leans on). Do the four pages as four sequential sub-steps, running the full Playwright baseline after each.
- **Touches:** `index.html`, `parent.html`, `mistakes.html`, `feedback.html` (v2 lane), new `js/pages/*`, `js/shared/*`. Does **not** touch `srs.js` (WI-10) or storage semantics (WI-11).
- **Data safety:** no storage/sync logic changes — mechanical relocation only. localStorage keys and payloads byte-identical (assert via a Playwright spec that dumps localStorage after a scripted session and deep-equals it against the same session on the pre-refactor build).
- **Verification:** full Playwright baseline green after each page; the localStorage-equivalence spec green; `node tests/test_html_syntax.js` and all existing suites green.
- **Rollback:** each page is one commit; revert the page's commit and redeploy `/v2/`.
- **DoD:** zero `<script>` blocks containing logic in the four HTML files (inline bootstrap of ≤5 lines allowed); duplication ledger in the PR description with before/after counts; all suites + Playwright green; deployed to `/v2/` and spot-checked live.

---

#### WI-10 — Decompose `srs.js` behind a compatibility facade

- **Objective:** split the 3,429-line `srs.js` into `js/engine/{grading,scheduler,examgen,scoring,storage,sync}.js` with `srs.js` remaining as the UMD facade re-exporting the same public API (`PSAT_ENGINE.*` unchanged), so all 11 existing Node suites and all page code keep working unmodified.
- **Dependencies:** WI-09.
- **Touches:** `srs.js`, new `js/engine/*`. Public API frozen — enforced by a new `tests/test_engine_api_surface.js` that asserts the exported symbol list (hand-written) is unchanged.
- **Data safety:** no semantic changes; `CLOUD_SYNC_ENDPOINT` and storage keys untouched.
- **Verification:** all existing suites green *unmodified* (they are the contract); API-surface test written red-first (delete an export, watch fail); Playwright baseline green; real-data run: generate one adaptive full mock + one filtered drill from `data/questions_data.js` and paste question counts (RW 27+27, Math 22+22, filter counts) matching a pre-refactor run of the same seeds.
- **Rollback:** revert; facade means callers never knew.
- **DoD:** suites green with zero test-file edits; API-surface test green; pre/post real-data generation outputs identical; `/v2/` deployed and Playwright green against it.

---

#### WI-11 — Storage & sync hardening (bounded documents, append-only attempts)

- **Objective:** implement roadmap §1 to stop the 228 KB master-doc growth (root cause 6): (1) versioned envelope `{schemaVersion: 2, …}` for local + synced state; (2) SRS history capped at 20 events/question with durable summary counters (total reviews/lapses, first/last timestamps); (3) attempts stored as append-only records with stable ids; sync sends only unsynced deltas via the existing outbox, server continues field-level merge (v1 clients unaffected — the merge is per-key, so a delta post merges identically to a full post); (4) every destructive local action (import/reset/demo) snapshots first and aborts if the snapshot fails (extends existing transactional-safety code, verified not regressed); (5) migration: on first v2 load, migrate local state 1→2 non-destructively (keep `psat_*_v1_backup` copies); server documents need **no** migration (v2 fields are additive).
- **Dependencies:** WI-10 (engine modules exist), WI-07 (merge pins protect this work).
- **Touches:** `js/engine/storage.js`, `js/engine/sync.js`, possibly `api/src/lib/merge.js` (only if a new field needs merge policy — any change re-runs the pin tests), `srs.js` facade.
- **Data safety:** **highest-risk item in the plan.** Preflight backup mandatory. The live student keeps using prod (v1) while this soaks on `/v2/` with `e2e_test_student` — the shared master doc is only touched by v2 once WI-18's parallel-run starts. Migration must be idempotent and reversible (v1 backup keys). Server-side: no document deletion anywhere; caps apply to *new* writes, and the one-time compaction of the existing 392-card history runs only after a named preflight backup and only via a dry-run-default script.
- **Verification:** unit tests (red-first) for cap, summaries, envelope migration both directions, outbox replay-once; integrity suite (WI-07) green with master-doc-size trend printed; simulated 3,059-question completion (script driving `recordAttempt` over the full bundle) keeps master doc < 400 KB — paste the measured size; Playwright: interrupted-sync spec (kill network mid-session, reload, verify each attempt stored exactly once).
- **Rollback:** v2 lane revert + local v1 backup keys; server data needs no rollback (nothing deleted).
- **DoD:** full-bank simulation prints final doc size < 400 KB; all integrity + merge pins + Playwright green; `e2e_test_student` doc on live Cosmos shows `schemaVersion: 2` with correct summaries after a scripted live session; `default_student` doc byte-untouched (verified by pre/post `_etag` comparison during the test window).

---

### Phase 3 — Design system & UI migration (in `/v2/`)

---

#### WI-12 — Design tokens + component library + reference page

- **Objective:** build §2.2: `styles/tokens.css`, `styles/components.css` (absorbing `buttons.css`), `js/components/` render helpers (statCard, banner, modal, progressBar, questionCard, navTabs, emptyState, dataTable), and `/v2/design.html` — a reference page rendering every component in every state (including empty/loading/error) that doubles as the Playwright visual-truth target. Self-host a pinned Chart.js; define the chart color tokens here too.
- **Dependencies:** WI-09 (pages are modular so components can be adopted incrementally). Can run parallel to WI-10/11.
- **Touches:** new `styles/tokens.css`, `styles/components.css`, `js/components/*`, `/v2/design.html`, `vendor/chart.min.js`.
- **Data safety:** none (presentation only); components must render `null` metrics as an explicit empty state, never a fabricated number (CLAUDE.md mode 1 — statCard's API takes `{value: number|null, label, isEstimate: bool}` and *renders "—" for null by construction*).
- **Verification:** Playwright spec loads `design.html`, asserts every component present, screenshots archived as the visual baseline; axe-core accessibility pass (contrast on tokens); statCard unit test: `value: null` renders "—" (red-first).
- **Rollback:** additive; nothing depends on it until WI-13.
- **DoD:** `design.html` deployed on `/v2/`, spec green, contrast checks pass, component inventory table in report.

---

#### WI-13 — Student portal rebuild on the design system

- **Objective:** rebuild `index.html` + `js/pages/student.js` on the WI-12 system with the four-tab IA (**Practice · Review · Exams · My Progress**). All existing student features map in: practice modes (domain/skill/difficulty filters, visual-card/text toggle), SRS queue, exam start/resume, high-yield mode, analytics (skills mastered, focus areas, skill-gap breakdowns from question metadata), rationale rendering, math tools/reference sheet. Tailwind Play CDN removed from this page. Clutter reduction by grouping and progressive disclosure only — the feature-parity checklist (every capability above, enumerated in the PR) is the contract that nothing is dropped.
- **Dependencies:** WI-11, WI-12.
- **Touches:** `index.html`, `js/pages/student.js`, `js/components/*` (additions allowed only via WI-12's reference page pattern).
- **Data safety:** reads/writes only through `js/engine/storage.js`; no new storage keys.
- **Verification:** extend Playwright: every tab, every filter combination class, full practice loop, SRS grade paths (1/3/4/5 via timing control), exam resume after reload, empty-state (fresh profile shows no non-zero number anywhere — automated by scanning rendered text for digits in stat components), analytics numbers cross-checked against a hand-computed fixture profile.
- **Rollback:** `/v2/` page-level revert + redeploy; prod untouched.
- **DoD:** feature-parity checklist 100% checked with the spec name covering each line; Playwright student suite green (2 runs); no `cdn.tailwindcss.com` reference; Lighthouse perf ≥ 90 on `/v2/index.html` (bundle is the dominant cost; must not regress vs current).

---

#### WI-14 — Parent portal rebuild on the design system

- **Objective:** rebuild `parent.html` + `js/pages/parent.js` with the five-tab IA (**Overview · Score & History · Mistakes & Action Plan · Exam Builder · Data & Backups**). Feature parity contract: projected score (labeled **Practice score estimate** with confidence interval per roadmap §2 — never "Official"; `MIN_PER_SECTION = 15` gate rendered as "—" below threshold), RW vs Math mastery breakdown, full test history (dates, duration, scores), knowledge-gap alerts, SRS due tracker, exam builder (standard adaptive full mock + filtered non-adaptive drills), data management (export/import/restore snapshots, backup freshness from WI-04). Every threshold imported from `js/engine/scoring.js` — zero display rules defined in this page (mode-2 elimination made checkable: `grep -c 'MIN_PER_SECTION\|>= *15' parent.html js/pages/parent.js` must hit only imports).
- **Dependencies:** WI-11, WI-12 (parallel with WI-13 allowed; whichever lands second resolves component collisions via WI-12's page).
- **Touches:** `parent.html`, `js/pages/parent.js`.
- **Data safety:** read-mostly; Data & Backups tab's destructive actions (import/reset) go through WI-11's snapshot-first transactional path, with confirm dialogs stating what is **erased** (mode 7 wording rule).
- **Verification:** Playwright: score gate at 14-vs-15 attempts per section boundary (fixture-driven, hand-computed expected values), history table matches fixture exams, exam builder produces a mock whose module sizes are asserted (27/27/22/22), export→wipe→import round-trip restores identical localStorage, backup-freshness widget shows red when the stubbed status endpoint reports stale.
- **Rollback:** `/v2/` page-level revert.
- **DoD:** parity checklist 100%; Playwright parent suite green (2 runs); grep proves no inline thresholds; no Tailwind CDN reference.

---

#### WI-15 — Mistakes & feedback pages rebuild

- **Objective:** rebuild `mistakes.html` (mistakes feed, root-cause/error-tag display, targeted action plan with drill launch into the student portal) and `feedback.html` (form → `/api/feedback`) on the design system. Removes the last Tailwind CDN references from the app.
- **Dependencies:** WI-13 (links into student drill flow), WI-12.
- **Touches:** `mistakes.html`, `feedback.html`, `js/pages/{mistakes,feedback}.js`.
- **Data safety:** mistakes page is read-only over progress data; feedback POST unchanged.
- **Verification:** Playwright: feed renders hand-written fixture mistakes with correct root-cause tags, action-plan links launch the right drill (deep-link params asserted), feedback submit success + failure paths (stubbed 200/500 — the 500 path must show a visible error, mode 5), empty states clean.
- **Rollback:** `/v2/` page-level revert.
- **DoD:** Playwright suites green (2 runs); zero `cdn.tailwindcss.com` occurrences repo-wide in v2 pages (`grep -r cdn.tailwindcss v2-pages` = 0); parity checklist 100%.

---

### Phase 4 — Feature verification & parallel run

---

#### WI-16 — Adaptive full-mock verification matrix + blueprint/config extraction

- **Objective:** make the existing MST implementation provably correct. (a) Move routing thresholds, module blueprints (domain/skill/difficulty/type mix), and score-conversion curves from inline constants in `js/engine/examgen.js`/`scoring.js` into `js/engine/config/adaptive_config.js` (versioned, documented — roadmap §2.5); label curves in UI copy as estimates (they are hand-authored, not College Board published tables — mode 1). (b) Test matrix against the **real bundle**: for module-1 performance profiles {0%, 25%, 55%, 58% boundary ±1 question, 75%, 100%} × {RW, Math}, assert the served module 2 is the correct difficulty pool, module sizes are 27/27 RW and 22/22 Math, no question repeats across modules, free-response mix per blueprint, and the scaled score is computed from the adaptive path taken (hand-computed expected scores for at least 4 profiles). (c) Playwright: one full adaptive mock driven end-to-end in the browser per routing branch (upper/lower × RW/Math), asserting the module-2 header and final report show the routed path.
- **Dependencies:** WI-10 (engine modules), WI-13/14 (UI hosts the flows).
- **Touches:** `js/engine/examgen.js`, `js/engine/scoring.js`, new `js/engine/config/adaptive_config.js`, `tests/test_adaptive_routing.js`, `tests/e2e/adaptive.spec.js`.
- **Data safety:** none server-side; exam reports written via standard attempt path.
- **Verification:** real-data run pasted: pool sizes per difficulty track from `data/questions_data.js`, all matrix cells green; red demonstration on the 58% boundary test (shift threshold, watch fail).
- **Rollback:** config module revert restores prior constants byte-for-byte (assert in test).
- **DoD:** `node tests/test_adaptive_routing.js` exits 0 with matrix table printed; Playwright adaptive specs green; config file documents every constant's provenance; UI labels verified by spec ("estimate" string present on score display).

---

#### WI-17 — SRS, analytics, and score-projection parity suites

- **Objective:** deep-verify the remaining learning-science paths on v2: SM-2 progression E2E (a question graded 5 today is due at the right future date — clock injected via test parameter, never monkeypatched), review-queue ordering, analytics correctness (skills mastered / focus areas / gap breakdown computed from a 60-attempt hand-designed fixture where expected outputs are hand-calculated), projection confidence bands react to sample size, and cross-portal consistency: the same fixture renders **identical numbers** on student "My Progress" and parent "Overview" (the automated twin-drift check — mode 2 as a permanent regression test).
- **Dependencies:** WI-13, WI-14.
- **Touches:** `tests/e2e/srs_progression.spec.js`, `tests/e2e/analytics_parity.spec.js`, fixtures.
- **Data safety:** all against local server + `e2e_test_student`.
- **Verification:** hand-computed expectation tables committed beside the fixtures; red-first on at least the parity spec (skew one page's rendering, watch fail).
- **Rollback:** n/a (additive).
- **DoD:** suites green (2 runs); parity spec compares ≥ 12 rendered metrics across portals with 0 mismatches.

---

#### WI-18 — Parallel-run reconciliation & migration proof for the live student

- **Objective:** the brief's "validate against production data before cutover". (a) Take a fresh full backup (preflight). (b) Read-only validation pass: load `/v2/` portals against the **real** `default_student` cloud data in read-only mode (sync GET allowed, POST disabled via a `?readonly=1` flag added for this purpose and default-off) and assert: all 406+ progress entries render, 392+ SRS cards schedule correctly, all 9+ exams appear in history with correct scores, analytics/mistakes/score views populated and consistent with prod's rendering of the same data (side-by-side Playwright run against prod root and `/v2/`, comparing extracted metric values). (c) Then begin the live parallel-run window (≥ 5 school days): the student keeps using **prod**; each day, `tests/integrity/run_integrity.js` + `snapshot_diff.js` versus the day-prior backup must show only legitimate growth (new attempts), zero disappearances. (d) Migration proof: in a scratch browser profile, pull `default_student` from cloud into v2, run the WI-11 v1→v2 local migration, and reconcile every record (script prints per-category counts: progress 406+/406+, SRS 392+/392+, exams 9+/9+, mismatches 0).
- **Dependencies:** WI-11…WI-17 all complete; Playwright + integrity suites fully green.
- **Touches:** `js/engine/sync.js` (`readonly` flag), `tests/e2e/parallel_run.spec.js`, `scripts/migration_proof.js`, daily integrity reports committed under `docs/parallel_run/`.
- **Data safety:** POST-disabled mode is enforced client-side **and** verified by network capture in the spec (zero sync POSTs recorded). The migration proof never syncs back (readonly + interceptor). `default_student` server doc `_etag` recorded before/after each session and compared.
- **Verification:** side-by-side metric comparison table (prod vs v2, real data) pasted in report — every number identical or explained; daily diffs archived; migration-proof output pasted.
- **Rollback:** n/a (read-only by construction).
- **DoD:** ≥ 5 consecutive daily integrity reports with zero anomalies; side-by-side comparison 0 unexplained mismatches on live data; migration proof prints 0 mismatches; `_etag` checks confirm zero writes to `default_student` from any validation activity.

---

### Phase 5 — Cutover (human-executed)

---

#### WI-19 — Cutover gate, promotion, and rollback path

- **Objective:** package the go/no-go decision. The coordinating agent assembles the **cutover gate report**: full Playwright suite (all specs, 2 consecutive green runs, run count and list), data-integrity suite green against live prod, WI-18 parallel-run evidence, feature-parity checklists (WI-13/14/15) all 100%, fresh preflight backup blob name + restore-verified date (must be ≤ 7 days old — rerun `weekly_restore_check.sh` if older), and explicit confirmation of coverage sufficiency. The human then: (1) runs `scripts/preflight_backup.sh`; (2) runs `scripts/promote_to_prod.sh` which now promotes **the v2 tree** to `$web` root (after a typed `PROMOTE`); (3) smoke-checks prod as the real student would; (4) keeps `/v2/` live as the canary twin. Rollback: `scripts/rollback_prod.sh` re-uploads the pre-cutover prod files from the git tag `pre-cutover-<date>` (created by the promote script before uploading) — data needs no rollback because both versions share the same documents and the merge semantics are non-destructive; a rolled-back client simply resumes reading the same Cosmos state.
- **Dependencies:** WI-18 gate passed.
- **Touches:** `scripts/promote_to_prod.sh` (v2-tree promotion + pre-cutover git tag + `$web` root file archive to `refactor-baseline/pre_cutover_<ts>/`), new `scripts/rollback_prod.sh`, `docs/CUTOVER_REPORT.md`.
- **Data safety:** preflight backup immediately before; pre-cutover `$web` root archived to blob before overwrite; `data/` untouched by promotion (verified byte-size check stays in the script).
- **Verification:** rollback script **rehearsed against `/beta/`** before the real day (promote v2 to beta, roll beta back, diff restored files against git tag — 0 diffs).
- **Rollback:** is the deliverable; rehearsal proves it.
- **DoD:** `docs/CUTOVER_REPORT.md` complete with every gate item checked and evidence-linked; rollback rehearsal output (0 diffs) pasted; human sign-off recorded; post-cutover: 48 h of green daily integrity reports, then the refactor is closed.

---

## 6. Sequencing

```
Phase 0 (serial):   WI-01 → WI-02 → WI-03 ⛔ → WI-04 → WI-05
Phase 1:            WI-06 → WI-07 → WI-08 ⛔        (06 before 07's API touch; 08 last)
Phase 2 (serial):   WI-09 → WI-10 → WI-11
Phase 3:            WI-12 (may start parallel to WI-10/11) → WI-13 ∥ WI-14 → WI-15
Phase 4:            WI-16 ∥ WI-17 → WI-18 (≥ 5-day window)
Phase 5:            WI-19 (human)
Recurring:          nightly cloud backup (verified by /api/backup-status)
                    preflight_backup.sh before merging any item touching api/, storage, sync, deploys
                    weekly_restore_check.sh every 7 days until closure
```

This satisfies the mandated pre-UI order: backup+restore-verify (WI-02/03) → cadence (WI-04/05) → parallel branch on same Cosmos (WI-06) → data-integrity suite (WI-07) → Playwright baseline of existing app (WI-08) → only then UX work.

## 7. Standing rules for every sub-agent (inherited into each work item)

1. `CLAUDE.md` is binding — especially: run the real code path on the real dataset and paste real numbers; no invented numbers in any UI; grep for every twin site of a rule; verify fields against the data; watch every new test fail first; every `catch` recovers or reports; destructive actions back up first.
2. Never write to Cosmos `student_default_student` or any `exam_*` doc from tests or tooling. Never deploy to `$web` root (WI-19's human step excepted). Never delete any blob in `cosmos-backups` or `refactor-baseline`.
3. Every completion report states: preflight backup blob name (when required), suites run with pass counts, real-data numbers observed, and any clause of the work item **not** satisfied — an honest gap flagged beats a silent one shipped.
4. Question content is frozen: `data/*.json`, `data/questions_data.js`, `data/images/**` unmodified throughout (verify with `git diff --stat` in every PR).
5. **Renaming policy (authorized by the owner):** rename folders, files, functions, and variables freely where it clarifies — inside the work item that owns the code, with every call site updated and grep-verified in the same commit. **Exception — live data contracts are never renamed:** Cosmos container names (`UATStudentAnswers` is a known misnomer and stays — a container "rename" is a data migration), Cosmos document ids/fields, localStorage keys (`psat_*`), and blob container names. Renaming any of those is a migration, not a rename, and needs its own explicitly approved work item.

## Appendix A — Verification quick-reference (live values as of 2026-08-29)

```bash
# Cosmos doc counts (expect 3059 / ≥10 / ≥0)
az cosmosdb keys list --name psat-cosmos-15958 --resource-group rg-psat-prep \
  --query primaryMasterKey -o tsv   # then query via api/node_modules/@azure/cosmos

# Image blob count (expect 3059)
az storage blob list --account-name psatprep4915 --account-key "$AK" \
  --container-name '$web' --prefix 'data/images/' --num-results '*' --query 'length(@)' -o tsv

# Bundle drift (deployed vs local; expect equal — 6,080,994 bytes today)
az storage blob show --account-name psatprep4915 --account-key "$AK" --container-name '$web' \
  --name 'data/questions_data.js' --query properties.contentLength

# Latest backup age (expect < 26 h)
az storage blob list --account-name psatprep4915 --account-key "$AK" --container-name cosmos-backups \
  --query 'reverse(sort_by([],&properties.lastModified))[0].{n:name,t:properties.lastModified}'

# Live student doc sanity (expect ≥406 progress keys, growing only)
curl -s 'https://psat-api-4915.azurewebsites.net/api/sync?student_name=default_student'

# Full local suite (all green as of this plan's date)
for t in tests/test_*.js; do node "$t" || break; done && python3 -m unittest test_extractor.py
```

## Appendix B — Sub-agent model assignment

Principle (revised 2026-08-29, owner request — reduce fable spend): **opus** for correctness-critical data/score work, large refactors, and anything deploying to live Azure (WI-03, 04, 06, 07, 09, 10, **11**, 13, 14, **16**) — WI-11 and WI-16 were originally fable and are downgraded to opus with extra-strict verification briefs and independent coordinator re-runs; **sonnet** for well-specified bounded engineering (WI-01, 02, 05, 08, 12, 15, 17); **haiku** only for repetitive report runs (WI-18 dailies). WI-18/19 are driven by the coordinating agent, with the human executing cutover. The coordinator reviews every completion report against the DoD and re-runs verification commands itself before the next item starts.
