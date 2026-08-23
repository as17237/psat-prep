# PSAT Prep Mastery — LLM Agent Handoff & Review Document

> **Target Audience**: Any AI Coding Assistant / LLM Agent resuming or reviewing this project.
> **Project Goal**: Build a high-performance PSAT/SAT test preparation, spaced repetition, and analytics platform targeting a **1500+ near-perfect score**.

---

## 1. Project Context & Current State

- **Source Question Banks**: College Board Question Bank PDFs (`ELA1.pdf`, `ELA1A.pdf`, `MATH1.pdf`, `MATH1A.pdf`).
- **Extraction State**: **100% Complete & Validated**.
  - Total Questions: **3,059** (1,554 Reading & Writing + 1,505 Math).
  - High-Resolution Un-spoiled Question Cards: **3,059 images** in `data/images/*.png`.
  - Zero dropped formulas, diagrams, or reading charts (rendered as vector-exact card images).
- **Test Suite Status**: `test_extractor.py` (9/9 unit tests passing, execution time ~1.2s).
- **Validation Engine**: `validator.py` (100.0% validation rate across all schema, option key, answer, and asset rules).

---

## 2. Key File Map & Roles

| File / Directory | Purpose & Role |
| :--- | :--- |
| [`data/ela_questions.json`](data/ela_questions.json) | 1,554 validated Reading & Writing questions with full metadata, options, answers, and rationales. |
| [`data/math_questions.json`](data/math_questions.json) | 1,505 validated Math questions (1,140 Multiple Choice + 365 Free Response). |
| [`data/questions_data.js`](data/questions_data.js) | Unified client-side bundle containing all 3,059 questions for instant browser execution without CORS hurdles. |
| [`data/images/`](data/images/) | 3,059 rendered question card PNGs (multi-page questions stitched seamlessly). |
| [`index.html`](index.html) | **Student Practice & Analytics Portal** (Dual-mode Visual Card / Text, live grading, collapsible rationales, Chart.js analytics, fast pagination). |
| [`parent.html`](parent.html) | **Parent Oversight & Score Forecaster Portal** (Projected scaled score 320–1520, weekly study meter, knowledge gap alert matrix, missed question audit). |
| [`extractor.py`](extractor.py) | High-performance multi-core PDF parsing and image rendering engine (`pypdfium2` + `Pillow`). |
| [`validator.py`](validator.py) | Automated validation engine checking schema, choice integrity (`A-D`), answer keys, rationale length, and image dimensions. |
| [`test_extractor.py`](test_extractor.py) | `unittest` test suite testing ground truth on sample questions and corrupt-data detection. |
| [`extract_questions.py`](extract_questions.py) | Batch extraction CLI (`--subject all --workers 4`). |
| [`upload_to_azure.py`](upload_to_azure.py) | Migration script for Azure Cosmos DB and Azure Blob Storage. |
| [`SYSTEM_ARCHITECTURE_AND_PLAN.md`](SYSTEM_ARCHITECTURE_AND_PLAN.md) | Full architectural blueprint, Cosmos DB schema design, SRS algorithms, and deployment guide. |
| [`README.md`](README.md) | Standard GitHub quickstart and repository documentation. |

---

## 3. Core Architecture Decisions

### 3.1 Azure Cosmos DB vs. Relational
- **Choice**: **Azure Cosmos DB (Serverless NoSQL)** + **Azure Blob Storage**.
- **Reasoning**: Question items are polymorphic (MCQ with 4 choices vs. Free Response with numeric strings; variable passage/chart lengths). NoSQL avoids complex join queries across questions, attempts, and session logs.
- **Partition Keys**:
  - `Questions` container: `/domain`
  - `SpacedRepetitionCards` container: `/user_id`
  - `TestSessions` container: `/user_id`
  - `SkillMastery` container: `/user_id`

### 3.2 Spaced Repetition (SRS) Algorithm (SM-2 Modified for PSAT)
- **Response Grading ($q \in [1..5]$)**:
  - $q = 1$: Incorrect $\rightarrow$ Reset interval to 1 day, reduce Ease Factor ($EF - 0.2$), schedule for next day's due queue.
  - $q = 3$: Correct with hesitation ($>90\text{s}$) $\rightarrow$ Interval = 1 day, $EF - 0.14$.
  - $q = 4$: Correct normal ($45\text{s}-90\text{s}$) $\rightarrow$ Interval = $I \times EF$.
  - $q = 5$: Correct fast ($<45\text{s}$) $\rightarrow$ Interval = $I \times EF \times 1.15$, $EF + 0.10$.
- **Ease Factor Formula**:
  $$EF' = \max\left(1.3, \, EF + (0.1 - (5 - q) \times (0.08 + (5 - q) \times 0.02))\right)$$

---

## 4. Development & Operation Commands

```bash
# 1. Start local web server
python3 -m http.server 8080

# 2. Run automated test suite
python3 test_extractor.py

# 3. Run validation on existing dataset
python3 -c "import json; from validator import validate_dataset; q = json.load(open('data/ela_questions.json')) + json.load(open('data/math_questions.json')); print(validate_dataset(q, base_image_dir='data/images'))"

# 4. Re-run batch extraction (if needed)
python3 extract_questions.py --subject all --workers 4

# 5. Upload to Azure
python3 upload_to_azure.py --cosmos-conn "<CONN>" --blob-conn "<CONN>"
```

---

## 5. Next Steps for Incoming LLM Agent / Developer

1. **Backend Integration (Optional)**: If migrating from client-side `localStorage` to cloud auth:
   - Implement Azure Functions backend (`src/backend/function_app.py`) for user registration, multi-student profiles, and server-side SRS syncing.
2. **Timed Mock Exam Mode**: Add a full-length timed diagnostic exam mode (Module 1 & Module 2 with 32-minute section countdown timer).
3. **Azure Static Web Apps CI/CD**: Connect GitHub repository to Azure Static Web Apps workflow.
