# Explainer System — from misses to mental models

How Prep Egg turns wrong answers into visual HTML explainers that teach the
*concept*, so the next sibling question falls on its own. Complements the
`explain-question` skill (per-question pages); this doc specifies the
**cluster pipeline**: one page per skill-cluster, built around a transferable
mental model, ending in sibling practice.

## 1. The loop

```
misses (progress + errorTags) → worklist.json → cluster by skill
  → extract the mental model (Claim → Test → Match, §3)
  → build one cluster page (spec §4) → QA (§5) → register in
    index.json (build_index.py) → link from mistakes page (§6)
  → refresh monthly: re-run worklist, retire mastered clusters, open new ones
```

Source of truth for *what to teach*: `explanations/worklist.json`
(`build_worklist.py`), refreshed from live `psat_progress` — `wrong` id lists
plus `errorTag` aggregates, never vibes. Cluster threshold: **≥3 misses in one
skill**, or ≥2 with the same trap species (§3).

## 2. Page kinds

| Kind | When | Shape |
|---|---|---|
| Cluster page (default) | one mental model explains ≥3 misses | model section + 2–3 worked misses + sibling practice + portable rules |
| Single page | lone miss, no cluster | existing `explain-question` pattern, unchanged |

This session's proof: `explanations/command-of-evidence-graphs.html` —
8 Command-of-Evidence graph/table misses, one model.

## 3. Mental-model extraction

Every cluster page teaches **Claim → Test → Match**:

1. **CLAIM** — the sentence the data must support (underlined conclusion,
   blank-filler, hypothesis). Student restates it in ~10 words first.
2. **TEST** — the claim rewritten as a yes/no check on the figure
   ("which line climbs?", "which group is lowest?", "bounce or flat?").
3. **MATCH** — every word of each choice checked against the figure.
   Choices are never judged true/false in isolation — only *does it prove
   the claim*.

Trap taxonomy (name the species in every walkthrough — naming is the transfer):

| Species | Shape | Example in CoE cluster |
|---|---|---|
| True-but-useless | numbers right, claim wrong | tree-growth A/B/C: accurate, answer a different question |
| Backwards | direction flipped | honeybee D: hexagonal *higher* for western, not lower |
| Half-right | one clause breaks it | seagrass A (Feb-2017 detail false), C (two cherry-picked windows) |
| Text-trap | contradicts the passage | honeybee B: eggs go in *hexagonal* cells, says the text |

## 4. Cluster-page spec

Follow `explainers/_template.html`: CSS **byte-identical**, same blocks
(`.qsec .steps .word .keybox .answer .traps .practice .close`). Additions:

- `.model` section first: the 3 model steps as `.step`s + trap table as
  `.traps`. This is the part the student re-reads before siblings.
- Each worked miss is one `.qsec` with `id="q-<id>"` (deep-link target).
- **Card image first**: `<figure class="card">` with
  `<img src="../data/images/<id>_question.png">` + caption, *above* the
  transcription. The PNG is the authority (901 text-incomplete records, 900
  placeholder-option sets) — never transcribe a number the card disagrees
  with; re-check every cited value against the card, not the JSON text.
- Vocabulary boxes (`.word`) for every domain term a 7th grader may not
  have (delta 15-N, period, intermittently…).
- Practice block: remaining cluster misses as `.pq` items with full choices
  + `<details class="reveal">` whose answer names **which model step did
  the work**. Plus 1–2 easier same-skill siblings from `find_siblings.py`.
- `.close` rules must be portable ("If a choice is true but answers a
  different claim, it is wrong *here*") — never question-specific.
- Depth stamp `<!-- depth: default -->`; `--simpler` rebuild rules unchanged.

## 5. QA checklist (all must pass before registering)

1. Every number cited appears on the card image (checked by eye, not JSON).
2. Correct keys re-verified against the dataset (`correct_answer`).
3. Each wrong choice mapped to exactly one trap species, in student words.
4. No `Option A`-style placeholder text anywhere on the page.
5. Reveal answers reference the model steps by name.
6. `index.json` entry added (question ids → file); page opens from
   `file://` and from the local server; mobile 360px scrolls, no sideways
   overflow; images have alt text.

## 6. App integration

- Mistakes page links each miss to its explainer when `index.json` has the
  id: `explanations/<file>#q-<id>` (new-tab link with a "visual walkthrough"
  label). No id → existing rationale view, unchanged.
- Recovery drills (`generatePostExamRecoveryPlan`) keep pointing at sibling
  *questions*; the explainer is the "why" behind the drill, linked from the
  drill header when the missed skill has a cluster page.
- No engine changes, no new localStorage keys, no bundle impact — pages are
  static files beside `data/images/`.

## 7. Refresh cadence

Monthly (or after each full mock): re-run `build_worklist.py`, retire
clusters whose skills are back above 75%, open the next biggest cluster.
Worked examples stay frozen (they're history); practice blocks may rotate in
fresh siblings. Record each run in `index.json.generated`.
