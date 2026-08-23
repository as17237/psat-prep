"""
extractor.py - High-Performance Multi-Core PSAT Question Bank Extractor
Parses College Board PSAT Question & Answer PDFs into structured JSON and rendered card images.
"""

import os
import re
import json
import logging
import time
from typing import Dict, List, Optional, Tuple, Any
from concurrent.futures import ProcessPoolExecutor
import pypdfium2 as pdfium
from PIL import Image

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

KNOWN_DOMAINS = [
    "Information and Ideas",
    "Craft and Structure",
    "Expression of Ideas",
    "Standard English Conventions",
    "Algebra",
    "Advanced Math",
    "Problem-Solving and Data Analysis",
    "Geometry and Trigonometry"
]

SKILL_ALIASES = {
    "Cross-text Connections": "Cross-Text Connections"
}

NUM_TO_LETTER = {
    "1": "A",
    "2": "B",
    "3": "C",
    "4": "D"
}

MISMATCH_QIDS = {"f302230c", "ac972578"}


def index_pdf_questions(pdf_doc: pdfium.PdfDocument, limit: Optional[int] = None) -> Dict[str, List[int]]:
    """
    Scans a PDF document and maps each Question ID to the list of page indices it occupies.
    """
    q_map: Dict[str, List[int]] = {}
    current_qid = None

    for page_idx in range(len(pdf_doc)):
        textpage = pdf_doc[page_idx].get_textpage()
        text = textpage.get_text_range()
        
        matches = re.findall(r"Question ID:\s*([a-zA-Z0-9]+)", text)
        if matches:
            if len(set(matches)) > 1:
                logger.warning(f"Page {page_idx} contains multiple Question IDs: {matches}")
            if limit is not None and len(q_map) >= limit:
                break
            current_qid = matches[0]
            if current_qid not in q_map:
                q_map[current_qid] = []
            q_map[current_qid].append(page_idx)
        elif current_qid is not None:
            q_map[current_qid].append(page_idx)

    return q_map


def parse_choices_robust(choices_text: str) -> List[Dict[str, str]]:
    """
    Robustly parses multiple choice options (A-D or 1-4).
    Handles empty text (vector math formulas) and multi-line options.
    """
    options = []
    current_key = None
    current_lines = []

    for line in choices_text.split("\n"):
        line_clean = line.strip()
        m = re.match(r"^([A-D1-4])[\.\)]\s*(.*)", line_clean)
        if m:
            if current_key:
                txt = "\n".join(current_lines).strip()
                options.append({
                    "key": current_key,
                    "text": txt if txt else f"Option {current_key}"
                })
            raw_key = m.group(1)
            current_key = NUM_TO_LETTER.get(raw_key, raw_key)
            current_lines = [m.group(2).strip()] if m.group(2).strip() else []
        elif current_key:
            if line_clean:
                current_lines.append(line_clean)

    if current_key:
        txt = "\n".join(current_lines).strip()
        options.append({
            "key": current_key,
            "text": txt if txt else f"Option {current_key}"
        })

    return options


