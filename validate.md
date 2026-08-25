# Extraction Validation Report — PSAT Prep Question Bank

**Date:** 2026-08-24 · **Scope:** all 4 source PDFs (`ELA1.pdf`, `ELA1A.pdf`, `MATH1.pdf`, `MATH1A.pdf`) vs `data/ela_questions.json`, `data/math_questions.json`, `data/questions_data.js`, and all 3,059 images in `data/images/`.

**Coverage: 3,059 / 3,059 questions (100%) validated by both an independent deterministic layer and an LLM map-reduce audit. No sampling — every question was checked.**

---

## Verdict

| Layer | Result |
| :--- | :--- |
| Deterministic re-extraction (PDF → JSON field diff, image pixel-compare) | **3,059/3,059 pass** — 0 mismatches |
| LLM semantic audit (answer correctness, image↔record binding) | **3,053/3,059 keys verified correct** · **5 extraction bugs found** · **1 College Board source defect** · **0 image problems** |

The extraction pipeline is structurally sound and complete, **but 5 student-produced-response (SPR) answer keys are silently truncated decimals** — a real grading-affecting extraction bug in `extractor.py` that both the project's validator and a naive re-extraction diff cannot see (details below).

---

## Method

### Layer 1 — Deterministic (script, full coverage)
Re-indexed all 4 PDFs from scratch and, for every one of the 3,059 records:
- **Field diff:** re-parsed the answer-PDF text and compared `assessment`, `test`, `domain`, `skill`, `difficulty`, `type`, `question_text`, `options` (keys + text), `correct_answer`, `rationale` against the JSON. → **0 mismatches in 30,590 field comparisons.**
- **Derived flags:** recomputed `text_complete` and `rationale_letter_mismatch`. → 0 mismatches.
- **Images:** re-rendered each record's question-PDF pages at scale 2 (stitching multi-page cards) and pixel-compared (`ImageChops`) against the stored PNG. → **3,059/3,059 pixel-identical**; dimensions all correct; 0 missing, 0 orphans, filenames all match IDs.
- **Structure:** no duplicate IDs; JSON order matches PDF order in both subjects; every JSON ID present in both the question and answer PDFs; `questions_data.js` bundle ≡ `ela + math` in order.

### Layer 2 — LLM map-reduce fan-out (full coverage)
- 64 batch manifests (26 ELA × 60, 38 Math × 40) covering all 3,059 questions; auto-cropped 1000px thumbnails generated from every card.
- One subagent per batch, in parallel waves. Each agent **viewed every question's card image** and returned per-question verdicts: `image_binding` (ID header vs record), `image_content` (metadata + question vs record), `answer_check` (**independently solving the problem**), `rationale_letter_consistent`.
- **Rate limits were hit repeatedly** (502 `provider_unavailable` / upstream throttle): handled by waiting 60–300 s and re-dispatching failed batches, splitting stubborn batches into 20-record parts, and instructing agents to write partial results incrementally. Final coverage: **3,059/3,059, no batch gaps, no corrupt outputs.**
- Every flagged verdict was then **manually adjudicated** (raw PDF text re-read + independent re-solving of the disputed items) before inclusion below.

---

## Issues found

### BUG-1 — 5 SPR answer keys truncated at the decimal point (extraction bug, affects grading)

`extractor.py:183` fallback regex `The\s+correct\s+answer\s+is\s+([^.\n]+)` **stops at the first period**, so "The correct answer is 1.3." extracts as `1`. These 5 questions have no explicit `Correct Answer:` line in the PDF text layer, so the rationale fallback fired and truncated:

| ID | Stored key | True answer (per PDF rationale + LLM solve) |
| :--- | :--- | :--- |
| `7a026c5b` | `1` | **1.3** |
| `a602f738` | `2` | **2.6** |
| `d9281ab5` | `1` | **1.5** |
| `e83a38d3` | `1` | **1.2** |
| `ebe77ad7` | `4` | **4.44** |

**Impact:** a student entering the correct `1.3` is marked wrong; a student entering the truncated `1` is marked right. All 5 are Math, Hard, SPR.
**Why existing checks missed it:** `validator.py` only checks presence/format, and a re-extraction diff reuses the same regex — comparing the implementation to itself. Dataset-wide scan with a sentence-aware regex confirms **exactly these 5** of 365 SPR records are affected (no others).
**Suggested fix:** capture to the sentence-ending period, e.g. `The\s+correct\s+answer\s+is\s+(.+?)\.(?:\s|$)`, then re-run `rebuild_bundle.py`; or hard-code the 5 corrections.

### SRC-1..3 — 3 College Board source defects (extraction is faithful; data shows what the PDF says)

| ID | Defect | Detail |
| :--- | :--- | :--- |
| `f302230c` | Key/rationale contradiction | PDF key line says **A** (correct: only (−4,0) satisfies y < −4x+4); rationale claims "Choice D is correct". Already flagged by `rationale_letter_mismatch`. |
| `ac972578` | Key/rationale contradiction | PDF key line says **B** (correct: 5 pints); rationale claims "Choice C is correct". Already flagged. |
| `2c14fa19` | **Wrong key line in source PDF** | Question: 20,300 mph in yd/hr (1 mi = 1,760 yd) → **35,728,000**. PDF key line says `35728` (missing ",000"); rationale number is absent from the text layer (vector-rendered). Stored key faithfully mirrors the PDF, so students are graded against a wrong key. Needs a data override + UI caveat. |

