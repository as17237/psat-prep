# PSAT Prep Mastery Platform

An advanced, HTML-based PSAT preparation and mastery system featuring spaced repetition (SRS), granular skill analytics, parent oversight dashboards, and official question card rendering with 100% mathematical and reading chart fidelity.

---

## 🚀 Key Features

1. **Complete Question Bank (3,059 Questions)**:
   - **Reading & Writing (ELA)**: 1,554 validated questions across 4 domains.
   - **Math**: 1,505 validated questions across 4 domains (Algebra, Advanced Math, Problem-Solving, Geometry).
2. **100% Visual Fidelity (Zero Dropped Formulas or Spoilers)**:
   - Official un-spoiled question cards rendered directly from Question PDFs.
   - Clean structured text & options for interactive search, scoring, and analytics.
3. **Spaced Repetition System (SRS)**:
   - SuperMemo SM-2 algorithm customized for PSAT/SAT to target retention decay and lock hard concepts into long-term memory.
4. **Parent Oversight & Analytics Portal**:
   - Projected scaled score forecast (320–1520), weekly habit tracking, knowledge gap alerts, and test audit logs.
5. **Azure Cloud-Native Architecture**:
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
├── extractor.py                    # Multi-core PDF parser & image renderer
├── validator.py                    # Dataset validation engine
├── test_extractor.py               # Automated unit tests
├── extract_questions.py            # Extraction CLI
├── upload_to_azure.py              # Azure Cosmos DB & Blob Storage migration script
├── SYSTEM_ARCHITECTURE_AND_PLAN.md # Full technical specification & LLM developer guide
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

### 2. Run the Test Suite
```bash
python3 test_extractor.py
```

### 3. Re-run or Customize Extraction
```bash
# Extract both ELA and Math with 4 parallel worker processes
python3 extract_questions.py --subject all --workers 4
```

### 4. Deploy to Azure
See [SYSTEM_ARCHITECTURE_AND_PLAN.md](SYSTEM_ARCHITECTURE_AND_PLAN.md) for full Azure Cosmos DB, Blob Storage, and Azure Static Web Apps deployment instructions.
