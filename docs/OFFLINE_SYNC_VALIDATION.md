# Offline exam and reconnect sync validation

## Release candidate completed — 2026-09-10

**Current status:** implementation and local release validation are complete against
the uncommitted working tree based on `5e0e963`. The five findings in the previous
review are resolved. No client/API deployment, merge, or commit was performed.
The sections below this one are historical review evidence, not current blockers.

### Implemented

- **One sync policy across student, parent, and mistakes pages.** All three download,
  upload, retry transient failures, and reconcile both outbox operations and legacy
  dirty counts. GET success never acknowledges local edits. A confirmed upload only
  subtracts writes covered by its snapshot; later edits remain pending and retry.
  Manual results and badges use the same outcome. The coordinator now returns an
  awaitable result; Web Locks serialize cooperating tabs where available.
- **Bookmark and error-tag integrity.** Answers preserve bookmark revisions. Delta
  selection includes independent flag/tag clocks. Both client and server merge tags
  by their own revision, preserve unknown legacy metadata, and respect deliberate
  removals. Correct answers advance the revision when resolving a tag. Failed tag
  saves expose recovery controls and retain the intended values.
- **Pause/resume completion.** New exams reset pause metadata. Paused reloads retain
  banked time, answers are blocked while paused, and completed reports persist pause
  count/time away. If saving a resume fails, recovery restores the paused state and
  does not spend banked time while storage is being repaired. Legacy reports do not
  gain invented pause measurements.
- **Shared short-test report summary.** Student and parent use the same persisted
  estimate and disclosure. A score requires at least 15 answered questions in each
  section and 30 total. Lean report serialization/rehydration retains estimates and
  pause measurements. Focused estimates stay outside full adaptive exam trends.
- **Minimalist cleanup.** Removed divergent page sync implementations, repeated
  score calculation, unused imports, and a redundant resume branch. Replaced stale
  setup instructions in README and removed five superseded handoff/task documents:
  `AGENT_HANDOFF.md`, `CONTINUE_HERE.md`, `REFACTOR_STATE.md`, `docs/WI-14_STATE.md`, and
  `docs/WI-14_AGENT_TASK_inventory_and_oracle.md`. Preserved unique source-PDF and API
  rollback references in the existing recovery runbook and repaired active links.
  Recovery journals, migrations, backups, and unsent operations remain active code.
- **Release wiring.** The new shared sync module is in both the deployment manifest
  and offline shell. Service-worker cache version is `20260910-sync-reports-1`.

### Verification actually run

| Check | Result |
| --- | --- |
| `npm test` | **42 offline Node suites passed**, zero failures |
| Full desktop/mobile Playwright run | **165 passed**, zero failures, **1 intentional mobile hover skip** |
| Additional completed-exam bookmark regression | **2 passed**, desktop/mobile; server flag remains false after offline removal, answer, completion, and reconnect |
| Python extractor suite | **7 passed, 2 skipped** (optional PDFs absent) |
| Bundle rebuild and validation | **3,059 questions, 3,059 valid, 0 invalid, 2,158 text-complete**; no bundle drift |
| Deployment staging | `DEPLOY_V2_DRY_RUN_OK v2-5e0e963-dirty`; new module included |
| Patch whitespace | `git diff --check` passed |

The 166-test full run preceded addition of the two exam-bookmark cases; those two
were then run separately. The offline completion cases were also rerun on both
viewports after strengthening their nonempty `examId` and exact five-attempt
assertions. The current suite discovers 168 cases. No automatic
retries were enabled to obtain these results. The first full run exposed expected
storage-baseline additions and one forced-click mobile test failure. The baseline
now checks the exact new metadata before comparing historical bytes; the mobile
test uses normal actionability and verifies question navigation. The final full
run above was clean.

Behavioral evidence includes:

- Full offline preparation/cold reload, five distinct cached question images and
  answers, completion of all **98 questions** (five answered), reconnect, and a lost
  server acknowledgement. The simulated server retains **one report and five
  attempt records**, each counted once after retry, on both viewports.
- Parent/mistakes arrival uploads a pending edit without another answer or manual
  sync. A mistakes tag survives a 503 and reaches the simulated server automatically.
- A real-bank **30/30-correct** focused report displays **1440 (estimate)** in both
  portals, preserves pause measurements, and a subsequent exam starts with zero
  pauses. A serialization round-trip retains **2 pauses and 65 seconds away**.
- Both adaptive routing directions, SRS repeat reviews, reload recovery, import/reset
  protections, and cross-portal analytics are included in the full browser run.
- New tag-ordering and full-storage pause tests were observed failing before fixes.
  Removing the upload acknowledgement guard in an in-memory mutation made the new
  shared-policy test fail (`0` dirty writes instead of the expected `3`).

Browser regressions use fresh synthetic profiles and intercepted sync endpoints;
new integration scenarios call the real server merge implementation behind the
interceptor. These are not physical-device or deployed-API certifications.

### Operational backup gates completed

- **`PREFLIGHT_BACKUP_OK cosmos_backup_2026-09-10T13-50-56-879Z.json`** — archive,
  checksum sidecar, API checksum, counts, and live integrity suite passed. Archive
  size **10,178,454 bytes**, **69 student-answer documents**, **3,059 questions**.
  This was an append-only backup plus read-only live integrity inspection; student
  records were not edited.
- **`WEEKLY_RESTORE_CHECK_OK baseline_2026-08-29T14-09-29Z`** — scratch restore matched,
  deliberate one-document corruption was detected, repair matched, and scratch
  database teardown completed. Final account database list contained only
  `psat-prep-db`.

### Concrete release artifacts and next deployment steps

Local candidate: `/private/tmp/psat-release-20260910/manifest.json`,
`candidate-source.zip`, and `api.zip`. The manifest records SHA-256 for **67 source
files** (54 client/bundle files and 13 API files), both archives, and the base commit.
These are temporary local release artifacts, not cloud backups; verify their hashes
against the working tree or recreate them if the tree changes. `/v2/` transformed
staging passed separately. Unrelated explanation edits and local profiles are not
included in the candidate archives.

For the deployment operator:

1. Choose a release window after the student's active test has finished. Confirm the
   candidate hashes; do not promote a later untested working tree. Preserve a current
   API rollback package and run `scripts/backup_prod_web.sh` to capture the current
   live web files and headers. Keep the resulting manifest for `scripts/rollback_prod.sh`.
2. Run the backup preflight immediately before merge/promotion if this session's
   backup is no longer current. A new code/data change invalidates earlier release
   assumptions. Do not lower integrity floors or waive failing checks.
3. Deploy the API package through the existing remote-build Functions procedure in
   the recovery runbook. The tag-ordering rule must land on both API and client.
   No database migration, live-profile reset, or compaction is needed.
4. Stage the matching client in `/v2/` with `scripts/deploy_v2.sh`. Smoke-test with the
   quarantined `v2smoke` fixture using the designated test identity. Verify pause,
   report parity, and pending-write retry on the deployed API before promotion.
5. Promote the tested client using `scripts/promote_to_prod.sh` in the agreed window,
   then verify its version, loaded modules, backup/integrity status, and test-identity
   sync. Record the deployment and rollback identifiers here. If a gate fails, keep
   the candidate unpromoted and diagnose it; do not reset student data to make it pass.

