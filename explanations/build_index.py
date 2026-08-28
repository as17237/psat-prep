#!/usr/bin/env python3
"""
Build explanations/index.json — a question-id -> explainer map the app can use.

Scans explanations/*.html and explainers/*.html for:
  <!-- artifact: <url> -->            the published page URL
  <section class="qsec" id="q-XXXX">  one anchor per question covered

Output shape (small, safe to ship to the browser):

  { "generated": "...", "pages": { "<file>": {...} },
    "questions": { "<8-char id>": { "url": "...#q-<id>", "skill": "...", "file": "..." } } }

Run after publishing or updating any explainer:
    python3 explanations/build_index.py
"""
import json, os, re, glob, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, 'explanations')

def main():
    qs = json.load(open(os.path.join(ROOT, 'data', 'ela_questions.json'))) \
       + json.load(open(os.path.join(ROOT, 'data', 'math_questions.json')))
    meta = {q['id'][:8]: q for q in qs}

    pages, questions, unpublished = {}, {}, []
    paths = sorted(glob.glob(os.path.join(DIR, '*.html'))) \
          + sorted(glob.glob(os.path.join(ROOT, 'explainers', '*.html')))
    for path in paths:
        if os.path.basename(path).startswith('_'):
            continue                      # _template.html is not an explainer
        name = os.path.relpath(path, ROOT)
        html = open(path).read()
        m = re.search(r'<!--\s*artifact:\s*(\S+)\s*-->', html)
        url = m.group(1) if m else None
        title = re.search(r'<title>(.*?)</title>', html)
        ids = re.findall(r'<section class="qsec" id="q-([0-9a-f]{8})"', html)
        pages[name] = {'url': url, 'title': title.group(1) if title else name,
                       'questionCount': len(ids)}
        if not url:
            unpublished.append(name)
        for qid in ids:
            if qid in questions:
                print(f"  !! {qid} appears in two pages: {questions[qid]['file']} and {name}")
            questions[qid] = {
                'file': name,
                'url': f'{url}#q-{qid}' if url else None,
                'skill': meta.get(qid, {}).get('skill'),
                'test': meta.get(qid, {}).get('test'),
            }

    out = {'generated': datetime.datetime.now().isoformat(timespec='seconds'),
           'pages': pages, 'questions': questions}
    dest = os.path.join(DIR, 'index.json')
    json.dump(out, open(dest, 'w'), indent=2, sort_keys=True)

    print(f"{len(questions)} questions across {len(pages)} page(s) -> explanations/index.json")
    for n, p in pages.items():
        flag = '' if p['url'] else '   <-- NOT PUBLISHED, no url stamped'
        print(f"   {p['questionCount']:>3}  {n}{flag}")
    if unpublished:
        print("\nStamp the URL into each unpublished page as:  <!-- artifact: https://... -->")
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