def parse_question_text(full_text: str, qid: str) -> Dict[str, Any]:
    """
    Parses full text of a question (from the Answer PDF) into structured components.
    """
    text = full_text.replace("\r\n", "\n").replace("\r", "\n")

    metadata = {
        "assessment": "PSAT 8/9",
        "test": None,
        "domain": None,
        "skill": None,
        "difficulty": None
    }

    # 1. Parse Metadata Block
    m_meta = re.search(r"Question ID:\s*[a-zA-Z0-9]+\s*\n(.*?)Question\b", text, re.DOTALL)
    if m_meta:
        meta_lines = [line.strip() for line in m_meta.group(1).strip().split("\n") if line.strip()]
        if len(meta_lines) >= 2:
            val_text = " ".join(meta_lines[1:])
            
            diff_match = re.search(r"\b(Easy|Medium|Hard)\b", val_text)
            if diff_match:
                metadata["difficulty"] = diff_match.group(1)

            test_match = re.search(r"\b(Reading and Writing|Math)\b", val_text)
            if test_match:
                metadata["test"] = test_match.group(1)

            assess_match = re.search(r"(PSAT 8/9|PSAT/NMSQT|PSAT 10|SAT)", val_text)
            if assess_match:
                metadata["assessment"] = assess_match.group(1)

            rem = val_text
            if metadata["assessment"]:
                rem = rem.replace(metadata["assessment"], "", 1)
            if metadata["test"]:
                rem = rem.replace(metadata["test"], "", 1)
            if metadata["difficulty"]:
                rem = rem.replace(metadata["difficulty"], "", 1)
            rem = re.sub(r"\s+", " ", rem).strip()

            for domain_candidate in KNOWN_DOMAINS:
                if rem.startswith(domain_candidate):
                    metadata["domain"] = domain_candidate
                    metadata["skill"] = rem[len(domain_candidate):].strip()
                    break
            
            if not metadata["domain"]:
                metadata["skill"] = rem

    # Normalize skill name casing
    if metadata["skill"] in SKILL_ALIASES:
        metadata["skill"] = SKILL_ALIASES[metadata["skill"]]

    # 2. Extract Rationale
    rationale = None
    m_rat = re.search(r"Rationale\s*\n(.*)", text, re.DOTALL)
    if m_rat:
        rationale = m_rat.group(1).strip()

    # 3. Extract Correct Answer
    correct_ans = None
    m_ans = re.search(r"Correct Answer:\s*([^\n]+)", text)
    if m_ans:
        correct_ans = m_ans.group(1).strip()
    elif rationale:
        # Fallback 1: Multiple choice in rationale (e.g. "Choice B is correct")
        m_rat_mc = re.search(r"Choice\s+([A-D])\s+is\s+(?:the\s+best\s+answer|correct)", rationale, re.IGNORECASE)
        if m_rat_mc:
            correct_ans = m_rat_mc.group(1).upper()
        else:
            # Fallback 2: "Note that X and Y are examples of ways to enter a correct answer"
            m_note = re.search(r"Note that\s+([^\s,]+)(?:\s+and\s+[^\s,]+)?\s+are examples of ways to enter a correct answer", rationale, re.IGNORECASE)
            if m_note:
                correct_ans = m_note.group(1).strip()
            else:
                # Fallback 3: Free response in rationale (e.g. "The correct answer is 40.")
                m_rat_fr = re.search(r"The\s+correct\s+answer\s+is\s+([^.\n]+)", rationale, re.IGNORECASE)
                if m_rat_fr and m_rat_fr.group(1).strip():
                    correct_ans = m_rat_fr.group(1).strip()

    # 4. Extract Question Text & Prompt
    m_q_body = re.search(r"Question\s*\n(.*?)(?=\nAnswer\b|\nCorrect Answer:|\nRationale\b)", text, re.DOTALL)
    q_content = m_q_body.group(1).strip() if m_q_body else ""

    # 5. Extract Answer Choices (A, B, C, D) vs Free Response
    options = []
    q_type = "free_response"

    m_choices = re.search(r"\nAnswer\s*\n(.*?)(?=\nCorrect Answer:|\nRationale\b)", text, re.DOTALL)
    if m_choices:
        q_type = "multiple_choice"
        choices_text = m_choices.group(1).strip()
        options = parse_choices_robust(choices_text)
        
        if len(options) != 4 and correct_ans in ("A", "B", "C", "D"):
            options = [{"key": k, "text": f"Option {k}"} for k in ("A", "B", "C", "D")]
    elif correct_ans in ("A", "B", "C", "D") and rationale and "Choice " in rationale:
        q_type = "multiple_choice"
        options = [{"key": k, "text": f"Option {k}"} for k in ("A", "B", "C", "D")]

    # 6. Compute text_complete flag
    text_complete = True
    if q_type == "multiple_choice":
        if not options or len(options) != 4:
            text_complete = False
        else:
            for opt in options:
                txt = opt.get("text", "").strip()
                if re.match(r"^Option\s+[A-D]$", txt, re.IGNORECASE) or not txt:
                    text_complete = False
                    break
    if len(q_content) < 15:
        text_complete = False

    return {
        "id": qid,
        "assessment": metadata["assessment"],
        "test": metadata["test"],
        "domain": metadata["domain"],
        "skill": metadata["skill"],
        "difficulty": metadata["difficulty"],
        "type": q_type,
        "question_text": q_content,
        "options": options,
        "correct_answer": correct_ans,
        "rationale": rationale,
        "text_complete": text_complete,
        "rationale_letter_mismatch": (qid in MISMATCH_QIDS)
    }


