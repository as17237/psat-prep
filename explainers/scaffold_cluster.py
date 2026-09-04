#!/usr/bin/env python3
"""Scaffold a cluster explainer page from verified dataset records.

Usage:
    python3 scaffold_cluster.py <slug> <qid>... [--repo-root DIR] [--out FILE]

Reads question records from the psat-prep dataset, verifies them, and emits a
skeleton cluster HTML page: mast stub, model-section stub, one .qsec per
question with card figure, verbatim choices (correct key marked), and the full
College Board rationale embedded as an authoring comment. The authoring model
fills in: headline, model steps, walkthrough prose, trap mapping, practice,
close rules. Then runs qa_cluster_page.py.

Never invents content: placeholder options and incomplete text are flagged
inline; missing/placeholder values must be restored from the card PNG by eye.
"""
import html
import json
import os
import re
import sys

ADDITIVE = """
  /* cluster-page additive (approved extension, see explanations/SYSTEM.md section 4): official card images */
  figure.card{margin:26px 0 0;background:var(--panel);border:1px solid var(--rule);border-radius:2px;padding:14px;}
  figure.card img{display:block;width:100%;height:auto;border-radius:2px;}
  figure.card figcaption{margin:12px 4px 2px;}
"""


def esc(s):
    return html.escape(s or "", quote=False)


def main(argv):
    args, opts, skip = [], {}, False
    for i, a in enumerate(argv):
        if skip:
            skip = False
            continue
        if a.startswith("--"):
            opts[a[2:]] = argv[i + 1] if i + 1 < len(argv) else ""
            skip = True
        else:
            args.append(a)
    if len(args) < 2:
        print(__doc__)
        return 1
    slug, qids = args[0], args[1:]
    repo = opts.get("repo-root", "/Users/ashutosh/dev/psat-prep")
    data = {}
    for name in ("ela_questions.json", "math_questions.json"):
        with open(os.path.join(repo, "data", name)) as fh:
            for q in json.load(fh):
                data[q["id"]] = q
    tpl = open(os.path.join(repo, "explainers", "_template.html")).read()
    css = re.search(r"<style>(.*?)</style>", tpl, re.S).group(1).rstrip() + "\n" + ADDITIVE

    missing = [i for i in qids if i not in data]
    if missing:
        print(f"!! unknown ids: {missing}")
        return 1

    out = [f"<!-- depth: {opts.get('depth', 'default')} -->",
           f"<!-- cluster: {slug} (see explanations/SYSTEM.md) -->",
           f"<title>{slug}</title>"]
    out += ['<link rel="preconnect" href="https://fonts.googleapis.com">',
            '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
            '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=Public+Sans:wght@400;500;600;700&family=STIX+Two+Text:ital,wght@0,400;0,500;0,600;1,400&display=swap">',
            "", "<style>" + css + "</style>", "", '<div class="wrap">', "",
            '  <header class="mast">',
            '    <p class="kicker">TODO kicker: PSAT 8/9 · skill · N misses, one model</p>',
            '    <h1>TODO headline<br><em>TODO second line</em></h1>',
            '    <p class="standfirst">TODO: shared slip in one sentence.</p>',
            '    <div class="howto">',
            '      <strong>How to use this.</strong> TODO.',
            '    </div>',
            '  </header>', "",
            '  <!-- TODO: model section (Claim/Test/Match or Shape/Form/Feature/Check) + trap taxonomy -->',
            ""]
    for n, qid in enumerate(qids, 1):
        q = data[qid]
        ph = any((o.get("text") or "").startswith("Option ") for o in q["options"])
        flags = []
        if ph:
            flags.append("PLACEHOLDER OPTIONS — restore choices from the card PNG")
        if q.get("text_complete") is not True:
            flags.append("TEXT INCOMPLETE — restore missing numbers from the card PNG")
        out.append(f'  <!-- AUTHOR NOTE ({qid}): {" // ".join(flags) or "record complete"}')
        out.append(f'       CORRECT KEY: {q["correct_answer"]}')
        out.append(f'       CB RATIONALE: {(q.get("rationale") or "").strip()[:1200]}')
        out.append("  -->")
        out += ['  <section class="qsec" id="q-' + qid + '">',
                '    <div class="qhead">',
                '      <div class="tagrow">',
                f'        <span class="qnum">TODO: Walkthrough {n} of {len(qids)}</span>',
                f'        <span class="qid">{qid}</span>',
                f'        <span class="qtopic">{esc(q.get("domain"))} · {esc(q.get("difficulty"))}</span>',
                '      </div>',
                '      <h2>TODO: plain-English idea title</h2>',
                '    </div>', "",
                '    <figure class="card">',
                f'      <img src="../data/images/{qid}_question.png" alt="TODO alt text">',
                '      <figcaption>TODO: what the card shows, in numbers.</figcaption>',
                '    </figure>', "",
                '    <div class="q">',
                '      <p class="q-label">The question as it appeared</p>',
                f'      <p class="q-text">{esc(q.get("question_text"))}</p>',
                '      <ul class="choices">']
        for o in q["options"]:
            cls = "right" if o["key"] == q["correct_answer"] else "trap"
            verdict = '<span class="verdict">Correct</span>' if cls == "right" else ""
            out.append(f'        <li class="{cls}"><span class="key">{o["key"]}</span>'
                       f'<span>{esc(o.get("text"))}</span>{verdict}</li>')
        out += ['      </ul>', '    </div>', "",
                '    <p class="plain">TODO: what is actually being asked, in plain words.</p>',
                '    <!-- TODO: steps, answer, traps (map each wrong choice to one trap species) -->',
                '  </section>', ""]
    out += ['    <!-- TODO: practice block (.pq items + reveals naming the model step) -->',
            '  <!-- TODO: close rules (portable, never question-specific) -->', "", "</div>", ""]
    text = "\n".join(out)
    if "out" in opts:
        with open(opts["out"], "w") as fh:
            fh.write(text)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
