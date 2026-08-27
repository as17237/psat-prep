#!/usr/bin/env python3
"""Rebuild explanations/worklist.json from the latest Cosmos backup.

Target set = every question answered incorrectly + every Hard question attempted.
"""
import json, os, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def main():
    b = json.load(open(os.path.join(ROOT, 'backups', 'cosmos_backup_latest.json')))
    prof = next(d for d in b['documents'] if d.get('doc_type') == 'student_master_profile')
    prog = prof['progress']
    qs = json.load(open(os.path.join(ROOT, 'data', 'ela_questions.json'))) \
       + json.load(open(os.path.join(ROOT, 'data', 'math_questions.json')))
    meta = {q['id']: q for q in qs}

    att = {k: v for k, v in prog.items() if v.get('answered') and k in meta}
    wrong = {k for k, v in att.items() if not v.get('isCorrect')}
    target = sorted(wrong | {k for k in att if meta[k]['difficulty'] == 'Hard'})

    groups = collections.defaultdict(list)
    for k in target:
        groups[meta[k]['skill']].append(k)
    order = sorted(groups, key=lambda s: (-len([k for k in groups[s] if k in wrong]), -len(groups[s])))

    def slug(s):
        out = ''.join(c if c.isalnum() else '-' for c in s.lower())
        while '--' in out:
            out = out.replace('--', '-')
        return out.strip('-')[:52]

    out = {'generated_from': b['backupMetadata']['generatedAt'],
           'total': len(target), 'wrong': len(wrong), 'groups': []}
    for s in order:
        ids = sorted(groups[s], key=lambda k: (k not in wrong, meta[k]['difficulty']))
        out['groups'].append({
            'skill': s, 'test': meta[ids[0]]['test'], 'domain': meta[ids[0]]['domain'],
            'file': f'explanations/{slug(s)}.html', 'count': len(ids),
            'wrong': [k[:8] for k in ids if k in wrong],
            'hard_correct': [k[:8] for k in ids if k not in wrong],
        })
    json.dump(out, open(os.path.join(ROOT, 'explanations', 'worklist.json'), 'w'), indent=2)
    print(f"{out['total']} questions · {out['wrong']} wrong · {len(order)} pages")

if __name__ == '__main__':
    main()
