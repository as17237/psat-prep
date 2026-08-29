# 🛡️ PSAT 8/9 Prep — Disaster Recovery Runbook & Backup Integrity Guide

**Document Version:** 1.0  
**Effective Date:** 2026-08-28  
**Scope:** Azure Cosmos DB (`psat-prep-db`), Azure Blob Storage (`cosmos-backups`), and Client-Side Browser Storage (`localStorage` / `sessionStorage`).

---

## 1. Overview & Data Topologies

The PSAT 8/9 Prep system uses a three-tier disaster recovery architecture designed for zero data loss and multi-layer isolation:

```
[ Tier 1: Client Storage (Browser) ]
      │  • Safety Snapshots (Pre-action transactional rollback)
      │  • Durable Sync Outbox (Offline write-ahead queue)
      ▼
[ Tier 2: Live Cloud DB (Azure Cosmos DB) ]
      │  • Database: psat-prep-db
      │  • Containers: UATStudentAnswers, UATFeedback
      ▼
[ Tier 3: Immutable Archive (Azure Blob Storage) ]
      │  • Container: cosmos-backups
      │  • Checksummed Archives (.json + .json.sha256 sidecars)
      │  • Scheduled Daily CRON (02:00 UTC)
```

---

## 2. Backup Formats & SHA-256 Checksum Integrity

Every backup produced by the Azure Function (`api/src/functions/backup.js`) or the local CLI (`scripts/backup_cosmos.js`) creates two artifacts:
1. **Data JSON Payload**: `cosmos_backup_YYYY-MM-DDTHH-mm-ss-sssZ.json`
2. **SHA-256 Checksum Sidecar**: `cosmos_backup_YYYY-MM-DDTHH-mm-ss-sssZ.json.sha256`

### Checksum Verification Rule
The restore utility (`scripts/restore_cosmos.js`) automatically reads the `.sha256` sidecar, calculates the SHA-256 hash of the payload buffer, and compares them before reading any documents.
* If the computed hash does not match the sidecar, restore **aborts with a hard failure** without touching the live database.
* If zero valid documents are found in the payload, restore **aborts immediately**.

---

## 3. Disaster Scenarios & Recovery Procedures

### Scenario 1: Accidental Student Profile Deletion or Reset

**Trigger:** Student or parent accidentally resets progress or overwrites local browser profile.

#### Recovery Steps:
1. **Client-Side Instant Rollback (if within browser session):**
   - Open Parent Dashboard → **Data Management & Audit** section.
   - Click **"Restore from Pre-Action Safety Snapshot"**.
   - Select the most recent timestamped snapshot prior to the reset.
2. **Cloud Pull (if local storage was completely cleared):**
   - Open Student App or Parent Dashboard.
   - Click **"Cosmos DB Sync"** (`PSAT_ENGINE.pullFromCloud`).
   - The app fetches master student profile, SRS memory states, and exam histories from Cosmos DB.

---

### Scenario 2: Data Corruption or Schema Incompatibility

**Trigger:** A buggy build writes malformed documents to Cosmos DB or corrupts exam history records.

#### Recovery Steps:
1. **Identify the Last Known Healthy Backup:**
   ```bash
   # List available local backups
   ls -la backups/cosmos_backup_*.json
   
   # Or download latest cloud backup from Azure Blob Storage
   ACCOUNT_KEY=$(az storage account keys list --resource-group rg-psat-prep --account-name psatprep4915 --query '[0].value' -o tsv)
   az storage blob download --account-name psatprep4915 --account-key "$ACCOUNT_KEY" --container-name cosmos-backups --name cosmos_backup_latest.json --file backups/cosmos_backup_latest.json
   az storage blob download --account-name psatprep4915 --account-key "$ACCOUNT_KEY" --container-name cosmos-backups --name cosmos_backup_latest.json.sha256 --file backups/cosmos_backup_latest.json.sha256
   ```

2. **Execute Dry-Run Validation:**
   ```bash
   node scripts/restore_cosmos.js backups/cosmos_backup_latest.json
   ```
   *Verify that SHA-256 checksum integrity passes and document count matches expectations.*

3. **Execute Live Restore with Automated Pre-Restore Safety Snapshot:**
   ```bash
   node scripts/restore_cosmos.js backups/cosmos_backup_latest.json --apply
   ```
   *Note: `--apply` creates an atomic pre-restore snapshot (`pre_restore_snapshot_<timestamp>.json`) before writing any documents.*

---

### Scenario 3: Complete Database Loss or Azure Account Re-creation

**Trigger:** Cosmos DB account was deleted, deprovisioned, or migrated to a new Azure subscription.

