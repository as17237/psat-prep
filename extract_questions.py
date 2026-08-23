"""
extract_questions.py - CLI Script for Full-Scale PSAT Question Extraction and Validation
Usage:
    python3 extract_questions.py --subject all --output-dir data
    python3 extract_questions.py --limit 100 --subject ela --output-dir data
"""

import os
import json
import argparse
import logging
import time
from extractor import extract_questions_from_bank
from validator import validate_dataset

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("extract_questions")

def run_extraction(subject: str, limit: int, output_dir: str, render_images: bool = True, num_workers: int = 4):
    os.makedirs(output_dir, exist_ok=True)
    images_dir = os.path.join(output_dir, "images")
    os.makedirs(images_dir, exist_ok=True)

    tasks = []
    if subject in ("ela", "all"):
        tasks.append(("Reading and Writing", "ELA1.pdf", "ELA1A.pdf", "ela_questions.json"))
    if subject in ("math", "all"):
        tasks.append(("Math", "MATH1.pdf", "MATH1A.pdf", "math_questions.json"))

    all_questions_combined = []
    t_start = time.time()

    for name, q_pdf, a_pdf, out_filename in tasks:
        logger.info(f"\n================ Processing {name} ================")
        if not os.path.exists(q_pdf) or not os.path.exists(a_pdf):
            logger.error(f"Missing required PDF files: {q_pdf} or {a_pdf}")
            continue

        questions = extract_questions_from_bank(
            question_pdf_path=q_pdf,
            answer_pdf_path=a_pdf,
            output_images_dir=images_dir if render_images else None,
            limit=limit if limit > 0 else None,
            render_images=render_images,
            num_workers=num_workers
        )

        all_questions_combined.extend(questions)

        # Validate extracted dataset
        logger.info(f"Validating {len(questions)} extracted {name} questions...")
        val_report = validate_dataset(questions, base_image_dir=images_dir if render_images else None)

        out_path = os.path.join(output_dir, out_filename)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(questions, f, indent=2, ensure_ascii=False)
        logger.info(f"Saved {len(questions)} questions to {out_path}")

        logger.info(f"Validation Result: {'PASSED [OK]' if val_report['is_valid'] else 'FAILED [X]'}")
        logger.info(f"  Valid: {val_report['valid_count']} / {val_report['total']}")
        if val_report["errors_by_qid"]:
            logger.warning(f"  Errors count: {len(val_report['errors_by_qid'])}")
            first_errs = list(val_report["errors_by_qid"].items())[:5]
            logger.warning(f"  Sample errors: {json.dumps(dict(first_errs), indent=2)}")

        logger.info(f"  Domains: {val_report['domain_distribution']}")
        logger.info(f"  Difficulties: {val_report['difficulty_distribution']}")
        logger.info(f"  Types: {val_report['type_distribution']}")

    # Write combined JavaScript bundle for client-side direct loading
    js_bundle_path = os.path.join(output_dir, "questions_data.js")
    with open(js_bundle_path, "w", encoding="utf-8") as f:
        f.write("window.QUESTIONS_DATA = " + json.dumps(all_questions_combined, indent=2, ensure_ascii=False) + ";\n")
    logger.info(f"\nGenerated combined bundle {js_bundle_path} with {len(all_questions_combined)} total questions in {time.time() - t_start:.2f}s.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract and validate questions from PSAT question banks.")
    parser.add_argument("--subject", choices=["ela", "math", "all"], default="all", help="Subject to extract")
    parser.add_argument("--limit", type=int, default=0, help="Maximum number of questions to extract per subject (0 for all)")
    parser.add_argument("--output-dir", default="data", help="Output directory for JSON and images")
    parser.add_argument("--no-images", action="store_true", help="Skip rendering card images")
    parser.add_argument("--workers", type=int, default=4, help="Number of parallel worker processes")

    args = parser.parse_args()
    run_extraction(
        subject=args.subject,
        limit=args.limit,
        output_dir=args.output_dir,
        render_images=not args.no_images,
        num_workers=args.workers
    )
