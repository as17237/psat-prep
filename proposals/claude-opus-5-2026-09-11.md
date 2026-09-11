# Proposal: Generic Exam Prep Framework

*Analysis basis: repository at `exp/educator-lessons` (HEAD `5a72906`), reviewed 2026-09-11. Every count, file path and line reference below was read or executed against the working tree; where I ran code to get a number, the command is shown.*

---

## 1. Findings from the existing codebase

### 1.1 The system as it stands

The client is static and has no build step. `package.json` states its own scope plainly: *"this package.json exists only to pin test tooling"*, and its single dependency is Playwright. Four hand-written HTML pages (`index.html` 1,630 lines, `parent.html` 1,222, `mistakes.html` 235, `feedback.html` 198) plus a design reference page load a set of plain `<script>` UMD modules alongside a set of native ES modules. State lives in `localStorage` and syncs to the cloud. The backend is Azure Functions v4 on a Consumption (Y1) plan. The store is Cosmos DB serverless: one container, partitioned by `student_name`, with isolation between lanes expressed as a partition key value rather than as separate infrastructure.

### 1.2 What is measurably here

| Thing | Measured value |
| :--- | :--- |
| Question bank | 3,059 records; 1,554 Reading and Writing, 1,505 Math; 8 domains |
| Question types | 2,694 multiple choice, 365 free response |
| Bundle shipped to the browser | `data/questions_data.js`, 6,080,994 bytes, parsed eagerly on page load |
| Question card images | 3,059 PNGs, 325 MB |
| Records with incomplete text | 901 of 3,059 (image is the authority for those) |
| Engine + page JavaScript | ~22,100 lines across `js/`, `api/src/`, `srs.js` and the four pages |
| Node test suites | 47 offline suites, discovered not listed, with a floor assertion |
| Browser tests | 30 Playwright specs |

Verified with:

```bash
node -e "const fs=require('fs');const js=fs.readFileSync('data/questions_data.js','utf8');
const d=JSON.parse(js.slice(js.indexOf('=')+1,js.lastIndexOf(']')+1));
console.log(d.length, d.filter(q=>q.type==='free_response').length, d.filter(q=>!q.text_complete).length);"
# 3059 365 901
```

### 1.3 What already generalizes cleanly, and should be carried forward

I want to be concrete about this, because the honest finding is that this codebase is much further along than "a single-subject app" suggests. Several of its patterns are better than what a greenfield rewrite would produce by default.

**The pure-engine discipline is real and it is the asset.** `js/engine/` holds grading, scheduling, scoring, exam generation, sync merge and exam lifecycle as modules with no DOM access and no clock reads. `js/engine/exam_state.js` and `js/engine/attempt.js` take `now` as a parameter on every function. `api/src/lib/merge.js` and `api/src/lib/datamodel.js` state purity as a contract in their headers and hold to it. This is exactly the functional core the redesign brief asks for, already built, already unit-pinned offline. It should be lifted, not rewritten.

**The exam definition is already data, not code.** `js/engine/adaptive_config.js` holds `OFFICIAL_BLUEPRINTS` (per-section module counts, per-domain target/min/max, time limits) and `SCALING_ASSUMPTIONS` (score floor and ceiling, sample-size gate, curve exponents) as plain objects with `version` strings. A generic framework needs roughly this object, typed and loaded per exam rather than imported as a constant. The conceptual work is done.

**The measurement-versus-estimate discipline is the best thing in the repository.** `adaptive_config.js` separates, in its own header, "MEASURED, published" values from "hand-authored ESTIMATES (NOT published, NOT validated)", marks the latter `(unvalidated)` inline, and requires anything derived from them to be labelled an Estimate. `SCALING_ASSUMPTIONS.MIN_SCORED_TEST_QUESTIONS` carries a paragraph explaining why a topic-filtered drill is biased by construction and may not be scaled. This is a product-correctness invariant that no framework gives you for free and that a rewrite will lose unless it is deliberately encoded. I treat it as a first-class requirement in §2.

**The self-verifying codec is a pattern worth stealing.** `api/src/lib/datamodel.js` compresses progress and SRS records with a short-key mapping, then re-expands its own output and compares byte-for-byte with the input including key order; on any mismatch it stores the original verbatim under `$r` and counts the fallback. The result is a compressor that cannot lose data on shapes it has never seen, only fail to save bytes, and that reports its own degradation as a number. Any future encode/decode boundary in the framework should be built this way.

**The safety scar tissue is institutional knowledge.** `CLAUDE.md` names seven recurring failure modes across six review rounds, each with citations. `scripts/run_offline_tests.sh` discovers suites rather than listing them and fails if it finds fewer than 30, because a hand-maintained list is how the previous coverage gap appeared. `scripts/lib/deploy_common.sh` refuses to write outside a lane's blob prefix and hard-fails if a module exists on disk but is absent from `APP_FILES`. These are not generic best practices; each one is a fix for a specific shipped defect. They should survive the redesign as executable rules, not as prose.

### 1.4 What will fight generalization

**a. Identity is a string literal in 26 files.** `default_student` appears across `js/engine/sync.js`, `js/engine/storage.js`, `js/shared/env.js`, `js/pages/parent.js`, `api/src/functions/sync.js`, `api/src/lib/merge.js`, five scripts and fourteen test files. `getEnvironmentConfig` derives the student name from the URL path. Multi-student is not a matter of parameterising a variable; it is a matter of introducing an identity concept that does not currently exist anywhere in the system.

**b. There is no authentication.** All four HTTP functions declare `authLevel: 'anonymous'`, and `api/src/functions/sync.js:54` reads the student identity straight off the query string:

```js
const studentName = request.query.get('student_name') || 'default_student';
```

Any caller can read or overwrite any student's records by changing a query parameter. `/api/backup` is also anonymous and triggers a full database export. For a single household behind an unlisted URL this is a deliberate simplification; for multi-account it is the single hardest blocker in the codebase, and it is an authorization model that has to be designed rather than retrofitted. Note this is not only about strangers: in a multi-student framework, sibling A must not read sibling B's records, and that is the same missing mechanism.

**c. The taxonomy is free text, normalized in exactly one place.** The bundle spells the domain `Problem-Solving and Data Analysis` (hyphen). `js/engine/adaptive_config.js:98` and `:127` spell it `Problem Solving and Data Analysis` (no hyphen). `js/engine/examgen.js:112` carries a private `_normalizeDomain` that lowercases and collapses hyphens and spaces, and uses it at three sites to match blueprint keys against record values. No other consumer normalizes. `js/engine/test_planner.js:677` filters with exact equality:

```js
step('domains', function (q) { return request.domains.indexOf(q.domain) !== -1; }, ...)
```

