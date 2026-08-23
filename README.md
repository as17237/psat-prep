# PSAT Prep Mastery Platform

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
├── srs.js                          # Core Spaced Repetition (SM-2) & Grading Engine
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

## 🌐 Live Azure Production Deployment

- **Student Practice & Analytics Portal**: [https://psatprep4915.z13.web.core.windows.net/index.html](https://psatprep4915.z13.web.core.windows.net/index.html)
- **Parent Oversight & Progress Dashboard**: [https://psatprep4915.z13.web.core.windows.net/parent.html](https://psatprep4915.z13.web.core.windows.net/parent.html)
- **Azure Resource Group**: `rg-psat-prep`
- **Storage Account**: `psatprep4915`
