# CONTINUE_HERE.md — Everything needed to resume this refactor on another machine

**Written:** 2026-08-30 · **Repo:** https://github.com/as17237/psat-prep · **Branch:** `main`

Read this file first, then `REFACTOR_PLAN.md` (the 20 work-item specs) and `REFACTOR_STATE.md` (per-item status + the storage finding). `CLAUDE.md` is binding on all code work — it encodes seven defect classes that shipped repeatedly in this project's history.

---

## 1. TL;DR — where things stand

A live PSAT 8/9 prep app (one real student, actively using it) is being refactored in place. **Production is healthy** and running a verified hotfix. All refactor work happens in a parallel `/v2/` lane that shares the same database; production is not touched until an explicit human cutover.

- **Done:** Phase 0 (backups + verified restore), Phase 1 (staging lane, integrity suite, browser tests), Phase 2 partial (inline-JS extraction, engine decomposition, storage v2), WI-12 (design system). An unplanned production hotfix (WI-08.5) was found, fixed and shipped.
- **Blocked/pending decision:** none — the storage architecture decision was made (option C, see §8).
- **In flight when this was written:** WI-11.5 (slim + shard the data model). **Its work is in a local git worktree and is NOT in this repo** — see §6.
- **Next up after WI-11.5:** WI-13 → WI-14 → WI-15 (portal rebuilds), then WI-16/17, then WI-18 (parallel run), then WI-19 (cutover — human).

---

## 2. What the app is

Static, dependency-free web app over **3,059 real PSAT 8/9 questions** (extracted from College Board PDFs; each question also has a rendered PNG "card" because math formulas are vector art, not text).

| Page | Audience | Purpose |
| :-- | :-- | :-- |
| `index.html` | Student | Practice, SRS review queue, exams, analytics |
| `parent.html` | Parent | Score projection, mastery, mistakes, test history, exam builder, data/backups |
| `mistakes.html` | Both | Mistakes feed with root-cause tags + targeted drills |
| `feedback.html` | Both | Feedback form |
| `design.html` | Dev | Design-system reference page (WI-12) |

Logic lives in ES modules: `js/pages/*` (per page), `js/shared/*` (cross-page helpers), `js/components/*` (render helpers), `js/engine/*` (6 UMD parts: grading, scheduler, scoring, storage, examgen, sync) behind the `srs.js` facade. Client state is `localStorage` (`psat_*` keys), synced to Cosmos DB via an Azure Function.

**No build step.** Serve with `python3 -m http.server 8080` and open `http://localhost:8080`.

---

## 3. Live cloud resources (exact names — do not guess)

Azure subscription: *Visual Studio Professional with MSDN* (`580d0d70-855b-45b2-b471-3024eefa2bb7`), resource group **`rg-psat-prep`**.

| Thing | Name / URL |
| :-- | :-- |
| Production site | https://psatprep4915.z13.web.core.windows.net/ |
| Staging lane (refactor) | https://psatprep4915.z13.web.core.windows.net/v2/ |
| Design reference | https://psatprep4915.z13.web.core.windows.net/v2/design.html |
| Beta lane (stale, known-broken images) | https://psatprep4915.z13.web.core.windows.net/beta/ |
| Storage account | `psatprep4915` — containers: `$web` (site + `data/images/` 3,059 PNGs + 6 MB question bundle), `cosmos-backups` (nightly), `refactor-baseline` (PRIVATE, the restore-verified snapshot) |
| Functions app | `psat-api-4915` — `/api/sync`, `/api/backup`, `/api/backup-status`, `/api/feedback` (all anonymous auth) |
| Cosmos DB | account `psat-cosmos-15958`, database `psat-prep-db` |

**Cosmos containers:**

| Container | Partition key | Contents |
| :-- | :-- | :-- |
| `Questions` | `/domain` | 3,059 question docs (mirror; the app actually loads questions client-side from the bundle) |
| `UATStudentAnswers` | `/student_name` | `student_default_student` = **THE LIVE STUDENT** · `student_e2e_test_student` = test identity · 9 immutable `exam_*` docs. ("UAT" is a historical misnomer; this is production data. Never renamed — a container rename is a data migration.) |
| `UATFeedback` | `/category` | Feedback submissions |

Live student's data as of 2026-08-30: **406 answered questions, 393 SRS cards, 9 exams, ~288 KB document**.

**No secrets are stored in this repo.** Every script fetches keys at runtime via `az` into environment variables (`AZURE_STORAGE_ACCOUNT`/`AZURE_STORAGE_KEY`, `COSMOS_KEY`). Never pass a key on a command line — a prior work item was corrected for exactly that.

---

## 4. Set up the new machine

