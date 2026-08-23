"""
rebuild_bundle.py - Rebuilds data/questions_data.js from data/ela_questions.json and data/math_questions.json.
Fast, zero-PDF-extraction bundle generator.
"""

import json
import os
import sys

def rebuild(data_dir: str = "data") -> None:
    ela_path = os.path.join(data_dir, "ela_questions.json")
    math_path = os.path.join(data_dir, "math_questions.json")
    bundle_path = os.path.join(data_dir, "questions_data.js")

    if not os.path.exists(ela_path) or not os.path.exists(math_path):
        print(f"Error: Missing {ela_path} or {math_path}", file=sys.stderr)
        sys.exit(1)

    with open(ela_path, "r", encoding="utf-8") as f:
        ela_qs = json.load(f)

    with open(math_path, "r", encoding="utf-8") as f:
        math_qs = json.load(f)

    all_qs = ela_qs + math_qs

    with open(bundle_path, "w", encoding="utf-8") as f:
        f.write("window.QUESTIONS_DATA = ")
        json.dump(all_qs, f, ensure_ascii=False)
        f.write(";\n")

    print(f"Successfully rebuilt {bundle_path} with {len(all_qs)} total questions ({len(ela_qs)} ELA, {len(math_qs)} Math).")

if __name__ == "__main__":
    rebuild()