### Deployment completed — 2026-09-10

- API deployed to `psat-api-4915` with Azure deployment ID `4a627ebc-b493-4b64-b172-976033d8f8d9`; remote build completed successfully.
- Client promoted to the production `$web` root with `PROMOTE_TO_PROD_OK 5e0e963`. Production `index.html`, `parent.html`, `mistakes.html`, `sw.js`, and `js/shared/sync.js` returned HTTP 200 after promotion.
- Live API read after promotion succeeded for `e2e_test_student` (33 progress records, 1 test report). No `default_student` read/write was performed by smoke tests, and the student's live data was not edited.
- `/v2/` smoke test passed 6/6 before promotion, including pause/resume, report parity, and retry recovery. Production promotion used the exact tested client.
- Web rollback manifest: `refactor-baseline/pre_cutover_20260910T142307Z/manifest.json`. API rollback manifest: `/private/tmp/psat-release-20260910/api-rollback-manifest.json`, with a private-storage copy.
- No student profile reset, migration, compaction, or database schema change was run.

**Remaining product limitations:** an unfinished exam is local to its originating
browser/device; preparing offline caches that exam's assets, not every optional
external tool. This change does not redesign simultaneous multi-device aggregate
merges or certify arbitrary clock skew. Earlier discussion of those broader limits
remains relevant. Documentation cleanup is an audited set of removals, not a claim
that every historical document or possible dead line has been eliminated.

---

## Latest validation — 2026-09-09, through `d7597f7`

Reviewed WI-31 through WI-37 against a frozen copy of committed `d7597f7`. **The earlier fixes improve sync integrity, and the full offline-exam flow still works. The change set is not fully correct: bookmark ordering is lost on a later answer, mistakes uploads remain incomplete, and pause/report integration needs correction.** This section supersedes earlier status summaries. No application fixes, deployments, or live student-data operations were performed.

### Remaining findings for Claude

1. **P1 — Preserve `flagUpdatedAt` when recording an answer.** The new client/server merge ordering fixes a simple bookmark removal, but `buildProgressEntry` (`js/engine/storage.js:911–927`) reconstructs the record without its flag revision. Both practice and completed-exam writes use this builder. Browser reproduction on both viewports: sync a bookmark set to true; go offline; remove it; answer that question; reconnect and click Sync. Before reconnect the local flag is false and `flagUpdatedAt` is absent; afterward both local and server flags are true. The older cloud revision wins over the now-unversioned local removal. Preserve the flag and its revision together through every progress-record writer. Add the removal → answer → reconnect case for both practice and exam completion, asserting the final server flag and unchanged bookmark revision. A direct codec round-trip retained the revision; the loss occurs in the progress builder, not the Cosmos codec. Existing seven flag-ordering tests do not exercise this writer/merge composition.

2. **P1 — Finish the shared upload/retry path on parent and mistakes pages.** Download-only counter clearing is fixed, and both pages now retain and visibly show pending state. However, navigating to either page with one unsent local change still produces **0 POSTs** over the 4.5-second observation, with the server lacking that record. More concretely, `setMistakeErrorTag` (`js/pages/mistakes.js:528–552`) still calls `pushToCloud` directly. A tag on an already-synced answer has no new answer timestamp, so the delta POST contains **zero progress IDs** and the server tag remains null. After resetting the synthetic cursor to force a full upload, returning HTTP 503, and restoring the mock server, there is **one POST total and no retry over five seconds**. The added `.then/.catch` only logs and redraws; it is not a retry coordinator, despite the comment at lines 540–542. Use one acknowledged upload/drain policy that includes dirty metadata in its payload, coalesces requests, retries transient failure, and reconciles status only after acceptance. Route all relevant page triggers through it. Tests must assert eventual server tag/record values without another answer, navigation, or manual sync; finding a `.then` in source is insufficient.

3. **P2 — Carry pause history into reports and reset it between exams.** Pause, reload while paused, and resume preserve the banked time and answers. But `finishExamAndShowReport` (`js/pages/student.js:2429`) never adds pause count/duration to the completed report, and `initExamSession` (`:1866`) never resets the new pause fields. Reproduced with a real-bank 30-question focused test: pause/resume, answer all questions, finish. Its stored report has neither pause count nor `totalPausedMs`; the next newly started mini exam immediately has **pause count 1** and the prior test's paused duration. Initialize the pause fields for every new exam, include them in the lean completed report/export/sync paths, and disclose paused timing on student and parent reports. Test two consecutive exams on the same page as well as report round-trips. Also handle the paused phase in the resume-banner wording (`checkActiveExamResume`): its current source labels a null deadline as expired even when the saved phase is paused.

4. **P2 — Use the short-test estimate consistently across reports.** The new estimate is computed only inside the student renderer (`shortTestEstimateFor`, `js/pages/student.js:2496`, and its calls at `:2533–2537`). It is not part of the stored score result consumed by `openParentExamReview` (`js/pages/parent.js:812`). With **15 Reading and Writing + 15 Math questions**, all answered correctly in a `focused_custom_test`, the student report shows **1440**, while the parent report of the same saved exam shows **30 / 30 (100%)** and no short-test estimate. Compute/describe the short-test result through a shared report path, including its provenance and disclosure, and present it consistently on both pages without admitting focused tests into full-exam trends. Calculate it once per render; the current branch repeats the same bank scan/scoring up to three times. Add a browser test of the same completed report on both portals; the new browser spec currently covers pause only.

5. **P2 — Complete documentation consolidation; cleanup is only partial.** All named unused declarations/accessors and `clearOutbox` have been removed, including facade and test expectations. The service-worker comment now reflects its active calls. However, README still sends new agents to contradictory continuation/state documents, and the obsolete WI-14 task brief remains. No consolidation/removal of those documents landed in these commits. Finish the previously specified consolidation while retaining unique recovery and rollback instructions. New comments also need to match their code: the mistakes upload is not coordinated/retrying, and the `scoreShortTest` header still describes a 20-question gate and single-section estimate, although WI-36 now requires 30 total and at least 15 in each section. Remove the redundant identical ternary branches in `resumeFromPause` as part of the focused cleanup; no new abstraction is needed.

### Verified improvements

- **Dirty state on download:** parent/mistakes no longer erase pending counters or stamp a successful upload time after GET. Their badges retained **1 Pending** in both browser runs; the missing mistakes status element is restored.
- **Bookmark add/remove in isolation:** actual button clicks now update both local and simulated server flags. The failure in finding 1 requires the intervening answer writer.
- **In-flight local writes:** a held POST followed by a newer local write drains automatically; the simulated server receives the newer value and the pending count reaches zero only afterward.
- **Pause/resume:** the committed browser spec passes on desktop/mobile, including reload while paused, retained answers/banked time, blocked editing while paused, and a usable timer after resume.
- **Scoring gates against the real 3,059-question bank:** 15+15 answered and correct → estimate 1440; 14+16, 0+30, and 10+10 → no scaled estimate. This verifies the implemented gates, not empirical score calibration.
- **Full offline exam:** both viewports prepared **147 images**, cold-loaded offline, retained **5 answers** through reload/resume, completed **one 98-question report** (93 intentionally skipped), and uploaded it on reconnect. Queue drained to zero; replay kept one attempt for each answered question. Lost-response recovery also passed without duplicate attempts.
- **CI wiring and cleanup:** `./scripts/run_offline_tests.sh` actually ran **42 suites: 42 passed, 0 failed**, printing `OFFLINE_TESTS_OK 42`. CI invokes the same runner. The confirmed unused builder variables, `countKeys`, `getMigrationReport`, and `clearOutbox` are absent.

