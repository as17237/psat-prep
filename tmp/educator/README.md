# Educator lessons — TEMPORARY experiment (branch `exp/educator-lessons`)

Generates static HTML diagnostic lessons with inline SVG visualizations from a
single student's measured practice data. Read-only: touches nothing outside
`tmp/educator/`.

## Regenerate

1. Re-pull the snapshot (read-only Cosmos query, 1 partition):
   `node -e "..."` — see `generate_lessons.js` header inputs; writes
   `student_snapshot.backup.json` (gitignored via `*.backup.json`).
2. `node tmp/educator/generate_lessons.js`
3. Open `tmp/educator/lessons/index.html` (no server needed) or
   `python3 -m http.server` from repo root.

## Files

- `generate_lessons.js` — the generator (dependency-free Node).
- `student_snapshot.backup.json` — student data, NEVER committed.
- `lessons/` — generated output (committed for review).

## What is computed vs written by hand

- Computed from data: skill ranking, accuracies, per-exam trends, miss
  heatmaps, walkthrough + sibling question selection (quality-filtered, never
  invented — the generator throws rather than emit a lesson without one).
- Written by hand: the pedagogy (analogies, rules, traps) for the 3 skills,
  and the learning-science framing (Dunlosky 2013, Cepeda 2006, Karpicke &
  Roediger 2008, Rohrer & Taylor, Sweller, Paivio/Mayer).
