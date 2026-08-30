# CONTINUE_HERE.md — Complete continuation guide

**Written:** 2026-08-30 · **Repo:** https://github.com/as17237/psat-prep (branch `main`) · **Owner:** ashutosh.shukla@gmail.com

**This is the entry point.** Read this whole file before touching anything. Then: `REFACTOR_PLAN.md` (the 20 work-item specs), `REFACTOR_STATE.md` (per-item status detail), `CLAUDE.md` (**binding** coding rules — seven defect classes that shipped repeatedly here), `docs/DISASTER_RECOVERY_RUNBOOK.md` (executed, timed backup/restore procedures).

Written on the assumption that **the original machine is unavailable** and whoever reads this — a person or an agent — starts cold.

---

## 1. Situation in one paragraph

A live PSAT 8/9 prep web app, used daily by one real student, is being refactored in place. Production is healthy and running a verified hotfix. All refactor work happens in a parallel `/v2/` lane that reads and writes the **same** database, so there is no data fork and no migration risk; production is only replaced by an explicit human-run cutover at the very end. Phases 0–2 and the design system are complete (14 of 20 work items). Nothing is blocked. The next code work is the three portal rebuilds.

---

## 2. Where the question bank lives (nothing is on one machine any more)

**3,059 questions.** Every artifact exists in at least three independent places:

| Artifact | In git/GitHub | Azure `$web` | Cosmos | `refactor-baseline` snapshot |
| :-- | :--: | :--: | :--: | :--: |
| `data/ela_questions.json` (1,554 Q, 4,365,286 B) | ✅ | — | — | ✅ |
| `data/math_questions.json` (1,505 Q, 2,257,024 B) | ✅ | — | — | ✅ |
| `data/questions_data.js` (combined browser bundle, 6,080,994 B) | ✅ | ✅ | — | ✅ |
| `data/images/*.png` — **3,059 question cards** | ✅ (3,059 tracked) | ✅ (3,059 blobs) | referenced by URL | ✅ (3,059 copied) |
| `Questions` container (3,059 docs, mirror) | — | — | ✅ | ✅ |
| **Source PDFs** (ELA1, ELA1A, MATH1, MATH1A — 378 MB) | ❌ gitignored | — | — | ✅ **`source-pdfs/`** |

The source PDFs were **only on the original machine** until 2026-08-30, when they were uploaded to `refactor-baseline/source-pdfs/` (private container) with `SHA256SUMS.txt`:

```
edf66093017508b8643ed2bc47f88b17d95608001f72936372630e68984c7569  ELA1A.pdf   93,514,609 B
13837883ac9461e679fc09b9e990d4ae18a87d37b2eedb16d0ebb9f2659b9a75  ELA1.pdf    85,340,206 B
2bb96e846ba39ffa1647425e3179ea0dfaeab7b893a5d6e78f4718fe1aad9bea  MATH1A.pdf 130,586,448 B
603f63e5743f12fc152a0a6966bb99bd01a087b521cc62a812710a75d3ecda29  MATH1.pdf   86,688,993 B
```

Retrieve them only if you need to re-run extraction (you almost certainly do not — the extracted JSON and all 3,059 rendered cards are in git):

```bash
export AZURE_STORAGE_ACCOUNT=psatprep4915
export AZURE_STORAGE_KEY=$(az storage account keys list -g rg-psat-prep -n psatprep4915 --query '[0].value' -o tsv)
az storage blob download-batch --source refactor-baseline --pattern 'source-pdfs/*' --destination .
sha256sum -c source-pdfs/SHA256SUMS.txt
```

**Dataset invariants** (assert these after any data change — they are in `CLAUDE.md` too):

```bash
python3 rebuild_bundle.py && git diff --stat data/questions_data.js     # expect: no drift
python3 -c "import json; from validator import validate_dataset; \
  q=json.load(open('data/ela_questions.json'))+json.load(open('data/math_questions.json')); \
  r=validate_dataset(q); print(r['valid_count'], r['invalid_count'], r['text_complete_count'])"
# expect exactly: 3059 0 2158
```