### Evidence and limits

Frozen source and temporary browser harnesses: `/private/tmp/psat-review-d7597f7/`. Browser scenarios used fresh synthetic profiles, the real question bank, real client/server merge functions, and intercepted API requests; external HTTPS was blocked. The review covered **22 distinct desktop/mobile scenario runs after diagnostic corrections**: twelve positive checks and ten deliberately asserting the remaining defects. Passing diagnostic assertions do not constitute a clean release gate.

The first test-discovery configuration included the frozen tree's own specs and failed module resolution; discovery was restricted to the intended review files. Two diagnostic scenarios were corrected and rerun on both viewports: an accidentally inverted bookmark-add expectation, and a report fixture initially missing the actual builder's `focused_custom_test` type. Only corrected results support the findings above. The complete repository browser suite, live Cosmos deployment, and physical-device behavior were not certified. Unrelated edits to explanation content were left untouched. Earlier multi-device aggregate-merge and complete offline-cache readiness limitations remain outside this change set.

## Minimalist review — 2026-09-09

**Scope:** committed `bc6d419`, plus a separately frozen copy of the uncommitted `js/pages/student.js` fix that appeared during review (SHA-256 `13ec1fee0fe416ddd49ab9898c708c2eae6e48d4fde827e28f0f8ad87a058a34`). Findings below distinguish those versions. Application code, student data, deployment state, and unrelated working edits were not changed. This section records observed defects and concrete cleanup candidates; it does not authorize deleting data or recovery mechanisms.

**Verdict:** the active engine, shared focused builder, and small dependency surface are worth keeping. The largest avoidable complexity is divergent sync behavior, followed by unused exports and contradictory continuation instructions. An offline app needs durable pending writes; eliminating those states would violate data preservation. Eliminate falsely completed and stranded states instead.

### Findings to implement

- **P1 — Parent/mistakes downloads erase dirty bookkeeping without uploading.** `js/pages/parent.js:82–86` and `js/pages/mistakes.js:56–61` still use the local-write helper for downloaded state and then set `psat_pending_sync_count` to zero after GET success. On both desktop/mobile, a real-bank question saved locally through `safeSetStorage`, followed by navigation to either page, produced **zero POSTs**, no corresponding server record, and pending count **0**. Parent displayed **“Cosmos DB Synced (Just now)”**. Local data survived, but its unsent status was erased. Consolidate these paths with the shared download/write/acknowledgement rules; a pull must never acknowledge local changes. Wire retries for mutations from the mistakes page too: `setMistakeErrorTag` currently fires `pushToCloud` and ignores its outcome. Acceptance: navigate between all three pages with unsent work, retain accurate status, then prove the server receives it without another answer or manual sync.

- **P1 — Removing a synced bookmark is undone.** `js/engine/sync.js:202` and `api/src/lib/merge.js:289` force `isFlagged` true if either side is true. In the frozen in-progress fix, adding a bookmark uploads correctly; clicking the same button again sets it false locally, then automatic sync restores true locally and on the server while showing **“All work saved.”** Reproduced through the actual bookmark button on both viewports. Direct execution of both merge functions also returns true for an older true record and a newer false record. Represent flag edits with an explicit ordering/revision that distinguishes a deliberate removal from an absent legacy field; apply the same rule client/server. Do not advance an answer timestamp just to represent a bookmark edit: that timestamp also feeds learning metrics. Acceptance must cover add, remove, reconnect, and an older flagged client rejoining, with the actual server value asserted.

- **P2 — A live status callback has no UI target.** `js/pages/mistakes.js:22–24` returns immediately because `#mistakes-sync-status-text` does not exist in `mistakes.html`; the browser probe confirmed a null element. Its listener and repeated refresh calls therefore display nothing. Provide one visible status element using the shared sync outcome, and remove obsolete markup-update paths in the same change. This is missing functionality, not justification to remove save-status feedback altogether.

- **P2 — Remove confirmed dead declarations and the unused destructive API.** The five builder variables at `js/pages/parent.js:71–75` (`selectedSkillsSet`, `domainToSkillsMap`, `skillToDomainMap`, `skillToSectionMap`, `skillQuestionCountMap`) have no readers or writers beyond their declarations. `countKeys` at `js/engine/import_validate.js:475` has no callers. `getMigrationReport` at `js/shared/storage.js:60` has no consumers. Remove those declarations/accessors; retain the actual migration and its result checking. `clearOutbox` at `js/engine/storage.js:1056` has no application callers and unconditionally removes unacknowledged operations, swallowing errors. Remove its definition, export, facade-manifest entry, and API-surface-test expectation together. The frozen API test currently protects the presence of this unused unsafe capability. Keep `ackOutboxOps` and the intentional backup/restore interfaces.

- **P2 — Wire existing safety tests into CI.** There are **33** tracked top-level `tests/test_*.js` suites; `.github/workflows/test-and-validate.yml:34–38` directly runs only three of them, alongside separate integrity checks. Browser CI also runs, but the dedicated `test_outbox_ack`, `test_sync_retry`, `test_storage_v2`, `test_offline_pin_identity`, and syntax suites are not invoked by the workflows, package scripts, or deployment scripts searched. Use one explicit offline-safe test command shared by local use and CI; retain separate credentials-requiring operational checks. Do not delete useful regression suites merely because they are disconnected. Keep the offline browser suite in a service-worker-enabled project; `playwright.local.config.js` deliberately blocks workers and excludes it.

- **P2 — Consolidate contradictory documentation and remove obsolete task briefs.** `README.md:3` still directs newcomers to `CONTINUE_HERE.md` and `REFACTOR_STATE.md`. The continuation guide says portal rebuilds are next; the state table calls WI-11 blocked and WI-12 onward unstarted; `docs/CUTOVER_REPORT.md` records the completed September 3 cutover. `REFACTOR_STATE.md` explicitly supersedes `AGENT_HANDOFF.md`, yet README still lists that handoff. `docs/WI-14_AGENT_TASK_inventory_and_oracle.md` still instructs an agent to create and push a pre-rebuild document. Consolidate current setup/interfaces into README and current recovery operations into the existing runbook, then remove superseded handoffs/task briefs and repair their inbound links in the same change. Preserve unique rollback evidence and recovery instructions before removing any historical document. Also replace the false **“NOT YET WIRED / sw.js does NOT call this”** comment at `js/shared/sw_routing.js:63–69`: `sw.js` calls `raceDeadline` in three paths. Keep comments about invariants; remove ticket-by-ticket narration that contradicts the current implementation.

### Latest sync fix: verified progress, not an outstanding committed-code finding

At committed `bc6d419`, clicking Bookmark after an accepted practice answer produced a delta POST with **zero progress IDs**; local flag true, server flag false, dirty count 0, badge “All work saved.” The unchanged answer timestamp excluded the edit from `buildSyncDelta`. The previously documented in-flight-write drain also remained incomplete in that commit.

