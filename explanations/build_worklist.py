#!/usr/bin/env python3
"""Rebuild explanations/worklist.json from the latest Cosmos backup.

Target set = every question answered incorrectly + every Hard question attempted.
"""
import json, os, collections, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STUDENT = os.environ.get('PSAT_STUDENT', 'default_student')


def reassembled_progress(backup_path, student):
    """The student's REAL progress: master profile merged with its progress shards.

    WI-18 freezes a migrated master's `progress` map and routes every new write to
    `progress_shard` documents, so reading `prof['progress']` alone silently returns
    a snapshot frozen at migration time (CLAUDE.md mode 3: the schema changed).
    Reassembly runs through the SHIPPED codec in api/src/lib/datamodel.js rather
    than a Python re-implementation of it, so there is exactly one decoder
    (CLAUDE.md mode 2). A failure here is fatal on purpose — a half-read progress
    map would quietly produce the wrong worklist (mode 5).
    """
    script = (
        "const fs=require('fs'),dm=require(process.argv[1]);"
        "const b=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));"
        "const sa=b.studentAnswers||b.documents||[];const name=process.argv[3];"
        "const m=sa.find(d=>d.doc_type==='student_master_profile'&&d.student_name===name)||{};"
        "const sh=sa.filter(d=>d.doc_type===dm.PROGRESS_SHARD_TYPE&&d.student_name===name);"
        "process.stdout.write(JSON.stringify(Object.assign({},m.progress||{},dm.reassembleProgress(sh))));"
    )
    dm_path = os.path.join(ROOT, 'api', 'src', 'lib', 'datamodel.js')
    out = subprocess.run(['node', '-e', script, dm_path, backup_path, student],
                         capture_output=True, text=True)
    if out.returncode != 0 or not out.stdout.strip():
        raise SystemExit(f"FATAL: could not reassemble progress for {student}: "
                         f"{(out.stderr or 'no output').strip()}")
    return json.loads(out.stdout)


def main():
    backup_path = os.path.join(ROOT, 'backups', 'cosmos_backup_latest.json')
    b = json.load(open(backup_path))
    prog = reassembled_progress(backup_path, STUDENT)
    print(f"reassembled progress for {STUDENT}: {len(prog)} entries "
          f"(master + progress shards, via api/src/lib/datamodel.js)")
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
