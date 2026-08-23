# PSAT Prep Mastery — LLM Agent Handoff & Review Document

> **Target Audience**: Any AI Coding Assistant / LLM Agent resuming or reviewing this project.
> **Project Goal**: Build a high-performance PSAT/SAT test preparation, spaced repetition, and analytics platform targeting a near-perfect score.

---

## 1. Project Context & Current State

- **Source Question Banks**: College Board Question Bank PDFs (`ELA1.pdf`, `ELA1A.pdf`, `MATH1.pdf`, `MATH1A.pdf`).
- **Extraction & Validation State**:
  - Total Extracted Questions: **3,059** (1,554 Reading & Writing + 1,505 Math).
  - Schema Validity: **100.0% (3,059 / 3,059)** verified via `validator.py`.
  - Text Completeness: **70.5% (2,158 / 3,059)**. (Math questions with vector curve formulas rely on the official visual card images by design).
  - High-Resolution Un-spoiled Question Cards: **3,059 images** in `data/images/*.png`.
- **Test Suite Status**:
  - Python Parser Tests (`test_extractor.py`): 9/9 passing, decoupled from raw PDFs using `tests/fixtures/`.
  - Node.js SRS & Grading Tests: 100% passing across 365 free-response questions and SM-2 ladder transitions.

---

## 2. Key File Map & Roles

| File / Directory | Purpose & Role |
| :--- | :--- |
| [`data/ela_questions.json`](data/ela_questions.json) | 1,554 validated Reading & Writing questions (99.9% text-complete). |
| [`data/math_questions.json`](data/math_questions.json) | 1,505 validated Math questions (1,140 MCQ + 365 Free Response). |
| [`data/questions_data.js`](data/questions_data.js) | Unified client-side bundle containing all 3,059 questions. |
| [`data/images/`](data/images/) | 3,059 rendered question card PNGs. |
| [`srs.js`](srs.js) | **Core Engine**: Free-response numerical evaluation, SuperMemo SM-2 review scheduler, and PSAT 8/9 empirical score modeling. |
| [`index.html`](index.html) | **Student Practice & Analytics Portal** (Visual Card / Text mode, live grading, collapsible rationales, timing capture, SRS review queue). |
| [`parent.html`](parent.html) | **Parent Oversight & Score Forecaster** (PSAT 8/9 240–1440 scale, active streak, weekly study minutes, knowledge gap alerts). |
| [`extractor.py`](extractor.py) | Multi-core PDF parser and image stitcher (`pypdfium2` + `Pillow`). |
| [`validator.py`](validator.py) | Validation engine reporting schema validity, text completeness, and casing collision checks. |
| [`rebuild_bundle.py`](rebuild_bundle.py) | Fast bundle regenerator from JSON files without PDF extraction. |
| [`test_extractor.py`](test_extractor.py) | Portable Python unit & integration tests. |
| [`tests/fixtures/`](tests/fixtures/) | Text fixtures for offline unit tests. |
| [`upload_to_azure.py`](upload_to_azure.py) | Azure Cosmos DB & Blob Storage migration script with URL rewriting and concurrency. |
| [`.github/workflows/test-and-validate.yml`](.github/workflows/test-and-validate.yml) | Automated CI workflow running parser tests, JS tests, and dataset validator. |

---

## 3. Core Algorithm Implementations

### 3.1 Free-Response Numerical Grading (`srs.js:gradeFreeResponse`)
- Evaluates student input numerically: parses fractions (`5/2`, `-49/150`), decimals (`2.5`), and multi-form accepted keys (`.2, 1/5`, `14.66, 14.67, 44/3`).
- Compares within precision tolerance ($\max(10^{-4}, |key| \times 10^{-3})$) with string fallback.

### 3.2 Spaced Repetition (SM-2) Engine (`srs.js:scheduleNext`)
- Grades responses $q \in [1..5]$ based on correctness and foreground response time ($<45\text{s} \rightarrow 5$, $45-90\text{s} \rightarrow 4$, $>90\text{s} \rightarrow 3$, incorrect $\rightarrow 1$).
- $$EF' = \max\left(1.3, \, EF + (0.1 - (5 - q) \times (0.08 + (5 - q) \times 0.02))\right)$$
- If $q < 3$: interval resets to 1 day; otherwise follows $1 \rightarrow 3 \rightarrow 7 \rightarrow \text{round}(I \times EF')$ progression.

### 3.3 Empirical PSAT 8/9 Score Forecaster (`srs.js:calculateScaledScore`)
- Evaluates Reading & Writing (120–720) and Math (120–720) on the PSAT 8/9 240–1440 scale.
- Gated on minimum 15 attempts per section to prevent misleading estimates from tiny sample sizes.

---

## 4. Verification Commands

```bash
# 1. Run portable Python unit tests
python3 -m unittest test_extractor.py -v

# 2. Run Node.js test suites
node tests/test_free_response.js
node tests/test_srs.js
node tests/test_dataset_free_response.js

# 3. Validate entire dataset
python3 -c "import json; from validator import validate_dataset; res = validate_dataset(json.load(open('data/ela_questions.json')) + json.load(open('data/math_questions.json')), base_image_dir='data/images'); print('Valid:', res['valid_count'], 'Text complete:', res['text_complete_count'])"

# 4. Rebuild browser bundle
python3 rebuild_bundle.py

# 5. Start web server
python3 -m http.server 8080
```