**The real question record shape** — verify fields against the data, never from memory (this exact mistake produced an 88-question exam sold as 98):

```
id, assessment, test, domain, skill, difficulty,
type ("multiple_choice" | "free_response"),    ← NOT question_type
question_text,                                  ← NOT prompt
options: [ {key:"A", text:"…"}, … ],            ← ARRAY; look up with .find(o => o.key === letter)
correct_answer, rationale, has_image, question_image,
text_complete, rationale_letter_mismatch
```

Distribution: ELA 1,554 (Information and Ideas 452 · Craft and Structure 387 · Standard English Conventions 372 · Expression of Ideas 343). Math 1,505 (Algebra 577 · Advanced Math 375 · Problem-Solving and Data Analysis 361 · Geometry and Trigonometry 192). 2,694 multiple-choice + 365 free-response. Math is only 40% text-complete by design — formulas are vector art, so the rendered PNG card is the authority.

---

## 3. Live cloud resources (exact names — never guess)

Subscription *Visual Studio Professional with MSDN* `580d0d70-855b-45b2-b471-3024eefa2bb7`, resource group **`rg-psat-prep`**, region eastus.

| | |
| :-- | :-- |
| **Production** | https://psatprep4915.z13.web.core.windows.net/ |
| **Staging (`/v2/`)** | https://psatprep4915.z13.web.core.windows.net/v2/ |
| **Design reference** | https://psatprep4915.z13.web.core.windows.net/v2/design.html |
| **Beta (stale, images 404)** | https://psatprep4915.z13.web.core.windows.net/beta/ |
| **Storage account** | `psatprep4915` |
| **Functions app** | `psat-api-4915` |
| **Cosmos account / DB** | `psat-cosmos-15958` / `psat-prep-db` (serverless) |

**Blob containers on `psatprep4915`:**

| Container | Public? | Contents |
| :-- | :-- | :-- |
| `$web` | public (static site) | prod site at root, `beta/`, `v2/`, `data/images/` (3,059), `data/questions_data.js` |
| `cosmos-backups` | private | nightly + on-demand backups, `.sha256` sidecars, `cosmos_backup_latest.json` pointer, `backup_FAILED_*` markers |
| `refactor-baseline` | **private** | `baseline_2026-08-29T14-09-29Z/` (restore-verified snapshot: 3 Cosmos exports + 3,059 images + bundle + MANIFEST) · `source-pdfs/` · two superseded partial baselines (never delete) |
| `app-packages`, `function-releases`, `scm-releases` | private | Functions deployment packages — the rollback artifacts |

**Cosmos containers in `psat-prep-db`:**

| Container | Partition key | Contents |
| :-- | :-- | :-- |
| `Questions` | `/domain` | 3,059 question docs (mirror; the app loads questions client-side from the bundle, not from here) |
| `UATStudentAnswers` | `/student_name` | `student_default_student` = **THE LIVE STUDENT** · `student_e2e_test_student` = test identity · 9 immutable `exam_*` docs. "UAT" is a historical misnomer for production data; never renamed, because renaming a container is a data migration |
| `UATFeedback` | `/category` | Feedback submissions (currently 0) |

**API endpoints** (all `authLevel: anonymous`, base `https://psat-api-4915.azurewebsites.net`):

| Endpoint | Method | Behaviour |
| :-- | :-- | :-- |
| `/api/sync` | GET | Returns the composite student profile `{progress, srsState, sessionsState, examHistory, updatedAt}` — reassembled from master + shards + immutable exam docs |
| `/api/sync` | POST | Non-destructive **per-key merge** (newer-timestamp wins per question/card, max-wins per session, dedupe by examId) + writes immutable exam docs. Accepts both v1 full-state and v2 delta payloads |
| `/api/backup` | GET/POST | On-demand full backup → `cosmos-backups`; returns counts + sha256 |
| `/api/backup-status` | GET | `{lastSuccessAt, ageHours, healthy, failureMarkerCount, …}` — healthy = success < 26 h old and no newer failure marker |
| `/api/feedback` | POST | Writes a feedback doc |

