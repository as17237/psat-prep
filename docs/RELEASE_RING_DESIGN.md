# Release ring design — pre / prod / old

**Status: DRAFT FOR REVIEW.** Nothing here is built. This document describes intent,
records the constraints we verified, and marks what is still open. It is deliberately
not prescriptive about implementation — the point is to agree the shape first.

**Reviewers:** please read §3 (verified constraints) before §4 onward. Every claim in
§3 was checked by execution against the live system on 2026-09-07, and the commands
are given so you can re-check rather than trust. If any of them is wrong, most of the
rest of this document is wrong too. §9 lists the specific questions we want answered.

---

## 1. What we are trying to achieve

Three versions of the app exist at all times:

| Slot | Meaning |
| :--- | :--- |
| `pre` | The next version. Browser-reachable. Where testing and human UAT happen. |
| `prod` | The live version the student uses. |
| `old` | The previous live version, retained as a rollback target. |

Promotion rolls forward: `pre → prod`, `prod → old`, and the previous `old` is retired.
Promotion is **human-initiated and human-approved** — there is no auto-promote on green.

The goal is to make rolling forward and rolling back both boring and fast.

## 2. Why this is worth doing here

This app is a single student's PSAT preparation. His accumulated work — currently 864
answered questions, 851 SRS cards, 24 exam sessions — is irreplaceable. In the last
week we shipped a change set that touched the exam lifecycle, the SRS attempt model,
the storage layer and the server-side merge. Recovery today rests on a `$web` blob
manifest and a retained Function zip, both created by hand immediately before the
deploy. That works, but it depends on someone remembering to do it.

## 3. Verified constraints

These are measured facts, not assumptions. They drive most of the design.

**3.1 The Function App cannot participate in a slot-based ring.**
```
az appservice plan list -g rg-psat-prep --query "[].{tier:sku.tier,size:sku.size}"
→ Dynamic  Y1
```
Y1 Consumption does not support deployment slots. **One Function App serves every
lane.** Any ring we build is a client-side ring unless we change plan or add a second
app.

**3.2 The static site serves from the `$web` root.**
```
https://psatprep4915.z13.web.core.windows.net/
```
There is no path-rewriting layer. Whatever is live at the root *is* prod. Lanes today
are path prefixes (`/beta/`, `/v2/`).

**3.3 Lane isolation is application-enforced and currently incomplete.**
`getEnvironmentConfig` in `js/engine/storage.js` derives identity from the URL path:
```
/index.html      → default_student
/beta/index.html → beta_default_student   (isolated)
/v2/index.html   → default_student        (NOT isolated)
```
The `/v2/` lane writes to the real student's Cosmos partition. This is a live example
of the isolation failing, and it is why `/v2/` was rejected as a UAT lane.

**3.4 One Cosmos container, partitioned by `student_name`.**
Account `psat-cosmos-15958`, serverless, single region. Isolation between lanes is a
partition key value, not separate infrastructure.

**3.5 Production data is sharded and the structure matters.**
```
master.progress (FROZEN, shardsVerifiedAt set) : 674 entries
progress shards                                 : 16
reassembled effective progress                  : 864
```
A migration froze the master map; new writes route to shard documents. Code that reads
`master.progress` alone silently sees 674 of 864. We hit exactly this bug in
`explanations/build_worklist.py` this week.

**3.6 The existing clone helper does not clone the database.**
`cloneProdDataToBeta` in `js/shared/beta_sandbox.js` copies four `localStorage` keys
in the browser. It never contacts Cosmos, and it copies the browser's already-
reassembled view. It cannot be reused for pre-environment seeding.

**3.7 Deployed bytes are not working-tree bytes.**
`scripts/deploy_v2.sh` transforms files at staging time — absolutising question-image
paths and injecting `PSAT_CLIENT_VERSION`. Any promotion that re-runs a build instead
of copying tested artifacts promotes something that was never tested.