The separately frozen uncommitted student fix now forces full uploads for legacy dirty state and includes that state in completion. On desktop/mobile it sent the bookmarked question in a full POST and delivered a newer write made while another POST was held, automatically, with the server value updated and final dirty count 0. These two cases pass. This fix does not change the parent/mistakes paths or the irreversible flag merge described above. The concurrently edited repository test was not certified; the evidence here comes from independent frozen browser scenarios through actual UI handlers.

### Evidence and limits

- Fresh checks: all **40** page/engine/shared modules parsed; the **106-symbol** facade contract suite and **8** acknowledgement checks passed. The facade check demonstrates why dead exports require updating the contract test, not preserving unused behavior forever.
- Committed-source browser diagnostics reproduced missing bookmark upload and parent/mistakes dirty-counter clearing on both viewports. The first mistakes probe used a missing selector without a null guard; corrected probes confirmed the absent UI target and dirty-counter defect.
- Frozen in-progress source: **10 browser scenarios completed** — four positive checks for the new upload/drain fixes and six checks deliberately asserting the remaining bookmark-removal/parent/mistakes defects. This is not a clean regression result.
- Harnesses: `/private/tmp/psat-minimalist-review-bc6d419/` and `/private/tmp/psat-minimalist-review-wip/`. Fresh synthetic profiles, actual question bundle, real merge functions behind a mocked API, and blocked remote HTTPS. No live Cosmos or physical-device verification. Earlier full-exam/SRS/adaptive evidence remains below; those broader suites were not rerun for this cleanup review.
- Static symbol/reference searches establish the named dead candidates, not a proof of zero dead code across the repository. A filename with no import is insufficient to delete manual backup, restore, provisioning, or dataset tools. The actively loaded `srs.js` facade, local recovery journal, schema migration, snapshots, and pending outbox are not dead code.

## Latest validation — 2026-09-09, through `bc6d419`

Reviewed WI-30 against a frozen, unmodified snapshot. **Three of the four preceding findings are verified fixed. The in-flight legacy-write finding is partially fixed: the pending count survives, but automatic delivery still stops prematurely.** This section supersedes earlier status summaries.

### One remaining issue from the latest four findings

**P1 — Include remaining legacy changes in drain completion and schedule their upload.** The subtraction at `js/pages/student.js:273–277` correctly preserves a write made after the POST snapshot. However, the `done` calculation at lines 317–319 still checks only upload success, persisted acknowledgements, and `stillPending === 0`; `stillPending` is the outbox length, not the remaining legacy count. The coordinator consequently reports `synced` and stops while dirty local state remains.

Desktop/mobile browser reproduction, through the actual manual Sync button:

1. Hold an upload containing a question's flag set to false.
2. While it is pending, save a newer local flag set to true through the real storage helper.
3. Accept the original upload and wait four seconds without another user action.
4. Observe **legacy pending 1**, **local flag true**, **server flag false**, badge **“1 change(s) waiting to sync”**, coordinator **`status:'synced'`**, **`pendingRequest:false`**, **`retryScheduled:false`**.
5. Clicking Sync again uploads the newer flag successfully.

The earlier false “All work saved” badge is fixed, and the local edit survives. The remaining defect is automatic delivery and the coordinator's completion result. Include both kinds of pending state in the combined result, subsequent drain, and manual-success message. Retain dirty changes until a payload containing those changes is accepted. Acceptance must compare the updated value on the simulated server, not merely a zero counter; ensure legacy-only changes are actually included by the delta/full-push policy. Add a permanent test that requires the second upload with no manual action.

### Verified fixes

- **Startup:** one offline practice attempt was accepted by the simulated server automatically after reopening online. Both desktop/mobile made a startup upload and drained the queue without a manual click.
- **Loaded focused test:** starting a seven-question Craft and Structure test, returning to the lobby, and clicking “Prepare my assigned test” now pins the exact **7 IDs**, caches **7 images**, and preserves its **720-second** limit on both viewports.
- **Beta initialization:** using mocked empty-beta and populated-fallback responses, the real pull function made **2 requests**, returned `seededFromProd:true`, and populated the beta-prefixed progress key. The unprefixed key remained untouched.
- **Full-exam regression:** desktop/mobile still cold-loaded offline, displayed five cached images, retained five answers through reload/resume, completed one 98-question report (93 deliberately skipped), and uploaded on reconnect. Replay retained one report and one attempt per answered question. Lost-response recovery also passed.
- **Checks:** all **40** page/engine/shared modules parsed; storage/sync v2 and the **5** offline-pin identity checks passed. The browser harness completed **10 scenarios**, two of which deliberately reproduce the incomplete in-flight-write behavior above.

Temporary harness/source: `/private/tmp/psat-offline-review-bc6d419/`. All cloud requests were intercepted and synthetic. No live student data was accessed or changed, no application fixes were applied, and no deployment was performed. Broader multi-device event durability and complete offline-cache readiness remain outside this four-finding closure.

## Latest validation — 2026-09-09, through `8a1ad70`

Reviewed WI-29 in a frozen, unmodified snapshot. **The body timeout and manual-button retry work. Assignment preparation and legacy pending-count reconciliation are only partially fixed. Startup sync remains explicitly unfinished.** This section supersedes earlier status summaries.

### Findings for Claude

1. **P1 — Pending-count reconciliation hides local writes made during an upload.** At `js/pages/student.js:253–260`, the new code sets the legacy dirty count to the current outbox length after a successful upload. Its comment assumes every local write increments both counters; `safeSetStorage` increments only the legacy count and does not append an operation. Desktop/mobile reproduction: hold a POST containing a question's `flagged:false`; while it is pending, save the same question locally with `flagged:true` and a newer timestamp through the real storage helper; then acknowledge the held POST. Result: **uploaded flag false, local flag true, outbox 0, pending count 0, success true, badge “All work saved.”** The local record survives, but its newer state has not been uploaded and is no longer represented by pending status. Track a revision/snapshot of acknowledged local changes and preserve any later dirty writes, or consistently journal every sync-relevant mutation. Do not infer that an empty outbox means all legacy-only writes were included in this response. Add the in-flight case to the permanent test suite.

2. **P1 — Startup synchronization is still open, as the commit acknowledges.** Startup still performs a standalone GET and never asks the coordinator to drain queued work (`js/pages/student.js:2903` onward). The erroneous GET-only timestamp/reset has been removed, which is good. Manual buttons now use the coordinator, but reopening after offline work still requires another trigger before upload. Finish startup routing and test actual server acceptance of queued work. The documented rollback cites the existing offline test's POST-count assertion: that test leaves the exam unfinished, with its answers only in the local active-exam snapshot. A prior full upload followed by no delta can legitimately skip a reconnect POST. Treat that as a test-coverage question, not proof that fewer requests mean lost work; assert accepted report/answer content and retained unacknowledged operations.

3. **P2 — The new prepare button fails for its already-loaded-test fallback.** `getSelectedFocusedTest` returns `activeExam` when no handed-over session assignment exists (`js/pages/student.js:1539–1540`), but the next step feeds that modules-based exam into `buildCustomExamFromPlan`, which expects top-level `questions` or `questionIds`. On desktop/mobile, starting a valid seven-question focused test, returning to the lobby, and clicking the new button produced **“This test has missing or duplicate questions”** and no pin. The same button works when the raw assignment is present in sessionStorage. Either accept and validate an already-normalized exam or normalize the fallback before calling the builder conversion. Test both selection sources through the button.

