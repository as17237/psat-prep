"""
normalize_data.py - Normalizes skill casing, flags source mismatches, and computes text_complete flag.
"""

import json
import re

SKILL_ALIASES = {
    "Cross-text Connections": "Cross-Text Connections"
}

MISMATCH_QIDS = {"f302230c", "ac972578"}

def is_text_complete(q: dict) -> bool:
    # Check options for placeholder text
    if q.get("type") == "multiple_choice":
        options = q.get("options", [])
        if not options or len(options) != 4:
            return False
        for opt in options:
            txt = opt.get("text", "").strip()
            if re.match(r"^Option\s+[A-D]$", txt, re.IGNORECASE) or not txt:
                return False
    # Check question text
    q_txt = q.get("question_text", "").strip()
    if len(q_txt) < 15:
        return False
    return True

def process_file(filepath: str):
    with open(filepath, "r", encoding="utf-8") as f:
        questions = json.load(f)

    updated_count = 0
    text_complete_count = 0

    for q in questions:
        # 1. Normalize skill name
        if q.get("skill") in SKILL_ALIASES:
            q["skill"] = SKILL_ALIASES[q["skill"]]
            updated_count += 1

        # 2. Flag source letter mismatch
        if q.get("id") in MISMATCH_QIDS:
            q["rationale_letter_mismatch"] = True
            updated_count += 1
        else:
            q["rationale_letter_mismatch"] = False

        # 3. Compute text_complete
        complete = is_text_complete(q)
        q["text_complete"] = complete
        if complete:
            text_complete_count += 1

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(questions, f, indent=2, ensure_ascii=False)

    print(f"Processed {filepath}: {len(questions)} total, {text_complete_count} text-complete, {updated_count} normalized.")

if __name__ == "__main__":
    process_file("data/ela_questions.json")
    process_file("data/math_questions.json")
