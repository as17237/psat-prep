# Code Review — Reviewer 2

**Reviewed:** 2026-08-25 · commit `b9f1f2a` ("fix(review-r9-f2): compare lastReviewedAt alone in mergeSrsState and add robust try/catch rollback with removeItem")
**Method:** Every finding below was validated by executing the real code paths against `srs.js` with `node -e` (engine-built fixtures), not by reading diffs. Test suites re-run at the end.

---

## Verdict on the latest fix commit

Two of the three findings from this review round are genuinely fixed and verified:

| # | Finding | Status |
| :-- | :--- | :--- |
| SRS merge used `dueAt` in recency comparison | **FIXED** ✅ verified |
| Rollback incomplete / unguarded | **FIXED** ✅ verified |
| Session merge not idempotent | **STILL BROKEN** ❌ |
| Anonymous sync + feedback endpoints | **STILL OPEN** ❌ |
| Push overwrites cloud wholesale | **STILL OPEN** ❌ |

---

## Fixed and verified

### 1. `dueAt` removed from `mergeSrsState` recency comparison — ✅ FIXED

`srs.js:1082-1083` now reads:

```js
var cTime = (typeof c.lastReviewedAt === 'number') ? c.lastReviewedAt : (c.timestamp || 0);
var lTime = (typeof l.lastReviewedAt === 'number') ? l.lastReviewedAt : (l.timestamp || 0);
```

Executed with engine-built cards (three chained correct reviews reaching reps 3 / interval 7 on Monday, then a **newer failing** review Tuesday on another device):

```
merged reps: 0, lastGrade: 2  -> newer FAIL wins (previously the older PASS won)
```

Test quality note: the new fixture in `tests/test_srs.js:445-452` asserts the precondition `monCardPass.dueAt > tueCardFail.dueAt`, which means it exercises exactly the ordering where `dueAt` dominance was invisible before. Against the previous implementation this test fails (`lastReviewedAt` would be 1000, not 2000) — it has been seen red, not just green.

### 2. Merge rollback guarded and complete — ✅ FIXED

`srs.js:1216-1231`: rollback writes are wrapped in try/catch, keys that had no prior value are now removed with `removeItem` instead of being left holding merged content. New test (`tests/test_srs.js:492-510`) forces a failure on the 3rd of 4 writes and asserts both that progress is restored byte-for-byte and that `psat_srs` (which did not exist pre-merge) ends as `null`.

Residual nit (non-blocking): a throwing rollback logs to console only. Acceptable because `{success:false, quotaExceeded:true}` is returned regardless, but if rollback itself fails the user's local state is silently half-restored — consider surfacing that case in the error message.

---

## Still broken — top 3 by priority

### FINDING R2-1 (highest priority): additive session merge is not idempotent — every sync cycle doubles daily stats

`srs.js:1011-1039` (`mergeSessionsState`) sums cloud + local per day key. That is correct for a single two-device merge, but the sync loop is pull → write locally → push → pull again. After the first pull, local equals the merged value; when it is pushed up and pulled again, it is summed with itself.

Executed against the real engine, simulating the actual app flow (`triggerCloudSync()` auto-pushes after answers at `index.html:1096`; pull runs on every load at `index.html:3063`):

```
device A: 12 answered, device B: 5 answered
pull 1: 12+5  = 17    -> pushed to cloud
pull 2: 17+17 = 34
pull 3: 68
pull 4: 136           <- should still be 17
```

Every repeated sync inflates `questionsAnswered`, `correct`, and `totalTimeMs` exponentially. Streaks, daily charts, and any time-based metric derived from `psat_sessions` become meaningless after two or three sessions on any device. Rounds 11–12 tested single merges only; no test ever ran two consecutive pull/push cycles — which is why this survived three rounds of review.

**Fix options** (pick one):
- Per-day `Math.max(cloud, local)` instead of sum — loses true multi-device same-day additivity but is idempotent and monotonic;
- Or keep additivity by storing a per-device sync watermark (e.g. `syncedThrough` timestamp per day per device) and only summing deltas recorded after the watermark;
- Or record server-side and never re-sum client-side.

Either way, add a test that runs `mergeSessionsState → push → mergeSessionsState → push → mergeSessionsState` and asserts the count does not grow after the first cycle. Watch it fail against current code first.

### FINDING R2-2: sync and feedback endpoints accept anonymous read/write of any student

`api/src/functions/sync.js:18` and `api/src/functions/feedback.js:18` both declare `authLevel: 'anonymous'`. `student_name` is an unauthenticated query/body parameter, so anyone who discovers the function URL can:

- GET any student's full record — progress, SRS state, complete exam history of a minor;
- POST-overwrite it wholesale (see R2-3), including planting bogus history.

This has been deferred as "owner's call" since round 10, but the data is now cloud-resident and the exposure grows with every device enrolled. Minimum viable hardening:
- Function access keys or Azure Easy Auth (Entra) on both functions; embed a per-deployment token in the client config.
- Server-side: replace `COSMOS_CONNECTION_STRING` env var with `DefaultAzureCredential` (round-1 recommendation, still unapplied — mode 2 twin).
- Add CORS restrictions rather than wildcard origins if currently configured as `*`.

### FINDING R2-3: `pushToCloud` overwrites the entire cloud master doc — last-writer-wins across devices

`srs.js:1140-1157` posts local state wholesale; `api/src/functions/sync.js:85-96` upserts it into `masterDoc` with no server-side merge. The client-side merges from R2-1/the SRS fix never run on this path. Any device that pushes before pulling (auto-push fires after *every* answer, so this is the common case, not an edge case) replaces the cloud copy of `progress`, `srsState`, and `sessionsState` with its own local-only view — silently erasing everything the other device did since its last pull.

Immutable exam docs survive via the `items.create` 409-ignore path, which masks the damage: exam reports persist while the underlying progress/SRS state regresses.

**Fix:** perform the merge server-side before upsert, using the same `PSAT_ENGINE` helpers (`mergeProgress`, `mergeSrsState`, `mergeSessionsState`) — they are UMD modules already loadable in Node. Alternatively reject pushes whose `clientTimestamp`/`updatedAt` is older than the stored doc and force a pull-merge first. Note this interacts with R2-1: fixing the endpoint without fixing idempotency will faithfully persist corrupted sums.

---

## Verification performed for this review

```text
node -e repros (against srs.js exports, engine-built fixtures)
  dueAt fail-vs-pass scenario      -> merged card = newer FAIL   (fix confirmed)
  4x pull/push session cycles      -> 17 -> 34 -> 68 -> 136      (R2-1 reproduced)

node tests/test_srs.js               PASS
node tests/test_free_response.js     PASS (365 items, 73 multi-form keys, 449 forms)
node tests/test_dataset_free_response.js  PASS
python3 -m unittest test_extractor.py     OK (9 tests)
```

Not verified (no deployment available): live behavior of the Azure Functions endpoints, deployed CORS configuration, and whether the production Cosmos container matches the schema assumed in `sync.js`.

## Suggested order of work

1. R2-1 — idempotent session merge + double-pull test (corrupting real student data today).
2. R2-3 — server-side merge on push (depends on 1 being settled first).
3. R2-2 — auth on both functions + `DefaultAzureCredential`.