**Secrets: none are in the repo.** Every script fetches keys at runtime via `az` into env vars (`AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_KEY`, `COSMOS_KEY`). Never pass a key on a command line — a work item was corrected for exactly that (it leaks into the process list).

---

## 4. Set up a new machine

```bash
git clone https://github.com/as17237/psat-prep.git && cd psat-prep

az login                                     # the MSDN subscription above
az account show --query name -o tsv

cd api && npm ci && cd ..                    # @azure/cosmos, @azure/storage-blob for scripts
npm ci                                       # dev-only: Playwright
npx playwright install --with-deps chromium
python3 -m pip install -r requirements.txt   # pypdfium2, Pillow — only needed for extraction
```

**Health check — every one of these must pass:**

```bash
for t in tests/test_*.js; do node "$t" >/dev/null || echo "FAIL $t"; done   # 19 suites, silent = good
node tests/integrity/test_merge_pins.js && node tests/integrity/test_datamodel.js \
  && node tests/integrity/test_shard_routing.js && node tests/integrity/test_snapshot_diff.js
python3 -m unittest test_extractor.py        # 7 pass + 2 skip without PDFs
npx playwright test                          # 14 spec files, ~81 tests, ~3 min (starts its own server)
node scripts/simulate_full_bank.js           # storage-growth gate; must print PASS
node tests/integrity/run_integrity.js        # LIVE: 11 checks vs production (needs az login)
./scripts/preflight_backup.sh                # LIVE: fresh verified backup, prints PREFLIGHT_BACKUP_OK
```

Run the app locally: `python3 -m http.server 8080` → http://localhost:8080

---

## 5. Repository map

```
index.html parent.html mistakes.html feedback.html design.html   ← thin shells (markup + one module tag)
srs.js                        ← UMD facade; exposes the frozen 56-symbol window.PSAT_ENGINE
js/engine/    grading scheduler scoring storage examgen sync     ← 6 UMD parts (load order matters)
js/pages/     student parent mistakes feedback design            ← one controller per page
js/shared/    html env storage beta_sandbox questions drill math_tools dom
js/components/ statCard banner modal progressBar questionCard navTabs emptyState dataTable format
styles/       tokens.css components.css buttons.css
vendor/       chart.min.js (pinned 4.5.1, sha256 recorded in its header)
data/         ela_questions.json math_questions.json questions_data.js images/ (3,059 PNG)
api/src/functions/  sync backup backupStatus feedback            ← Azure Functions v4
api/src/lib/        merge datamodel shardsync backupCore          ← pure, unit-tested
scripts/            see §6
tests/              19 Node suites · tests/integrity/ (4) · tests/e2e/ (14 Playwright specs)
extractor.py validator.py extract_questions.py rebuild_bundle.py normalize_data.py
docs/DISASTER_RECOVERY_RUNBOOK.md  docs/FEATURE_AND_RELIABILITY_ROADMAP.md
```

**Engine load order** (dependencies are asserted at load; a missing part throws rather than exposing a partial API): `grading, scheduler, scoring, storage, examgen, sync`, then `srs.js`.

**localStorage keys** (live data contract — never rename): `psat_progress`, `psat_srs`, `psat_sessions`, `psat_exam_history`, `psat_active_exam_state`, plus `psat_*_v1_backup` migration copies.

---

## 6. Every script, and when to run it