4. **P2 — Response-envelope naming breaks beta fallback initialization.** `pullFromCloud` already defines `env = getEnvironmentConfig(loc)`, but the new `.then(function(env) { ... })` at `js/engine/sync.js:696` shadows it with `{ok,status,body}`. Consequently, the existing `env.isBeta` check at line 757 is always false and an empty beta profile never enters its fallback branch. With entirely mocked responses, the same `/beta/index.html` scenario made **2 requests before this commit and 1 afterward**, returning empty. Rename the response variable and preserve access to the environment configuration. Add a beta-path regression test with intercepted/synthetic responses; no real production profile is needed to exercise this branch.

### Verified improvements

- **Response-body timeout fixed:** the updated retry suite completed all **10 checks**; the real push path with a stalled JSON body returned `SYNC_TIMEOUT` after **20,010 ms** against a 20,000-ms deadline.
- **Manual UI retry fixed:** clicking the actual header Sync button with healthy GET/failing POST, then restoring POST, automatically retried on desktop/mobile. Both runs made **2 POSTs**, drained the queue, and reconciled a legacy count created before the upload to zero.
- **Assignment UI path works:** the actual “Prepare my assigned test” button, supplied a synthetic session assignment matching the parent's handoff format, pinned the exact **7 question IDs** and cached **7 images** on both viewports. This did not exercise creating that assignment in the parent portal.
- **Full exam and reconnect regression passed:** both viewports cold-loaded offline, retained five answers through reload/resume, completed one 98-question report (93 deliberately skipped), and uploaded on reconnect. Replay retained one report and one attempt per answered question. Upload-only retry and lost-response recovery also passed.
- Storage/sync v2 tests passed. The browser checks ran **14 scenarios** across the two viewports; four deliberately assert the remaining loaded-test/in-flight-counter defects. A passing diagnostic assertion is not a release approval.

Local scripts and frozen source: `/private/tmp/psat-offline-review-8a1ad70/`. All sync requests were intercepted and operated on synthetic state. No application code or live student records were changed, and no deployment was performed. Broader multi-device event durability, full offline-cache readiness verification, parent status, and the earlier exact-operation test gap remain open.

## Latest validation — 2026-09-09, through `cf653db`

Reviewed WI-28 in a frozen, unmodified snapshot. **The failed-upload retry, HTTP classification, and focused-data conversion fixes now work. Four completion gaps remain below.** This section supersedes the earlier status summaries.

### Remaining findings for Claude

1. **P1 — Startup still leaves offline work queued; manual buttons still bypass the coordinator.** The startup handler at `js/pages/student.js:2837–2855` performs only a standalone pull. In desktop and mobile browser tests, one offline attempt survived a reload after connectivity returned, but after five idle seconds there had been **0 POSTs**, and **1 operation remained queued**. Source confirms startup never requests a coordinator drain. The three manual buttons in `index.html` still invoke `manualTriggerCloudSync(true)` directly, so they can overlap a coordinator drain and do not independently schedule recovery after failure. Route startup and manual actions through one awaitable coordinator. Test reopening with pending work, manual-only upload failure, and a click during an existing upload. Keep the queue and last-confirmed status intact until upload acknowledgement; startup still resets legacy pending count and stamps sync time after GET alone.

2. **P1 — The new 20-second timeout ends at response headers, not at complete response consumption.** `fetchWithTimeout` clears its timer when `fetchFn` resolves (`js/engine/sync.js:843–845`); callers await `res.json()` afterward. A stalled JSON body therefore still leaves the entire drain pending indefinitely. Running the actual push function with injected fetch responses: a request with no response headers returned `SYNC_TIMEOUT` after **20,037 ms**, but an immediately available response whose `json()` remained pending had **not completed after 21,038 ms**, despite the configured 20,000-ms timeout. The diagnostic then released the body so the test could exit. Keep timeout/abort protection active through body reading/parsing, and cover both GET and POST with a stalled-body test.

3. **P1, feature incomplete — Focused offline preparation still has no UI caller.** `prepareFocusedTestForOffline` is now exposed and correctly converts raw `questionIds`/`questions` to modules. However, repository search finds no button, builder action, or assignment flow invoking it. `index.html:654` still calls only `prepareOfflineExam()` without the selected test. Direct browser calls to the focused helper now work, but parents and students still cannot reach this functionality through the interface. Add an explicit action connected to the current preview/assignment, then test selection → preparation → offline reload → start using the actual UI. Do not mark the feature complete on helper tests alone.

4. **P2 — Local legacy pending counts still remain after successful upload.** The new download writer fixes the previously reproduced artificial increment of three; ordinary successful download no longer invents pending work. However, local writes using `safeSetStorage` still increment `psat_pending_sync_count`, and acknowledged upload does not reconcile it. `readSyncBadgeState` continues to use `max(outbox.length, legacyCount)` at `js/shared/storage.js:158–164`. Browser reproduction after one local progress write and a successful combined sync: **success true, outbox 0, legacy count 1, badge “1 change(s) waiting to sync.”** Fix legacy dirty-state accounting without erasing writes made while an upload is in flight. Carry existing legacy-only changes safely into the new model; do not use the current startup GET-only reset as the fix.

### Verified fixes and limits

- **Upload-only transient failure:** with healthy downloads, restoring the upload endpoint caused an automatic additional POST on both desktop/mobile; POST count **2 → 3**, queued operations **1 → 0**. This closes the prior combined-outcome integration bug for that scenario.
- **Focused conversion and pinning:** a seven-question Craft and Structure setup supplied as question IDs produced **one module, seven cached images, the exact seven selected IDs, and a 720-second limit**. Both viewports cold-loaded offline and started at “Question 1 of 7.” This verifies the helper path, not the missing UI action.
- **Full exam regression:** desktop/mobile still cold-loaded offline, retained five answers through reload/resume, completed one 98-question report (93 intentionally skipped), and uploaded it on reconnect. Replays retained one report and one count per answered question. Lost-response recovery also passed.
- **Classification through the real engine:** HTTP 400 → permanent; 408, 429, and 503 → retry. This closes the previous result-shape mismatch.
- **Status improvements:** downloads no longer manufacture three pending changes; the phone-hiding classes were removed from the status markup. Production styling and parent portal status were not browser-certified in this review.
- **Unit checks:** retry coordinator (9), offline identity (5), outbox acknowledgement (8), and the 106-symbol engine API contract all passed.
- **Browser evidence:** 12 scenario checks completed successfully across the two viewports, including four that intentionally reproduce the still-open startup/legacy-count defects. Passing diagnostic assertions must not be read as approval of all requirements.

Harness and frozen source: `/private/tmp/psat-offline-review-cf653db/`. API responses were intercepted and synthetic; no live student data was accessed, no application code was changed, and no deployment was performed. The broader multi-device event-integrity, complete offline-cache readiness, parent-status, and exact-operation regression-test items remain open. Results apply to `cf653db`, not any subsequent promotion or edits.

## Latest validation — 2026-09-08, through `d037de2`

