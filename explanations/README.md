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

### Primary pages (WI-21)

A cluster page marked `<!-- primary -->` is the **model-first front door** for the
ids it covers and wins any collision with an older single-question page holding
the same id (which it links to as the "full slow version"). Without this, plain
alphabetical order would silently decide which page the student lands on.
`command-of-evidence-graphs.html` and `nonlinear-functions-model.html` are
primary; the pages they supersede own no ids and are not listed in the Review
tab's walkthrough card.

Both carry a `<!-- verified: <date> -->` stamp recording that every cited figure
was checked against the card PNGs (2026-09-04: all 14 cards read; one correction
— the condor wild-vs-captive crossover is 2014, not 2015, and the captive range
is ~168–193).

### Beta pages (WI-21)

A cluster page whose numbers are **not yet card-verified** carries a
`<!-- beta -->` marker and a visible BETA banner. `build_index.py` routes its
questions into a separate **`betaQuestions`** map (never the verified
`questions` map, so it cannot clobber a verified link even when it covers the
same miss id). The app surfaces `betaQuestions` links **only when
`APP_ENV.isBeta`** (`?env=beta` or a `/beta` path), always badged "🧪 Beta".
Combined with the fact that `explanations/` is not in the deploy `APP_FILES`,
this keeps unverified figures off the real student's screen (CLAUDE.md failure
mode 1). To graduate a page out of beta: verify every number against the card,
refresh the miss set (`build_worklist.py`), remove the `<!-- beta -->` marker
and banner, then re-run `build_index.py`.

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