| Script | Purpose | Safety |
| :-- | :-- | :-- |
| `scripts/preflight_backup.sh` | **Run before merging anything touching `api/`, storage, sync, deploys.** Triggers a cloud backup, verifies blob + sidecar + API sha256 all match, sanity-checks counts, runs the live integrity suite. Prints `PREFLIGHT_BACKUP_OK <file>` | read-only + backup |
| `scripts/weekly_restore_check.sh` | **Weekly.** Full drill: restore baseline → scratch DB → reconcile → corrupt one doc → prove it's caught → repair → reconcile → teardown. A run without the red demo doesn't count | scratch DB only |
| `scripts/deploy_v2.sh` | Deploy the working tree to `$web/v2/` | asserts every blob name starts `v2/` |
| `scripts/deploy_beta.sh` | Deploy to `$web/beta/` | asserts `beta/` prefix |
| `scripts/promote_to_prod.sh` | **OWNER ONLY.** Full suite → drift check → typed `PROMOTE` → deploys to `$web` root (`--yes` skips the prompt) | the only path to production |
| `scripts/backup_cosmos.js` | Local CLI backup → `backups/` (gitignored) | read-only on Cosmos |
| `scripts/restore_cosmos.js` | Restore a backup. **Dry-run by default**; `--apply` required; verifies checksum; snapshots live state first | never run `--apply` casually |
| `scripts/full_baseline_snapshot.sh` | Rebuild the complete baseline snapshot (Cosmos + images + bundle + manifest) | read-only, additive |
| `scripts/restore_baseline_to_scratch.js` | Restore the baseline into `psat-prep-db-drtest` | **hard-fails if target is `psat-prep-db`** |
| `scripts/reconcile_restore.js` | Deep-compare scratch DB vs the baseline export | read-only |
| `scripts/corrupt_one_doc.js` | Corrupt exactly one scratch doc for the DR red demo | scratch only, same guard |
| `scripts/migrate_to_shards.js` | WI-11.5 additive shard migration + rollback | dry-run default; `default_student` needs `--i-have-owner-approval-for-default-student` |
| `scripts/verify_shard_migration_scratch.js` | End-to-end shard proof against a scratch copy of real data | scratch only |
| `scripts/simulate_full_bank.js` | Storage-growth gate: drives all 3,059 questions + deep review pass + 50 mocks; fails if the cap stops engaging or any doc exceeds 400 KB | offline |
| `scripts/compact_srs_history.js` | Trim over-long SRS histories | dry-run default |
| `scripts/prune_backups.js` | Retention (keep ≤30 days + weekly) | dry-run default; refuses to delete the newest 7 |
| `scripts/export_questions_container.js` | Export the Cosmos `Questions` container | read-only |

---

## 7. Test inventory

**Node unit/integration (19 in `tests/`)** — run each with `node tests/<name>.js`:
`test_srs` (SM-2, exam generation, scoring, sync — the big one) · `test_free_response` · `test_dataset_free_response` (all 365 SPR items) · `test_scaled_score` (16 cases) · `test_engine_api_surface` (**56 frozen symbols**) · `test_storage_v2` · `test_components` · `test_html_syntax` (also enforces "no logic in inline scripts") · `test_buttons_and_interactions` · `test_ui_rendering` · `test_ui_simplifications` · `test_analytics_ux` · `test_math_tools_and_reference` · `test_backup_cli` · `test_backup_restore` · `test_backup_status` · `test_backup_status_widget` · `test_prune_backups` · `test_deploy_scripts`.

**Integrity (`tests/integrity/`)**: `test_merge_pins` (38 pins on the server merge contract) · `test_datamodel` (31, slim codec + reassembly on real data) · `test_shard_routing` (20, incl. hand-transcribed v1 compatibility) · `test_snapshot_diff` (21) · `run_integrity.js` (**live**, 11 checks) · `snapshot_diff.js` (tool).

**Playwright (`tests/e2e/`, 14 specs)**: `fixtures.js` (**the safety quarantine — import it in every spec**) · `interceptor-quarantine` (proves the quarantine hard-fails) · `practice-flow` · `srs-review-queue` · `exam-flow` · `analytics` · `parent-portal` · `mistakes-page` · `feedback-form` · `nav-crawl` · `known-defects` (canaries for the 5 defects found in prod) · `localstorage-equivalence` (no-behaviour-change proof) · `storage-v2` · `design-system` · `v2-smoke` (tagged `@v2smoke`, runs against the live `/v2/`).