Reviewed WI-26 (`2127717`) and WI-27 (`d037de2`) in a frozen, unmodified snapshot. **The external timeout works and the new helpers make progress, but upload retries and focused offline preparation are not complete end-to-end.** This section supersedes earlier status tables.

### Findings for Claude, in priority order

1. **P1 — The coordinator receives the GET result even when POST fails.** `manualTriggerCloudSync` now awaits `pushToCloud`, but still returns `pullRes` at `js/pages/student.js:274`. The coordinator invokes this function at line 1513 and treats `success:true` as completion. When GET succeeds but POST returns 503, it stops with an unconfirmed operation still queued. Reproduced on desktop and mobile with a settled initial write followed by one reconnect attempt: after the server recovered, POST count stayed **2 → 2** during 6.5 seconds and **1** operation remained. Manual sync recovered. Return a combined outcome that reflects upload success, acknowledgement persistence, and remaining work; ensure empty/partial acknowledgements cannot mark the drain complete. Add a browser test where GET remains healthy and only POST fails. The isolated coordinator tests currently substitute the desired result shape and miss this integration error.

2. **P1 — Focused offline preparation is neither reachable from the UI nor compatible with its input.** `prepareFocusedTestForOffline` at `js/pages/student.js:1455` has no caller and is not exposed as a window handler. Existing markup still invokes only `prepareOfflineExam()` with no selected test. Moreover, its forwarding call passes raw custom data to a pinning path that expects `exam.modules`; the builder produces `questionIds`, and `generateCustomTest` produces `questions`. The conversion into modules currently lives in `startCustomTestDirect`, not in preparation. Direct browser execution of the shared `prepareOfflineExam(customTest)` path with **7 Craft and Structure questions** produced **0 pinned modules / 0 cached images** and displayed **“Offline-ready.”** This happened on both viewports. The new unit test manually constructs modules, bypassing the actual mismatch. Extract one validated conversion for both start and prepare, wire an explicit prepare control into the focused/assignment flow, and reject empty or incomplete pins before claiming readiness. Then test the actual parent/student UI through offline reload with the exact requested IDs, count, domain, and timing.

3. **P1 — Hanging sync requests still have no timeout, and some callers bypass the coordinator.** The GET/POST fetches in `js/engine/sync.js:592`, `:695`, and `:759` remain unbounded. The coordinator stays `inFlight` until `run` settles; a hanging connection therefore prevents retry and coalesced requests from progressing. Manual buttons call `manualTriggerCloudSync` directly, startup still performs a standalone pull, and error-tag changes still call `pushToCloud` directly. Route all triggers through one awaitable coordinator and apply an actual fetch timeout/abort policy. Verify a hanging request, an in-flight manual click, and startup with unsynced work. This is a source-verified gap; this round did not run a real long-duration stalled-sync test.

4. **P2 — Successful sync creates a false pending count.** `safeSetStorage` increments the legacy count for downloaded progress/SRS/history (`js/shared/storage.js:115–122`), and `readSyncBadgeState` still takes the maximum of that count and the outbox (`:138–146`). WI-26 removed the manual-sync counter reset without replacing this accounting. Reproduced on desktop/mobile: a successful upload followed by manual sync left **outbox 0**, **legacy count 3**, and the badge **“3 change(s) waiting to sync.”** Downloaded state must not create unsent-change counts. Replace legacy bookkeeping with a reliable dirty-state/queue model, preserving legacy-only unsynced changes during migration; do not simply zero counters before upload confirmation.

5. **P2 — Permanent-error classification does not match actual engine responses.** `classifySyncOutcome` checks numeric `result.status`, but `pushToCloud`/`pullFromCloud` return an error string such as `HTTP_400` without that field. A direct call through the real push function with a mocked HTTP 400 returned `{success:false,error:'HTTP_400',syncMode:'full'}` and classified as **retry**. Preserve HTTP status in engine outcomes and test through those functions. Distinguish retryable rate limiting/timeouts from other 4xx failures as part of the same policy.

6. **P2 — Save status is hidden on phone-sized layouts.** The new `index.html:55` indicator uses `hidden sm:inline-flex`; below the small breakpoint the student cannot see it. Provide a compact visible mobile status. Parent status has not been updated in these commits. This visibility finding follows directly from the markup; browser probes in this review read status text without certifying production styling, since external assets were blocked.

### Confirmed improvements and evidence

- The four targeted Node suites passed: retry coordinator **9** checks, focused pin identity **5**, outbox acknowledgement **8**, and worker routing/deadlines **17 + 7**. These do not prove UI integration.
- The full adaptive exam still passed desktop/mobile cold offline reload, five cached images/answers, reload/resume, completion of one **98-question report** (93 intentionally skipped), reconnect acceptance, queue drainage, and replay without duplicate counters.
- Lost-response recovery still passed on both viewports using the real merge functions in a simulated server.
- A failed **GET** does trigger automatic retry: restoring the server without another user action drained the operation on both viewports. This working case is distinct from the failed-POST case above.
- An uncached optional worker request deliberately held pending returned `null` after **2,006 ms** on both viewports. The previously missing external timeout is now implemented. Existing local caching and timer fixes remain intact.
- Focused metadata is preserved when the input already has valid modules, as the new unit tests demonstrate. The missing conversion/UI path prevents calling the user-facing feature complete.

The earlier broad reconnect reproduction also recovered because it first induced a failed GET and overlapping triggers. It was refined to isolate a settled, healthy-GET/failed-POST sequence; only that sequence supports finding 1. Initial diagnostic scripts also attempted to access private ES-module bindings; those harness errors were corrected to use public handlers and status text, and are not reported as application defects.

Local scripts and frozen source: `/private/tmp/psat-offline-review-d037de2/`. All browser calls to the sync API were intercepted and applied only to synthetic state. No application fixes, live data access, or deployment occurred in this review. Multi-device event integrity, complete shell/cache readiness verification, and the previous exact-operation regression-test follow-up remain open.

## Follow-up validation — 2026-09-08

Reviewed committed code through `14cf5ee` (WI-24 timer/wiring fix and WI-25 acknowledgement fix). The original September 7 findings below are retained as historical evidence; this section supersedes their status.

| Original finding | Current status |
| --- | --- |
| 1. Worker timer receiver | **Fixed and browser-verified.** Cold offline reload and resume work. A deliberately stalled worker request for a cached shell file returned successfully in 2,512 ms on desktop and 2,508 ms on mobile Chromium. |
| 2. Acknowledgement integrity | **Core queue-removal defects fixed.** Eight dedicated unit checks pass: empty/missing/unknown acknowledgements retain operations, partial/duplicate acknowledgements count actual removals, storage failures retain operations and expose `ackPersisted:false`, and full acknowledgement drains the queue. UI integration and cursor-write reporting still need work. |
| 3. Retry after transient reconnect failure | **Still open, reproduced again.** On both viewports, one queued operation remained after a failed reconnect POST; server recovery alone produced no retry during the subsequent 6.5-second observation. Manual sync recovered. Source still has no retry scheduler. |
| 4. Truthful visible sync status | **Still open.** `pushToCloud` returns `success:true` even when `ackPersisted:false`; this can represent server acceptance, but no UI caller checks the new acknowledgement/pending fields. Manual sync still does not await its upload. |
| 5. Complete offline package and focused tests | **Still open in reviewed commit.** No implementation changes to preparation or the parent builder. |
| 6. Uncached external dependency timeout | **Not fixed in reviewed commit.** Additional uncommitted worker/helper edits addressing it appeared during this review; inspected for intent but not included in the browser-verified snapshot. |
| 7. Multi-device event integrity | **Still open.** API/event merge code is unchanged. |