**3.8 A missing file breaks a whole lane, silently at build time and loudly at runtime.**
`srs.js` throws if any engine part is absent, so an incomplete `APP_FILES` manifest
ships an app whose engine never initialises. This happened during the WI-22 deploy;
only the deploy guard caught it.

**3.9 The service worker is root-scoped.** `sw.js` caches the app, so changing what the
root serves does not immediately change what a returning browser runs.

**3.10 Backups.** A daily timer writes checksummed archives (verified firing at
02:00 UTC). Retention is being reduced to 15 days. The Cosmos account itself is on
Periodic backup with 8-hour retention and support-ticket-only restore; a switch to
Continuous 7-day point-in-time restore is pending.

## 4. The model: pointers over immutable releases

Think of the three slots as **symlinks**. The releases are immutable; the slots point
at them.

```
releases/
  2026-09-07-c8f4040/     ← immutable, written once
  2026-09-06-aed2e7e/
  2026-09-04-632fbe1/

pre   → releases/2026-09-07-c8f4040
prod  → releases/2026-09-06-aed2e7e
old   → releases/2026-09-04-632fbe1
```

Promotion retargets pointers. Rollback retargets them back. **Nothing is ever deployed
to `old`** — it is already sitting there, byte-identical to what was live.

One physical caveat (from §3.2): blob storage has no symlinks and the static site
serves the root. So `pre` and `old` can be true pointers served from their own
prefixes, while `prod` is a pointer **plus a materialized copy** at the root. Copying
within a storage account is server-side and fast.

Two properties we want from this:

- **Promotion copies tested artifacts.** Never re-stage, never rebuild (§3.7).
- **The pointer record is the source of truth** for what is where, rather than
  inferring it from whatever bytes happen to be in a container.

## 5. Data for `pre`

`pre` is browser-reachable, so a human will click through it with real-looking data.
That data must be real in *shape*, and must never be the student's live records.

**Clone a partition, not a database.** `pre_default_student`, the same mechanism beta
already uses. No new infrastructure.

**Copy verbatim; never reassemble.** This is the most important detail in this
document. If the clone flattens the sharded profile into one tidy map, `pre` tests a
shape that does not exist in production (§3.5) and every shard-routing and migration
bug walks through. Copy every document in the partition, rewriting only `id` and
`student_name`.

**Two surfaces need seeding.** Cosmos is the sync target, but `localStorage` is the
app's primary state and the client-side migration runs against it. A pre environment
that only clones Cosmos cannot test migrations. The e2e fixtures already seed
`localStorage`; that is the lever.

**Cadence.** Re-clone at the start of each test cycle. A clone diverges the moment
tests write to it, so a stale clone resembles neither prod nor a fresh environment.

**One-way, enforced.** Pre data must never flow back to prod. Given §3.3, we do not
think client-side lane detection is a sufficient guarantee. The direction we favour is
a server-side check — staging already injects a client version, so it could inject the
lane too, and the API could refuse writes to `default_student` that carry a pre release
id. Alternatives welcome.

**Lifecycle.** A `pre` partition is a live second copy of real student data that
nothing prunes and nothing backs up. It should be created on clone and dropped when
`pre` is promoted or abandoned.

**What a clone cannot do.** DATA-01, DATA-03 and DATA-04 are concurrency defects —
two devices racing on the same question. A point-in-time copy reproduces none of them.
Those need a deliberate two-writer harness and are out of scope here.

## 6. The schema problem

This is the sharpest issue and we want reviewers to attack it.

A one-way data migration **invalidates the rollback**. Once prod crosses the shard
freeze, the `old` client can no longer read the data correctly — it would show 674 of
864 answers. So the ring protects everything *except* the class of change most likely
to need protection.

The direction we currently favour is **expand/contract**:

- **Expand.** New code writes both the old and the new shape. Old code still works.
  Fully rollbackable. This is a normal promotion.
- **Contract.** Stop writing the old shape. Only permitted once `old` no longer needs
  to be supported. A second, separate promotion.

Schema changes therefore cost two promotions rather than one.

