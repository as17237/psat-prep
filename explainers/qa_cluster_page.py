#!/usr/bin/env python3
"""QA a cluster explainer page against the dataset (SYSTEM.md section 5).

Usage:
    python3 qa_cluster_page.py <html> --ids a,b,c --keys a:A,b:B \\
        [--repo-root DIR] [--strict-choices]

Checks: card PNGs exist; image refs + #q-<id> anchors present; correct keys
match the dataset; choice texts verbatim (skipped with a warning for
placeholder-option records unless --strict-choices); no literal placeholder
options; tags balanced; template CSS is a strict prefix of page CSS.
Exit 0 = all green, 1 = failure. Pass --ids/--keys for every covered question.
"""
import json
import os
import re
import sys
from html.parser import HTMLParser

VOID = {"img", "br", "meta", "link", "hr", "input", "source"}


class Balance(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.errs = [], []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if self.stack and self.stack[-1] == tag:
            self.stack.pop()
        else:
            self.errs.append((tag, self.getpos()))


def main(argv):
    if len(argv) < 1 or "--ids" not in argv or "--keys" not in argv:
        print(__doc__)
        return 1
    path = argv[0]
    get = lambda f: argv[argv.index(f) + 1]
    ids = get("--ids").split(",")
    keys = dict(kv.split(":") for kv in get("--keys").split(","))
    repo = get("--repo-root") if "--repo-root" in argv else "/Users/ashutosh/dev/psat-prep"
    strict = "--strict-choices" in argv
    fails, warns = [], []

    data = {}
    for name in ("ela_questions.json", "math_questions.json"):
        with open(os.path.join(repo, "data", name)) as fh:
            for q in json.load(fh):
                data[q["id"]] = q
    html = open(path).read()

    for i in ids:
        if i not in data:
            fails.append(f"{i}: unknown id")
            continue
        if not os.path.exists(os.path.join(repo, "data", "images", f"{i}_question.png")):
            fails.append(f"{i}: card PNG missing")
        if f"images/{i}_question.png" not in html:
            fails.append(f"{i}: image ref missing")
        if f'id="q-{i}"' not in html:
            fails.append(f"{i}: #q-{i} anchor missing")
        if data[i]["correct_answer"] != keys.get(i):
            fails.append(f"{i}: key {keys.get(i)} != dataset {data[i]['correct_answer']}")
        ph = any((o.get("text") or "").startswith("Option ") for o in data[i]["options"])
        if ph and not strict:
            warns.append(f"{i}: placeholder options — choices must be restored from card PNG")
        else:
            for o in data[i]["options"]:
                if (o["text"] or "")[:60] not in html:
                    fails.append(f"{i}: choice {o['key']} text not verbatim")
    if "Option A" in html:
        fails.append("literal placeholder 'Option A' on page")
    p = Balance()
    p.feed(html)
    if p.errs or p.stack:
        fails.append(f"tag imbalance: {p.errs} {p.stack}")
    tpl = open(os.path.join(repo, "explainers", "_template.html")).read()
    t = re.search(r"<style>(.*?)</style>", tpl, re.S).group(1)
    m = re.search(r"<style>(.*?)</style>", html, re.S)
    if not m:
        fails.append("no <style> block")
    elif not m.group(1).startswith(t):
        fails.append("template CSS is not a strict prefix of page CSS")
    for w in warns:
        print("WARN:", w)
    if fails:
        print("FAIL:")
        for f in fails:
            print("  -", f)
        return 1
    print(f"PASS: {path} ({len(ids)} questions green)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