**Test rules that are binding** (`CLAUDE.md` mode 4): write expected values **by hand**, never by reusing the code under test; **break the code and watch the test fail before making it pass**, and paste that red output; never monkeypatch time/randomness — pass them as parameters; tests must run on a clean clone.

---

## 8. Hard safety rules

1. **Never write `student_default_student` or any `exam_*` doc** — not from a test, script, or "just once". Use `e2e_test_student`. The Playwright fixture rewrites/hard-fails any request naming the live student.
2. **Never deploy to the `$web` root** except via `scripts/promote_to_prod.sh`, run by the owner.
3. **Preflight before merging** anything touching `api/`, storage, sync, or deploy scripts; cite `PREFLIGHT_BACKUP_OK <file>`. Weekly restore drill.
4. **Never delete a blob** in `cosmos-backups` or `refactor-baseline` — including superseded partial baselines.
5. **Question content is frozen**: `data/*.json`, `data/questions_data.js`, `data/images/**`. Every change should show an empty `git diff --stat -- data/`.
6. **Never rename live data contracts**: Cosmos container/doc names and fields, `psat_*` localStorage keys, blob containers. Renaming anything else for clarity is encouraged.
7. **Scratch DB only** for restore/migration experiments (`psat-prep-db-drtest`); the guard that refuses `psat-prep-db` must stay.
8. **Every number shown to a student or parent is a real measurement or is visibly labelled as not one.** No invented fallbacks — use `null` + a reliability flag, and render an em-dash. `MIN_PER_SECTION = 15` gates any score.

---

## 9. Work-item status (14 of 20 complete)

✅ done · 🟠 superseded · ⬜ not started

| # | Item | | Evidence |
| :-- | :-- | :-: | :-- |
| WI-01 | Fix backup CLI | ✅ | It crashed on every run (undefined variable) |
| WI-02 | Full baseline snapshot | ✅ | `baseline_2026-08-29T14-09-29Z`: 3059/10/0 docs + 3,059 images + bundle + MANIFEST, checksummed, private |
| WI-03 | Prove restore works ⛔ | ✅ | Scratch restore, 0 mismatches, red demo caught 1 corrupted doc, teardown verified. Runbook §5 |
| WI-04 | Nightly backup gaps | ✅ | Adds `Questions`; FAILED markers; `/api/backup-status`; parent freshness widget; prune script |
| WI-05 | Cadence gates | ✅ | preflight + weekly drill + CLAUDE.md gate |
| WI-06 | `/v2/` parallel lane | ✅ | Lane-asserted deploys; split the script that deployed prod+beta together; write-isolation proven by etag |
| WI-07 | Data-integrity suite | ✅ | `merge.js` extracted, 38 pins, 20,000-case equivalence, live suite |
| WI-08 | Playwright harness | ✅ | First real-browser coverage — **found 5 production defects** |
| WI-08.5 | Production hotfix | ✅ | Crash-class defects; **promoted to prod**; prod verified |
| WI-09 | Extract inline JS | ✅ | 5,361 lines → modules; duplication 57→31; localStorage-equivalence proof |
| WI-10 | Decompose `srs.js` | ✅ | 6 parts + facade; 56-symbol API frozen; generation byte-identical |
| WI-11 | Storage hardening | 🟠 | Envelope v2, summaries, delta sync, transactional restore — kept, but its growth claim was superseded by WI-11.5 |
| WI-11.5 | **Slim + shard** | ✅ | See §10 — the Cosmos ceiling is solved |
| WI-12 | Design system | ✅ | tokens + components + `design.html` + vendored Chart.js |
| WI-13 | Student portal rebuild | ⬜ | 4 tabs: Practice · Review · Exams · My Progress |
| WI-14 | Parent portal rebuild | ⬜ | 5 tabs: Overview · Score & History · Mistakes & Action Plan · Exam Builder · Data & Backups. Also fix 5 lucide icon `className` assignments that have never applied (`js/shared/dom.js` header) |
| WI-15 | Mistakes + feedback rebuild | ⬜ | |
| WI-16 | Adaptive exam verification | ⬜ | Routing matrix + config extraction |
| WI-17 | Parity suites | ⬜ | Includes the permanent student-vs-parent twin-drift test |
| WI-18 | Parallel run ≥5 days | ⬜ | **Owner approval point** |
| WI-19 | Cutover | ⬜ | **Owner executes** |

