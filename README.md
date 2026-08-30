# PSAT Prep Mastery Platform

> **🔧 Active refactor in progress.** If you are picking this project up — on a new machine or as a new agent — read **[CONTINUE_HERE.md](CONTINUE_HERE.md)** first: setup, live Azure resources, work-item status, safety rules, and the next actions. Plans live in [REFACTOR_PLAN.md](REFACTOR_PLAN.md), current status in [REFACTOR_STATE.md](REFACTOR_STATE.md), and binding coding rules in [CLAUDE.md](CLAUDE.md).

An advanced, dependency-free PSAT preparation and mastery system featuring spaced repetition (SRS), empirical skill analytics, parent oversight dashboards, and official question card rendering with 100% mathematical and reading chart fidelity.

---

## 🚀 Key Features

1. **Complete Question Bank (3,059 Questions)**:
   - **Reading & Writing (ELA)**: 1,554 validated questions across 4 domains (99.9% text-complete).
   - **Math**: 1,505 validated questions across 4 domains (40.2% text-complete, 100% visual card complete).
2. **100% Visual Card Fidelity**:
   - Official un-spoiled question cards rendered directly from College Board Question PDFs.
   - Preserves all vector formulas, coordinate grids, and reading charts with zero spoilers.
3. **Spaced Repetition System (SRS)**:
   - SuperMemo SM-2 algorithm implemented in `srs.js` with visibility-aware response time grading ($<45\text{s}$ vs $45\text{s}-90\text{s}$ vs $>90\text{s}$).
   - Includes "Review Due Today" practice filter.
4. **Robust Free-Response (SPR) Grading**:
   - Parses fractions (`5/2`, `-49/150`), decimals (`2.5`), and multi-form accepted keys (`.2, 1/5`, `14.66, 14.67, 44/3`).
5. **Parent Oversight & Empirical Analytics Portal**:
   - PSAT 8/9 scaled score forecaster (240–1440 scale, 120–720 per section).
   - Real study streak, weekly practice duration, domain mastery progress, and knowledge gap alerts.
6. **Azure Cloud-Native Architecture**:
   - Ready for Azure Cosmos DB (Serverless NoSQL) + Azure Blob Storage & CDN + Azure Static Web Apps.

---

## 📁 Repository Structure

```
├── data/
│   ├── ela_questions.json          # 1,554 ELA questions
│   ├── math_questions.json         # 1,505 Math questions
│   ├── questions_data.js           # Combined client bundle (3,059 questions)
│   └── images/                     # 3,059 high-resolution question card PNGs
├── index.html                      # Student Practice & Analytics Portal
├── parent.html                     # Parent Oversight & Progress Dashboard
├── srs.js                          # UMD facade — recomposes js/engine/* into PSAT_ENGINE
├── js/
│   ├── engine/                     # The engine, split by concern (WI-10). Load order:
│   │   ├── grading.js              #   free-response grading, rationales, calculator
│   │   ├── scheduler.js            #   SM-2 scheduling, daily sessions, streaks
│   │   ├── scoring.js              #   scaled scores, blueprints, exam scoring, error tags
│   │   ├── storage.js              #   snapshots, outbox, demo guards, lean reports
│   │   ├── examgen.js              #   adaptive MST exams, mini exams, drills
│   │   └── sync.js                 #   cloud sync client + field-level merge
│   ├── shared/                     # Shared page helpers (WI-09)
│   └── pages/                      # Per-page ES-module controllers (WI-09)
├── extractor.py                    # Multi-core PDF parser & image renderer
├── validator.py                    # Dataset validation engine
├── rebuild_bundle.py               # Fast zero-PDF bundle generator
├── test_extractor.py               # Portable Python unit & integration tests
├── tests/
│   ├── fixtures/                   # Small text fixtures for offline CI testing
│   ├── test_free_response.js       # Free-response grading unit tests
│   ├── test_srs.js                 # Spaced repetition SM-2 unit tests
│   └── test_dataset_free_response.js
├── upload_to_azure.py              # Azure Cosmos DB & Blob Storage migration script
├── SYSTEM_ARCHITECTURE_AND_PLAN.md # Full technical specification
├── AGENT_HANDOFF.md                # Quick briefing for AI coding agents
└── requirements.txt                # Python dependencies
```

---

## 🛠️ Quick Start

### 1. Launch the Application Locally
Run a lightweight HTTP server:
```bash
python3 -m http.server 8080
```
- Open **Student App**: `http://localhost:8080/index.html`
- Open **Parent Portal**: `http://localhost:8080/parent.html`

