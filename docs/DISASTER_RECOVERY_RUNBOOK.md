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