---

## 10. The data model, and the one thing still pending

**The problem that was solved (WI-11.5).** All student data lived in one Cosmos document. Cosmos hard-limits a document to 2 MB. Measured projection at full coverage: **4.33 MB — 2.06× over the wall**, reached at roughly 1,500–2,000 answered questions. The student is at 406.

**The fix, owner-approved as "option C":**

- **Slim** — drop only exactly-derivable fields (`answered`, `timesIncorrect`, `accuracyPercent`, SRS `questionId`/`dueAt`, duplicated newest-attempt fields) and shorten keys via one central table. The codec is **self-verifying**: it expands its own output and byte-compares before returning, falling back to storing the record verbatim rather than risk loss. Result on real data: progress **−64.8%** (306→108 B), SRS **−59.0%** (159→65 B), **0 fallbacks** across 798 records.
- **Shard** — `bucketOf(id) = FNV-1a-32(id) % 16` into `pshard_<name>_bNN` / `sshard_<name>_bNN` docs on the **same partition key**, so a full read stays one in-partition query. Full bank: **33 documents, largest 81 KB (3.9% of the wall)**.
- **Constraints held**: no data loss (additive; the legacy master map is frozen and never deleted); the existing app keeps working (**zero client changes** — it is entirely server-side; the server reassembles and still accepts v1 full-state writes); no wall.

Two real records in the live data would have been silently corrupted by a naive "recompute derivable fields" (`1b9fa866` has inconsistent counters; `q100` has `timesSeen: 0` and missing fields). Both are pinned as tests.

**⚠️ PENDING — the API is NOT deployed.** `api/src/functions/sync.js` and the new `api/src/lib/{datamodel,shardsync}.js` are merged into `main` but **not deployed to `psat-api-4915`**. Production still runs the previous handler, and behaves exactly as before. Deferred deliberately for owner approval because it changes how the live student's data is read and written.

**To deploy it when approved:**

```bash
./scripts/preflight_backup.sh                    # cite the OK line
# capture the current package first (rollback artifact):
az storage blob list --account-name psatprep4915 --container-name scm-releases -o table
cd api && zip -r ../api_deploy.zip . -x 'node_modules/*' && cd ..
az functionapp deployment source config-zip -g rg-psat-prep -n psat-api-4915 \
  --src api_deploy.zip --build-remote true
# IMMEDIATELY verify the live student's data is intact and identical:
curl -s 'https://psat-api-4915.azurewebsites.net/api/sync?student_name=default_student' \
  | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; \
    print('progress',len(d['progress']),'srs',len(d['srsState']),'exams',len(d['examHistory']))"
# expect at least: progress 406  srs 393  exams 9   (only ever grows)
node tests/integrity/run_integrity.js
```

Rollback: redeploy the previously captured package the same way (runbook §6.5). After deploy, the ordered follow-ups are: migrate `e2e_test_student` (`scripts/migrate_to_shards.js --student e2e_test_student --apply`), run Playwright, and only then consider the live student's migration — which needs its own explicit approval and the `--i-have-owner-approval-for-default-student` flag.

---

## 11. Decisions already made — do not re-litigate