### Known/by-design (confirmed, not defects)
- **900 MCQs have ≥1 placeholder option** (`"Option A"…"Option D"`): 899 Math + 1 ELA — vector formulas absent from the PDF text layer by nature; the card image is authoritative. `text_complete` = 2,158/3,059 (70.5%) reflects this honestly.
- **72 SPR keys hold multiple accepted forms** (e.g. `".2, 1/5"`) — data correct; grader must split on commas (tracked elsewhere in REVIEW.md).

### LLM false positives (adjudicated, no action needed)
- `da469dc8` — agent claimed max large candles = 105; independent re-solve confirms **182** (980 + 6.7L ≤ 2200 → L ≤ 182.09, S=18, cost $2,199.40 ✓). Stored key correct.
- 3 `image_content: partial` flags (`d121eb59`, `e2340ff2`, `e5d21818`) — JSON metadata verified identical to **both** PDFs; agent misread. Deterministic layer already proves pixel-exact provenance.

---

## Results by check (all 3,059 questions)

| Check | ELA | Math | Total |
| :--- | ---: | ---: | ---: |
| Records in JSON | 1,554 | 1,505 | 3,059 |
| IDs present in question PDF / answer PDF | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ |
| Field-level match vs fresh PDF re-parse | 1,554 | 1,505 | **3,059** |
| Image pixel-identical to fresh re-render | 1,554 | 1,505 | **3,059** |
| Image ID-header binding (LLM) | 1,554 match | 1,505 match | **3,059 match** |
| Answer key verified correct (LLM + adjudication) | 1,554 | 1,499 | **3,053** (5 truncations + 1 source defect in Math) |
| Rationale "Choice X is correct" consistent | 1,553 yes | 1,139 yes / 2 no | 2 known source contradictions |

**Answer distribution (MCQ):** A 689 / B 687 / C 631 / D 687 — uniform, no parsing bias.
**Difficulty:** Easy 276 / Medium 937 / Hard 1,846. **Domains:** Algebra 577, Info & Ideas 452, Adv Math 375, PSDA 361, Craft & Structure 387, Std Eng 372, Expr of Ideas 343, Geo & Trig 192.
**Validator:** `3059 valid, 0 invalid, 2158 text_complete, 901 warnings` — matches README's claims.

---

## Artifacts & reproduction

Working files (temporary): `/tmp/opencode/psat_val/` — `deterministic.py` (Layer 1), `build_manifests.py` + `manifests/` (batch inputs), `thumbs/` (validation thumbnails), `verdicts/` (64 raw LLM verdict files), `reduce.py` + `llm_aggregate.json` (aggregation), `deterministic_results.json` (Layer 1 full output).

```bash
# Layer 1 (deterministic, ~2 min, needs the 4 PDFs)
python3 /tmp/opencode/psat_val/deterministic.py
# Layer 2 aggregation (verdicts already collected)
python3 /tmp/opencode/psat_val/reduce.py
# Truncation-bug dataset scan (5 hits)
python3 - <<'EOF'
import json, re
from fractions import Fraction
parse = lambda s: (lambda v: float(v) if v is not None else None)((
    float(Fraction(*map(int, s.strip().rstrip('.').split('/'))))
    if '/' in s else
    (lambda x: float(x) if x else None)(s.strip().rstrip('.').replace(',', '') and __import__('re').sub(r'[^0-9./-]', '', s.strip().rstrip('.')) or None)))
qs = json.load(open('data/ela_questions.json')) + json.load(open('data/math_questions.json'))
for q in qs:
    if q['type'] != 'free_response': continue
    m = re.search(r"The\s+correct\s+answer\s+is\s+([^\n]+?)\.(?:\s|$)", q.get('rationale') or '')
    if not m: continue
    claim, stored = m.group(1).strip(), str(q['correct_answer'])
    def num(s):
        s = s.strip().rstrip('.')
        try: return float(Fraction(s)) if '/' in s else float(s.replace(',', ''))
        except Exception: return None
    if num(claim) is not None and num(claim) not in [num(f) for f in stored.split(',')]:
        print(q['id'], 'stored:', stored, '| true:', claim)
EOF
```

## Limitations (stated plainly)
- LLM `answer_check` is model judgment (each question independently solved from the card image), not an official College Board key. Every disagreement was manually adjudicated against the raw PDF text; none were accepted on the model's word alone.
- Layer 1 reuses `extractor.parse_question_text` for the field diff — it proves JSON ≡ pipeline output and pipeline ≡ PDF for everything the parser reads, but cannot catch parser-internal bugs (which is exactly how BUG-1 hid; it was caught by Layer 2 + a regex-independent scan).
- Multi-page cards (20 questions) were pixel-verified for stitch geometry via dimensions + full pixel diff; all passed.
- The 4 PDFs are gitignored; Layer 1 must be re-run on a machine that has them.
