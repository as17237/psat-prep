#!/usr/bin/env python3
"""
Dump everything known about a question, by full or partial (8-char) ID.

    python3 explainers/fetch_question.py 1224cb23 [more ids...]

Prints the real record straight from data/*.json — never from memory — plus the
path to the question card image. READ THAT IMAGE. Equations, tables and figures
live only in the image; the text layer has them stripped out, and questions with
text_complete=False may even have placeholder option text ("Option A").
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def load():
    qs = []
    for name in ("ela_questions.json", "math_questions.json"):
        with open(os.path.join(ROOT, "data", name)) as fh:
            qs.extend(json.load(fh))
    return qs

def show(q):
    print("=" * 78)
    print(f"ID          {q['id']}")
    print(f"Test        {q.get('test')}")
    print(f"Domain      {q.get('domain')}   /   Skill: {q.get('skill')}")
    print(f"Difficulty  {q.get('difficulty')}     Type: {q.get('type')}")
    tc = q.get("text_complete")
    print(f"text_complete  {tc}" + ("   <-- TEXT IS INCOMPLETE. The image is the only full source." if tc is False else ""))
    img = q.get("question_image")
    if img:
        path = os.path.join("data", img)
        exists = os.path.exists(os.path.join(ROOT, path))
        print(f"IMAGE       {path}" + ("" if exists else "   <-- MISSING ON DISK"))
        print("            ^ Read this with the Read tool before writing anything.")
    print("-" * 78)
    print("QUESTION TEXT (may have equations stripped out):")
    print(q.get("question_text", "").strip() or "(empty)")
    if q.get("options"):
        print("-" * 78)
        print("OPTIONS (array; look up a letter with .find(o => o.key === letter)):")
        for o in q["options"]:
            flag = "  <-- PLACEHOLDER, read the image" if o["text"].strip().lower().startswith("option ") else ""
            print(f"  {o['key']}: {o['text']}{flag}")
    print("-" * 78)
    ans = q.get("correct_answer")
    print(f"CORRECT ANSWER: {ans!r}")
    if q.get("type") == "free_response":
        forms = [f.strip() for f in str(ans).replace(" or ", ",").split(",") if f.strip()]
        if len(forms) > 1:
            print(f"            MULTI-FORM KEY — all {len(forms)} of these are accepted: {forms}")
            print("            Tell the student every accepted form (fraction vs decimal, etc.).")
        else:
            print("            Free response: no answer choices. Explain the likely wrong paths")
            print("            instead of distractors, and say which equivalent forms count.")
    print("-" * 78)
    print("RATIONALE (College Board's own; also often has equations stripped):")
    print((q.get("rationale") or "(none)").strip())
    print()

def main(argv):
    if not argv:
        print(__doc__)
        return 1
    qs = load()
    by_id = {q["id"]: q for q in qs}
    missing = []
    for want in argv:
        hit = by_id.get(want) or next((q for q in qs if q["id"].startswith(want)), None)
        if hit:
            show(hit)
        else:
            missing.append(want)
    for want in missing:
        print(f"!! No question found matching {want!r}")
    return 1 if missing else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