- **Storage = option C** (slim + shard), owner-approved 2026-08-30. Delivered in WI-11.5.
- **Design system** = self-hosted tokens + component CSS, no framework, no build. Vite+Tailwind was considered and rejected as too much risk mid-refactor (`REFACTOR_PLAN.md` §2.2).
- **The student's interrupted exam (2026-08-29) is written off** by owner decision. Only that exam's score report and history entry were lost; the per-question answers were saved before the crash and still feed analytics and SRS. Cloud history showing 9 exams is expected, not a symptom. **Closed.**
- **Sub-agent models**: opus for correctness-critical/large/deploy work, sonnet for bounded work, haiku for repetitive runs. **No fable** — the owner is credit-constrained.
- **`UATStudentAnswers` keeps its misleading name** — renaming a Cosmos container means migrating live data for zero functional gain.

---

## 12. How the work gets done

One sub-agent per work item, coordinated by a session that verifies rather than trusts.

1. **Brief from the plan.** Each item in `REFACTOR_PLAN.md` has objective, dependencies, exact files/containers, data-safety precautions, verification criteria, rollback, and a machine-verifiable definition of done. Agents start cold — paste the context in; they cannot see prior conversation.
2. **Always include**: the safety rules (§8), the traps (§13), "no background watchers — run synchronously and end with the report", and explicit demands for red-first evidence and real measured numbers.
3. **Verify independently before accepting** — re-run the suites, `curl` the live API, check `git diff --stat` for scope creep, compare the live student's etag. Multiple agent reports contained real errors caught this way; one agent's own simulation disproved its central claim.
4. **Commit per accepted item**, then `git push origin main` (pre-authorised in `.claude/settings.json`).
5. **Parallelism only with `isolation: "worktree"`**, and only when items share neither the `/v2/` lane, the Playwright port, nor the same files. Note worktree work is machine-local until merged — it does not exist for anyone else until you merge and push.

---

## 13. Traps that have already bitten (put these in agent briefs)

- **`scripts/lib/deploy_common.sh`** has `APP_FILES` + `assert_app_files_cover_js_tree()` — any `js/`, `styles/`, or `vendor/` file on disk missing from `APP_FILES` hard-fails all three deploy scripts.
- **`scripts/deploy_v2.sh` pins exact counts**: currently **4** image-path rewrites and **5** version injections. Adding a page or moving image code changes them — recount, update the pin, show the per-file breakdown.
- **`tests/test_deploy_scripts.js`** has a hand-written expected blob list. Additive only; never weaken an assertion.
- **`tests/test_html_syntax.js`** enforces: no `function` in inline `<script>` blocks, ≤5 lines each, every page has a module entry.
- **Several Node suites parse page source** via `tests/helpers/page_source.js` (flattens the module graph for `vm` sandboxes). Move code between modules → update the loader, never the assertions.
- **ES modules are always strict mode.** Extraction surfaced a real crash (`SVGElement.className` is read-only) that sloppy mode had silently swallowed — see `js/shared/dom.js#setClassName`.
- **`az storage blob list` returns `properties.copy` as null unless you pass `--include c`** — this convinced one agent a finished 3,059-blob copy had never completed.
- **Azure `config-zip` deploys drop `WEBSITE_RUN_FROM_PACKAGE` / `ENABLE_ORYX_BUILD`** app settings (runbook §6.5).
- **Playwright binds a fixed port** — never run two suites at once.
- **Dates roll over.** A localStorage baseline keyed by calendar day broke at midnight; normalise date keys in comparisons.
- **A shell's working directory persists between tool calls.** After inspecting a worktree, `cd` back explicitly or use absolute paths — otherwise edits land in the wrong tree.
- **The live student writes to the same document while you work.** Their doc's `updatedAt`/etag changing is usually them, not you. Distinguish by `clientVersion` (`v1` = production client), by whether counts grew in a student-shaped way, and by whether your own writes were scoped to a scratch DB.

---

## 14. Next actions, in order