### Evidence from this follow-up

- All four targeted Node suites passed: outbox acknowledgements (8 checks), worker routing/deadlines (17 + 7 checks), offline exam helpers (39 checks), and storage/sync v2.
- Against an **unmodified snapshot of the committed application**, desktop and mobile both prepared a real-bank adaptive exam, cold-loaded offline, displayed five cached question images, retained five answers through another offline reload/resume, completed a 98-question report, and uploaded it to the simulated server on reconnect. Each server state held one report and five progress entries; replay retained one attempt per answered question. The other 93 questions were intentionally skipped.
- Lost-response checks passed on both viewports: the server accepted an attempt, the response was dropped, the local operation survived, and manual replay did not duplicate the counter.
- Browser results: 6 scenario checks plus 2 stalled-worker-request checks passed. Two of the six intentionally assert the still-existing missing-retry defect; “8 passed” does not mean all offline/sync requirements are met.
- Local harness/source: `/private/tmp/psat-offline-review-sep08/`. Cloud calls were intercepted; no live student records were accessed. No application code was modified by this review.

### Specific follow-ups for Claude

1. **P1:** wire `ackPersisted`, `pendingOps`, and actual upload completion into student/parent status before calling acknowledgement handling fully complete. Check `writeSyncCursor`'s return as well: cursor-write failures are still only logged and do not appear in the result. Replay remains safe, but persistence status is incomplete.
2. **P1:** implement the retry coordinator, then turn the existing missing-retry reproduction into an eventual-delivery assertion without a manual action.
3. **P2, regression-test gap:** `tests/e2e/localstorage-equivalence.spec.js:315` now accepts any queue length of at least two, provided the last item is an exam and the earlier items are attempts. The fixed scenario creates three practice attempts plus one exam, so dropping two attempts could still pass. Assert all four operations and the expected question/attempt identities rather than a minimum count. The commit description says the test requires exact retention; the assertion does not yet do that.
4. **Documentation:** remove the stale “NOT YET WIRED”/“sw.js does NOT call this” description at `js/shared/sw_routing.js:63`. The helper is now wired and its browser failure is fixed.
5. Continue the remaining package/focused-test, external-dependency, and multi-device items above. The active-exam and live-Cosmos limitations in the original acceptance section still apply.

## Original validation — 2026-09-07

Reviewed 2026-09-07. Base commit: `79e898d635c375836c523eccc79cececefe2bed9`.

**Conclusion:** the local exam/save foundation works, but the current working service-worker changes break cached loading. Reconnect synchronization also needs stronger acknowledgement handling, retries, and visible status before it can be called reliable.

This was a review, not an application fix or deployment. All browser checks used fresh synthetic profiles, the real 3,059-question bundle, a local static server, and intercepted cloud requests. No live student records were read or changed.

## Scope and reproducibility

Service-worker edits appeared during the review, so browser validation used an isolated source snapshot. The reviewed, uncommitted files had these SHA-256 hashes:

- `sw.js`: `d613d2d49ac2d5a992ccf18ec0f12881fc63cebb6fc8c09fea7847d86b00cc52`
- `js/shared/sw_routing.js`: `005925422f6c199880aad8f085533a01e6b3bd70e267ebf3c95a48cad3707a20`

The temporary harness and frozen source are at `/private/tmp/psat-offline-validation/`. They are local diagnostic artifacts, not permanent CI tests. Its sync stub applies the real `api/src/lib/merge.js` rules; it does not emulate Cosmos transactions, shard writes, authentication, or concurrent clients.

At final inspection, concurrent edits had changed `sw.js` again (adding an import cache-buster and a fallback for a missing helper), and the untracked soft-offline browser spec discussed below was no longer present. The timer helper hash remained unchanged: a fallback for a missing helper does not fix the exception inside the present helper. Browser results below refer to the frozen versions, not a certification of those subsequent edits.

## Findings and implementation order

### 1. P1 — Fix the service-worker timer receiver before shipping WI-24

**Where:** `js/shared/sw_routing.js:87–105`, called by `sw.js` navigation and shell handlers.

`raceDeadline` copies native worker timers into an ordinary object and calls `t.setTimeout(...)` / `t.clearTimeout(...)`. Chromium's worker timer requires the worker global as its receiver. The current call throws:

```text
TypeError: Illegal invocation
  at js/shared/sw_routing.js:92:21
  at new Promise (<anonymous>)
  at raceDeadline (js/shared/sw_routing.js:90:12)
```

The prepared exam displayed “Offline-ready,” and both the HTML and question bundle were cached, but offline `page.reload()` failed with `net::ERR_FAILED`. Calling the helper directly inside the real service worker produced the stack above. The helper fails whenever a cached response takes this branch, including online cache hits.

**Required fix:** preserve the native timer receiver, for example with wrapper functions that call the global timers normally. Preserve injected timers for pure tests.

**Diagnostic confirmation:** changing only the default timer wrappers in the temporary source made cold offline reload and the full completion/reconnect scenario pass on desktop and mobile Chromium. The workspace application remains unchanged by this review.

**Test requirement:** retain a real cold-navigation browser test with service workers enabled. The new `tests/e2e/soft_offline.spec.js` comment attributing navigation failure to Playwright interception should be revisited: this reproduction found an actual worker exception, and the same harness navigated successfully after the temporary timer correction. Node's injected-timer tests pass while this browser bug exists.

### 2. P1 — Remove queued work only after explicit, durable acknowledgement

**Where:** `js/engine/sync.js:605–633`; `js/engine/storage.js:1021–1037`.

- A `{success:true, ackOpIds:[]}` response clears every operation sent in that request. An empty acknowledgement must acknowledge nothing. Missing acknowledgement fields should not silently clear a modern client's queue either; any legacy compatibility must use an explicit, documented protocol guarantee.
- An unknown acknowledged ID leaves the real operation queued, but `pushToCloud` still reports the sent queue length as `ackCount`.
- A local storage failure while removing acknowledged operations returns zero from `ackOutboxOps`; the caller ignores that result, advances its cursor, and reports success.

**Measured reproductions:** one queued operation plus an empty acknowledgement produced queue length **0** and reported acknowledgement count **1**. An unrelated ID produced queue length **1** but reported acknowledgement count **1**. Injecting an outbox write failure likewise left **1** queued while reporting success/count **1**.

**Required fix:** intersect acknowledgements with sent operation IDs, check persistence results, report the actual number durably removed, and retain all unconfirmed work. Distinguish server acceptance from failure to persist the local acknowledgement. Preserve safe replay and avoid presenting the whole sync as complete while reconciliation remains pending.

**Acceptance:** empty, missing, partial, duplicate, and unknown acknowledgement lists; storage failure during acknowledgement/cursor writes; an answer added while a push is in flight. No test may remove an unacknowledged operation.

### 3. P1 — Retry pending work after transient failures without requiring another answer

**Where:** `js/pages/student.js:1460–1473`, `triggerCloudSync`, `manualTriggerCloudSync`, and the fetches in `js/engine/sync.js`.