```bash
git clone https://github.com/as17237/psat-prep.git
cd psat-prep

# 1. Azure CLI, logged in to the subscription above
az login
az account show --query name -o tsv        # expect the MSDN subscription

# 2. Node deps for the API SDK used by scripts (@azure/cosmos, @azure/storage-blob)
cd api && npm ci && cd ..

# 3. Dev deps for the browser test harness
npm ci
npx playwright install --with-deps chromium

# 4. Python deps (data pipeline + validator)
python3 -m pip install -r requirements.txt
```

**Verify the checkout is healthy (all of these should pass):**

```bash
# Node suites (unit + integration; ~17 files)
for t in tests/test_*.js; do node "$t" >/dev/null || echo "FAIL $t"; done; echo "node suites done"

# Offline integrity suites
node tests/integrity/test_merge_pins.js && node tests/integrity/test_snapshot_diff.js

# Python parser tests (7 pass + 2 skip without the PDFs, which are gitignored)
python3 -m unittest test_extractor.py

# Dataset validator — expect exactly: 3059 0 2158
python3 -c "import json; from validator import validate_dataset; \
  q=json.load(open('data/ela_questions.json'))+json.load(open('data/math_questions.json')); \
  r=validate_dataset(q); print(r['valid_count'], r['invalid_count'], r['text_complete_count'])"

# Bundle drift — must produce no diff
python3 rebuild_bundle.py && git diff --stat data/questions_data.js

# Browser suite (starts its own local server; ~3 min, 81 tests)
npx playwright test

# LIVE checks (need az login)
node tests/integrity/run_integrity.js       # 9 checks against production, expect INTEGRITY_SUITE_OK
./scripts/preflight_backup.sh               # takes + verifies a fresh cloud backup
```

Not in the repo (and not needed): the four source PDFs (`*.pdf`, gitignored, ~400 MB) and `backups/` (local snapshots; cloud backups are canonical). `data/images/` **is** tracked — all 3,059 PNGs are in git.

---

## 5. Work-item status

Legend: ✅ done & pushed · 🟠 landed but not accepted · 🔶 in flight · ⬜ not started

| # | Item | Status | Notes |
| :-- | :-- | :-- | :-- |
| WI-01 | Fix backup CLI | ✅ | `scripts/backup_cosmos.js` crashed on every run (undefined variable) |
| WI-02 | Full baseline snapshot | ✅ | `refactor-baseline/baseline_2026-08-29T14-09-29Z/` — 3059/10/0 docs + 3,059 images + bundle + MANIFEST, all checksummed, container private |
| WI-03 | Prove restore works ⛔gate | ✅ | Restored into scratch DB, 0 mismatches, red-demo caught a single corrupted doc, scratch torn down. Runbook §5 |
| WI-04 | Nightly backup gaps | ✅ | Now includes `Questions`; failure marker blobs; `/api/backup-status`; parent freshness widget; prune script (dry-run default) |
| WI-05 | Backup cadence gates | ✅ | `scripts/preflight_backup.sh`, `scripts/weekly_restore_check.sh`, CLAUDE.md gate block |
| WI-06 | `/v2/` parallel lane | ✅ | Lane-asserted deploy scripts; `promote_beta.sh` (which deployed prod+beta together) split into `deploy_beta.sh` + `promote_to_prod.sh` |
| WI-07 | Data-integrity suite | ✅ | `api/src/lib/merge.js` extracted + 38 pins + 20,000-case equivalence; `tests/integrity/run_integrity.js` |
| WI-08 | Playwright harness | ✅ | First real-browser coverage. **Found 5 production defects** |
| WI-08.5 | Production hotfix | ✅ | Crash-class defects from an earlier UI pass; **promoted to prod by the owner**; prod verified fixed |
| WI-09 | Extract inline JS | ✅ | 5,361 lines → ES modules; duplication 57→31 sites; localStorage-equivalence proof |
| WI-10 | Decompose `srs.js` | ✅ | 6 engine parts behind a facade; 56-symbol API frozen by test; exam generation byte-identical |
| WI-11 | Storage/sync hardening | 🟠 | Code landed and green, **not accepted** — its own simulation shows the data model still breaks the Cosmos 2 MB ceiling (see §8). Its `api/src/functions/sync.js` change is committed but deliberately **not deployed** |
| WI-11.5 | Slim + shard data model | 🔶 | **See §6 — in a local worktree, not in this repo** |
| WI-12 | Design system | ✅ | tokens.css, components.css, 8 render helpers, `design.html`, self-hosted Chart.js 4.5.1 |
| WI-13 | Student portal rebuild | ⬜ | 4-tab IA on the design system |
| WI-14 | Parent portal rebuild | ⬜ | 5-tab IA. Also fix: 5 lucide icon `className` assignments have never applied (see `js/shared/dom.js` header) |
| WI-15 | Mistakes + feedback rebuild | ⬜ | |
| WI-16 | Adaptive exam verification | ⬜ | Routing matrix + config extraction |
| WI-17 | SRS/analytics parity suites | ⬜ | Includes the permanent student-vs-parent twin-drift test |
| WI-18 | Parallel run (≥5 days) | ⬜ | **Owner approval point** |
| WI-19 | Cutover | ⬜ | **Owner executes** |