**Decided:** when `pre` and `prod` disagree on schema, promotion is **not** blocked
automatically and **not** waved through automatically. The tooling presents the human
with the full picture — what changes, what becomes unreadable to `old`, whether
rollback survives, what the recovery path is if it does not — and the human makes a
controlled decision. The pointer record should carry each release's schema version so
this comparison can be made mechanically rather than from memory.

## 7. The promotion gate

Promotion is human-approved. The gate is a checklist presented for that approval, not
a green light.

Green tests alone are explicitly **not** sufficient. `CLAUDE.md` records seven rounds
in which a passing suite coexisted with a shipped defect, two of them this week: a
retention bug that deleted the seven newest backups passed sixteen test groups and a
clean production dry run.

Candidate gate contents — open to revision:

- Unit and regression suites green, with evidence they were watched failing.
- A real-data smoke against the pre clone, not an empty profile.
- An old-client-reads-new-data compatibility check. Everyone tests the forward
  direction; this is the one that catches rollback breakage.
- Backup preflight green and a rollback manifest captured.
- A human click-through of changed surfaces.
- Schema comparison surfaced (§6) if versions differ.

## 8. Decisions already made

| Decision | Rationale |
| :--- | :--- |
| Slots are pointers over immutable releases | Exact rollback; `old` costs nothing and is never deployed to |
| Promotion copies artifacts, never rebuilds | §3.7 — a rebuild promotes something untested |
| `pre` gets a verbatim partition clone | §3.5 — a flattened clone tests a nonexistent shape |
| API stays additive-only, backwards-compatible | §3.1 — one API serves all lanes; endpoint versioning would not fix the real (data) failure mode |
| Schema mismatch is a human decision with full context | §6 |
| Promotion and approval are human-driven | User requirement |
| `old` does not auto-rotate on every promote | Recency is not the same as known-good |

## 9. Open questions for reviewers

1. **Is expand/contract the right migration discipline here**, or is there a better fit
   for a single-user app where we control both ends and can afford downtime?
2. **Is one shared API across three client versions acceptable long-term?** The
   alternative is an EP plan (real cost) or a second Function App (near-free on
   Consumption, but doubles deploy and config surface).
3. **Is partition-level isolation sufficient for `pre`**, given §3.3 shows lane
   detection has already failed once? Or does `pre` need its own container or database?
4. **What is the right enforcement point** for "pre never writes prod's partition"?
   We lean toward a server-side guard keyed on an injected lane identity.
5. **What should retire `old`?** A soak period, a session count, a clean-run signal, or
   an explicit human action? Should a separate `last-known-good` be pinned that never
   auto-rotates?
6. **Does the service worker (§3.9) need release-keyed cache names** for rollback to be
   real, and what is the least invasive way to do that?
7. **Is three environments justified at all** for a single-user app? The incidents this
   week were a merge bug, a floor bug and a missing manifest entry — none of which a
   third environment would have caught. A gate with a data clone and a human pass might
   deliver most of the value.

## 10. Explicitly out of scope for now

- Concurrency testing (DATA-01/03/04) — needs a two-writer harness, not a ring.
- Any change to the Cosmos plan or Function App plan.
- Automated promotion.
- The 46 exam-skipped questions that leave no record (a product gap, tracked separately).

## 11. What exists today that this would build on

| Asset | Role |
| :--- | :--- |
| `scripts/lib/deploy_common.sh` | `APP_FILES` manifest and the lane-prefix assertions |
| `scripts/promote_to_prod.sh` | Root promotion with a typed confirmation and test gate |
| `scripts/backup_prod_web.sh` → `rollback_prod.sh` | Manifest capture and byte-for-byte restore |
| `function-releases/` container | Retained API packages — an informal `old` for the API |
| `scripts/preflight_backup.sh` | Checksummed backup + live integrity suite |
| `js/shared/env.js`, `getEnvironmentConfig` | Lane detection (needs hardening, §3.3) |
| `tests/e2e/fixtures.js` | Sync quarantine and `localStorage` seeding |
