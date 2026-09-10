# PSAT Prep

A static PSAT 8/9 practice app with a 3,059-question bank, adaptive mock exams,
focused tests, spaced repetition, and student/parent reports. The browser app uses
native JavaScript modules without a build step. Azure Functions provides cloud sync.

## Start here

Read [CLAUDE.md](CLAUDE.md) for coding and data-preservation rules. The current
release work and verification evidence are in
[Offline sync validation](docs/OFFLINE_SYNC_VALIDATION.md). Recovery procedures live
in the [disaster recovery runbook](docs/DISASTER_RECOVERY_RUNBOOK.md); the completed
portal cutover is recorded in [CUTOVER_REPORT.md](docs/CUTOVER_REPORT.md).

```sh
npm ci
npm ci --prefix api
npx playwright install chromium
python3 -m pip install -r requirements.txt
python3 -m http.server 8080
```

Open `http://localhost:8080/index.html` for the student, `parent.html` for the parent,
or `mistakes.html` for remediation. For automated testing, use the quarantined
fixtures below: a normal local browser can still reach the configured cloud API.

## Active interfaces

- `js/engine/` contains pure grading, scoring, generation, scheduling, persistence,
  and sync logic. `srs.js` exposes the tested public facade in Node and the browser.
- `js/pages/` owns page behavior; `js/shared/` owns common storage, sync, and UI logic.
  Add runtime modules to both `sw.js` and `scripts/lib/deploy_common.sh`.
- `api/src/functions/` exposes the cloud endpoints; `api/src/lib/` owns merge and
  storage contracts. Client/server ordering rules must agree.
- `data/*.json`, `data/questions_data.js`, and `data/images/` are the frozen question
  bank. Source PDFs are optional for tests; recovery locations are in the runbook.
- `psat_*` local storage keys and cloud identities are persistent interfaces.
  Preserve recovery journals, backups, and unacknowledged outbox operations.

Standard adaptive mocks have 98 questions in modules of 27/27/22/22. The parent
Exam Builder supports domains, skills, question count, and available time. Focused
practice is non-adaptive. Score estimates require at least 15 answered questions
per section and 30 total. Short-test estimates are labeled separately and do not
enter full-mock score trends.

Timed modules can pause and resume across reloads. Completed reports record pause
count and time away. In-progress exams remain on their originating device/browser;
completed reports and practice records upload when connectivity returns. Preparing
an exam for offline use caches its question images as well as the app shell.

## Verification

```sh
npm test
npm run test:e2e
python3 -m unittest test_extractor.py -v
```

`npm test` discovers offline Node suites. `npm run test:e2e` runs desktop and mobile
against a local server with synthetic profiles and an intercepted sync API. Every
browser spec must import `tests/e2e/fixtures.js`. The separate `v2smoke` project and
live integrity commands require explicit operational setup; they are not part of
the offline test command.

## Release and recovery

Stage a candidate with `scripts/deploy_v2.sh --dry-run --keep-staging` and inspect
its file manifest. The `/v2/` deployment is isolated from the production root.
Production promotion uses `scripts/promote_to_prod.sh`; first run the required
backup/restore gates and preserve a current web rollback manifest. API releases
need their own rollback package. See the runbook for exact procedures and the
validation document for this candidate's verified scope and release status.

Never run data-reset, shard migration, or compaction tools on a live student as a
deployment convenience. Operational backups and rollback evidence are retained
independently of documentation cleanup.