So the same conceptual mismatch is papered over in the exam generator and left live in the test planner. This is `CLAUDE.md` failure mode 2 ("applying a rule in one place but not its twin") present in the tree right now, and it is caused by using display strings as join keys. A generic framework that lets an admin define arbitrary taxonomies will hit this on the first import.

**d. The exam shape is specified twice.** `OFFICIAL_BLUEPRINTS.standard_psat89` says 2 modules of 27 for Reading and Writing at 32 minutes; `PSAT_89_SPECS.sections.readingAndWriting` independently says 54 questions, 64 minutes, two modules of 27 at `32 * 60` seconds. Two objects, one fact. `CLAUDE.md` records that a prior version of this duplication produced an 88-question exam advertised as 98. One `ExamConfig` with derived totals removes the class.

**e. The storage model was forced into an unnatural shape by the store.** `api/src/lib/datamodel.js` exists entirely because Cosmos DB has a 2 MB hard per-document limit and the single `student_<name>` master document was measured at 234,708 bytes with 406 progress entries, projecting to 3.29 MB at full bank coverage — a write rejection, meaning data loss, at roughly 1,500 to 2,000 answered questions. The response was a 16-bucket FNV-1a shard scheme plus a lossless key-shortening codec: 707 lines of genuinely careful engineering whose entire purpose is to work around a document-size ceiling. In a row-oriented store, none of it needs to exist. This is the strongest single argument in the repository against carrying Cosmos forward.

**f. The merge cannot be made correct, and its authors say so.** `api/src/lib/merge.js` documents DATA-01 in unusual detail: two devices answering the same question from a shared base of one prior attempt end at `timesSeen: 2` when the truth is 3, because per-field maxima cannot distinguish two indistinguishable attempts. The header states the real fix plainly:

> The real fix is durable append-only attempt events with stable ids (Milestone 3), which is out of scope here. This change only stops the counters from going backwards.

It also notes that monotonic maxima break the `timesSeen === timesCorrect + timesIncorrect` invariant, and that a deliberate downward correction (a parent "Replace" import) can now be resurrected by a stale device. That is DATA-06, explicitly unsolved. The project has already diagnosed its own data model; §2 acts on that diagnosis rather than re-deriving it.

**g. Styling and logic are entangled by construction, but less than expected.** The four pages carry 1,458 `class=` attributes and 36 inline `style=` attributes between them. `REFACTOR_PLAN.md` §1 identifies "~5,100 lines of untestable inline JS across four HTML monoliths" as the primary root cause of recurring regressions, and the WI-09 through WI-15 work items have already moved most of it into `js/pages/`. What remains is that the page controllers still hold display rules: `js/pages/student.js` is 3,039 lines and `js/pages/parent.js` is 1,362, and both still reference section names directly. The separation is half-done and heading the right way.

**h. Two module systems coexist.** `js/engine/*` uses a UMD wrapper publishing onto `window.__PSAT_ENGINE_PARTS`; `js/pages/*` and `js/shared/*` use native ES modules. `srs.js` is a facade that recomposes the parts into the historic `PSAT_ENGINE` global and throws if any of 8 parts or any of ~100 named symbols is absent. The throw is good engineering under the constraint. The constraint is the absence of a build step, and it is now costing more than it saves: `scripts/lib/deploy_common.sh` maintains a hand-listed `APP_FILES` manifest with a guard against forgotten entries, because a missing file silently breaks a whole lane (`RELEASE_RING_DESIGN.md` §3.8 records this happening during the WI-22 deploy).

**i. Deployed bytes are not working-tree bytes.** `scripts/deploy_v2.sh` rewrites question-image paths and injects `PSAT_CLIENT_VERSION` at staging time (`RELEASE_RING_DESIGN.md` §3.7). There is a build step; it is just written in `sed` and lives in a shell script, where no type checker or test can see it.

**j. There is no infrastructure as code.** A search for `*.tf`, `*.bicep` or ARM templates returns nothing. Infrastructure is `az` CLI invocations embedded in shell scripts and in `SYSTEM_ARCHITECTURE_AND_PLAN.md` §6. Standing up a second environment today is a manual procedure, which is precisely why the pre/prod/old ring is still a draft.

**k. The client loads the entire bank.** Every page parses a 6 MB JavaScript literal to answer questions about a handful of records. At one exam config and 3,059 questions this is merely slow. At ten exam configs it is not viable.

---

## 2. Proposed framework model (multi-subject, multi-student)

### 2.1 The five concepts

The framework is defined by five artifacts. Everything else is a function over them.

**1. `ExamConfig` — the exam as data.** One versioned, immutable document describing sections, modules, per-module question counts and time limits, the taxonomy it expects, the blueprint (per-domain target/min/max), the scoring rule to apply, the adaptive routing rule if any, and the sample-size gates below which no score may be shown. Publishing a new version never mutates an old one, because attempts already scored under `psat89@3` must remain interpretable forever.

This replaces `OFFICIAL_BLUEPRINTS` plus `PSAT_89_SPECS` plus `SCALING_ASSUMPTIONS` with one object, and removes finding (d) structurally.

Critically, the measurement/estimate distinction from `adaptive_config.js` becomes a typed field rather than a comment. Every numeric parameter carries a `provenance` discriminant:

```ts
type Provenance =
  | { kind: 'published'; source: string; retrieved: string }
  | { kind: 'estimate'; rationale: string; validated: false }
```

A score derived from any parameter whose provenance is `estimate` is typed as an estimate all the way to the renderer, and the renderer has no code path that displays an estimate without its label. `CLAUDE.md` failure mode 1 — the most persistent defect in this project's history, present in five of six review rounds — stops being a discipline that reviewers must enforce and becomes a thing the compiler enforces. I consider this the single highest-value change in the proposal.

**2. `Taxonomy` — identified, not spelled.** Sections, domains and skills are records with a stable `id` (`psat89.math.psda`), a `label` for display, and optional `aliases` for import matching. Questions and blueprints reference ids. Normalization happens exactly once, at import, and the result is checked: an import that cannot resolve a label to an id fails loudly with the unresolved values listed, rather than silently producing a drill with zero questions. Finding (c) becomes an import-time error instead of a runtime near-miss.

**3. `QuestionBank` — content, versioned, addressed by content hash.** Questions belong to a bank; a bank targets a taxonomy; an `ExamConfig` references a bank version. Assets (the 325 MB of PNGs) live in object storage addressed by hash, served through signed URLs, never bundled. A bank is imported through a validator that reports both counts the way `validator.py` already does: valid *and* complete, never one number that flatters (`CLAUDE.md` failure mode 5).

