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

    # `questions` are the verified, always-on per-question links. `betaQuestions`
    # is a SEPARATE map for pages carrying a `<!-- beta -->` marker (numbers not
    # yet card-verified): the app reveals these only when APP_ENV.isBeta, so they
    # never clobber a verified per-question link even when a beta page covers the
    # same miss id (which the cluster pages deliberately do).
    pages, questions, beta_questions, unpublished = {}, {}, {}, []
    paths = sorted(glob.glob(os.path.join(DIR, '*.html'))) \
          + sorted(glob.glob(os.path.join(ROOT, 'explainers', '*.html')))
    for path in paths:
        if os.path.basename(path).startswith('_'):
            continue                      # _template.html is not an explainer
        name = os.path.relpath(path, ROOT)
        html = open(path).read()
        m = re.search(r'<!--\s*artifact:\s*(\S+)\s*-->', html)
        artifact_url = m.group(1) if m else None
        is_beta = re.search(r'<!--\s*beta\b', html) is not None
        # A page that has never been published as an artifact is still openable
        # from the app: fall back to its repo-relative path, which is exactly the
        # URL relative to index.html (served at /explanations/<file>).
        url = artifact_url or name
        title = re.search(r'<title>(.*?)</title>', html)
        # Every deep-link target the page carries, not only <section class="qsec">:
        # the cluster pages anchor worked misses on <section class="qsec"> AND
        # practice/drill misses on <div class="pq">, and both are real #q-<id>
        # targets a student can be sent to. Existing verified pages anchor only
        # on qsec (total == qsec, verified above), so this broadening leaves their
        # registration byte-identical while giving the cluster pages full coverage.
        ids = list(dict.fromkeys(re.findall(r'id="q-([0-9a-f]{8})"', html)))
        pages[name] = {'url': url, 'title': title.group(1) if title else name,
                       'questionCount': len(ids), 'beta': is_beta}
        if not artifact_url:
            unpublished.append(name)
        target = beta_questions if is_beta else questions
        for qid in ids:
            if qid in target:
                print(f"  !! {qid} appears in two {'beta ' if is_beta else ''}pages: {target[qid]['file']} and {name}")
            target[qid] = {
                'file': name,
                'url': f'{url}#q-{qid}',
                'skill': meta.get(qid, {}).get('skill'),
                'test': meta.get(qid, {}).get('test'),
                'beta': is_beta,
            }

    out = {'generated': datetime.datetime.now().isoformat(timespec='seconds'),
           'pages': pages, 'questions': questions, 'betaQuestions': beta_questions}
    dest = os.path.join(DIR, 'index.json')
    json.dump(out, open(dest, 'w'), indent=2, sort_keys=True)

    print(f"{len(questions)} verified + {len(beta_questions)} beta question link(s) "
          f"across {len(pages)} page(s) -> explanations/index.json")
    for n, p in pages.items():
        flags = []
        if p.get('beta'):
            flags.append('BETA (isBeta-only)')
        if n in unpublished:
            flags.append('local path (no artifact url stamped)')
        flag = ('   <-- ' + ', '.join(flags)) if flags else ''
        print(f"   {p['questionCount']:>3}  {n}{flag}")
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
