# Synthesis: four independent framework proposals

Four agents were given the same prompt and the same repository on 2026-09-11. This file distills where they agree, where they genuinely split, what only one of them noticed, and which claims do not survive checking.

**Disclosure:** I wrote `claude-opus-5-2026-09-11.md`. Synthesising a set that includes my own report is a bias worth naming up front. I have tried to correct for it by verifying other reports' unique findings by execution, and by recording plainly where they beat me. Two did.

## 0. The reports, and how much weight each claim carries

| Report | Lines | Verified against a running shell? |
| :--- | ---: | :--- |
| `fugu-max-2026-09-11.md` | 382 | Yes. Cites file paths, line counts, constant names throughout. |
| `claude-opus-5-2026-09-11.md` | 468 | Yes. Commands shown inline for each measured number. |
| `muse-code-2026-09-11.md` | 388 | **No.** States plainly that `bash` failed all session; counts read from code and comments, each flagged read-vs-measured. |
| `mercury-2026-09-11.md` | 231 | Not stated. Few specific citations; mostly architectural generalities. |

`muse-code` deserves credit for declaring its limitation rather than presenting read values as measured. I spot-checked several of its claims below and they held.

---

## 1. Unanimous, and therefore probably settled

These carried all four reports, mostly with independently arrived-at reasoning. Treat them as decided unless someone brings new evidence.

- **TypeScript, not a functional-first language.** All four were invited by the prompt to consider ClojureScript and all four declined. The reasoning converged without coordination: the implementers are AI agents, agent training mass and tooling are overwhelmingly TypeScript, and a static type error at edit time is the tightest correctness signal an agent gets. Three of four separately noted that Clojure's REPL advantage is a *human* advantage an agent cannot exploit. Independent convergence on a question the prompt flagged as genuinely open is the strongest signal in the set.
- **A functional discipline inside TypeScript, enforced by lint rather than by language.** Pure core, no DOM, no clock, no IO, `readonly` types, time and randomness passed as parameters. Two reports independently noted that this is already the house style in `attempt.js`, `exam_state.js` and `test_planner.js`.
- **Skip the heavy FP libraries.** Two reports named `fp-ts` and Effect explicitly and rejected both on the prompt's own "minimal implicit context" criterion. Prefer plain functions, tagged unions, and a hand-owned `Result` type.
- **Leave Cosmos DB for Postgres.** All four. The shared argument is that `api/src/lib/datamodel.js` — FNV-1a sharding, a self-verifying slim codec, 16 buckets — exists solely to dodge a 2 MB per-item limit, and is a database limitation masquerading as domain complexity.
- **Exam definition becomes versioned data, not code.** All four independently proposed lifting `OFFICIAL_BLUEPRINTS`, `PSAT_89_SPECS` and `SCALING_ASSUMPTIONS` into a validated config document that both generation and scoring consume, with PSAT 8/9 becoming the first plug-in pack.
- **Identity and authorization are day-one, not retrofit.** All four flagged that every endpoint is `authLevel: 'anonymous'` and that the student name is read from a query parameter. Nobody thought this could be parameterised into multi-student.
- **Monorepo with mechanically enforced import direction.** Three reports specified lint-enforced package boundaries so that UI cannot import persistence and core cannot import React. One called it the structural fix for the twin-page drift that `CLAUDE.md` names as failure mode 2.
- **Stop shipping the whole bank to the browser.** The 6 MB eager parse plus 325 MB of images does not survive multiple exam programs.
- **Data lives outside the deployment slots.** `old` and `prod` read the same production database; rollback is a code rollback. Three reports reached this independently as the answer to "how does a rollback not strand recent attempts."
- **Promotion copies tested artifacts and never rebuilds.** Both reports that engaged with the ring cited `RELEASE_RING_DESIGN.md` §3.7, where `deploy_v2.sh` transforms bytes at staging time, so a rebuild promotes something never tested.
- **`CLAUDE.md`'s seven failure modes survive as executable rules.** Three reports proposed promoting them from prose into lint rules and CI gates.

---

## 2. Where the reports genuinely split

### 2.1 Cloud provider — the widest split

| Report | Primary | Reasoning |
| :--- | :--- | :--- |
| claude-opus-5 | Stay on Azure | Operator continuity: live subscription, verified backup automation, an existing DR runbook |
| fugu-max | **Leave Azure** | Cosmos item limits, Y1 has no deployment slots, proprietary backup semantics, `$web` root cannot symlink |
| muse-code | Deliberately boring, any container host | Terraform abstracts it; the choice should not matter |
| mercury | AWS | "The safe choice" |

This is the sharpest disagreement and it is not really technical. Every report converges on the same *portable* components: Postgres, containers, object storage, Terraform. The split is whether the existing Azure operational muscle outweighs Azure having taught the wrong data model. `fugu-max` puts it well: Azure is an acceptable implementation of the design, not the design.

### 2.2 How deep the event sourcing goes

- **claude-opus-5 and fugu-max:** a full append-only event spine, with all read models derived and disposable. Both argue this is what makes rollback survive schema change, because `old` rebuilds its own projection shape from the same events.
- **muse-code:** deliberately narrower. Append-only for learner evidence only; conventional mutable rows for accounts, configs and content. Explicitly rejects "full CQRS ceremony."
- **mercury:** internally inconsistent. Recommends "standard Postgres with JSONB for simplicity" over event sourcing in one section, then specifies "event sourcing for audit trails; append-only events with immutable IDs" in another.