---

## 6. ⚠️ In-flight work that is NOT in this repo

When this file was written, **WI-11.5 was running in an isolated git worktree** at `.claude/worktrees/agent-ae529bb717aa49097` (gitignored, machine-local). It had uncommitted edits to `api/src/functions/sync.js`, `scripts/simulate_full_bank.js`, `tests/integrity/run_integrity.js`, and `tests/integrity/snapshot_diff.js`, and **no commits**.

**That work does not exist on any other machine.** On the new machine, either:

- **(a)** Ask on the original machine for the worktree to be finished, verified, merged to `main` and pushed — then `git pull`; or
- **(b)** Re-run WI-11.5 from scratch using its full spec in `REFACTOR_PLAN.md` (search "WI-11.5 — Bound the data model"). Nothing is lost by doing this; the spec is complete and self-contained.

Check which applies: `git log --oneline | grep -i "WI-11.5"` — if nothing appears, the work is not here.

---

## 7. Hard safety rules (violating these is the only way to actually hurt the student)

1. **Never write to `student_default_student` or any `exam_*` document** — not from a test, not from a script, not "just once". Use `e2e_test_student`. The Playwright fixture (`tests/e2e/fixtures.js`) rewrites/hard-fails any request naming the live student; keep importing it in every spec.
2. **Never deploy to the `$web` root** except through `scripts/promote_to_prod.sh`, run by the owner. `/v2/` is the working lane (`scripts/deploy_v2.sh`).
3. **Run `./scripts/preflight_backup.sh` before merging anything touching `api/`, storage, sync, or a deploy script**, and cite the printed `PREFLIGHT_BACKUP_OK <file>`. Run `./scripts/weekly_restore_check.sh` weekly (a run without its red demonstration does not count).
4. **Never delete a blob** in `cosmos-backups` or `refactor-baseline`. Backups are additive forever.
5. **Question content is frozen**: `data/*.json`, `data/questions_data.js`, `data/images/**`. Every PR should show an empty `git diff --stat -- data/`.
6. **Live-data contracts are never renamed**: Cosmos container/document names and fields, `psat_*` localStorage keys, blob container names. Renaming anything else for clarity is encouraged (`REFACTOR_PLAN.md` §7 rule 5).
7. **Restore scripts hard-fail if the target database is `psat-prep-db`** — keep that assert; scratch work goes to `psat-prep-db-drtest`.

---

## 8. Decisions already made (do not re-litigate)

- **Storage architecture — option C, owner-approved 2026-08-30.** The single student document hits Cosmos' 2 MB hard limit at roughly 1,500–2,000 answered questions (measured: 3.29 MB projected at the full 3,059). WI-11's SRS history cap does **not** help — growth is per-entry size (577 B/progress entry, 495 B/SRS card), not history length. Fix = slim per-entry payloads **and** shard the document, with three acceptance criteria: no data loss (additive migration, legacy doc never deleted), the existing app keeps working (v1 clients untouched; server reassembles and still accepts full-state writes), and every document under 400 KB at full coverage. Spec: WI-11.5.
- **Design system** = self-hosted tokens + component CSS (no framework, no build). Rejected Vite+Tailwind as too much risk mid-refactor. See `REFACTOR_PLAN.md` §2.2.
- **The student's interrupted exam (2026-08-29) is written off** by owner decision. Only that exam's score report and history entry were lost; the per-question answers were saved before the crash and still feed analytics/SRS. Cloud history showing 9 exams is expected. **Do not reopen.**
- **Model assignment for sub-agents:** opus for correctness-critical/large/deploy work, sonnet for bounded work, haiku for repetitive runs. **No fable** — the owner is credit-constrained (`REFACTOR_PLAN.md` Appendix B).

---

## 9. How the work actually gets done (the process that has been working)

One sub-agent per work item, coordinated by a main session that never blindly trusts a report.

