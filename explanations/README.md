# Explanations

One page per skill, covering every question the student got **wrong** plus every
**Hard** question he attempted — 68 questions across 16 skills, taken from the
Cosmos backup of 2026-08-26.

Each page leads with the mental model shared by that skill's questions, then
walks each question: the data, the job the question is asking for, **what he
actually chose and why it tempted him**, and the answer.

Regenerate the worklist after a fresh backup:

```bash
node scripts/backup_cosmos.js
python3 explanations/build_worklist.py
```

## Pages

| Skill | Wrong | Hard-correct | Page | Published |
| :--- | ---: | ---: | :--- | :--- |
| Command of Evidence | 8 | 9 | `command-of-evidence.html` | https://claude.ai/code/artifact/35d1537d-9fb6-4781-9973-0910b6ea2af3 |
| Nonlinear functions | 3 | 3 | `nonlinear-functions.html` | https://claude.ai/code/artifact/51908d27-ac99-487d-98c1-2997e57636dd |
| Equivalent expressions | 2 | 4 | _pending_ | |
| Central Ideas and Details | 2 | 4 | _pending_ | |
| Area and volume | 2 | 1 | _pending_ | |
| Nonlinear equations & systems | 1 | 6 | _pending_ | |
| Inferences | 1 | 2 | _pending_ | |
| Right triangles and trigonometry | 1 | 1 | _pending_ | |
| Words in Context | 0 | 5 | _pending_ | |
| Text Structure and Purpose | 0 | 5 | _pending_ | |
| Cross-Text Connections | 0 | 3 | _pending_ | |
| Percentages | 0 | 1 | _pending_ | |
| Linear equations in two variables | 0 | 1 | _pending_ | |
| Lines, angles, and triangles | 0 | 1 | _pending_ | |
| One-variable data: distributions | 0 | 1 | _pending_ | |
| Linear equations in one variable | 0 | 1 | _pending_ | |

## Using these from the app

`index.json` maps a question id to its published explainer, anchored to that
question's section:

```json
"1b9fa866": {
  "url": "https://claude.ai/code/artifact/…#q-1b9fa866",
  "skill": "Command of Evidence",
  "file": "explanations/command-of-evidence.html"
}
```

Both `index.html` and `parent.html` fetch it on load and reveal a link only for
questions that have one — the student app under the rationale card, the parent
portal at the top of the per-question modal. A missing or unreachable
`index.json` just leaves the link hidden.

Rebuild it after publishing or updating any explainer:

```bash
python3 explanations/build_index.py
```

It scans `explanations/*.html` and `explainers/*.html` for the stamped
`<!-- artifact: <url> -->` comment and every `<section class="qsec" id="q-XXXX">`
anchor, so **files are named by skill and questions are addressed by id** —
never by date.

`worklist.json` holds the exact question IDs per page.

## Related

`../explainers/` holds the ad-hoc explainers built from IDs on request, plus the
`_template.html` design system these pages share and the `fetch_question.py` /
`find_siblings.py` helpers.
