"""
normalize_data.py - Normalizes skill casing and ensures text_complete & mismatch flags are derived.
"""

import json
import re

SKILL_ALIASES = {
    "Cross-text Connections": "Cross-Text Connections"
}

def process_file(filepath: str):
    with open(filepath, "r", encoding="utf-8") as f:
        questions = json.load(f)

    updated_count = 0
    text_complete_count = 0
    mismatch_count = 0

    for q in questions:
        # 1. Normalize skill name
        if q.get("skill") in SKILL_ALIASES:
            q["skill"] = SKILL_ALIASES[q["skill"]]
            updated_count += 1

        # 2. Derive source letter mismatch dynamically
        correct_ans = q.get("correct_answer")
        rationale = q.get("rationale")
        mismatch = False
        if q.get("type") == "multiple_choice" and correct_ans and rationale:
            m_rat = re.search(r"Choice\s+([A-D])\s+is\s+(?:the\s+best\s+answer|correct)", rationale, re.IGNORECASE)
            if m_rat and m_rat.group(1).upper() != str(correct_ans).upper():
                mismatch = True
                mismatch_count += 1
        q["rationale_letter_mismatch"] = mismatch

        # 3. Check text_complete
        complete = True
        if q.get("type") == "multiple_choice":
            options = q.get("options", [])
            if not options or len(options) != 4:
                complete = False
            else:
                for opt in options:
                    txt = opt.get("text", "").strip()
                    if re.match(r"^Option\s+[A-D]$", txt, re.IGNORECASE) or not txt:
                        complete = False
                        break
        if len(q.get("question_text", "").strip()) < 15:
            complete = False
        
        q["text_complete"] = complete
        if complete:
            text_complete_count += 1

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(questions, f, indent=2, ensure_ascii=False)

    print(f"Processed {filepath}: {len(questions)} total, {text_complete_count} text-complete, {mismatch_count} mismatches dynamically derived.")

if __name__ == "__main__":
    process_file("data/ela_questions.json")
    process_file("data/math_questions.json")
