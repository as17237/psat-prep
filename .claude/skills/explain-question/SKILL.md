---
name: explain-question
description: Build a step-by-step HTML explainer for any PSAT question by ID, pitched at a 7th–early 8th grader, saved into explainers/ and published as an artifact. Pass --simpler to rebuild an existing explainer with more scaffolding when the student is still stuck. Use when the user gives one or more question IDs and asks to explain, unpack, teach, simplify, or build an explainer for them.
---

# Explain a question

Turn any question ID from the 3,059-question bank into an explainer that builds a **mental model**, not a worked solution.

**The reader is a 7th grader with some early algebra behind him, reading this alone.** Nobody is sitting next to him to fill a gap, so no step may depend on a follow-up question.

**What you may assume** — arithmetic, fractions, negative numbers, plotting points, variables, substituting a number for a variable, combining like terms, distributing, solving a simple linear equation like `2x + 3 = 11`, and **factoring** (including pulling out a common term and using it to find where an expression equals zero).

**What you must build on the page, every time** — quadratics and parabolas, function notation `f(t)`, a variable in an exponent, the quadratic formula, completing the square, and anything named after a rule (`−b/2a`, the zero-product property, vertex form). Treat these as new even if he has seen them once; a technique met recently is not a technique available under time pressure.

When you are unsure which side of the line something falls on, build it. A step he already knew costs him ten seconds; a step he didn't stops him dead.

```
/explain-question <id> [<id> ...]
```

The bank spans both tests, all difficulties, and both question types. Handle whatever you are given:

| | |
| :--- | :--- |
| **Reading and Writing** | Information and Ideas · Craft and Structure · Expression of Ideas · Standard English Conventions |
| **Math** | Algebra · Advanced Math · Problem-Solving and Data Analysis · Geometry and Trigonometry |
| **Type** | 2,694 multiple choice · 365 free response (grid-in, no choices) |
| **Difficulty** | 1,846 Hard · 937 Medium · 276 Easy |

## Depth: `--simpler`

If he reads an explainer and is still stuck, rebuild it with more scaffolding:

```
/explain-question <id> --simpler
```

Each `--simpler` moves one level down. Stack them (`--simpler --simpler`) to go further.

| | Default | `--simpler` | `--simpler --simpler` |
| :--- | :--- | :--- | :--- |
| **Algebra** | use what he has, incl. factoring | arithmetic main path, algebra named after | arithmetic only; no symbol manipulation anywhere |
| **Steps** | one idea per step | split any step holding two ideas | one small move per step, nothing implicit |
| **Numbers** | tables where they help | a table for every claim | every arithmetic line worked out in full, no "so we get" |
| **Words** | define the hard ones | define anything above everyday speech | short sentences, one clause each |
| **Diagrams** | where they earn it | one per major step | label every part of every diagram |

Rebuilding **replaces the existing explainer** — same file path, same artifact URL — so there is one current page per question rather than a confusing set of versions. Record the level as an HTML comment at the top of the file (`<!-- depth: simpler -->`) and in the `explainers/README.md` row, so a later session knows where it left off.

When you rebuild, **find out what broke before rewriting**. If the user said where he got lost, that step is the one to expand most — going uniformly slower everywhere is a worse fix than going much slower at the one place that failed.

## Step 1 — Get the real record. Never work from memory.

```bash
python3 explainers/fetch_question.py <id> [<id> ...]
```

Accepts full or 8-character IDs. Verify any field before you use it; do not assume a schema.

## Step 2 — Read the question image. This is not optional.

The script prints an image path for every question. **Read it with the Read tool before writing anything.**

Equations, tables, diagrams and figures are rendered as pictures in the source PDFs and are **stripped out of the text layer**. This fails silently:

- **901 of 3,059** questions have `text_complete: False` — their extracted text has holes, e.g. *"The function is defined by . Which expression represents the maximum value of ?"*
- **900** store literal placeholder options: `"Option A"`, `"Option B"`.
- The College Board rationale has its equations stripped too, so it often reads as nonsense.

Everything you need is in the image. Skip it and you will explain a question that does not exist.

## Step 3 — Verify by execution before writing a word.

Confirm the stated answer yourself. Never publish a number you have not computed.

**Multiple choice** — evaluate *every* distractor, not just the key. The numbers are what let you name the exact slip behind each wrong choice instead of asserting "C is wrong."

**Free response** — there are no choices, so instead establish what counts as correct. **73 of the 365** free-response keys accept several forms (a fraction and its decimal, or a comma-separated list). Check `correct_answer` for commas or "or", and tell the student every form that is accepted — including whether an equivalent fraction would be marked right.

If your working disagrees with `correct_answer`, **stop and tell the user.** The dataset has had genuinely wrong keys before; do not quietly explain your way to the stored answer.

## Step 4 — Find the mental model.

The goal is transfer. Before writing, finish this sentence: *"Next time you see a question like this, the thing to notice is ___."* If you cannot, you are not ready to write.

A model is portable and describes what to **see** or **do first** — not a fact about this question. Ways to find one, by family:

- **Math, "how many / which graph / what shape"** — usually no algebra is wanted. What do the given conditions force about shape and position?
- **Math, an expression to manipulate** — what is the one structural move, and what does each wrong answer's slip look like?
- **Math, a word problem or data question** — what is being asked *for*, in plain units, and which given is a distraction?
- **Information and Ideas** — what claim must the evidence support, and does the choice actually support *that* claim?
- **Craft and Structure** — what **job** does the word or sentence do? Connectors and pivots are the instructions.
- **Expression of Ideas** — what relationship do the two parts have? The transition must match that relationship.
- **Standard English Conventions** — name the rule, then show why the other three break it. Grammar questions need the rule stated plainly, not a feel for what sounds right.