### 2. Run the Test Suites
```bash
# Python parser and validator tests (portable, no PDFs needed)
python3 -m unittest test_extractor.py -v

# Node.js grading and SM-2 tests
node tests/test_free_response.js
node tests/test_srs.js
node tests/test_dataset_free_response.js
```

### 3. Deploy to Azure
See [SYSTEM_ARCHITECTURE_AND_PLAN.md](SYSTEM_ARCHITECTURE_AND_PLAN.md) for full Azure Cosmos DB, Blob Storage, and Azure Static Web Apps deployment instructions.

---

## 🌐 Live Azure Deployments & Dual-Version Environment

Both environments share the **exact same live Azure Cosmos DB database** (`student_default_student`). Any exam or practice completed in either environment instantly syncs and reflects in both portals:

- **🟢 Production (Stable v1.0)**:
  - **Student Portal**: [https://psatprep4915.z13.web.core.windows.net/index.html](https://psatprep4915.z13.web.core.windows.net/index.html)
  - **Parent Analytics**: [https://psatprep4915.z13.web.core.windows.net/parent.html](https://psatprep4915.z13.web.core.windows.net/parent.html)
  - **Mistake Review Center**: [https://psatprep4915.z13.web.core.windows.net/mistakes.html](https://psatprep4915.z13.web.core.windows.net/mistakes.html)
- **🟡 Beta / Preview Environment**:
  - **Student Portal**: [https://psatprep4915.z13.web.core.windows.net/beta/index.html](https://psatprep4915.z13.web.core.windows.net/beta/index.html)
  - **Parent Analytics**: [https://psatprep4915.z13.web.core.windows.net/beta/parent.html](https://psatprep4915.z13.web.core.windows.net/beta/parent.html)
  - **Mistake Review Center**: [https://psatprep4915.z13.web.core.windows.net/beta/mistakes.html](https://psatprep4915.z13.web.core.windows.net/beta/mistakes.html)

---

## ⚡ 7-Week High-Yield Sprint Mode (Mid-October Target)

When time is limited and the student cannot complete all 3,059 questions before the mid-October test, the engine supports **High-Yield Sprint Prioritization**:
- Prioritizes **Upper-Track Gateway questions** (Hard & Medium difficulty).
- Weights the highest-frequency College Board domains first:
  - **Math**: *Algebra* (35%) & *Advanced Math* (32%).
  - **Reading & Writing**: *Information & Ideas* (26%) & *Craft & Structure* (28%).
- Can be toggled on demand in the test generator or via URL parameter `&highyield=true`.

---

## 💾 Automated Cloud Backups & Disaster Recovery

Progress is continuously protected by redundant automated backups:

1. **Daily Automated Cloud Timer Backup**:
   - **Trigger**: Runs every night at `02:00 UTC` (`0 0 2 * * *`) via Azure Function App `psat-api-4915` (`backup.js`).
   - **Target**: Stored off-machine in Azure Blob Storage container `cosmos-backups` in `psatprep4915`.
   - **Retention**: Preserves timestamped archives `cosmos_backup_YYYY-MM-DDTHH-mm-ss-sssZ.json` and updates `cosmos_backup_latest.json`.
2. **On-Demand Cloud Backup Trigger**:
   - Trigger an immediate cloud snapshot via HTTP `POST` or `GET`:
     ```bash
     curl -X POST https://psat-api-4915.azurewebsites.net/api/backup
     ```
3. **Local CLI Backup & Guarded Restore**:
   ```bash
   # Export live Cosmos DB snapshot locally
   node scripts/backup_cosmos.js

   # Verify backup in dry-run mode (does not modify DB)
   node scripts/restore_cosmos.js

   # Execute live restore to Cosmos DB
   node scripts/restore_cosmos.js --apply
   ```

---

## 🏗️ Cloud Infrastructure (Resource Group: `rg-psat-prep`)

- **Azure Storage Account**: `psatprep4915` (Static website hosting in `$web`, backup archives in `cosmos-backups`)
- **Azure Cosmos DB**: `psat-cosmos-15958` (Database: `psat-prep-db`, Container: `UATStudentAnswers`)
- **Azure Functions API**: `psat-api-4915` (Sync endpoint `/api/syncStudentAnswers`, backup endpoint `/api/backup`, feedback endpoint `/api/submitFeedback`)

