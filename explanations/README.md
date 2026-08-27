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
| Nonlinear functions | 3 | 3 | _pending_ | |
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

`worklist.json` holds the exact question IDs per page.

## Related

`../explainers/` holds the ad-hoc explainers built from IDs on request, plus the
`_template.html` design system these pages share and the `fetch_question.py` /
`find_siblings.py` helpers.