Two things to check for on any question:

- **A shared model.** If several IDs turn on the same idea, teach them together under one heading. Worth more than separate write-ups.
- **An unused given.** Hard questions often supply a condition that is never needed, purely so students hunt for a use and lose time. If you finished without using something, say so explicitly — an unused given is not proof of a mistake.

## Step 5 — Write it, step by step, assuming nothing.

Copy `explainers/_template.html` to `explainers/<id>.html` (or a descriptive name for a themed set). Keep the CSS byte-identical so the folder reads as one set.

Per question, in order: **the question as it appeared** (real text, holes restored from the image) → **`.plain`**, one italic line on what is actually being asked → **numbered `.step` blocks**, one idea each → **`.answer`** → **`.traps`** → **`.practice`**.

**Scale the depth to the question.** An Easy question may need three steps; a Hard one may need seven. Padding an easy question with ceremony teaches nothing.

**Lead with the route that builds the picture; name the shortcut second.** This is the most important rule on this page.

For anything on the "must build" list, the main path through a step should be one he can walk with arithmetic and a table — that is what produces intuition rather than a memorised move. Then, in a sentence or two clearly marked as optional, name the faster algebraic way for when he meets it. That way the page works whether or not the technique has landed yet, and it keeps working as he learns more.

| For this | Main path | Then mention |
| :--- | :--- | :--- |
| Where a curve hits zero | Factoring is fine here — he has it | the table as a check, so he can verify himself |
| Where a parabola peaks | Find two equal heights; the peak is halfway between | −b/2a, named as the shortcut it is |
| A variable in an exponent | Multiply it out once, slowly, and let the pattern show | the exponent rule by name |
| Choices written as expressions | Turn all four into numbers and compare | the symbolic route, briefly |
| `f(t)` | A machine: put a number in, get a number out — say it every time | — |

If a question genuinely cannot be reached without one of these, teach it from scratch in its own numbered step. Never use one in passing as though it were known.

Rules for the steps:

- **Define every term on first use** in a `.word` box. If a word would make a 12-year-old pause, it gets a box. Reading passages get their hard vocabulary defined too.
- **Build every graph, shape or figure from real values** in a `.vt` table, and let the conclusion fall out of the numbers. Never assert a shape — produce the numbers that leave only one shape possible.
- **Prefer reasoning a 12-year-old can reconstruct over formulas they must trust.** A remembered formula fails under pressure; a picture does not.
- **When the choices are expressions, evaluate all of them into a table.** Matching a number beats manipulating symbols.
- **Give elimination shortcuts their own callout** — anything that kills a choice on sight, before real work.
- **Check that invented example numbers didn't matter.** If you picked convenient values to draw a picture, add a step confirming the reasoning rested on the stated conditions, not on your choices.

Diagram geometry must be **computed, not sketched** — generate coordinates in Python and paste real values. If a true-to-scale drawing would be illegible, draw it schematically, **drop the numeric axis labels**, and say so in the caption. Never imply a false quantity.

### Naming the traps

Explain *why a wrong choice tempts*, never just that it is wrong. This is usually the most valuable text on the page. Most distractors are one of:

- **Reversed** — the right pieces with the comparison running the wrong way.
- **Right number, wrong source** — a real value from the wrong column, row, group, or step.
- **Unsupported claim** — real numbers wrapped in something the data cannot show (e.g. spread inferred from averages).
- **One step short, or one too far** — stopping before the final step, or answering a question that wasn't asked.
- **Sign or direction error** — subtracting where you add, or the wrong end of a range.
- **True but irrelevant** — a correct statement that doesn't answer *this* question.

For free response, there are no distractors: cover the likely wrong paths instead, and list every accepted answer form.

### End with practice, and with the class of problem

**Practice.** Every explainer closes with a `.practice` block holding **two easier questions that drill the same skill**:

```bash
python3 explainers/find_siblings.py <id> -n 2
```

It matches on the `skill` tag and prefers Easy, then Medium, then complete text. Every question has between 34 and 233 siblings, so there is always something. **Read each practice question's image too** — the same extraction holes apply. Put the answer behind the `<details class="reveal">` block so he has to try first, and in the reveal say *which step of the model above did the work*.

**The class of problem.** The closing `.rules` list is where the specific question becomes a general habit. Write each rule so it applies to the next question of that type — something he could say to himself before starting one. Keep it short; two to five lines. This is the part meant to outlive the question.

## Step 6 — Publish and report.

Load the `artifact-design` skill, then publish with the `Artifact` tool. Favicon `📐` for consistency with the set. Add a row to the table in `explainers/README.md`.

**Updating an existing explainer:** republish the same file path from this conversation to keep its URL. From a different conversation, pass the old URL as `url`, or you will create a second artifact instead of updating.

Then tell the user: the link, the model each question turned on, and anything found in the data — a wrong key, a placeholder option, an unused given.

## House style

- Sentences a 12-year-old reads without stopping. Short. Concrete.
- Second person, present tense: *"Follow the curve with your finger."*
- No emoji as section markers. Number the steps — they are a genuine sequence — but never number things that aren't.
- **He is reading alone.** Never write "ask an adult", never leave a step half-finished, and never assume a word is known. If a sentence would make him stop and look something up, it has failed.
- The answer is the least useful part of the page. Write accordingly.