1. **Deploy the WI-11.5 API change** when the owner approves (§10) — everything else is staged behind it.
2. Then, in order: migrate `e2e_test_student` to shards → run Playwright → `run_integrity.js`.
3. **WI-13** (student portal) → **WI-14** (parent portal) → **WI-15** (mistakes/feedback), all on the WI-12 design system, in the `/v2/` lane. Never run these concurrently with data-model work.
4. **WI-16** ∥ **WI-17**, then **WI-18** (≥5-day parallel run — owner approval), then **WI-19** (cutover — owner executes).
5. Housekeeping: raise `tests/integrity/expected_floor.json` by hand after real growth; retire or fix the stale `/beta/` lane; delete the dead `copyShareableTestLink('custom')` branch in `parent.html`; consider anonymising `tests/integrity/fixtures/real_master_profile_2026-08-29.json` (it holds real study data — question ids, answers, timings; no PII).

---

## 15. Emergency procedures

**The student's data looks wrong / something was deleted.** Do not write anything. Then:

```bash
curl -s 'https://psat-api-4915.azurewebsites.net/api/sync?student_name=default_student' > /tmp/now.json
export AZURE_STORAGE_ACCOUNT=psatprep4915
export AZURE_STORAGE_KEY=$(az storage account keys list -g rg-psat-prep -n psatprep4915 --query '[0].value' -o tsv)
az storage blob download --container-name cosmos-backups --name cosmos_backup_latest.json --file /tmp/latest.json
az storage blob download --container-name cosmos-backups --name cosmos_backup_latest.json.sha256 --file /tmp/latest.json.sha256
node tests/integrity/snapshot_diff.js /tmp/latest.json /tmp/other_backup.json --expect-no-removals
node scripts/restore_cosmos.js /tmp/latest.json          # DRY RUN — inspect before anything else
# only with owner approval, after reading the output:
# node scripts/restore_cosmos.js /tmp/latest.json --apply
```

Backups are nightly at 02:00 UTC with checksums; `GET /api/backup-status` tells you the age and health. The full restore procedure, with real observed timings, is `docs/DISASTER_RECOVERY_RUNBOOK.md` §5–§7.

**Production is broken.** Roll back the site by redeploying the last-known-good commit's files with `scripts/promote_to_prod.sh` (a pre-cutover git tag and a blob archive of the previous root are created by the promotion path). Roll back the API by redeploying the previous package from `scm-releases`/`function-releases`. Because both app versions share the same database and the server merge is non-destructive, **rolling back the code never requires rolling back data**.

**Everything is on fire.** The baseline snapshot `refactor-baseline/baseline_2026-08-29T14-09-29Z/` is a verified, restorable, checksummed copy of every question, every image, and all student data as of that date, and the restore has been rehearsed end to end (WI-03). `scripts/restore_baseline_to_scratch.js` + `scripts/reconcile_restore.js` restore and verify it into a scratch database without touching production.

---

## 16. Quick reference

```bash
python3 -m http.server 8080                 # run locally
bash scripts/deploy_v2.sh                   # deploy to staging
./scripts/preflight_backup.sh               # backup gate
./scripts/weekly_restore_check.sh           # weekly DR drill
npx playwright test                         # browser suite
node tests/integrity/run_integrity.js       # live integrity (11 checks)
node scripts/simulate_full_bank.js          # storage growth gate
curl -s https://psat-api-4915.azurewebsites.net/api/backup-status
bash scripts/promote_to_prod.sh             # OWNER ONLY — production
```

Docs: `REFACTOR_PLAN.md` (specs) · `REFACTOR_STATE.md` (status detail) · `CLAUDE.md` (binding rules) · `docs/DISASTER_RECOVERY_RUNBOOK.md` · `docs/FEATURE_AND_RELIABILITY_ROADMAP.md` (product intent) · `SYSTEM_ARCHITECTURE_AND_PLAN.md` and `AGENT_HANDOFF.md` (older; describe some aspirational architecture — trust this file and `REFACTOR_STATE.md` over them where they disagree).