`muse-code`'s narrow version is probably the right landing point. It captures the DATA-01 fix without paying ceremony on data that has no concurrency problem.

### 2.3 Engine-enforced versus conventional append-only

Only one report raised it. Postgres enforces append-only by revoked permissions plus a trigger, which is convention a superuser can undo. Azure SQL Database offers append-only **ledger tables**, where the engine refuses `UPDATE` and `DELETE`, hashes each insert into a verifiable chain, and emits digests for external tamper detection. Three of four reports did not surface the feature. The decision hinges on whether data sanctity must be *provable* to an outside party or merely *robust* against loss — for a household app, robust, which is why even the report that raised it still recommends Postgres.

### 2.4 UI framework

React (claude-opus-5, fugu-max), Svelte (mercury), unstated-but-Vite (muse-code). `fugu-max` names Svelte as a reasonable second and predicts other reports will pick it, which they did. All four agree the buildless vanilla approach does not survive, citing the 3,039-line `js/pages/student.js` as evidence that "no framework" never meant "separated UI."

### 2.5 Cost estimates diverge by an order of magnitude

| Report | Monthly, low usage |
| :--- | :--- |
| muse-code | $10–25 |
| claude-opus-5 | $11–22 |
| fugu-max | $15–70 (includes $5–30 of LLM spend) |
| mercury | **$150–250** |

Three cluster tightly. `mercury` is a clear outlier, carrying a $50/month monitoring line and a $50/month ECS line for an application serving single-digit households. Its own database line is only $25, so the bulk is overhead nobody else charged. Discount it.

---

## 3. Findings only one report made

This is where running four agents actually paid. Each was verified by execution before being listed here.

**From `fugu-max`:**

- **The Cosmos `Questions` container is a dead mirror.** Confirmed: it is referenced only by `api/src/functions/backup.js` and `backupCore.js`. The running client loads the bank from `data/questions_data.js` at `index.html:1109`. The system backs up 3,059 documents it never reads.
- **The API host is hardcoded in three separate client files.** Confirmed at `js/engine/sync.js:44`, `js/pages/parent.js:77` and `js/pages/feedback.js:62`. Three sites, no shared constant — failure mode 2 waiting to happen on the first endpoint move.
- **`attempt.js` already emits versioned attempt events and its comments say "Milestone 3 will ingest these."** The groundwork for the append-only spine is already written and unused.
- **`docs/OFFLINE_MODE.md` already fetches only one sitting's images, roughly 15 MB rather than 325 MB.** The pattern that replaces the eager bundle already exists in the codebase.
- **A student-and-parent feature map** separating what exists today from what the framework newly enables. No other report produced one, and it is the most directly useful artifact in the set for product planning.

**From `muse-code`:**

- **`renderRationale` in `js/engine/grading.js` emits Tailwind class strings and an inline `onclick` handler.** Confirmed at `grading.js:193`. A UI string generator lives inside the supposedly pure engine. This is the single most concrete instance of the entanglement the prompt asks about, and the other three reports all missed it.
- **Dead schema alias chains are still load-bearing.** Confirmed: `(q.type || q.question_type)` appears at ten or more sites in `examgen.js` alone. `CLAUDE.md` records that `question_type` exists on 0 of 3,059 records and caused the 88-question exam sold as 98. The fallbacks are scar tissue from that fix and still ship.

**From `claude-opus-5`:** provenance as a *type* rather than a comment, so an estimate cannot reach a renderer without its label; a mechanical numeric guard rejecting any LLM output containing a number absent from its input payload; and the ledger-table option in §2.3.

**From `mercury`:** the existing delta-sync cursor (`buildSyncDelta`, `getSyncCursor`) as an asset worth carrying. Thin, but real.

---

## 4. One recommendation to reject

**`mercury` §5.2:** *"All three environments connect to the same database but filter by environment tag or use separate databases with replication"* and *"environment is tracked in request context."*

This is the exact failure the repository has already lived through. `RELEASE_RING_DESIGN.md` §3.3 documents that the `/v2/` lane wrote to the real student's Cosmos partition because lane identity was a client-side convention derived from the URL path. An environment tag carried in request context is the same mechanism with a different name: a check that a bug can bypass.

The other three reports independently insist on the stronger form — separate databases with separate credentials, so that `pre` cannot write production data because the secret is not present in the process. That is a capability boundary rather than a check. Adopt that version.

---

## 5. What the set collectively says to do first

All four converge on roughly the same first move, phrased differently. Build the kernel and refuse to port the Cosmos document shape forward:

1. Schema package (`ExamProgram`, `Item`, `AttemptEvent`, `Household`, `Learner`) with validation at every boundary.
2. Pure core lifted from the existing `js/engine/` algorithms — grading, SM-2, exam-state lifecycle, the planner contract, the honesty gates. Port the algorithms and their tests; leave the UMD loader, the `psat_*` keys and the shard codec behind.
3. Authenticated identity and server-side authorization, replacing path-derived student names.
4. Append-only attempt ingest, idempotent on a stable attempt id.
5. PSAT 8/9 as the first program pack: bank, blueprints, scoring recipe, with the unvalidated curve flags preserved so the UI still cannot print "Official."

The open questions that actually gate design, common to at least three reports: whether offline full sittings remain a hard requirement (it decides IndexedDB plus outbox and rules out a server-rendered app); the licensing posture for copyrighted question images once more than one household is served; COPPA and FERPA scope given the learners are minors; and how the existing single student's history migrates, given the event log was never recorded and only summaries exist.
