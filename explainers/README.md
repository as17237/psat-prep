# Explainers

Step-by-step HTML explainers for questions the student got wrong, pitched at a
7th–early 8th grader. Each file is self-contained and publishable as an artifact.

Built by the `explain-question` skill, which works for any ID in the bank —
either test, any of the eight domains, multiple choice or free response, any
difficulty:

```
/explain-question 1224cb23
/explain-question 1224cb23 7ced5c84      # a themed set, taught together
/explain-question 1224cb23 --simpler     # still stuck? rebuild with more scaffolding
```

`--simpler` rebuilds an existing explainer one level down — more steps, more
tables, arithmetic in place of algebra. Stack it (`--simpler --simpler`) to go
further. It replaces the page in place, keeping the same URL, so there's one
current explainer per question. The level is stamped at the top of each file.

## Built so far

| File | Questions | Depth | Published |
| :--- | :--- | :--- | :--- |
| `2026-08-26-five-hard-questions.html` | `7ced5c84` `1224cb23` `d98c3c8c` `fde9312b` `e465d17e` | default | https://claude.ai/code/artifact/dc39798f-97a8-4121-917f-35bb5d2eb509 |

## Who it's written for

A **7th grader who has not done formal algebra, reading alone.** He has
arithmetic, fractions, negative numbers, and plotting points. He does not have
the quadratic formula, function notation, variable exponents, or anything named
after a rule. He *does* have factoring. Lead with the route that builds the
picture — a table, trying values, symmetry — then name the algebraic shortcut
after it, so the page teaches the why and the speed.

## Files here

- `_template.html` — the shared design system and skeleton. Copy it; keep the
  CSS identical so every explainer reads as one set. Never write an explainer
  into this file.
- `fetch_question.py` — dumps a question's real record, its image path, and for
  free response the accepted answer forms. Always the first step.
- `find_siblings.py` — finds easier questions with the same `skill` tag for the
  practice block at the end of each explainer.

## Two things that bite

**The image is the only complete source.** All 3,059 questions store their
content as a rendered card image. **901** have `text_complete: False`, meaning
the extracted text has holes where equations and figures were, and **900** store
literal placeholder options (`"Option A"`). The College Board rationale is
stripped the same way. Read the image before writing anything.

**Free-response keys can accept several forms.** **73** of the 365 grid-in keys
list more than one accepted answer — a fraction and its decimal, for instance.
`fetch_question.py` splits these out; pass all of them on to the student.