#### Recovery Steps:
1. **Provision New Cosmos DB Resource & Containers:**
   ```bash
   # Create Cosmos DB Account (if needed)
   az cosmosdb create --name psat-cosmos-recovery --resource-group rg-psat-prep --default-consistency-level Session

   # Create Database
   az cosmosdb sql database create --account-name psat-cosmos-recovery --resource-group rg-psat-prep --name psat-prep-db

   # Create Containers with partition keys
   az cosmosdb sql container create --account-name psat-cosmos-recovery --resource-group rg-psat-prep --database-name psat-prep-db --name UATStudentAnswers --partition-key-path "/student_name"
   az cosmosdb sql container create --account-name psat-cosmos-recovery --resource-group rg-psat-prep --database-name psat-prep-db --name UATFeedback --partition-key-path "/student_name"
   ```

2. **Restore Data from Blob Storage Archive:**
   ```bash
   COSMOS_ENDPOINT="https://psat-cosmos-recovery.documents.azure.com:443/" \
   node scripts/restore_cosmos.js backups/cosmos_backup_latest.json --apply
   ```

3. **Update Azure Static Web Apps Backend Application Settings:**
   ```bash
   NEW_CONN_STRING=$(az cosmosdb keys list --name psat-cosmos-recovery --resource-group rg-psat-prep --type connection-strings --query 'connectionStrings[0].connectionString' -o tsv)
   
   az staticwebapp appsettings set --name psat-prep-swa --setting-names COSMOS_CONNECTION_STRING="$NEW_CONN_STRING"
   ```

---

## 4. Verification & Health Check Commands

After completing any restore procedure, execute the test suite to verify end-to-end integrity:

```bash
# 1. Run Complete Automated Unit & Integration Test Suite
node tests/test_srs.js && \
node tests/test_backup_restore.js && \
node tests/test_free_response.js && \
node tests/test_dataset_free_response.js && \
python3 -m unittest test_extractor.py -v

# 2. Trigger an On-Demand Cloud Backup to Confirm Function Health
curl -s -X POST https://psatprep4915.azurewebsites.net/api/backup | jq .
```

---

## 5. Full-Baseline Restore Verification (EXECUTED — WI-03)

> **This section documents a procedure that was actually run end to end on
> 2026-08-29, not a theoretical one.** Every count, timing and checksum below is a
> measurement taken during that run. Production (`psat-prep-db`) was never written to;
> the restore target was the throwaway database `psat-prep-db-drtest`, which was
> deleted afterwards.

### 5.1 What this proves

Sections 1–4 cover restoring the *nightly* backup, whose scope is only
`UATStudentAnswers` + `UATFeedback`. WI-02 added a **full-scope baseline snapshot**
(all three Cosmos containers, all 3,059 question images, the data bundle and sources)
in the private blob container `refactor-baseline`. Until WI-03 that snapshot had never
been restored, so "we have a backup" was an assumption. It is now a measurement.

**Baseline folder verified:** `refactor-baseline/baseline_2026-08-29T14-09-29Z`
(git SHA `08a5dd1aaed12d3516c4a1f2bd1a83804fbaa4d5`). The container also holds two
superseded folders from earlier WI-02 runs (`…13-34-25Z`, `…14-05-17Z`) — **ignore
them, never delete them.** Set `BASELINE_FOLDER` to restore a different one.

### 5.2 Tooling

| Script | Role |
| :-- | :-- |
| `scripts/restore_baseline_to_scratch.js` | Downloads + checksum-verifies the three exports, creates `psat-prep-db-drtest` with the production partition keys, inserts every document (system fields stripped). |
| `scripts/reconcile_restore.js` | **Independently** re-downloads and re-verifies the exports, reads the scratch DB back, and deep-compares. Also byte-compares 20 random baseline images against their live `$web` originals. Exits nonzero on any discrepancy. |

Both scripts share one guard, `assertScratchTarget()`. It throws unless the target
database is exactly `psat-prep-db-drtest`, and names `psat-prep-db` explicitly as a
refusal case. It is called before any Azure client is constructed and again before
every database- and container-level write, so there is no code path in which this
tooling can write to production.

### 5.3 Prerequisites

```bash
az login                                     # subscription 580d0d70-855b-45b2-b471-3024eefa2bb7
export AZURE_STORAGE_ACCOUNT=psatprep4915
export AZURE_STORAGE_KEY=$(az storage account keys list \
  --account-name psatprep4915 --resource-group rg-psat-prep --query '[0].value' -o tsv)
export COSMOS_KEY=$(az cosmosdb keys list \
  --name psat-cosmos-15958 --resource-group rg-psat-prep --query primaryMasterKey -o tsv)
```

Secrets go into the environment only — **never onto a command line**, where `ps aux`
exposes them to any local user for the lifetime of the process.

### 5.4 Step 0 — offline safety check (no credentials needed)

```bash
node scripts/restore_baseline_to_scratch.js --assert-test
node scripts/reconcile_restore.js --assert-test
```

Observed: 7/7 assertions pass in each, exit 0. The guard rejects `psat-prep-db`,
`"psat-prep-db "`, `PSAT-PREP-DB-DRTEST`, `""`, `undefined` and `psat-prep-db-drtest2`,
and accepts only `psat-prep-db-drtest`.