1. **Write the brief from the plan.** Each work item in `REFACTOR_PLAN.md` already has: objective, dependencies, files/containers touched, data-safety precautions, verification criteria, rollback, and a machine-verifiable definition of done. Paste the relevant context into the agent brief — agents start cold and cannot see this conversation.
2. **Always include in the brief:** the known deploy traps (§10), the safety rules (§7), "no background watchers — run synchronously and end with the report", and an explicit demand for red-first test evidence and real numbers.
3. **Verify independently before accepting.** Re-run the key checks yourself — live `curl` of the API, the suites, `git diff --stat` for scope, etag comparison on the live student doc. Several agent reports contained real errors caught this way.
4. **Commit per accepted item** with a descriptive message, then `git push origin main` (allowed by `.claude/settings.json`).
5. **Parallelism:** only with an isolated worktree (`isolation: "worktree"`), and only when the items don't share the `/v2/` deploy lane, the Playwright port, or the same files. Two agents on one tree already caused one accidental cross-commit.

---

## 10. Gotchas that have already bitten (put these in agent briefs)

- **`scripts/lib/deploy_common.sh` has `APP_FILES` + `assert_app_files_cover_js_tree()`** — any `js/`, `styles/`, or `vendor/` file on disk that is missing from `APP_FILES` hard-fails all three deploy scripts. Add new files there.
- **`scripts/deploy_v2.sh` pins exact counts**: currently **4** image-path rewrites and **5** page version-injections. Adding a page or moving image code changes these — recount and update the pin, with a per-file breakdown.
- **`tests/test_deploy_scripts.js` has a hand-written expected blob list** (`V2_EXPECTED_BLOBS`). Additive updates only; never weaken an assertion.
- **`tests/test_html_syntax.js` enforces structure**: no `function` inside inline `<script>` blocks, ≤5 lines per inline block, every page has a module entry.
- **Several Node suites parse page source** via `tests/helpers/page_source.js` (flattens the ES-module graph for `new Function`/`vm` sandboxes). If you move code between modules, update the loader — never the assertions.
- **ES modules are always strict mode.** Extraction from inline scripts surfaced a real crash (`SVGElement.className` is read-only) that sloppy mode had silently swallowed. See `js/shared/dom.js#setClassName`.
- **`az storage blob list` returns `properties.copy` as null unless you pass `--include c`** — this made one agent believe a completed 3,059-blob copy had never finished.
- **Azure `config-zip` deploys drop `WEBSITE_RUN_FROM_PACKAGE`/`ENABLE_ORYX_BUILD`** app settings (documented in runbook §6.5).
- **The Playwright config binds a fixed port** — never run two suites concurrently.
- **The date rolls over.** A localStorage-equivalence baseline keyed by calendar day broke at midnight; normalize date keys in comparisons.

---

## 11. Suggested next actions, in order

1. **Resolve WI-11.5** (§6): pull it if it was finished elsewhere, else re-run it from its spec. It is the highest-value remaining item — it removes the storage ceiling that will otherwise break saving for the student mid-course.
2. After it lands, do the steps it was fenced out of: deploy `/v2/`, run the full Playwright suite, deploy the API change with preflight + immediate live verification of `/api/sync` (expect ≥406 progress keys), and run `node tests/integrity/run_integrity.js`.
3. **WI-13 → WI-14 → WI-15** (portal rebuilds on the WI-12 design system). Never run WI-13/14 concurrently with data-model work.
4. **WI-16 ∥ WI-17**, then **WI-18** (≥5-day parallel run; owner approval), then **WI-19** (cutover; owner executes).
5. Housekeeping when convenient: raise `tests/integrity/expected_floor.json` after real growth (by hand, never automatically); decide whether to retire or fix the stale `/beta/` lane; delete the dead `copyShareableTestLink('custom')` branch in `parent.html`.

---

## 12. Quick reference

```bash
# Serve locally
python3 -m http.server 8080

# Deploy to the staging lane (never the root)
bash scripts/deploy_v2.sh

# Backup gate before risky merges
./scripts/preflight_backup.sh

# Weekly disaster-recovery drill (restore + red demo + teardown)
./scripts/weekly_restore_check.sh

# Live health of the student's data
curl -s 'https://psat-api-4915.azurewebsites.net/api/sync?student_name=default_student' \
  | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; \
    print('progress',len(d['progress']),'srs',len(d['srsState']),'exams',len(d['examHistory']))"

# Backup freshness
curl -s https://psat-api-4915.azurewebsites.net/api/backup-status

# Production promotion — OWNER ONLY, after the cutover gate
bash scripts/promote_to_prod.sh        # asks you to type PROMOTE
```

Key documents: `REFACTOR_PLAN.md` (specs) · `REFACTOR_STATE.md` (status + storage finding) · `CLAUDE.md` (binding rules) · `docs/DISASTER_RECOVERY_RUNBOOK.md` (backup/restore procedures, executed and timed) · `docs/FEATURE_AND_RELIABILITY_ROADMAP.md` (product intent behind WI-11).