The online event schedules one sync after 2.5 seconds. A temporarily unavailable API causes that attempt to fail, with no retry loop. A new answer, manual action, reload, or another online event may trigger another attempt, but an idle student does not.

**Measured on desktop and mobile:** after the reconnect POST received HTTP 503, the simulated server recovered. Over the next 6.5 seconds POST count stayed **1 → 1**, and **1** operation remained queued. Source inspection confirms there is no delayed retry scheduler. Manual sync then drained it.

**Required fix:** one shared sync coordinator with bounded request timeouts, one in-flight drain, exponential backoff with jitter for retryable failures, and triggers on reconnect, startup, and return to the foreground. Treat `navigator.onLine` as a hint; a captive portal or unavailable API can exist while it is true. Preserve the durable queue through tab closure and reload. Permanent errors should remain visible without a rapid retry loop.

**Acceptance:** fail the first reconnect request, restore the server without another connectivity event or student answer, and verify eventual server acceptance plus a cleared queue. Also test lost responses, hanging GET/POST requests, repeated reconnect events, and tab reopen.

### 4. P1 — Show truthful local-save and cloud-sync status

**Where:** `js/pages/student.js:194–235`, `updateSyncStatusBadge`, and student/parent markup.

Manual sync waits for the GET, starts the POST without awaiting it, then updates sync timestamps/pending indicators and may say all attempts are synchronized. A successful download does not prove the upload succeeded. The student markup also lacks the `hdr-cloud-badge` and `cloud-sync-btn-text` elements that this code tries to update.

**Required fix:** await the complete upload/acknowledgement cycle. Display “Saved on this device,” “N changes waiting to sync,” “Syncing,” “Synced at …,” or an actionable failure. Derive pending status from the durable queue rather than a separate counter reset after GET. Make the same facts visible to parents. A failed local save must be distinguished from a cloud outage.

### 5. P1 — Verify the complete offline package, including parent-built short tests

**Where:** `prepareOfflineExam` in `js/pages/student.js:1370–1420`; `sw.js` shell installation; focused builder/student assignment launch.

The current preparation path always generates a full adaptive exam. It does cache alternate module routes, which is good. It does not prepare the exact 10-/20-question or time-/domain-filtered test selected in the parent builder.

“Offline-ready” currently checks worker readiness and successful image requests. Worker installation skips failed shell assets individually, and the preparation flow does not verify that every essential asset is present. A prepared pin can also outlive a subsequently evicted image cache. `parent.html` is not in the precached shell; navigation fallback serves student `index.html` for any navigation.

**Required fix:** share a prepare operation across full, mini, and focused tests. Pin the exact question IDs, settings, and every possible adaptive branch; verify durable Cache Storage entries for essential HTML/JS/CSS/question data and images. Revalidate readiness before offline start, report missing items, and repair only missing assets. Include cache version/scope in readiness checks. Never delete answers, history, or pending operations to make room.

Decide explicitly whether parents must be able to build tests while already offline. At minimum, a parent-generated assignment prepared online must be available for the student to launch offline with the intended domain and question count.

### 6. P2 — Bound uncached external dependencies on weak connections

**Where:** `sw.js` `staleWhileRevalidate`; `js/shared/sw_routing.js:89`.

The new external-resource handler calls `raceDeadline(network, null, EXTERNAL_DEADLINE_MS)`, but the helper deliberately skips its deadline when no cached response exists. Consequently, the stated two-second limit does not apply to an uncached, hanging CDN request.

**Required fix:** make critical exam dependencies local, and let optional uncached external resources fail within a bounded interval. Test an empty external cache with a hanging request; an already-open page or a cached same-origin JS probe is insufficient evidence of a usable cold load.

### 7. P1 for a no-loss, multi-device guarantee — Finish event-level sync protection

**Where:** existing DATA-01 notes in `api/src/lib/merge.js`, and `api/src/functions/sync.js` read/plan/upsert flow.

Single-device replay worked in this review. That does not prove two devices can independently answer offline and both retain every attempt. Current aggregate merging uses maxima; two distinct attempts can produce equal counters and collapse. The API returns operation IDs as acknowledgements, but this alone is not a durable, deduplicated event ledger or a concurrency check.

**Required follow-up:** stable attempt IDs, durable deduplication, conflict-safe writes, and deterministic rebuilding/merging of progress and SRS. Reuse the existing data-integrity plan rather than introducing another competing representation. Test two devices from the same starting state, different answers to the same question, reversed upload order, concurrent writes, and replay after a lost response. Preserve both attempts and deterministic SRS results.

## What actually passed

| Check | Result and limit |
| --- | --- |
| Existing offline helper suite | 39 checks passed against the real 3,059-question bundle. |
| Existing storage/sync suite | Passed, including local migrations, interrupted acknowledgements, and delta/full merges. This does not cover all findings above. |
| Current worker Node suite | 17 routing checks and 6 deadline checks passed despite the real worker timer exception. |
| Current uncorrected worker cold reload | Failed; worker stack identified the timer receiver error. |
| Temporary timer correction: desktop and mobile | Both cold-loaded offline, displayed five cached question images, retained five answers through another offline reload/resume, and completed all four modules. Each produced one 98-question report with five answered questions; the rest were intentionally skipped. |
| Completion upload after reconnect | In both corrected-copy runs, the simulated server received one report and five progress entries; queue reached zero. Repeating sync kept one report and each attempt counter at one. |
| Lost server response | On both viewports, the operation remained queued after the simulated server accepted the write but lost its response. Manual retry cleared the queue without double-counting. |
| Server briefly unavailable after reconnect | Reproduced the missing-retry defect on both viewports; manual retry recovered. |

The temporary browser run reported **6 passed**: two successful completion/reconnect tests, two lost-response recovery tests, and two tests that intentionally assert the existing missing-retry defect. This is not a clean bill of health for the unmodified app.

## Release acceptance and operating limits

- Add the failure cases above to permanent tests using the repository's quarantined browser fixtures. Keep a dedicated local-only service-worker-enabled configuration: `playwright.local.config.js` blocks workers and excludes `offline_exam.spec.js`. A soft-offline spec also needs a configuration that actually permits its worker.
- Strengthen the existing offline exam test: finish a report and verify accepted answer/report/SRS content, not just an increase in POST count. Its current five-answer unfinished exam remains in local active-exam storage; `buildSyncDelta` does not include that snapshot.
- Treat unfinished exam resume as **same-browser/device** unless checkpoint sync is explicitly implemented. Show that distinction. Protect question answers, elapsed time, module route, and completion recovery through storage failures and reloads.
- Reconnect sync presently requires the app to be running or reopened. No background-sync registration was found. If synchronization while the browser is closed is desired, define supported platforms and add a durable background-capable queue; do not promise it from an `online` event listener.
- Validate real offline/weak-network startup on the student's actual browser/device and a safe deployment lane after automated tests pass. Test cached-worker upgrades and scoped deployments as well. Mobile Chromium emulation here is not an iPhone/Safari check.
- Before merging implementation that touches sync/storage/API, follow `CLAUDE.md` backup preflight and restore requirements. Use a dedicated test identity for any later live integration check. This review did not change infrastructure, clear a real profile, migrate records, or deploy code.
