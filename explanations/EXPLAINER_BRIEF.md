# Explainer Build Brief — one cluster page, start to finish

**Audience:** any agent (or person) building a skill-cluster explainer for the
`as17237/psat-prep` repo. Self-contained: if you have the repo and this file, you
have everything. Read it fully before writing a line of HTML.

**Data as of 2026-09-04** (backup `cosmos_backup_2026-09-04T10-52-02-234Z`):
767 questions answered, **81.6% accuracy** (RW 82.9%, Math 79.6%), **141 misses**
across 26 skills.

---

## 1. The job, and the one idea behind it

You are building **one HTML page for one skill**, for a real 13–14-year-old
studying for the PSAT 8/9. He has already seen the official College Board
rationale for every question he missed — it is rendered in the app under each
question. **Do not rebuild that.**

> The rationale explains **the question**. Your page teaches **the concept**, so
> the *next* question of that type falls on its own.

If a student finishes your page and can only solve the questions on it, you have
failed. He must leave with a **named, reusable procedure** he can run on a
question he has never seen.

**Cluster, don't enumerate.** You are not writing one section per miss. You are
finding the *single mental model* that explains why all of these were missed, and
teaching that — then showing it fire on 2–3 worked examples, then handing him
practice.

---

## 2. Orientation — the repo

```
data/ela_questions.json, data/math_questions.json   3,059 records (the dataset)
data/images/<id>_question.png                        the OFFICIAL question card
explanations/                                        cluster pages live here
explanations/SYSTEM.md                               the pipeline spec (read it)
explanations/worklist.json                           current misses per skill
explainers/_template.html                            the design system (CSS source)
explainers/scaffold_cluster.py                       scaffolds a page from ids
explainers/qa_cluster_page.py                        the machine QA gate
explanations/build_index.py                          registers ids -> page
```

Record shape (verify a field exists before using it — never assume):

```
id, assessment, test, domain, skill, difficulty,
type ("multiple_choice" | "free_response"),
question_text,                       <-- NOT "prompt"
options: [ {key:"A", text:"…"}, … ], <-- an ARRAY; find by o.key === "A"
correct_answer, rationale, has_image, question_image
```

Serve locally with `python3 -m http.server 8000` from the repo root; your page is
at `/explanations/<slug>.html`.

---

## 3. Non-negotiable rules

These exist because each one has already shipped as a bug here.

1. **The card PNG is the only authority.** 901 records have incomplete text and
   900 have placeholder options (literally `"Option A"`). The JSON may be wrong;
   the image never is. **Open every card image and read it with your own eyes**
   before citing any number, label, axis, year, or answer choice.
2. **Every number you print must be one you personally read off the card.** No
   number inferred from the rationale, no number carried over from another
   document, no "approximately" hiding a guess. If you cannot read it, do not
   cite it — describe the shape instead ("the line climbs steadily").
3. **Quote choices verbatim** from the card (or the dataset when its options are
   real). Never paraphrase an answer choice.
4. **Do not invent the student's reasoning.** You may say "the trap here is X"
   because the trap is a property of the question. Only say "you chose D" if the
   assignment below tells you he did.
5. **CSS is byte-identical to `explainers/_template.html`.** The template's
   `<style>` block must be a strict *prefix* of yours. Add new rules only at the
   end. The QA script enforces this.
6. **Every cited number gets checked twice** — once when you write it, once in a
   final pass against the card.

---

## 4. Page structure

Follow `explanations/SYSTEM.md` §4 and copy the shape of the two finished pages:

- `explanations/command-of-evidence-graphs.html` (RW exemplar)
- `explanations/nonlinear-functions-model.html` (Math exemplar)

Required order:

1. **Header comments** — `<!-- depth: default -->`, then
   `<!-- primary: … -->` (this page is the front door for its ids), then
   `<!-- verified: <YYYY-MM-DD> — every cited figure checked against all N card PNGs. -->`
2. `<title>` — a real, memorable title, not the skill name.
   *Good:* "Don't Read the Graph — Interrogate It". *Bad:* "Command of Evidence".
3. A back link: `<a href="../index.html">← Back to Prep Egg</a>`
4. `<header class="mast">` — kicker, `<h1>`, standfirst, and a `.howto` box.
5. **`<section class="qsec" id="model">` — the model.** The most important part.
   3–4 numbered `.step`s + a `.traps` table naming each trap species.
   Must fit roughly one screen. This is what he re-reads before a test.
6. **2–3 worked misses**, each `<section class="qsec" id="q-<id>">` containing:
   `<figure class="card">` with `<img src="../data/images/<id>_question.png">`
   and a caption **above** the transcription, then `.q` (question + `.choices`
   marking `.right`/`.trap`), a `.plain` one-liner, the `.steps` showing the model
   firing, an `.answer` block, and a `.traps` block explaining every wrong choice.
7. **`<div class="practice">`** — the remaining misses as `<div class="pq" id="q-<id>">`
   items with full choices and a `<details class="reveal">` whose answer **names
   which model step did the work**. Add 1–2 easier same-skill siblings.
8. **`<section class="close">`** — "The whole page in five lines": portable rules
   only. A rule that mentions a specific question is not portable.

Available blocks (all styled by the template): `.qsec .steps .step .snum .word
.keybox .traps .trapitem .choices .answer .practice .pq .reveal .close .vt
table.vals .plain .faster figure.card`.

---

## 5. Be creative — this is the part that matters

The structure above is a skeleton. A skeleton is not a lesson. What makes these
pages work is the writing, and you are expected to be genuinely inventive here.

