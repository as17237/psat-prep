#!/usr/bin/env python3
"""
Find easier questions that practise the same skill, for the practice block.

    python3 explainers/find_siblings.py <id> [-n 2]

Same `skill` tag as the given question, preferring Easy then Medium, and
preferring complete text so the practice question can be read without its image.
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORDER = {"Easy": 0, "Medium": 1, "Hard": 2}

def load():
    qs = []
    for name in ("ela_questions.json", "math_questions.json"):
        with open(os.path.join(ROOT, "data", name)) as fh:
            qs.extend(json.load(fh))
    return qs

def main(argv):
    if not argv:
        print(__doc__)
        return 1
    want = argv[0]
    n = int(argv[argv.index("-n") + 1]) if "-n" in argv else 2
    qs = load()
    base = next((q for q in qs if q["id"] == want or q["id"].startswith(want)), None)
    if not base:
        print(f"!! No question matching {want!r}")
        return 1

    pool = [q for q in qs if q["skill"] == base["skill"] and q["id"] != base["id"]]
    pool.sort(key=lambda q: (ORDER.get(q["difficulty"], 3), q.get("text_complete") is not True))

    print(f"Base   {base['id'][:8]}  {base['difficulty']}  {base['test']} / {base['domain']}")
    print(f"Skill  {base['skill']!r}   ({len(pool)} other questions share it)")
    print(f"\nBest {n} for practice (easiest first, complete text preferred):\n")
    for q in pool[:n]:
        print("=" * 78)
        print(f"{q['id'][:8]}  {q['difficulty']}  {q['type']}   text_complete={q.get('text_complete')}")
        print(f"  image: data/{q.get('question_image')}   <-- read it before using this question")
        print(f"  {(q.get('question_text') or '').strip()[:400]}")
        for o in (q.get("options") or []):
            print(f"     {o['key']}: {o['text'][:120]}")
        print(f"  ANSWER: {q.get('correct_answer')!r}")
    print("=" * 78)
    print("\nCheck each one against its image before putting it on the page.")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