**4. `Learner` and `Household` — identity as a first-class row.** A household has one or more guardians and one or more learners. A learner enrolls in an exam config. Every attempt event carries `learner_id`, and every query is scoped by an authorization check, not by a query parameter. This is the concept that does not exist today (finding a) and that cannot be retrofitted by parameterisation.

**5. `AttemptEvent` — the append-only spine.** Discussed in §2.2.

### 2.2 Data sanctity: append-only events, derived projections

I recommend an append-only event log as the source of truth for learner activity, with all read models derived from it. I want to give the reasoning rather than assert it, because this is the decision most likely to be called over-engineering.

The argument is not abstract. `api/src/lib/merge.js` already names append-only events with stable ids as the fix for the defect it cannot otherwise close. The current model stores a mutable per-question record with counters, and two devices merging that record must reconcile two summaries of histories they cannot see. With events, both devices emit `AttemptRecorded` rows with client-generated UUIDs, the server inserts both, the counter is `count(*)`, and the answer is 3 because three things happened. There is no merge rule to get wrong, because there is no merge.

Four further properties follow, each of which maps to a defect class in `CLAUDE.md`:

- **Nothing overwrites.** Failure mode 7 is destructive actions without a guard — "Load Sample Data" wholesale-overwriting four `localStorage` keys, quota recovery silently pruning completed exam reports. An append-only log makes "restore progress" a projection rebuild and makes accidental destruction require an explicit, audited compensating event.
- **Corrections are recorded, not applied.** DATA-06 (a parent's deliberate downward correction resurrected by a stale device) becomes an `AttemptsReset` event with a timestamp and an actor. A stale device pushing older events cannot undo it, because the reset is later in the log.
- **Projections are disposable, and that is what makes rollback real.** This is the connection to §5 and I think it is the strongest structural argument in this proposal. `RELEASE_RING_DESIGN.md` §6 identifies the sharpest problem with the three-slot ring: *"a one-way data migration invalidates the rollback"*, because after the shard freeze the old client reads 674 of 864 answers. With the events immutable and the read models derived, rolling back to `old` means rebuilding `old`'s projection shape from the same events. The ring protects schema changes instead of being defeated by them.
- **Idempotency is free.** The outbox pattern already in `js/engine/storage.js` (`enqueueOutboxOp` / `ackOutboxOps`) gets a natural key: retrying a push re-inserts an event id that already exists, and the insert is a no-op.

Being honest about the costs. Projections must be rebuildable and that rebuild must be tested, or the "disposable" property is a claim rather than a fact. Querying "this learner's accuracy in Algebra" means reading a projection, so a stale or broken projection is a new failure mode the current design does not have. And there is real ceremony: adding a field means adding an event type and a fold, which is more work than editing a record.

I judge the trade worth it *specifically here*, for two reasons that would not apply to a generic CRUD app. First, the data is irreplaceable and the owner has said so (`RELEASE_RING_DESIGN.md` §2: "His accumulated work ... is irreplaceable"). Second, the project's documented defect history is dominated by silent overwrites and by numbers that drifted from their evidence — both of which an append-only log addresses at the structural level rather than the review level.

What I do *not* recommend: a CQRS framework, a message bus, or eventual consistency between write and read sides. One table with an append-only constraint, projections maintained in the same transaction as the insert, and a rebuild script. The pattern, not the ceremony.

**How append-only is enforced is a separate decision from the pattern, and the options are not equivalent.** In Postgres the mechanism is convention: `REVOKE UPDATE, DELETE` on the event table plus a trigger, which is real protection against application bugs and no protection against anyone holding superuser. Azure SQL Database offers append-only *ledger tables*, where the engine itself refuses `UPDATE` and `DELETE`, hashes every insert into a verifiable chain, and emits periodic digests that can be stored in immutable blob storage for later tamper detection. Microsoft's own documentation names event logs and transaction journals as the intended use.

That is a closer fit to this brief's data-sanctity requirement than anything Postgres offers natively, and it maps onto the event/projection split exactly: events live in the append-only ledger table, projections live in ordinary mutable tables and are rebuilt. I still recommend Postgres, for reasons given in §3.3, but the gap is narrow and the deciding question is in §8.

### 2.3 What generalizes with no work, and what has to be rebuilt

| Current asset | Disposition |
| :--- | :--- |
| `js/engine/grading.js` (free-response parsing, multi-form answers, scientific expressions) | Port near-verbatim. Subject-agnostic already. |
| `js/engine/scheduler.js` (SM-2, history cap, streak) | Port. Make SM-2 one registered `SchedulingRule` among possible others (FSRS is the obvious second). |
| `js/engine/examgen.js` blueprint assembly | Port the algorithm; drive it from `ExamConfig` instead of the imported constant. Delete `_normalizeDomain`. |
| `js/engine/exam_state.js`, `attempt.js` | Port. Already pure and clock-free; this is the shape the whole framework should be in. |
| `js/engine/scoring.js` | Port the Wilson interval and the gates. Split PSAT-specific curves into a `psat89` scoring plug-in. |
| `api/src/lib/merge.js` | **Delete.** 412 lines whose job disappears with append-only events. |
| `api/src/lib/datamodel.js`, `shardsync.js` | **Delete.** 927 lines that exist only to dodge Cosmos' 2 MB item limit. |
| `getEnvironmentConfig` path-sniffing identity | **Delete.** Replaced by authenticated sessions. |
| `data/questions_data.js` 6 MB bundle | **Delete.** Replaced by paginated queries over a content service. |
| `js/pages/student.js`, `parent.js` (4,401 lines) | Rebuild. This is where the entanglement lives. |
| `styles/tokens.css` | Port as the seed of the theme package; the contrast-verified palette and the reasoning about not shipping half a dark mode are worth keeping verbatim. |
| `CLAUDE.md`'s seven failure modes | **Port as executable rules**, not prose. §4.4. |

---

## 3. Stack recommendation and rationale

### 3.1 Recommendation

**TypeScript in strict mode across core, API and UI; a deliberate functional discipline inside it rather than a functional-first language; PostgreSQL; React for the UI; Vitest and Playwright; Terraform for infrastructure.**

Evaluated against the eight properties the brief names.

### 3.2 The functional-language question, answered directly

The brief asks whether a functional-first runtime such as ClojureScript is worth it here, and says the question is genuinely open. It is, and I will give my real assessment rather than hedge: **no, and the deciding factor is the one the brief itself introduces — that implementation will be done by AI agents.**

The case *for* ClojureScript is strong on the merits. Immutable data structures by default, not by convention. `clojure.spec` gives generative testing with less ceremony than anything in the TypeScript ecosystem, and §4.4 argues generative testing is exactly what this project's defect history demands. Data-as-code makes an `ExamConfig` literally a literal. If a skilled human team were building this, I would consider it seriously.

Three things decide against it in this specific context.

**The agent feedback loop is weaker.** An agent's tightest correctness signal is a type error at edit time, before anything runs. `tsc --noEmit` tells an agent that a scoring rule returns the wrong shape without executing a line. ClojureScript's equivalent signal arrives at runtime, in a test, usually as a spec failure some frames away from the mistake. The brief asks to favour patterns an agent can work within correctly, and the static check is the single highest-leverage such pattern.

**REPL-driven development is a human superpower, not an agent one.** The strongest argument for Clojure is the interactive REPL loop, and it is largely inaccessible to an agent working through file edits and batch test runs. Adopting the language while forfeiting its principal advantage is a bad trade.

**Training-data density is a real engineering input now, not a talking point.** An agent writing idiomatic TypeScript with discriminated unions is on well-trodden ground. An agent writing ClojureScript with re-frame and shadow-cljs is not, and the failure mode is subtly non-idiomatic code that passes tests — which is precisely this project's documented history (`CLAUDE.md` failure mode 4: tests that cannot fail).

**What I would take from the functional world instead**, as enforced discipline inside TypeScript:

- `core/` is pure. No IO, no `Date.now()`, no `Math.random()`, no logging. Time and randomness are parameters, which is already this project's established pattern (`calculateStreak(map, todayKey)`, and every `exam_state.js` function taking `now`). Enforced by an ESLint rule that fails the build on a forbidden import inside `packages/core`, not by convention.
- `readonly` on every core type; no method mutates its argument. `merge.js` and `datamodel.js` already promise this in prose; a type makes it checkable.
- Domain errors are values, not exceptions: a hand-rolled `Result<T, E>` with a discriminated union. This is 20 lines, needs no library, and forces call sites to handle failure — which is `CLAUDE.md` failure mode 5 ("a returned flag added but never checked at any of six call sites") made structurally impossible.
- Discriminated unions over optional fields. A grade is `{ ok: true; grade: 1|2|3|4|5 } | { ok: false; reason: 'timing_unreliable' }`, never a number with a sibling boolean. The `timingReliable` defect class — where a fix landed an argument one position early and filed sessions under the literal key `"true"` — cannot be expressed.

**On Effect-TS specifically**, since it is the obvious "functional-first inside TypeScript" candidate: I recommend against it, on the brief's own criterion. Effect is powerful and its error channel is genuinely better than `Result`. It also demands substantial ambient knowledge — its own effect system, its own module conventions, its own idioms for resource management — and the brief asks to favour "explicit interfaces, small pure functions, minimal implicit context ... over patterns that are elegant but require a lot of ambient project knowledge to use correctly." Effect is precisely the pattern that clause excludes. This is a judgment call and I hold it loosely; a team already fluent in Effect should ignore me.

### 3.3 The rest of the stack

**Serverless PostgreSQL, not Cosmos DB.** The brief asks to favour Postgres unless there is a strong reason not to, and here the evidence runs the other way: there is a strong reason to *leave* Cosmos. 927 lines of sharding and codec exist solely because of a 2 MB per-item limit that a row store does not have. Beyond removing that, Postgres gives an append-only table with a real unique constraint, transactional projection updates, `jsonb` for the polymorphic question body (which is the one thing Cosmos was genuinely chosen for — `SYSTEM_ARCHITECTURE_AND_PLAN.md` §2.1 cites "polymorphic schema" first), and the entire portability story.

**Specifically Neon rather than a provisioned instance.** The obvious objection to leaving Cosmos is idle cost: Cosmos serverless idles at near zero and a provisioned Postgres server bills whether anyone studies or not. Serverless Postgres removes that objection rather than answering it. Neon suspends compute after five minutes of inactivity, bills per compute-hour with no monthly minimum, and is available as an Azure Native Integration with unified Azure billing and single sign-on, so choosing it does not forfeit the operator-continuity argument above. It is also real Postgres, so the portability claim survives intact. §5.4 carries the revised numbers.

**The alternative I take seriously is Azure SQL Database serverless, and the reason is ledger tables, not cost.** Its auto-pause and free allowance are comparable, its free storage allowance is considerably larger, and it is first-party rather than a partner service. The real draw is the engine-enforced append-only guarantee described in §2.2, which is a better answer to the data-sanctity requirement than a revoked permission.

I still land on Postgres, narrowly, on the criterion I used to reject a functional-first language in §3.2: an agent works most reliably on the best-trodden path, and TypeScript against Postgres is markedly better travelled than TypeScript against SQL Server across drivers, query builders and migration tooling. Applying that test inconsistently would be special pleading. Two honest caveats: T-SQL is a dialect, so "portable" is weaker for Azure SQL than for Postgres but far stronger than for Cosmos; and if the answer to §8's provable-versus-robust question is *provable*, ledger tables win outright and I would change this recommendation.

Amazon Aurora Serverless v2 also now scales to zero and is Postgres-compatible, but it resumes in roughly fifteen seconds, rising past thirty after a day idle. That lands on a student opening a timed exam, and adopting it means moving to AWS and giving up the operator continuity that motivated the provider choice in the first place.

**React, and accept the build step.** The buildless choice was correct for its context and `REFACTOR_PLAN.md` §2.2 defends it well ("more risk than benefit at this scale"). At framework scale the arithmetic inverts. There is already an unacknowledged build (`deploy_v2.sh` rewriting paths with `sed`), already a hand-maintained file manifest with a guard, and already a 100-symbol runtime facade that throws to compensate for the absence of static linking. A real build replaces all three with `tsc` and a bundler. React specifically because the UI is dense, stateful and data-driven, its testing story (Testing Library plus Playwright) is the strongest available, and agent familiarity is highest. Vite for the dev loop.

**Headless logic, themed shell.** UI components take props and emit events; they never read storage, never compute a score, never decide whether a number is displayable. The `js/components/` directory already proves the value of this — it exists so both portals emit identical markup for the same concept — and `styles/tokens.css` already proves the token layer. Formalise both: `@exam/ui` has a peer dependency on `@exam/core` types only, never on `@exam/api` or a store.

**Vitest for unit and property tests; fast-check for generative tests; Playwright for browser.** Playwright is already here with 30 specs and a sync-quarantine fixture that fails the build if a test writes to the real student partition. Keep that fixture's spirit exactly.

**Terraform, not Bicep or ARM.** Portability, and the more concrete reason that three environments cannot be stood up reproducibly today (finding j), which is why the ring is still a draft document rather than a deployed thing.

### 3.4 Scorecard

| Property | How the recommendation satisfies it |
| :--- | :--- |
| Strong typing | `tsc --strict`, no `any`, Zod at every boundary, schemas and types generated from one source |
| Functional style / plug-in extension | Pure `core/`, lint-enforced; rules registered by id from config; new exam = new data + optional new module |
| Separation of concerns | Package boundaries with enforced dependency direction (§4.2); UI cannot import persistence |
| Data sanctity | Append-only events; projections derived; `REVOKE UPDATE, DELETE` on the event table |
| AI-agent ergonomics | Static errors before runtime; small explicit interfaces; dense training data; one command per check |
| TDD | Core is pure so unit tests need no harness; Vitest watch is sub-second; Playwright covers the shell |
| Deploy feedback | Containers plus Terraform plus scale-to-zero; §5 targets a measured under-10-minute path |
| Performance | Paginated content queries replace a 6 MB eager parse; projections make dashboards single-row reads |

---

## 4. Architecture and module boundaries

### 4.1 Repository layout

A single pnpm workspace monorepo. One repository because the framework, its content pipeline and its UI must version together; multiple packages because the boundaries need to be mechanically enforceable.

```
packages/
  schema/       Zod schemas + inferred types. ExamConfig, Taxonomy, Question,
                AttemptEvent, projections. Zero dependencies. The vocabulary.
  core/         Pure functions ONLY. grading, scheduling, examgen, scoring,
                projections (event folds), exam lifecycle. Depends on schema.
                No IO, no clock, no randomness — lint-enforced.
  rules/        Plug-in implementations registered by id:
                  scoring/psat89.ts, scoring/linear.ts
                  scheduling/sm2.ts, scheduling/fsrs.ts
                  adaptive/two-module-routing.ts
                Each satisfies an interface declared in schema. Depends on
                schema + core. NOTHING depends on rules; it is loaded by
                registry lookup from an ExamConfig.
  content/      Bank import, validation, taxonomy resolution, asset addressing.
                The only place a free-text label becomes an id.
  persistence/  Repository interfaces + the Postgres implementation +
                migrations. The ONLY package that knows SQL exists.
  api/          HTTP (Hono), authn/authz, request validation, composition.
                Thin: parse, authorize, call core, persist, respond.
  insights/     The AI seam. Ports, provider adapters, the numeric guard (§6).
  ui/           Headless React components. Depends on schema types only.
  theme/        Tokens, primitives, the contrast check. Swappable whole.
apps/
  web/          The student + guardian application shell.
  admin/        Exam config authoring, bank import, learner management.
infra/          Terraform: envs/{pre,prod}, modules/
tools/          Projection rebuild, seeding, anonymized clone, backup verify.
```

### 4.2 How the boundaries are enforced

Stating a layering and enforcing one are different things, and this project's history is a history of rules stated and then not applied at the twin site (`CLAUDE.md` failure mode 2, cited in five of six rounds). So each boundary gets a mechanism:

- **Dependency direction** by `dependency-cruiser` in CI: `ui` may not import `persistence` or `api`; `core` may not import `rules`; nothing may import `apps/*`. A violating import fails the build.
- **Core purity** by an ESLint rule banning `Date`, `Math.random`, `fetch`, `process` and any node builtin inside `packages/core`. This turns "pass `now` as a parameter" from the established convention it already is into a checked property.
- **Store isolation** by the fact that `persistence` exports repository interfaces and the Postgres implementation is injected at composition. Core tests use in-memory implementations and never start a database.
- **Theme isolation** by `ui` components consuming only CSS custom properties from `theme`. Swapping `theme` restyles everything; no component carries a colour.

### 4.3 Why this kills "hard refactor for every new feature"

The test is specific: what does adding the SAT, or a new scoring model, or an new analytics view actually cost?

**A new exam type costs one data file.** SAT has different sections, counts, timings and a 400–1600 scale. If its scoring is the same shape as PSAT's (raw ratio to a scaled band), it is an `ExamConfig` document referencing `scoring: "linear-band"` with different parameters. Zero code. The current design requires editing `adaptive_config.js`, `scoring.js`, `examgen.js` and every page that names a section.

**A genuinely new scoring model costs one new file.** Add `packages/rules/scoring/ap-composite.ts` implementing the declared interface, register it, reference its id from a config. No existing module is edited, so no existing module needs re-testing. This is the plug-in property the brief asks for, and it works because the registry is keyed by data rather than by an import graph.

**A new analytics view costs one projection plus one component.** A projection is a pure fold over the event stream — trivially unit-testable against hand-built event sequences, and rebuildable for historical data because the events were never thrown away. Contrast with today, where adding an analytic means changing what gets *stored* and having no history for it.

**A new scheduling algorithm costs one file.** FSRS alongside SM-2, selected per exam config or per learner. `js/engine/scheduler.js` today has SM-2's constants inline in its interval progression.

### 4.4 Testing, and the rules this project paid for

`CLAUDE.md`'s failure mode 4 is "writing a test that cannot fail", with five rounds of citations: tests that required gitignored PDFs so "9/9 passing" meant nothing on a clean clone; a free-response test that split keys with the same helper the grader used, so it compared the implementation to itself; a streak test that monkeypatched an export while the code called the closure, passing only because its fixtures were dated in the future. These are not generic testing mistakes and a generic testing strategy will not prevent them. Four rules, carried forward as CI gates:

1. **Expected values are hand-written.** A test may not construct its expectation with the helper under test. Not mechanically checkable; enforced at review, and stated in the contributing rules an agent reads.
2. **Every new test is demonstrated red.** Break the code, watch it fail, paste the failure. `CLAUDE.md` already requires this and `REFACTOR_PLAN.md` §4 makes it a definition-of-done clause. Mutation testing (Stryker) over `packages/core` automates the spirit of it: a surviving mutant is a test that cannot fail, found by machine.
3. **Generative tests for anything that deletes, prunes or overwrites, asserting invariants rather than outputs.** This is the most specific lesson in the file and it was expensive: the WI-22 backup retention defect passed sixteen hand-written groups and a clean production dry run, and a 300-seed fuzz flags it at seed 11. `CLAUDE.md` states the principle exactly — "hand-built fixtures only ever cover the cases their author imagined". fast-check, with invariants like "the N newest are never deleted" and "the container is never emptied".
4. **A run that produced no output has verified nothing.** The same WI-22 dry run returned "0 archives selected" and that read as safety, when in fact nothing was eligible and almost none of the selection logic executed. Every destructive-path test asserts a count of cases that actually did something before its clean result is treated as evidence.

And the rule above all of them, `CLAUDE.md`'s "one rule that would have caught most past bugs": **execute the real code path against the real dataset.** In the framework this becomes a CI stage that generates a full exam from the real bank for every registered `ExamConfig` and asserts the real counts. The 88-question exam advertised as 98 shipped past a green suite and would have died instantly to one such run.

---

## 5. Cloud, deployment, and environment rotation (pre/prod/old)

### 5.1 Provider

**Azure, primary — chosen for operator continuity, not technical superiority.** The owner has a live subscription, working backup automation verified firing at 02:00 UTC, a disaster-recovery runbook, and real operational muscle. The portability-first components mean the provider is close to a commodity: the same Terraform shape maps to AWS (App Runner or ECS, RDS) or GCP (Cloud Run, Cloud SQL) with the provider block and a handful of resource types changed. If the household is already on Google Workspace or the operator prefers Cloud Run's ergonomics, that is a reasonable override and I would not argue hard.

| Component | Choice | Portable? |
| :--- | :--- | :--- |
| API | Azure Container Apps, scale-to-zero | Yes — a standard container |
| Database | Neon serverless Postgres, Azure Native Integration, scale-to-zero | Yes — stock Postgres |
| Static web | Azure Static Web Apps (free tier) | Yes — static files |
| Assets | Azure Blob Storage, **private**, signed URLs, CDN in front | Yes — S3-compatible shape |
| IaC | Terraform | Yes |
| Identity | Entra External ID (or Clerk/Auth0) behind an internal `IdentityProvider` port | Behind a port |
| CI/CD | GitHub Actions | Yes |

**Declared exceptions to portability.** Container Apps is a managed wrapper over Kubernetes and its scale-to-zero config is Azure-specific; the container itself is not. Static Web Apps is a convenience over a storage account plus CDN and could be replaced in an afternoon. Identity is genuinely provider-shaped, which is why it sits behind a port — this is the one place where a swap would be real work, and I would rather own that seam explicitly than pretend it is free.

**Assets private by default.** `CLAUDE.md` failure mode 7 records a blob container created world-readable for copyrighted material. Signed URLs with short expiry, private container, `public_access = "None"` in Terraform with a test asserting it. Also see §8 on the legal dimension, which changes when the framework serves more than one household.

### 5.2 Deployment feedback loop

Target: a change goes from merged to verified-in-`pre` in under ten minutes, with every step machine-checked.

```
push → typecheck + lint + unit (target < 90s, core is pure so no services)
     → build container, tag with the git sha (immutable)
     → terraform plan on infra changes; apply gated on a human
     → deploy sha to pre (Container Apps revision, scale-to-zero)
     → migrations (expand-only) against pre
     → projection rebuild check: rebuild from events, diff against live, expect zero
     → Playwright against pre, seeded with the anonymized clone
     → real-data exam-generation stage for every registered ExamConfig
     → human gate → promote the SAME image sha to prod
```

The promotion rule is copied straight from `RELEASE_RING_DESIGN.md` §8 and it is the most important line here: **promotion copies tested artifacts, never rebuilds.** §3.7 records why — `deploy_v2.sh` transforms files at staging time, so a rebuild at promotion time promotes something that was never tested. An immutable image tagged with the commit sha makes this structural rather than procedural.

### 5.3 The ring: pre → prod → old

The draft design's central insight is right and I adopt it: **slots are pointers at immutable releases; promotion retargets pointers; nothing is ever deployed to `old`.** With containers this is cleaner than with blob storage, because Container Apps revisions and image tags *are* immutable releases and traffic weights *are* pointers. The physical caveat in §4 of the draft — that blob storage has no symlinks so prod must be a materialized copy at the root — disappears.

```
image registry:  app:9f2c722   app:5a72906   app:c8f4040
pointers:        old           prod          pre
```

Rollback is retargeting the traffic weight to the previous revision. Seconds, no rebuild, no deploy.

**The schema problem, which the draft correctly calls the sharpest issue.** §6 states it: a one-way data migration invalidates the rollback, so the ring protects everything except the class of change most likely to need protection. My answer has two parts.

*Part one: expand/contract, enforced rather than intended.* Expand migrations (add nullable column, add table, add index) are allowed to deploy with the code. Contract migrations (drop, rename, narrow, add NOT NULL) are a separate, later promotion permitted only once `old` no longer needs supporting. Enforcement is a CI check that parses the migration and fails on a contract statement unless the PR carries an explicit `contract-migration` label and names the release that `old` will have rotated past. Schema changes cost two promotions, exactly as the draft concludes.

*Part two, and this is the part the draft cannot reach from its current data model: the event log makes the rollback survivable anyway.* If projections are derived and events are immutable, then `old` rolling back does not need the *new* projection to be readable — it rebuilds the projection shape *it* understands from the same events. The shard-freeze scenario in §3.5, where old code silently sees 674 of 864 answers, cannot recur, because no code reads the storage layout directly; it reads a projection it regenerates. This is the concrete payoff of §2.2 and it is why I would not adopt the ring without the event log.

**Data across the rotation.** One production database, shared by whichever code revision is serving. `old` is a code rollback, not a data rollback. Recent attempts cannot be stranded because they were never in a slot-specific store — they are rows in the event table, and a rolled-back binary reads them through a rebuilt projection. A slot-specific database would strand exactly the recent attempts the rotation is supposed to protect.

**Seeding `pre`.** The draft's §5 is right on the decisive detail and I adopt it verbatim in spirit: **copy verbatim, never reassemble.** If the clone tidies the production shape into something cleaner, `pre` tests a shape that does not exist and every migration bug walks straight through. Concretely: `pg_dump` the production event table, run a deterministic anonymizer over learner identity and free-text response fields, restore into the `pre` database. Refresh at the start of each test cycle, because a clone diverges the moment tests write to it.

Neon's database branching makes the copy step near-instant and copy-on-write, which is a genuine improvement on dump-and-restore. It does not remove the anonymization step and must not be read as doing so: a branch carries the real records, so the anonymizer still runs against the branch before anyone points a browser at it, and the branch still gets its own credentials per the enforcement rule below.

**Enforcing one-way flow.** The draft's open question 4 asks for the right enforcement point and leans toward a server-side guard on an injected lane identity. I agree the guard must be server-side, and I would go one step further: make it a *credential* boundary rather than a *check*. The `pre` container's environment holds only the `pre` connection string. There is no code path from `pre` to production data because the secret is not present in the process. §3.3 records lane detection already failing once — `/v2/` writing to the real student's partition through path-derived identity — and a check that can be bypassed by a bug is weaker than a capability that does not exist.

**Backups and restore verification.** Neon's branch-based point-in-time restore (the retention window varies by plan and should be confirmed against the plan actually chosen), plus a nightly `pg_dump` to blob with a SHA-256 sidecar (the existing `scripts/backup_cosmos.js` pattern, which already writes checksums). The zero-document guard carries over: a backup that exports zero events refuses to overwrite. Restore is verified weekly by restoring into a scratch database and running the integrity suite against it — and per `CLAUDE.md`, **a restore check without its red demonstration does not count.** The runbook's requirement that the check prove it can detect a corrupted backup, not merely complete, is the lesson from the WI-22 dry run that returned "0 archives selected" and read as safety.

### 5.4 Cost at low usage

Single-digit households, hundreds of attempts per month. Monthly, USD, list price, East US:

| Item | pre | prod | Note |
| :--- | ---: | ---: | :--- |
| Neon serverless Postgres | 0 | 0–3 | Free allowance may cover this outright; see caveat below |
| Container Apps (scale-to-zero) | 0–2 | 2–5 | Free grant covers this volume; cost is idle replicas |
| Static Web Apps | 0 | 0 | Free tier |
| Blob Storage, ~350 GB assets | — | 7 | Hot LRS, shared across environments |
| CDN egress | — | 1–3 | Assets are cacheable and change rarely |
| Backup storage | — | 1–2 | Archives at 15-day retention |
| Container registry | 0 | 0 | GitHub Container Registry, free at this scale |
| **Total** | | **~$11–22/mo** | |

**The database line is a projection, not a measurement, and should be treated as one.** Neon's free allowance is 100 compute-hours and 0.5 GB of storage per project. My arithmetic says this workload sits inside that, but I have not measured a real month and the storage headroom in particular is thin if projections grow. Verify against one month of actual traffic before this number enters a budget. Publishing it unlabelled would be precisely the defect this report spends §1.3 praising the codebase for having learned to avoid.

Three further notes. First, `old` costs nothing: it is a retained image tag and a stopped revision, which is the draft's point that `old` is never deployed to. Second, the earlier objection that leaving Cosmos raises the bill no longer holds. A provisioned Burstable instance would have added roughly $12–17/month on its own; scale-to-zero removes that floor, and the midpoint here is close to what the current Cosmos and Consumption setup costs. The 2 MB ceiling, real SQL and portability are now close to free. Third, a fully isolated `pre` project rather than a branch adds little at these volumes, which weakens the cost argument against isolating it (§7).

**The 325 MB of question images is the largest single cost driver and the least examined.** Worth measuring whether WebP conversion and a per-question size budget cuts it materially before committing to the storage line.

---

## 6. AI insights integration

### 6.1 What already exists, which is better than it looks

The project has a working AI content pipeline and it is not the shape most proposals will assume. `explanations/SYSTEM.md` documents a loop: live progress and error tags produce `worklist.json`, misses cluster by skill at a threshold of three, each cluster becomes one HTML explainer built around a transferable mental model with a named trap taxonomy, the page is QA'd, registered in `index.json`, and linked from the mistakes page. Generation happens **offline, by an agent, with a human in the loop**, and the output is a reviewed static artifact committed to the repository. There are ten such pages today.

This is a genuinely good architecture for teaching content and the redesign should preserve its shape rather than replace it with runtime generation. Explanations are expensive, reusable across every learner who misses the same question, and carry a real cost when wrong — a confidently incorrect explanation of a math concept to a thirteen-year-old is worse than no explanation. Generating per-request is worse on all three axes.

### 6.2 The seam

`packages/insights` exposes ports; providers are adapters; nothing else in the system knows a model exists.

```ts
interface InsightProvider {
  readonly id: string;                    // 'claude-opus-5', 'gpt-5'
  generate(req: InsightRequest): Promise<Result<InsightDraft, InsightError>>;
}

type InsightRequest =
  | { kind: 'question-explainer'; question: Question; level: ScaffoldLevel }
  | { kind: 'cluster-explainer'; skill: SkillId; misses: readonly Question[] }
  | { kind: 'guardian-narrative'; figures: ComputedFigures; window: DateRange }
  | { kind: 'focus-suggestion'; gaps: readonly SkillGap[] }
```

Three properties matter more than the interface shape.

**The seam sits above `core` and below `api`, and `core` never calls it.** Scoring, scheduling and gap detection stay deterministic and unit-testable. The model narrates conclusions that pure functions computed. An AI outage degrades the product to a fully functional product without prose.

**Every output is a persisted artifact with provenance, never an ephemeral response.** An `InsightDocument` row carries the content, the provider id, the prompt-template version, a hash of the input payload, the generation timestamp, and a review status. Consequences: the same explainer is generated once and served to everyone; a bad one is identifiable and revocable; changing providers is a diff you can inspect, because the same input hash under two provider ids gives two comparable artifacts; and a guardian reading a narrative can be shown what it was derived from.

**Guardian-facing narratives are gated on human review by default**, following what the project already does. Per-question explainers may be auto-published once a regression suite passes over a held-out set, because they are checkable against a known correct answer. Trend narratives about a specific child's progress are not checkable that way and should not auto-publish.

### 6.3 The numeric guard

This is the part I would insist on, and it comes directly from this project's defect history rather than from general LLM caution.

`CLAUDE.md` failure mode 1 is "inventing a number and showing it as a measurement", present in five of six review rounds: a hardcoded five-day streak, a score of 1460 with zero questions attempted, an invented linear map labelled "Official", a 1290/1440 score from an eight-question quiz. That is what the codebase did *without* a language model. Handing an LLM a dashboard and asking it to describe trends is handing the most productive defect class in the project's history a generator.

So: **the model receives pre-computed figures and may only phrase them. It never computes, estimates, rounds or extrapolates.**

Enforced mechanically, not by prompt. `ComputedFigures` is a closed record produced by `core`. After generation, a validator extracts every numeral and every percentage from the draft and asserts each appears in the input record. A draft containing a number that was not given to it is rejected, logged with both the draft and the payload, and never shown. This is cheap, it is testable, and it makes the whole class of hallucinated statistics a build-time-visible event rather than something a parent discovers.

The same rule extends the existing provenance discipline: a figure whose `ExamConfig` provenance is `estimate` (§2.1) arrives in the payload already carrying its label, and the prompt template is required to render the label. A narrative saying "his projected score is 1180" when the underlying curve exponents are marked `(unvalidated)` is exactly the "Official" defect from round 5, wearing better prose.

---

## 7. Trade-offs and where other models may disagree

**1. Event sourcing versus mutable records.** I expect this to be the sharpest split. A reasonable reviewer will call an append-only event log with derived projections over-engineered for a handful of households, and they are not wrong about the ceremony: more moving parts, projections that can go stale, more work to add a field. My case rests on three specific artifacts rather than on architectural preference — `merge.js` naming append-only events with stable ids as the fix it could not implement, `RELEASE_RING_DESIGN.md` §6 identifying migration as the thing that defeats rollback, and a documented history of silent overwrites. I would hold this position, but if a reviewer proposes mutable records **plus** a separate immutable audit log of every write, that captures most of the value at lower cost and I would accept it as a reasonable landing point.

**2. TypeScript versus a functional-first language.** The brief explicitly invites ClojureScript and a model that takes the invitation will produce a defensible argument — immutable by default, `clojure.spec`'s generative testing is a better fit for §4.4's requirements than anything in the TS ecosystem, and configuration-as-data is literally the language. I land on TypeScript because the implementers are agents, and static errors at edit time plus training-data density beat REPL ergonomics an agent cannot use. This is a judgment about the *implementer*, not about the language, and a reviewer who weights language merit over implementer fit will land differently and be reasoning honestly.

**3. Which store, and whether append-only should be engine-enforced.** Two separable disagreements that land in the same decision.

On leaving Cosmos, some reviewers will keep it: it works, its backup automation is built and verified, and the polymorphic question schema was the documented reason for choosing it. The strongest version of that case used to be idle cost. Serverless Postgres removes it, so a reviewer arguing to stay on Cosmos now has to argue that 927 lines of sharding and lossless-codec engineering written to dodge a 2 MB item limit are an acceptable permanent tax.

On enforcement, I expect most reports to reach for Postgres and enforce append-only by revoking permissions, which is convention rather than guarantee. Azure SQL Database's append-only ledger tables make it an engine property with cryptographic tamper evidence, and I think it is likely that few or no other reports will surface the feature at all. I still choose Postgres, on agent-ecosystem grounds, and I hold that more loosely than any other recommendation here. It is the decision I would most want a second opinion on.

**4. Whether three environments are justified at all.** `RELEASE_RING_DESIGN.md` §9.7 asks this of itself, and answers it uncomfortably: the incidents that week were a merge bug, a floor bug and a missing manifest entry, and *none of them would have been caught by a third environment*. I propose `pre` and `prod` with `old` as a retained immutable image tag, which is close to two environments wearing a third's name, because `old` genuinely costs nothing once releases are immutable images. A reviewer proposing full three-way isolation, or proposing one environment plus a strong gate, are both defensible. I lean toward the cheapest arrangement that preserves instant rollback.

**5. Whether to keep the buildless, framework-free client.** `REFACTOR_PLAN.md` §2.2 defends zero-build explicitly and rejects Vite plus Tailwind as more risk than benefit, and that reasoning was right for a four-page single-student app. I recommend reversing it for a framework, on the grounds that there is already a `sed`-based build, a hand-maintained file manifest with a guard, and a 100-symbol runtime facade that throws — three compensations for the missing compiler. A reviewer who weights the project's stated preference for zero dependencies more heavily will keep it, and the resulting proposal will be internally consistent. I think it stops paying at framework scale, but I hold this less firmly than items 1 and 3.

**6. Where the AI seam lives.** I put it above `core` with mandatory persisted artifacts, human review for guardian-facing prose, and a mechanical numeric guard. Others may propose runtime streaming generation with caching, which is simpler and more responsive. The disagreement is really about whether an LLM may touch numbers at all; I say no, enforced by a validator, because of failure mode 1's five-round history.

---

## 8. Open questions for the human reviewer

**1. Question-bank licensing is the gating question for multi-tenancy, and it is legal rather than technical.** The bank was extracted from College Board PDFs. One household using it privately is one posture; a framework serving multiple accounts is redistribution, and the 325 MB of rendered question images makes the exposure concrete. `CLAUDE.md` failure mode 7 already records a blob container created world-readable for this material. Before any multi-account work, decide whether the framework ships with content or ships empty and each account imports its own — because the answer changes the content packaging, the asset access model, and arguably whether the thing can be distributed at all. I would design for "ships empty, imports per account" regardless, since it is also the better framework design.

**2. Are the learners minors, and does that put COPPA or FERPA in scope?** This app is built for a thirteen-year-old. Multi-account means storing identified performance data about other people's children. Verifiable parental consent, data retention limits, deletion rights and a "no third-party sharing" commitment are legal requirements with architectural consequences — particularly for §6, where sending a child's performance data to a third-party model provider becomes a disclosure decision, not just a latency and cost decision. I flag it; I am not qualified to answer it.

**3. What is the real isolation requirement between households?** Row-level security in one database with a tenant column is cheapest and covers §5.4's estimate. Schema-per-household or database-per-household is stronger and more expensive. `RELEASE_RING_DESIGN.md` §3.3 documents lane isolation already failing once through path-derived identity, which argues for a mechanism stronger than an application check. My default is row-level security enforced in the database rather than in application code, but the answer depends on how the framework is distributed.

**4. Does data sanctity need to be *provable*, or only *robust*?** The distinction decides §3.3. Robust means do not lose or silently corrupt the child's work, and revoked permissions on an append-only table plus verified restores are sufficient. Provable means someone outside the system must be able to verify that history was never altered, which implies a dispute, an audit or a regulator, and points at engine-enforced ledger tables with external digests. For a household prep app I read the requirement as robust, which is why I recommend Postgres. If the framework is ever distributed to other families, or if a score is ever used for anything consequential, the answer may flip.

**5. Must the existing student's data migrate, and with what fidelity?** Currently 864 answered questions, 851 SRS cards, 24 exam sessions. The projections are reconstructible; the *event history* is not, because it was never recorded — only summaries exist. So a migration produces a synthetic genesis event per question carrying the summary, and every derived analytic before the cutover date is an approximation. That is acceptable if stated, and it is exactly the kind of thing that must be **labelled in the UI rather than silently smoothed over** (failure mode 1). Confirm the migration is wanted and that the approximation is acceptable.

**6. What is the actual budget ceiling, and does anything in §5.4 need verifying first?** With serverless components throughout, §5.4 lands near $11–22/month against a current bill probably under $15, so cost is no longer a reason to prefer one design over another. The open item is the unverified free-tier assumption on the database line. If the ceiling is generous, a fully isolated `pre` project and continuous point-in-time restore both become affordable and several §7 trade-offs relax.

**7. How many exam types realistically, and how soon?** The entire plug-in architecture is justified by the second and third exam type. If the honest answer is "PSAT now, SAT in two years, probably nothing else", a smaller redesign — extract `ExamConfig`, add identity and auth, move to Postgres, keep the rest — delivers most of the value at a fraction of the cost, and I would rather say that now than build a framework for one tenant.

**8. Who operates this?** Terraform, Container Apps revisions, projection rebuilds and a weekly restore check with a red demonstration are all straightforward for an operator with Azure experience and all real burden for one without. The current setup is already at the edge of what one person plus an agent can carry, and §5 adds infrastructure-as-code to that load. If the answer is "the agent operates it", say so explicitly, because it changes how much of §5 must be a single idempotent command rather than a runbook.