def render_stitched_image(doc: pdfium.PdfDocument, page_indices: List[int], out_path: str, scale: int = 2) -> None:
    """
    Renders one or more pages from the PDF document and vertically stitches them into a single PNG image.
    """
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    images = [doc[p].render(scale=scale).to_pil() for p in page_indices]
    if len(images) == 1:
        images[0].save(out_path, format="PNG")
    else:
        max_width = max(img.width for img in images)
        total_height = sum(img.height for img in images)
        combined = Image.new("RGB", (max_width, total_height), (255, 255, 255))
        y_offset = 0
        for img in images:
            combined.paste(img, (0, y_offset))
            y_offset += img.height
        combined.save(out_path, format="PNG")


def _worker_process_chunk(args: Tuple[str, str, List[Tuple[str, List[int], List[int]]], Optional[str], int]) -> List[Dict[str, Any]]:
    """
    Worker function executed in separate process for fast parallel extraction.
    """
    q_pdf_path, a_pdf_path, chunk_items, out_img_dir, scale = args
    q_doc = pdfium.PdfDocument(q_pdf_path)
    a_doc = pdfium.PdfDocument(a_pdf_path)

    results = []
    for qid, q_pages, a_pages in chunk_items:
        try:
            full_text = "\n".join(a_doc[p].get_textpage().get_text_range() for p in a_pages)
            q_data = parse_question_text(full_text, qid)

            if out_img_dir:
                img_name = f"{qid}_question.png"
                img_path = os.path.join(out_img_dir, img_name)
                render_stitched_image(q_doc, q_pages, img_path, scale=scale)
                q_data["question_image"] = os.path.join("images", img_name)
                q_data["has_image"] = True
            else:
                q_data["question_image"] = None
                q_data["has_image"] = False

            results.append(q_data)
        except Exception as e:
            logger.error(f"Error processing question {qid}: {str(e)}")
            
    return results


def extract_questions_from_bank(
    question_pdf_path: str,
    answer_pdf_path: str,
    output_images_dir: Optional[str] = None,
    limit: Optional[int] = None,
    render_images: bool = True,
    scale: int = 2,
    num_workers: int = 4
) -> List[Dict[str, Any]]:
    """
    Extracts questions with parallel multi-core rendering and parsing.
    """
    logger.info(f"Opening PDFs to index question boundaries: {question_pdf_path} & {answer_pdf_path}")
    q_doc = pdfium.PdfDocument(question_pdf_path)
    a_doc = pdfium.PdfDocument(answer_pdf_path)

    q_pages_map = index_pdf_questions(q_doc, limit=limit)
    a_pages_map = index_pdf_questions(a_doc, limit=limit)

    total_found = len(a_pages_map)
    logger.info(f"Indexed {total_found} questions. Preparing {num_workers} parallel workers...")

    items = []
    for count, (qid, a_pages) in enumerate(a_pages_map.items()):
        if limit is not None and count >= limit:
            break
        q_pages = q_pages_map.get(qid, a_pages)
        items.append((qid, q_pages, a_pages))

    if num_workers <= 1 or len(items) <= 10:
        return _worker_process_chunk((question_pdf_path, answer_pdf_path, items, output_images_dir if render_images else None, scale))

    chunk_size = (len(items) + num_workers - 1) // num_workers
    chunks = [items[i:i + chunk_size] for i in range(0, len(items), chunk_size)]
    worker_args = [
        (question_pdf_path, answer_pdf_path, chunk, output_images_dir if render_images else None, scale)
        for chunk in chunks
    ]

    extracted = []
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        for chunk_result in executor.map(_worker_process_chunk, worker_args):
            extracted.extend(chunk_result)
            logger.info(f"Extracted {len(extracted)} / {len(items)} questions ({time.time() - t0:.1f}s elapsed)...")

    logger.info(f"Completed extraction of {len(extracted)} questions in {time.time() - t0:.2f}s.")
    return extracted