**Name things.** A model with a name gets remembered; a paragraph does not.
`Claim → Test → Match`. `Shape → Form → Feature → Check`. Give your skill its own
named procedure, 3–4 steps, each step a **verb**. Then name the traps —
*True-but-useless*, *Backwards*, *Half-right*, *Story-number grab*. Naming a trap
is the single highest-transfer thing on the page: once he can say "that's a
Backwards," he stops falling for it.

**Write to a 13-year-old, not down to one.** Short sentences. Second person.
Contractions. Concrete before abstract. No hedging, no throat-clearing, no "it is
important to note that". Compare:

> ✗ "It is essential to first identify the claim being made before evaluating
>   the answer choices for evidentiary support."
> ✓ "Find the sentence the data is supposed to prove. Say it in ten words. If you
>   can't point at it, you're not ready to look at the choices."

**Lead with the killing blow.** For every wrong choice, give the *one check* that
kills it in ten seconds — not a paragraph of analysis. "Day zero must give 53. D
gives 2,809. Dead." That's the whole explanation.

**Use the picture.** Put the card image above the transcription and refer to it
physically: "run your finger across the Akumal row", "find the square-marked
line". Embodied instructions stick.

**Vocabulary boxes** (`.word`) for any term a 7th grader may not own —
*intermittently*, *nonhexagonal*, *period*, *bridging trust*. One sentence, plain
words.

**Find the pattern across the misses.** The best line on the finished nonlinear
page is that all three wrong answers were **D**, for three different reasons —
that observation is what makes the page memorable. Look for that kind of thread
in your cluster and build the page around it.

**Things that make a page worse:** restating the CB rationale; a wall of prose
before the model; explaining a question instead of a pattern; a "close" rule that
only applies to one question; cleverness that costs clarity.

---

## 6. Your assignment

Build **one** page for the cluster named in your task. IDs are 8-char prefixes;
the card is `data/images/<id>_question.png`. `(H)/(M)/(E)` = difficulty.

| Skill | Test | Misses to cover | Suggested file |
|---|---|---|---|
| **Words in Context** | RW | `e545b111`(E) `6d7897fa`(H) `c795962b`(H) `dbece047`(H) `32578cc7`(M) `d423172b`(M) `e9798f2b`(M) `fb17d540`(M) | `explanations/words-in-context.html` |
| **Inferences** | RW | `29d97f27`(H) `45659801`(H) `4c4fe342`(H) `737870c6`(H) `8d605fb1`(H) `bc9c696f`(H) `c188a048`(H) `ea1de10e`(H) `f2040ca2`(H) `1f222de0`(M) `49568189`(M) `85fae948`(M) | `explanations/inferences.html` |
| **Nonlinear equations & systems** | Math | `1d4f9e0d`(H) `39d18414`(H) `5422f370`(H) `5879c172`(H) `828a628e`(H) `9c2a8ff4`(H) `a181bd86`(H) `aa3f6ab0`(H) `e80003f5`(H) `f9744796`(H) `ae662dda`(M) | `explanations/nonlinear-equations.html` |
| **Text Structure and Purpose** | RW | `5438bcd5`(H) `b46f4b75`(H) `dd948d66`(H) `e52f6f74`(H) `fde9312b`(H) `99bd56d8`(M) | `explanations/text-structure-and-purpose.html` |
| **Boundaries** | RW | `11de53df`(H) `25273a8d`(H) `95aee254`(H) `e3051a8e`(H) `7e989974`(M) | `explanations/boundaries.html` |

Pick **2–3** of your misses to walk in full (choose the ones that best show the
model — usually the Hard ones with the richest traps); the rest go in the
practice block. For easier sibling drills, `explanations/worklist.json` lists a
`hard_correct` array per skill (questions he got right — good stretch targets),
and `explainers/find_siblings.py` finds same-skill questions.

If your cluster has more than ~8 misses (Inferences, Nonlinear equations), do
**not** cram all of them in. Cover the ones that share the model; note the
leftovers at the bottom as "retry in the app" with their ids.

---

## 7. Definition of done

Run these and paste the real output into your report.

```bash
# 1. Machine QA — must exit 0. Keys come from the dataset.
python3 explainers/qa_cluster_page.py explanations/<slug>.html \
  --ids <id1>,<id2>,... --keys <id1>:<A>,<id2>:<B>,...

# 2. Register the page (adds its #q-<id> anchors to the index)
python3 explanations/build_index.py

# 3. Repo gates
node tests/test_explainer_links.js
node tests/test_html_syntax.js
```

Checklist — every line must be true:

- [ ] I opened **every** card PNG for every id on the page and read it.
- [ ] Every number on the page was read off a card by me, twice.
- [ ] Every answer choice is verbatim.
- [ ] Correct keys match `correct_answer` in the dataset.
- [ ] The model section has a named procedure with verb steps and fits a screen.
- [ ] Every wrong choice is mapped to exactly one **named** trap species.
- [ ] Every `.reveal` names the model step that did the work.
- [ ] The `.close` rules are portable — none names a specific question.
- [ ] `<!-- primary -->` and `<!-- verified: <date> -->` headers present.
- [ ] `qa_cluster_page.py` exits 0; the repo gates pass.
- [ ] Page opens from the local server; no sideways scroll at 360px width.

**Report honestly.** If you could not read a value off a card, say so explicitly
rather than printing a number. A page with one admitted gap is fine; a page with
one invented number is not — that is the single defect this project has shipped
most often, and it is why the last page was rebuilt.

---

## 8. Publishing (maintainer only — do not run as a subagent)

```bash
python3 explanations/build_index.py       # register
./scripts/publish_explainers.sh           # upload to $web (prod)
```

The pages are also listed automatically in the app's **Review** tab, and linked
under the rationale of any question they cover.
