"""
validator.py - Accuracy and Integrity Validator for Extracted Questions
Performs comprehensive schema, logic, and asset validation on question bank data.
"""

import os
import re
from typing import Dict, List, Any, Optional
from PIL import Image

VALID_DIFFICULTIES = {"Easy", "Medium", "Hard"}
VALID_TYPES = {"multiple_choice", "free_response"}
VALID_CHOICE_KEYS = ["A", "B", "C", "D"]

def validate_question(q: Dict[str, Any], base_image_dir: Optional[str] = None) -> List[str]:
    """
    Validates a single question dictionary against all schema and content rules.
    Returns a list of error strings. If list is empty, the question is valid.
    """
    errors = []
    qid = q.get("id")

    # 1. ID Check
    if not qid or not isinstance(qid, str) or len(qid) < 3:
        errors.append(f"Invalid or missing Question ID: {qid}")

    # 2. Metadata completeness
    if not q.get("assessment"):
        errors.append(f"[{qid}] Missing assessment")
    if not q.get("test"):
        errors.append(f"[{qid}] Missing test name (e.g. Reading and Writing / Math)")
    if not q.get("domain"):
        errors.append(f"[{qid}] Missing domain")
    if not q.get("skill"):
        errors.append(f"[{qid}] Missing skill")

    diff = q.get("difficulty")
    if not diff or diff not in VALID_DIFFICULTIES:
        errors.append(f"[{qid}] Invalid difficulty '{diff}'. Expected one of {VALID_DIFFICULTIES}")

    # 3. Question Type & Choices Check
    qtype = q.get("type")
    if qtype not in VALID_TYPES:
        errors.append(f"[{qid}] Invalid type '{qtype}'. Expected one of {VALID_TYPES}")

    options = q.get("options", [])
    if qtype == "multiple_choice":
        if len(options) != 4:
            errors.append(f"[{qid}] Multiple choice question must have exactly 4 options, found {len(options)}")
        else:
            keys = [opt.get("key") for opt in options]
            if keys != VALID_CHOICE_KEYS:
                errors.append(f"[{qid}] Expected option keys {VALID_CHOICE_KEYS}, found {keys}")
    elif qtype == "free_response":
        if len(options) > 0:
            errors.append(f"[{qid}] Free response question should not have choices, found {len(options)}")

    # 4. Correct Answer Check
    ans = q.get("correct_answer")
    if not ans or len(str(ans).strip()) == 0:
        errors.append(f"[{qid}] Missing correct_answer")
    else:
        if qtype == "multiple_choice" and ans not in VALID_CHOICE_KEYS:
            errors.append(f"[{qid}] Multiple choice correct_answer '{ans}' must be one of {VALID_CHOICE_KEYS}")

    # 5. Rationale Check
    rat = q.get("rationale")
    if not rat or len(str(rat).strip()) < 10:
        errors.append(f"[{qid}] Missing or suspiciously short rationale (length: {len(str(rat)) if rat else 0})")

    # 6. Image / Visual Asset Check
    if q.get("has_image"):
        img_rel_path = q.get("question_image")
        if not img_rel_path:
            errors.append(f"[{qid}] has_image is True but question_image path is missing")
        elif base_image_dir:
            full_img_path = os.path.join(base_image_dir, os.path.basename(img_rel_path))
            if not os.path.exists(full_img_path):
                errors.append(f"[{qid}] Rendered image does not exist on disk at {full_img_path}")
            else:
                try:
                    with Image.open(full_img_path) as im:
                        if im.width < 100 or im.height < 100:
                            errors.append(f"[{qid}] Image dimensions ({im.width}x{im.height}) too small")
                except Exception as e:
                    errors.append(f"[{qid}] Failed to open image: {str(e)}")

    return errors


def validate_dataset(questions: List[Dict[str, Any]], base_image_dir: Optional[str] = None) -> Dict[str, Any]:
    """
    Validates an entire dataset of questions and produces summary metrics.
    """
    total = len(questions)
    valid_count = 0
    invalid_count = 0
    errors_by_qid = {}
    
    domains: Dict[str, int] = {}
    skills: Dict[str, int] = {}
    difficulties: Dict[str, int] = {}
    types: Dict[str, int] = {}

    for q in questions:
        qid = q.get("id", "UNKNOWN")
        errs = validate_question(q, base_image_dir=base_image_dir)
        if errs:
            invalid_count += 1
            errors_by_qid[qid] = errs
        else:
            valid_count += 1

        d = q.get("domain", "Unknown")
        domains[d] = domains.get(d, 0) + 1

        s = q.get("skill", "Unknown")
        skills[s] = skills.get(s, 0) + 1

        df = q.get("difficulty", "Unknown")
        difficulties[df] = difficulties.get(df, 0) + 1

        t = q.get("type", "Unknown")
        types[t] = types.get(t, 0) + 1

    return {
        "total": total,
        "valid_count": valid_count,
        "invalid_count": invalid_count,
        "is_valid": (invalid_count == 0 and total > 0),
        "errors_by_qid": errors_by_qid,
        "domain_distribution": domains,
        "skill_distribution": skills,
        "difficulty_distribution": difficulties,
        "type_distribution": types
    }
