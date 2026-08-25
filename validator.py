"""
validator.py - Accuracy, Text-Completeness, and Integrity Validator for Extracted Questions
Performs schema checks, choice integrity, text-completeness assessment, and asset verification.
"""

import os
import re
from typing import Dict, List, Any, Optional, Tuple
from PIL import Image

VALID_DIFFICULTIES = {"Easy", "Medium", "Hard"}
VALID_TYPES = {"multiple_choice", "free_response"}
VALID_CHOICE_KEYS = ["A", "B", "C", "D"]

def validate_question(q: Dict[str, Any], base_image_dir: Optional[str] = None) -> Tuple[List[str], List[str]]:
    """
    Validates a single question dictionary against all schema and content rules.
    Returns (errors, warnings).
    """
    errors = []
    warnings = []
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
            
            # Check for placeholder option text (vector math formulas)
            has_placeholder = any(re.match(r"^Option\s+[A-D]$", opt.get("text", "").strip(), re.IGNORECASE) for opt in options)
            if has_placeholder:
                warnings.append(f"[{qid}] Contains placeholder option text ('Option A'..'Option D') due to PDF vector math")
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
    elif qtype == "multiple_choice" and ans:
        # Check for College Board source rationale mismatch
        m_rat_mc = re.search(r"Choice\s+([A-D])\s+is\s+(?:the\s+best\s+answer|correct)", rat, re.IGNORECASE)
        if m_rat_mc and m_rat_mc.group(1).upper() != ans:
            warnings.append(f"[{qid}] Source contradiction: Correct Answer is '{ans}' but rationale states 'Choice {m_rat_mc.group(1).upper()} is correct'")
    elif qtype == "free_response" and ans:
        # Known source defect override where rationale or key in PDF was defective
        KNOWN_SPR_OVERRIDES = {
            "2c14fa19": "35728000"  # 20,300 mph × 1,760 yd/mi = 35,728,000 (PDF key erroneously omitted ,000)
        }
        if qid in KNOWN_SPR_OVERRIDES:
            if str(ans).strip() != KNOWN_SPR_OVERRIDES[qid]:
                errors.append(f"[{qid}] Expected known SPR override '{KNOWN_SPR_OVERRIDES[qid]}', found '{ans}'")
        else:
            # Check sentence-aware free response rationale consistency
            m_rat_fr = re.search(r"The\s+correct\s+answer\s+is\s+(?:either\s+)?([^.\n]+(?:\.[0-9]+)?)\.(?:\s|$)", rat, re.IGNORECASE)
            if m_rat_fr:
                expected_raw = m_rat_fr.group(1).strip()
                ans_clean = str(ans).strip()
                accepted_tokens = [t.strip() for t in ans_clean.split(",")]
                
                # If rationale mentions 'either A or B' or 'A, B, or C'
                parts = re.split(r"\s+or\s+|\s*,\s*", expected_raw)
                parts = [p.strip() for p in parts if p.strip() and p.strip().lower() not in ("either", "and", "or")]
                
                if parts:
                    # Check that every extracted numeric part matches an accepted token
                    for p in parts:
                        is_match = (p in accepted_tokens)
                        if not is_match:
                            try:
                                is_match = any(abs(float(p) - float(tok)) < 1e-6 for tok in accepted_tokens)
                            except Exception:
                                pass
                        if not is_match and re.match(r"^-?[0-9]+(?:\.[0-9]+)?$", p):
                            errors.append(f"[{qid}] Free-response key '{ans}' does not match sentence rationale component '{p}'")
                elif expected_raw and expected_raw.lower() not in ("either or", "either , or", "either , , or"):
                    is_match = (expected_raw in accepted_tokens)
                    if not is_match:
                        try:
                            is_match = any(abs(float(expected_raw) - float(tok)) < 1e-6 for tok in accepted_tokens)
                        except Exception:
                            pass
                    if not is_match and re.match(r"^-?[0-9]+(?:\.[0-9]+)?$", expected_raw):
                        errors.append(f"[{qid}] Free-response key '{ans}' does not match sentence rationale '{expected_raw}'")

    # 6. Image / Visual Asset Check
    if q.get("has_image", False):
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

    return errors, warnings


def validate_dataset(questions: List[Dict[str, Any]], base_image_dir: Optional[str] = None) -> Dict[str, Any]:
    """
    Validates an entire dataset of questions, reporting schema validity and text completeness.
    """
    total = len(questions)
    valid_count = 0
    invalid_count = 0
    text_complete_count = 0
    errors_by_qid = {}
    warnings_by_qid = {}
    
    domains: Dict[str, int] = {}
    skills: Dict[str, int] = {}
    difficulties: Dict[str, int] = {}
    types: Dict[str, int] = {}

    skill_casing_map: Dict[str, str] = {}
    casing_collisions: List[str] = []

    for q in questions:
        qid = q.get("id", "UNKNOWN")
        errs, warns = validate_question(q, base_image_dir=base_image_dir)
        if errs:
            invalid_count += 1
            errors_by_qid[qid] = errs
        else:
            valid_count += 1

        if warns:
            warnings_by_qid[qid] = warns

        if q.get("text_complete", True) and not any("placeholder" in w for w in warns):
            text_complete_count += 1

        d = q.get("domain", "Unknown")
        domains[d] = domains.get(d, 0) + 1

        s = q.get("skill", "Unknown")
        skills[s] = skills.get(s, 0) + 1

        # Check casing collisions
        s_lower = s.lower()
        if s_lower in skill_casing_map:
            if skill_casing_map[s_lower] != s and s not in casing_collisions:
                casing_collisions.append(f"Collision: '{skill_casing_map[s_lower]}' vs '{s}'")
        else:
            skill_casing_map[s_lower] = s

        df = q.get("difficulty", "Unknown")
        difficulties[df] = difficulties.get(df, 0) + 1

        t = q.get("type", "Unknown")
        types[t] = types.get(t, 0) + 1

    return {
        "total": total,
        "valid_count": valid_count,
        "invalid_count": invalid_count,
        "is_valid": (invalid_count == 0 and total > 0),
        "text_complete_count": text_complete_count,
        "text_complete_pct": round((text_complete_count / total * 100), 1) if total > 0 else 0.0,
        "casing_collisions": casing_collisions,
        "errors_by_qid": errors_by_qid,
        "warnings_count": len(warnings_by_qid),
        "domain_distribution": domains,
        "skill_distribution": skills,
        "difficulty_distribution": difficulties,
        "type_distribution": types
    }