### 5.5 Step 1 — restore (observed 2026-08-29T14:32:18Z)

```bash
node scripts/restore_baseline_to_scratch.js
```

| Phase | Observed |
| :-- | :-- |
| Download + sha256 verify `Questions.json` | 3,059 docs · 7,879,599 B · `4512ba8cb2a7…` · 2.7 s |
| Download + sha256 verify `UATStudentAnswers.json` | 10 docs · 532,342 B · `883c7bbadae5…` · 0.3 s |
| Download + sha256 verify `UATFeedback.json` | 0 docs · 211 B · `683184552bfa…` · 0.1 s |
| Create database `psat-prep-db-drtest` | 0.1 s |
| Create containers | `Questions` `/domain` 0.5 s · `UATStudentAnswers` `/student_name` 0.4 s · `UATFeedback` `/category` 0.5 s |
| Insert `Questions` | **3,059 / 3,059** in 9.3 s (329.4 docs/s, concurrency 20, zero 429 retries needed) |
| Insert `UATStudentAnswers` | **10 / 10** in 0.4 s |
| Insert `UATFeedback` | **0 / 0** |
| Post-insert `SELECT VALUE COUNT(1)` in scratch | 3059 · 10 · 0 |
| **Total wall clock** | **15.6 s** |

Checksums are verified **before the JSON is parsed**; a mismatch aborts without
creating the database. Cosmos system fields (`_rid`, `_self`, `_etag`, `_attachments`,
`_ts`) are stripped before insert, since Cosmos regenerates them.

### 5.6 Step 2 — reconcile (green)

```bash
node scripts/reconcile_restore.js     # exit 0
```

```
  containers checked : 3/3
  Questions          docs 3059/3059  missing 0  extra 0  deep-equal failures 0
  UATStudentAnswers  docs 10/10      missing 0  extra 0  deep-equal failures 0
  UATFeedback        docs 0/0        missing 0  extra 0  deep-equal failures 0
  deep-equal failures (all containers): 0
  missing: 0   extra: 0
  images  : 20/20 byte-identical (of 3059 baseline blobs)
  elapsed : 10.3s
  RESULT  : PASS — restored scratch DB matches the baseline exactly.
```

Partition keys read back from the scratch DB were `["/domain"]`, `["/student_name"]`,
`["/category"]` — identical to production. Image verification downloads both copies in
full and compares buffers (`Buffer.equals`), not just Content-MD5 metadata.

### 5.7 Step 3 — the red demonstration (MANDATORY, do not skip)

A reconciler that has never been seen to fail is not evidence (CLAUDE.md failure mode
4). Corrupt exactly one field on exactly one document in the **scratch** DB and confirm
the reconciler catches precisely that one:

```bash
# in the scratch DB only: set Questions/139f1b75 .difficulty = 'CORRUPTED-BY-WI03-RED-TEST'
node scripts/reconcile_restore.js ; echo "exit=$?"
```

Observed — one document, one field, correctly localised, and a nonzero exit:

```
[Questions]  pk=/domain
  counts: baseline 3059 / restored 3059
  missing … 0
  extra   … 0
  deep-equal failures: 1
    - MISMATCH id=139f1b75
        difficulty: "Hard" -> "CORRUPTED-BY-WI03-RED-TEST"
…
  deep-equal failures (all containers): 1
  RESULT  : FAIL — 1 problem(s):
     • Questions: 1 document(s) failed deep equality
exit=1
```

Repairing that document from the checksum-verified baseline export and re-running
returned the suite to green (`deep-equal failures 0`, images `20/20`, exit 0).

The checksum guard was likewise proven to fail red, offline, with an injected fake blob
client: one flipped byte, a missing sidecar, a sidecar naming a different file, and an
`exportedCount` that disagrees with the document array each abort with a hard error
rather than restoring unverified data.

### 5.8 Step 4 — teardown (mandatory)

The scratch database is a full second copy of the question bank. Delete it as soon as
the reconcile is green — by **literal name only**, never the account, never
`psat-prep-db`, and never any blob:

```bash
az cosmosdb sql database delete \
  --account-name psat-cosmos-15958 --resource-group rg-psat-prep \
  --name psat-prep-db-drtest --yes

az cosmosdb sql database list \
  --account-name psat-cosmos-15958 --resource-group rg-psat-prep --query '[].name' -o tsv
# MUST print exactly: psat-prep-db
```

Observed after the 2026-08-29 run: the list printed `psat-prep-db` and nothing else.

### 5.9 Cadence

Re-run this whole cycle (restore → reconcile → teardown) **weekly for the duration of
the refactor, and after every phase boundary in `REFACTOR_PLAN.md` §6.** A backup whose
last proven restore is months old is an assumption again.

**WI-05 will wrap §5.5–5.8 in `scripts/weekly_restore_check.sh` as a single command.**
Until that exists, run the four steps above by hand and record the counts. A run that
does not include the red demonstration (§5.7) does not count as a verification.

