/**
 * tests/test_storage_v2.js — WI-11 (REFACTOR_PLAN.md) storage & sync hardening.
 *
 * Covers, in order:
 *   1. SRS history cap at 20 + EXACT durable summary counters that survive capping
 *   2. Migration v1 -> v2: non-destructive, idempotent, reversible (byte-equal rollback)
 *   3. Append-only attempts in the outbox: replay-once under an interrupted ack
 *   4. Delta sync vs full-state sync: identical final master doc through the REAL
 *      api/src/lib/merge.js
 *
 * CLAUDE.md mode 4 rules honoured here:
 *   - every expected value below is a hand-written literal, never produced by calling
 *     the code under test (the 20-event cap arithmetic, the review/lapse counts and the
 *     merged-document shapes were all worked out on paper first);
 *   - no module export is monkeypatched for time — every clock value is passed in as a
 *     parameter (scheduleNext(card, grade, nowMs, ...));
 *   - the delta/full equivalence test imports the production merge module directly
 *     (api/src/lib/merge.js), so it cannot pass by re-implementing the server's rules.
 *
 * Run: node tests/test_storage_v2.js
 */
const assert = require('assert');
const path = require('path');

const PSAT_ENGINE = require('../srs.js');
const serverMerge = require('../api/src/lib/merge.js');

let sectionCount = 0;
function section(title) {
  sectionCount++;
  console.log(`\n--- ${sectionCount}. ${title} ---`);
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

/** Minimal localStorage stand-in. String values only, exactly like the real thing. */
function makeStore(initial) {
  const map = Object.assign({}, initial || {});
  return {
    map,
    getItem(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem(k, v) { map[k] = String(v); },
    removeItem(k) { delete map[k]; }
  };
}

const PROD_LOC = { pathname: '/index.html', search: '' };

// ===========================================================================
section('SRS history cap at 20 with exact durable summaries');
// ===========================================================================

// --- 1a. The 21st event drops the OLDEST, keeps the newest 20 ---------------
// Hand-computed: reviews are stamped at T0 + n*DAY for n = 1..21.
// After 21 reviews the stored history must hold n = 2..21 (20 events);
// the n = 1 event is the one that falls off the front.
const T0 = 1700000000000;
const DAY = 86400000;

let card = { questionId: 'q_cap', repetitions: 0, intervalDays: 1, easeFactor: 2.5, history: [] };
for (let n = 1; n <= 21; n++) {
  card = PSAT_ENGINE.scheduleNext(card, 5, T0 + n * DAY, 30000);
}
assert.strictEqual(card.history.length, 20, 'history must be capped at 20 events');
assert.strictEqual(card.history[0].reviewedAt, T0 + 2 * DAY, 'oldest surviving event must be review #2 (review #1 dropped)');
assert.strictEqual(card.history[19].reviewedAt, T0 + 21 * DAY, 'newest event must be review #21');
assert.strictEqual(card.totalReviews, 21, 'totalReviews must be 21 even though only 20 events are stored');
assert.strictEqual(card.totalLapses, 0, 'no grade < 3 was given, so totalLapses must be 0');
assert.strictEqual(card.firstReviewedAt, T0 + DAY, 'firstReviewedAt must survive the drop of review #1');
assert.strictEqual(card.lastReviewedAt, T0 + 21 * DAY, 'lastReviewedAt must be review #21');
ok('21st event drops the oldest; summaries stay exact (21 reviews, 0 lapses)');

// --- 1b. Summary counters vs hand-computed values over a mixed run ----------
// 30 reviews at T0 + n*DAY, n = 1..30. Grades chosen by hand:
//   n in {3, 7, 8, 19, 26}  -> grade 1 (a LAPSE, grade < 3)   = 5 lapses
//   every other n           -> grade 5
// Hand-computed expectations: totalReviews 30, totalLapses 5,
// firstReviewedAt T0+1*DAY, lastReviewedAt T0+30*DAY, history length 20 (n = 11..30).
const LAPSE_AT = [3, 7, 8, 19, 26];
let mixed = { questionId: 'q_mixed', repetitions: 0, intervalDays: 1, easeFactor: 2.5, history: [] };
for (let n = 1; n <= 30; n++) {
  const grade = LAPSE_AT.indexOf(n) !== -1 ? 1 : 5;
  mixed = PSAT_ENGINE.scheduleNext(mixed, grade, T0 + n * DAY, 25000);
}
assert.strictEqual(mixed.totalReviews, 30, 'totalReviews must be 30');
assert.strictEqual(mixed.totalLapses, 5, 'totalLapses must be the 5 hand-listed grade-1 reviews');
assert.strictEqual(mixed.firstReviewedAt, T0 + 1 * DAY, 'firstReviewedAt must be the first review');
assert.strictEqual(mixed.lastReviewedAt, T0 + 30 * DAY, 'lastReviewedAt must be the last review');
assert.strictEqual(mixed.history.length, 20, 'history must be capped at 20');
assert.strictEqual(mixed.history[0].reviewedAt, T0 + 11 * DAY, 'oldest surviving event must be review #11');
// Only 1 of the 5 lapses (n = 19, n = 26) is still visible in the truncated history,
// hand-counted: of {3,7,8,19,26} only 19 and 26 are >= 11, so 2 remain in history.
const lapsesStillInHistory = mixed.history.filter(h => h.grade < 3).length;
assert.strictEqual(lapsesStillInHistory, 2, 'only 2 of the 5 lapses remain inside the 20-event window');
assert.strictEqual(mixed.totalLapses, 5, 'the durable counter still reports all 5 lapses');
ok('summary counters exact against hand-computed 30-review / 5-lapse run');

// --- 1c. summarizeSrsCard on a v1 card with history but NO counters ---------
// A v1 card written before summaries existed: 6 history events, 2 of them lapses,
// no totalReviews / totalLapses / firstReviewedAt fields at all.
const v1Card = {
  questionId: 'q_v1',
  repetitions: 3,
  intervalDays: 7,
  easeFactor: 2.4,
  lastReviewedAt: T0 + 6 * DAY,
  history: [
    { reviewedAt: T0 + 1 * DAY, grade: 5, intervalDays: 1, responseTimeMs: 20000 },
    { reviewedAt: T0 + 2 * DAY, grade: 1, intervalDays: 1, responseTimeMs: 40000 },
    { reviewedAt: T0 + 3 * DAY, grade: 4, intervalDays: 3, responseTimeMs: 22000 },
    { reviewedAt: T0 + 4 * DAY, grade: 2, intervalDays: 1, responseTimeMs: 50000 },
    { reviewedAt: T0 + 5 * DAY, grade: 5, intervalDays: 3, responseTimeMs: 18000 },
    { reviewedAt: T0 + 6 * DAY, grade: 5, intervalDays: 7, responseTimeMs: 19000 }
  ]
};
const v1Summary = PSAT_ENGINE.summarizeSrsCard(v1Card);
assert.strictEqual(v1Summary.totalReviews, 6, 'totalReviews must be derived from the 6 stored events');
assert.strictEqual(v1Summary.totalLapses, 2, 'totalLapses must be the 2 hand-counted grade<3 events');
assert.strictEqual(v1Summary.firstReviewedAt, T0 + 1 * DAY, 'firstReviewedAt must come from the oldest event');
assert.strictEqual(v1Summary.lastReviewedAt, T0 + 6 * DAY, 'lastReviewedAt must be the card field');
ok('summarizeSrsCard backfills exact counters for a v1 card that has none');

// --- 1d. scheduleNext must not UNDERCOUNT a v1 card's prior reviews ---------
// The v1 card above has 6 prior reviews. One more review => totalReviews 7,
// and its 2 prior lapses must be carried over (a grade-5 review adds none).
const v1Advanced = PSAT_ENGINE.scheduleNext(v1Card, 5, T0 + 7 * DAY, 21000);
assert.strictEqual(v1Advanced.totalReviews, 7, 'a v1 card with 6 events must advance to 7, not to 2');
assert.strictEqual(v1Advanced.totalLapses, 2, 'the v1 cards 2 prior lapses must be carried forward');
assert.strictEqual(v1Advanced.firstReviewedAt, T0 + 1 * DAY, 'firstReviewedAt must come from the oldest stored event');
ok('scheduleNext seeds its counters from history, so v1 cards do not lose reviews');

// --- 1e. summaries survive compactSrsState -----------------------------------
const compacted = PSAT_ENGINE.compactSrsState({ q_v1: v1Card });
assert.strictEqual(compacted.q_v1.totalReviews, 6, 'compactSrsState must report the exact 6 reviews');
assert.strictEqual(compacted.q_v1.totalLapses, 2, 'compactSrsState must report the exact 2 lapses');
assert.strictEqual(compacted.q_v1.firstReviewedAt, T0 + 1 * DAY, 'compactSrsState must keep firstReviewedAt');
assert.strictEqual(PSAT_ENGINE.SRS_HISTORY_CAP, 20, 'SRS_HISTORY_CAP must be the documented 20');
ok('compactSrsState preserves exact summaries and the cap constant is exported');

// ===========================================================================
section('Versioned envelope + v1 -> v2 migration (non-destructive, idempotent, reversible)');
// ===========================================================================

// A hand-written v1 local state: no psat_schema_meta key anywhere, SRS cards with
// history but no summary counters (exactly the shape the live student's browser holds).
const V1_PROGRESS = {
  q_alpha: { answered: true, selectedAnswer: 'A', isCorrect: true, timestamp: T0 + 1000, timesSeen: 1, timesCorrect: 1, timesIncorrect: 0 },
  q_beta: { answered: true, selectedAnswer: 'C', isCorrect: false, timestamp: T0 + 2000, timesSeen: 2, timesCorrect: 0, timesIncorrect: 2 }
};
const V1_SRS = {
  q_alpha: {
    questionId: 'q_alpha', repetitions: 2, intervalDays: 3, easeFactor: 2.5, lastReviewedAt: T0 + 3 * DAY,
    history: [
      { reviewedAt: T0 + 1 * DAY, grade: 4, intervalDays: 1, responseTimeMs: 20000 },
      { reviewedAt: T0 + 2 * DAY, grade: 1, intervalDays: 1, responseTimeMs: 60000 },
      { reviewedAt: T0 + 3 * DAY, grade: 5, intervalDays: 3, responseTimeMs: 15000 }
    ]
  },
  // A card with 25 events — 5 must be trimmed by the cap, and the summary must
  // still report all 25 reviews / the 4 hand-placed lapses.
  q_beta: (function () {
    const h = [];
    for (let n = 1; n <= 25; n++) {
      h.push({ reviewedAt: T0 + n * DAY, grade: (n === 4 || n === 5 || n === 22 || n === 24) ? 2 : 5, intervalDays: 1, responseTimeMs: 30000 });
    }
    return { questionId: 'q_beta', repetitions: 4, intervalDays: 6, easeFactor: 2.3, lastReviewedAt: T0 + 25 * DAY, history: h };
  })()
};
const V1_SESSIONS = { '2026-08-27': { date: '2026-08-27', questionsAnswered: 3, correct: 2, totalTimeMs: 90000 } };
const V1_HISTORY = [{ examId: 'v1_exam_1', completedAt: T0 + 4 * DAY, totalQuestions: 8, totalCorrect: 5 }];

function makeV1Store() {
  return makeStore({
    psat_progress: JSON.stringify(V1_PROGRESS),
    psat_srs: JSON.stringify(V1_SRS),
    psat_sessions: JSON.stringify(V1_SESSIONS),
    psat_exam_history: JSON.stringify(V1_HISTORY)
  });
}

// --- 2a. A v1 store reports schemaVersion 1 and stays readable forever -------
const preStore = makeV1Store();
assert.strictEqual(PSAT_ENGINE.SCHEMA_VERSION, 2, 'SCHEMA_VERSION must be 2');
const preMeta = PSAT_ENGINE.readSchemaMeta(preStore, PROD_LOC);
assert.strictEqual(preMeta.schemaVersion, 1, 'a store with no psat_schema_meta must read as schemaVersion 1');
ok('a v1 store (no meta key) reads as schemaVersion 1, not as an error');

// --- 2b. Migration writes v1 backups FIRST and leaves the originals intact ---
const mStore = makeV1Store();
const v1RawProgress = mStore.getItem('psat_progress');
const v1RawSrs = mStore.getItem('psat_srs');
const v1RawSessions = mStore.getItem('psat_sessions');
const v1RawHistory = mStore.getItem('psat_exam_history');

const mig1 = PSAT_ENGINE.migrateLocalStateToV2(mStore, PROD_LOC);
assert.strictEqual(mig1.success, true, 'migration must succeed on a healthy store');
assert.strictEqual(mig1.migrated, true, 'first run must report migrated: true');
assert.strictEqual(mig1.schemaVersion, 2, 'migration must land on schemaVersion 2');

assert.strictEqual(mStore.getItem('psat_progress_v1_backup'), v1RawProgress, 'progress v1 backup must be byte-identical');
assert.strictEqual(mStore.getItem('psat_srs_v1_backup'), v1RawSrs, 'srs v1 backup must be byte-identical');
assert.strictEqual(mStore.getItem('psat_sessions_v1_backup'), v1RawSessions, 'sessions v1 backup must be byte-identical');
assert.strictEqual(mStore.getItem('psat_exam_history_v1_backup'), v1RawHistory, 'exam-history v1 backup must be byte-identical');

// Non-destructive: progress / sessions / exam history are untouched by the migration.
assert.strictEqual(mStore.getItem('psat_progress'), v1RawProgress, 'migration must not rewrite psat_progress');
assert.strictEqual(mStore.getItem('psat_sessions'), v1RawSessions, 'migration must not rewrite psat_sessions');
assert.strictEqual(mStore.getItem('psat_exam_history'), v1RawHistory, 'migration must not rewrite psat_exam_history');
ok('migration writes byte-identical psat_*_v1_backup copies and touches no non-SRS key');

// --- 2c. Migrated SRS: capped history + EXACT summaries ---------------------
const migratedSrs = JSON.parse(mStore.getItem('psat_srs'));
assert.strictEqual(migratedSrs.q_alpha.totalReviews, 3, 'q_alpha has 3 stored events -> totalReviews 3');
assert.strictEqual(migratedSrs.q_alpha.totalLapses, 1, 'q_alpha has 1 hand-placed grade-1 event');
assert.strictEqual(migratedSrs.q_alpha.firstReviewedAt, T0 + 1 * DAY, 'q_alpha firstReviewedAt from oldest event');
assert.strictEqual(migratedSrs.q_alpha.history.length, 3, 'q_alpha has fewer than 20 events, so nothing is trimmed');

assert.strictEqual(migratedSrs.q_beta.totalReviews, 25, 'q_beta had 25 events -> totalReviews 25');
assert.strictEqual(migratedSrs.q_beta.totalLapses, 4, 'q_beta has 4 hand-placed grade-2 events');
assert.strictEqual(migratedSrs.q_beta.history.length, 20, 'q_beta history must be trimmed to the 20 newest');
assert.strictEqual(migratedSrs.q_beta.history[0].reviewedAt, T0 + 6 * DAY, 'oldest surviving q_beta event is #6 (25 - 20 + 1)');
assert.strictEqual(migratedSrs.q_beta.firstReviewedAt, T0 + 1 * DAY, 'q_beta firstReviewedAt survives the trim of events 1..5');
assert.strictEqual(migratedSrs.q_beta.easeFactor, 2.3, 'unrelated SM-2 fields must be preserved verbatim');
assert.strictEqual(mig1.cardsUpgraded, 2, 'both cards must be reported as upgraded');
assert.strictEqual(mig1.eventsTrimmed, 5, '25 - 20 = 5 events trimmed, reported as a measurement');
ok('migrated SRS is capped at 20 with exact summaries (25 reviews / 4 lapses survive the trim)');

// --- 2d. Idempotence: running the migration twice changes nothing -----------
const afterFirst = JSON.parse(JSON.stringify(mStore.map));
const mig2 = PSAT_ENGINE.migrateLocalStateToV2(mStore, PROD_LOC);
assert.strictEqual(mig2.success, true, 'a second migration run must succeed');
assert.strictEqual(mig2.migrated, false, 'a second run must report migrated: false');
assert.strictEqual(mig2.alreadyV2, true, 'a second run must report alreadyV2');
assert.deepStrictEqual(mStore.map, afterFirst, 'a second migration run must leave the store byte-for-byte identical');
const mig3 = PSAT_ENGINE.migrateLocalStateToV2(mStore, PROD_LOC);
assert.strictEqual(mig3.migrated, false, 'a third run is still a no-op');
assert.deepStrictEqual(mStore.map, afterFirst, 'a third migration run must still change nothing');
ok('migration is idempotent: runs 2 and 3 leave the store deep-equal to run 1');

// --- 2e. Reversibility: rollback restores v1 byte-for-byte ------------------
const rb = PSAT_ENGINE.rollbackLocalStateToV1(mStore, PROD_LOC);
assert.strictEqual(rb.success, true, 'rollback must succeed when v1 backups exist');
assert.strictEqual(mStore.getItem('psat_progress'), v1RawProgress, 'psat_progress must be byte-equal to v1');
assert.strictEqual(mStore.getItem('psat_srs'), v1RawSrs, 'psat_srs must be byte-equal to v1');
assert.strictEqual(mStore.getItem('psat_sessions'), v1RawSessions, 'psat_sessions must be byte-equal to v1');
assert.strictEqual(mStore.getItem('psat_exam_history'), v1RawHistory, 'psat_exam_history must be byte-equal to v1');
assert.strictEqual(mStore.getItem('psat_schema_meta'), null, 'rollback must clear the v2 envelope marker');
assert.strictEqual(PSAT_ENGINE.readSchemaMeta(mStore, PROD_LOC).schemaVersion, 1, 'after rollback the store reads as v1 again');
// The backups themselves must NOT be deleted (CLAUDE.md mode 7: a fallback path may
// never be more destructive than the primary path).
assert.strictEqual(mStore.getItem('psat_srs_v1_backup'), v1RawSrs, 'rollback must keep the v1 backup copies');
ok('rollback restores every v1 key byte-for-byte and keeps the backups');

// Round trip: v1 -> v2 -> rollback must equal the original v1 store exactly.
const fresh = makeV1Store();
const originalMap = JSON.parse(JSON.stringify(fresh.map));
PSAT_ENGINE.migrateLocalStateToV2(fresh, PROD_LOC);
PSAT_ENGINE.rollbackLocalStateToV1(fresh, PROD_LOC);
Object.keys(originalMap).forEach((k) => {
  assert.strictEqual(fresh.map[k], originalMap[k], `${k} must be byte-identical after the v1->v2->rollback round trip`);
});
ok('v1 -> v2 -> rollback round trip is byte-identical on every original key');

// --- 2f. A failing backup write ABORTS the migration, changing nothing ------
const failStore = makeV1Store();
const failMapBefore = JSON.parse(JSON.stringify(failStore.map));
const realSet = failStore.setItem.bind(failStore);
failStore.setItem = function (k, v) {
  if (k === 'psat_srs_v1_backup') {
    const e = new Error('QuotaExceededError');
    e.name = 'QuotaExceededError';
    throw e;
  }
  return realSet(k, v);
};
const failed = PSAT_ENGINE.migrateLocalStateToV2(failStore, PROD_LOC);
failStore.setItem = realSet;
assert.strictEqual(failed.success, false, 'migration must fail when a v1 backup write fails');
assert.ok(failed.error && String(failed.error).length > 0, 'the failure must be reported, not swallowed');
assert.strictEqual(failStore.getItem('psat_schema_meta'), null, 'an aborted migration must not mark the store as v2');
assert.deepStrictEqual(failStore.map, failMapBefore, 'an aborted migration must leave the store exactly as it was');
ok('a failing v1-backup write aborts the migration and leaves the store untouched');

// --- 2g. The envelope itself -------------------------------------------------
const envStore = makeV1Store();
PSAT_ENGINE.migrateLocalStateToV2(envStore, PROD_LOC);
const env = PSAT_ENGINE.buildStateEnvelope(envStore, PROD_LOC);
assert.strictEqual(env.schemaVersion, 2, 'the envelope must carry schemaVersion 2');
assert.strictEqual(typeof env.createdAt, 'number', 'the envelope must carry a numeric createdAt');
assert.strictEqual(typeof env.updatedAt, 'number', 'the envelope must carry a numeric updatedAt');
assert.deepStrictEqual(Object.keys(env.progress).sort(), ['q_alpha', 'q_beta'], 'the envelope carries the real progress map');
assert.deepStrictEqual(env.examHistory, V1_HISTORY, 'the envelope carries the real exam history');
assert.strictEqual(Object.keys(env.sessionsState).length, 1, 'the envelope carries the real sessions map');
ok('buildStateEnvelope wraps the four state keys with schemaVersion 2 + timestamps');

// --- 2h. Beta lane isolation: migration is prefix-aware ----------------------
const betaLoc = { pathname: '/beta/index.html', search: '' };
const dualStore = makeStore({
  psat_progress: JSON.stringify(V1_PROGRESS),
  psat_srs: JSON.stringify(V1_SRS),
  beta_psat_progress: JSON.stringify(V1_PROGRESS),
  beta_psat_srs: JSON.stringify(V1_SRS)
});
const prodRaw = dualStore.getItem('psat_srs');
const betaMig = PSAT_ENGINE.migrateLocalStateToV2(dualStore, betaLoc);
assert.strictEqual(betaMig.migrated, true, 'the beta lane must migrate independently');
assert.ok(dualStore.getItem('beta_psat_schema_meta'), 'beta lane must get its own prefixed meta key');
assert.strictEqual(dualStore.getItem('psat_schema_meta'), null, 'the production lane must NOT be marked v2 by a beta migration');
assert.strictEqual(dualStore.getItem('psat_srs'), prodRaw, 'production psat_srs must be byte-for-byte untouched');
assert.strictEqual(dualStore.getItem('psat_srs_v1_backup'), null, 'no unprefixed backup may be created from the beta lane');
ok('migration is storage-prefix aware: beta migration never touches production keys');

// Sections 3 and 4 exercise the async push path, so they run inside an async main().
(async function main() {
// ===========================================================================
section('Append-only attempts in the outbox: replay-once under an interrupted ack');
// ===========================================================================

/**
 * A stand-in for POST /api/sync that applies the REAL server merge rules from
 * api/src/lib/merge.js. It also keeps an append-only ledger of every op id it has
 * ever been handed, so a replay is visible as a repeated id rather than inferred.
 */
function makeFakeServer(opts) {
  const state = { master: (opts && opts.master) || null, opLedger: [], posts: [] };
  let dropAckOnce = !!(opts && opts.dropAckOnce);
  return {
    state,
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      state.posts.push(body);
      const prev = state.master;
      state.master = {
        id: 'student_' + body.student_name,
        student_name: body.student_name,
        doc_type: 'student_master_profile',
        progress: serverMerge.mergeProgress(prev && prev.progress, body.progress),
        srsState: serverMerge.mergeSrsState(prev && prev.srsState, body.srsState),
        sessionsState: serverMerge.mergeSessions(prev && prev.sessionsState, body.sessionsState),
        examHistory: serverMerge.mergeExamHistory(prev && prev.examHistory, body.examHistory, serverMerge.EXAM_HISTORY_CAP),
        schemaVersion: Math.max(Number(body.schemaVersion) || 0, (prev && prev.schemaVersion) || 1),
        clientVersion: body.client_version || (prev && prev.clientVersion) || null
      };
      (body.outboxOps || []).forEach((op) => state.opLedger.push(op.id));
      if (dropAckOnce) {
        // The write LANDED, but the response never reaches the client. This is the
        // exact failure the replay-once requirement is about.
        dropAckOnce = false;
        throw new Error('network dropped after the server committed the write');
      }
      return {
        ok: true,
        json: async () => ({ success: true, updatedAt: Date.now(), ackOpIds: (body.outboxOps || []).map((o) => o.id) })
      };
    }
  };
}

// --- 3a. The same attempt enqueued twice produces ONE op --------------------
const dupStore = makeStore({});
const dupA = PSAT_ENGINE.enqueueOutboxOp(dupStore, 'question_attempt', { questionId: 'q_dup', isCorrect: true, timestamp: T0 }, PROD_LOC);
const dupB = PSAT_ENGINE.enqueueOutboxOp(dupStore, 'question_attempt', { questionId: 'q_dup', isCorrect: true, timestamp: T0 }, PROD_LOC);
assert.strictEqual(PSAT_ENGINE.getOutboxOps(dupStore, PROD_LOC).length, 1, 'the same attempt must not queue twice');
assert.strictEqual(dupA.id, dupB.id, 'a re-enqueue must return the op already queued, not a new one');
// A different attempt on the same question is a DIFFERENT op.
PSAT_ENGINE.enqueueOutboxOp(dupStore, 'question_attempt', { questionId: 'q_dup', isCorrect: false, timestamp: T0 + 1000 }, PROD_LOC);
assert.strictEqual(PSAT_ENGINE.getOutboxOps(dupStore, PROD_LOC).length, 2, 'a later attempt on the same question is a separate op');
ok('outbox ops for attempts are content-addressed: re-enqueue is a no-op, new attempt is a new op');

// --- 3b. Interrupted ack: retry stores each attempt exactly once ------------
// Hand-written local state: three attempts on q_replay (timesSeen 3, 2 correct),
// one on q_other. Nothing has ever synced, so the first push is a full push.
const replayProgress = {
  q_replay: { answered: true, selectedAnswer: 'B', isCorrect: true, timestamp: T0 + 3000, timesSeen: 3, timesCorrect: 2, timesIncorrect: 1 },
  q_other: { answered: true, selectedAnswer: 'A', isCorrect: true, timestamp: T0 + 4000, timesSeen: 1, timesCorrect: 1, timesIncorrect: 0 }
};
const replayStore = makeStore({
  psat_progress: JSON.stringify(replayProgress),
  psat_srs: JSON.stringify({}),
  psat_sessions: JSON.stringify({}),
  psat_exam_history: JSON.stringify([])
});
[
  { questionId: 'q_replay', isCorrect: false, timestamp: T0 + 1000 },
  { questionId: 'q_replay', isCorrect: true, timestamp: T0 + 2000 },
  { questionId: 'q_replay', isCorrect: true, timestamp: T0 + 3000 },
  { questionId: 'q_other', isCorrect: true, timestamp: T0 + 4000 }
].forEach((p) => PSAT_ENGINE.enqueueOutboxOp(replayStore, 'question_attempt', p, PROD_LOC));
assert.strictEqual(PSAT_ENGINE.getOutboxOps(replayStore, PROD_LOC).length, 4, '4 distinct attempts must be queued');

const server = makeFakeServer({ dropAckOnce: true });
const push1 = await PSAT_ENGINE.pushToCloud(replayStore, server.fetch.bind(server), 'e2e_test_student', PROD_LOC);
assert.strictEqual(push1.success, false, 'the interrupted push must report failure to the caller');
assert.strictEqual(PSAT_ENGINE.getOutboxOps(replayStore, PROD_LOC).length, 4, 'an unacknowledged op must stay in the outbox');
assert.strictEqual(server.state.opLedger.length, 4, 'the server did receive the 4 ops before the ack was lost');

const push2 = await PSAT_ENGINE.pushToCloud(replayStore, server.fetch.bind(server), 'e2e_test_student', PROD_LOC);
assert.strictEqual(push2.success, true, 'the retry must succeed');
assert.strictEqual(PSAT_ENGINE.getOutboxOps(replayStore, PROD_LOC).length, 0, 'the outbox must be empty after a successful ack');

// The server saw 8 op deliveries (4 + 4 replays) but must hold each ATTEMPT once.
assert.strictEqual(server.state.opLedger.length, 8, 'the replay really did re-deliver all 4 ops');
assert.strictEqual(new Set(server.state.opLedger).size, 4, 'only 4 DISTINCT op ids exist across both deliveries');
assert.strictEqual(server.state.master.progress.q_replay.timesSeen, 3, 'q_replay must still show 3 attempts, not 6');
assert.strictEqual(server.state.master.progress.q_replay.timesCorrect, 2, 'q_replay correct count must not double');
assert.strictEqual(server.state.master.progress.q_other.timesSeen, 1, 'q_other must still show 1 attempt');
assert.strictEqual(Object.keys(server.state.master.progress).length, 2, 'no phantom question may appear');
ok('interrupted ack -> retry: each attempt is stored exactly once (3 and 1, not 6 and 2)');

// --- 3c. A third push with nothing new must not re-post the world ----------
const push3 = await PSAT_ENGINE.pushToCloud(replayStore, server.fetch.bind(server), 'e2e_test_student', PROD_LOC);
assert.strictEqual(push3.success, true, 'a no-op push must still report success');
assert.strictEqual(push3.skipped, true, 'a push with no changes and no queued ops must be skipped');
assert.strictEqual(server.state.posts.length, 2, 'no third HTTP POST may be issued when nothing changed');
ok('a push with an empty delta and an empty outbox issues no request at all');

// ===========================================================================
section('Delta sync vs full-state sync: identical master doc through the real merge.js');
// ===========================================================================

// Hand-written scenario. "OLD" records were synced yesterday and are already on the
// server byte-identically; "NEW" records were produced after the cursor.
const CURSOR = T0 + 100000;
const OLD_PROG = {
  q_old_1: { answered: true, selectedAnswer: 'A', isCorrect: true, timestamp: T0 + 10, timesSeen: 1, timesCorrect: 1, timesIncorrect: 0 },
  q_old_2: { answered: true, selectedAnswer: 'D', isCorrect: false, timestamp: T0 + 20, timesSeen: 1, timesCorrect: 0, timesIncorrect: 1 }
};
const NEW_PROG = {
  q_new_1: { answered: true, selectedAnswer: 'B', isCorrect: true, timestamp: CURSOR + 10, timesSeen: 1, timesCorrect: 1, timesIncorrect: 0 },
  q_new_2: { answered: true, selectedAnswer: 'C', isCorrect: true, timestamp: CURSOR + 20, timesSeen: 4, timesCorrect: 3, timesIncorrect: 1 }
};
const OLD_SRS = {
  q_old_1: { questionId: 'q_old_1', repetitions: 1, intervalDays: 1, easeFactor: 2.6, lastReviewedAt: T0 + 10, totalReviews: 1, totalLapses: 0, firstReviewedAt: T0 + 10, history: [] }
};
const NEW_SRS = {
  q_new_1: { questionId: 'q_new_1', repetitions: 2, intervalDays: 3, easeFactor: 2.5, lastReviewedAt: CURSOR + 10, totalReviews: 2, totalLapses: 0, firstReviewedAt: T0 + 5, history: [] }
};
const OLD_SESS = { '2026-08-20': { date: '2026-08-20', questionsAnswered: 2, correct: 1, totalTimeMs: 40000 } };
const NEW_SESS = { '2026-08-29': { date: '2026-08-29', questionsAnswered: 6, correct: 5, totalTimeMs: 180000 } };
const OLD_EXAM = [{ examId: 'exam_old', completedAt: T0 + 30, totalQuestions: 8, totalCorrect: 4 }];
const NEW_EXAM = [{ examId: 'exam_new', completedAt: CURSOR + 30, totalQuestions: 8, totalCorrect: 7 }];

// What the server already holds — exactly the OLD records, as a full push would
// have left them yesterday.
function serverBefore() {
  return {
    id: 'student_e2e_test_student',
    student_name: 'e2e_test_student',
    doc_type: 'student_master_profile',
    progress: JSON.parse(JSON.stringify(OLD_PROG)),
    srsState: JSON.parse(JSON.stringify(OLD_SRS)),
    sessionsState: JSON.parse(JSON.stringify(OLD_SESS)),
    examHistory: JSON.parse(JSON.stringify(OLD_EXAM))
  };
}

function applyServerMerge(existing, body) {
  return {
    progress: serverMerge.mergeProgress(existing.progress, body.progress),
    srsState: serverMerge.mergeSrsState(existing.srsState, body.srsState),
    sessionsState: serverMerge.mergeSessions(existing.sessionsState, body.sessionsState),
    examHistory: serverMerge.mergeExamHistory(existing.examHistory, body.examHistory, serverMerge.EXAM_HISTORY_CAP)
  };
}

const FULL_LOCAL = {
  progress: Object.assign({}, OLD_PROG, NEW_PROG),
  srsState: Object.assign({}, OLD_SRS, NEW_SRS),
  sessionsState: Object.assign({}, OLD_SESS, NEW_SESS),
  examHistory: OLD_EXAM.concat(NEW_EXAM)
};

const deltaStore = makeStore({
  psat_progress: JSON.stringify(FULL_LOCAL.progress),
  psat_srs: JSON.stringify(FULL_LOCAL.srsState),
  psat_sessions: JSON.stringify(FULL_LOCAL.sessionsState),
  psat_exam_history: JSON.stringify(FULL_LOCAL.examHistory)
});

// --- 4a. buildSyncDelta selects exactly the records newer than the cursor ---
const delta = PSAT_ENGINE.buildSyncDelta(deltaStore, PROD_LOC, CURSOR);
assert.strictEqual(delta.isFull, false, 'a delta build with a cursor must not be a full push');
assert.deepStrictEqual(Object.keys(delta.progress).sort(), ['q_new_1', 'q_new_2'], 'only the 2 new progress entries are selected');
assert.deepStrictEqual(Object.keys(delta.srsState).sort(), ['q_new_1'], 'only the 1 new SRS card is selected');
assert.deepStrictEqual(delta.examHistory.map((e) => e.examId), ['exam_new'], 'only the new exam is selected');
assert.strictEqual(delta.counts.progress, 2, 'delta must report 2 progress entries as a measurement');
assert.strictEqual(delta.counts.srs, 1, 'delta must report 1 SRS card');
assert.strictEqual(delta.counts.exams, 1, 'delta must report 1 exam');
ok('buildSyncDelta picks exactly the 2 progress / 1 SRS / 1 exam records newer than the cursor');

// --- 4b. A full build with no cursor selects everything ---------------------
const fullBuild = PSAT_ENGINE.buildSyncDelta(deltaStore, PROD_LOC, null);
assert.strictEqual(fullBuild.isFull, true, 'no cursor means a full push');
assert.strictEqual(Object.keys(fullBuild.progress).length, 4, 'a full build carries all 4 progress entries');
assert.strictEqual(fullBuild.examHistory.length, 2, 'a full build carries both exams');
ok('buildSyncDelta with no cursor is the full-state fallback path');

// --- 4c. THE EQUIVALENCE: delta post == full post, via the real merge.js ----
const viaFull = applyServerMerge(serverBefore(), {
  progress: FULL_LOCAL.progress,
  srsState: FULL_LOCAL.srsState,
  sessionsState: FULL_LOCAL.sessionsState,
  examHistory: FULL_LOCAL.examHistory
});
const viaDelta = applyServerMerge(serverBefore(), {
  progress: delta.progress,
  srsState: delta.srsState,
  sessionsState: delta.sessionsState,
  examHistory: delta.examHistory
});
assert.deepStrictEqual(viaDelta, viaFull, 'a delta post must merge to the SAME master document as a full post');
assert.strictEqual(Object.keys(viaDelta.progress).length, 4, 'the merged doc holds all 4 questions either way');
assert.strictEqual(viaDelta.examHistory.length, 2, 'the merged doc holds both exams either way');
assert.strictEqual(viaDelta.sessionsState['2026-08-20'].questionsAnswered, 2, 'the untouched old session day survives the delta post');
ok('delta post and full post produce byte-identical master documents through api/src/lib/merge.js');

// --- 4d. A v1 client (full state, no schemaVersion) is unaffected -----------
// A v1 client pushes the whole world afterwards. Nothing the delta path did can
// make that push lose data: the server merge is per-key in both directions.
const v1Push = applyServerMerge(viaDelta, {
  progress: FULL_LOCAL.progress,
  srsState: FULL_LOCAL.srsState,
  sessionsState: FULL_LOCAL.sessionsState,
  examHistory: FULL_LOCAL.examHistory
});
assert.deepStrictEqual(v1Push, viaFull, 'a v1 full-state push over a delta-built doc converges to the same document');
ok('a v1 full-state client pushing over delta-written state converges, losing nothing');

// --- 4e. pushToCloud switches full -> delta and reports which it used -------
const modeStore = makeStore({
  psat_progress: JSON.stringify(OLD_PROG),
  psat_srs: JSON.stringify({}),
  psat_sessions: JSON.stringify({}),
  psat_exam_history: JSON.stringify([])
});
const modeServer = makeFakeServer({});
const first = await PSAT_ENGINE.pushToCloud(modeStore, modeServer.fetch.bind(modeServer), 'e2e_test_student', PROD_LOC);
assert.strictEqual(first.success, true, 'the first push must succeed');
assert.strictEqual(first.syncMode, 'full', 'the first push for a profile must be a FULL push');
assert.strictEqual(Object.keys(modeServer.state.posts[0].progress).length, 2, 'the full push carries both existing entries');
assert.strictEqual(modeServer.state.posts[0].schemaVersion, 2, 'the pushed payload must carry schemaVersion 2');

// Now add one new attempt and push again -> delta with exactly that one entry.
const grown = Object.assign({}, OLD_PROG, {
  q_fresh: { answered: true, selectedAnswer: 'A', isCorrect: true, timestamp: Date.now() + 5000, timesSeen: 1, timesCorrect: 1, timesIncorrect: 0 }
});
modeStore.setItem('psat_progress', JSON.stringify(grown));
const second = await PSAT_ENGINE.pushToCloud(modeStore, modeServer.fetch.bind(modeServer), 'e2e_test_student', PROD_LOC);
assert.strictEqual(second.success, true, 'the second push must succeed');
assert.strictEqual(second.syncMode, 'delta', 'the second push must be a DELTA push');
assert.deepStrictEqual(Object.keys(modeServer.state.posts[1].progress), ['q_fresh'], 'the delta payload carries only the new entry');
assert.strictEqual(Object.keys(modeServer.state.master.progress).length, 3, 'the server doc still holds all 3 entries after the delta');
ok('pushToCloud: first push full, second push delta carrying 1 of 3 entries, server keeps all 3');

// --- 4f. resetSyncCursor forces the next push back to full ------------------
PSAT_ENGINE.resetSyncCursor(modeStore, PROD_LOC);
assert.strictEqual(PSAT_ENGINE.getSyncCursor(modeStore, PROD_LOC).lastPushAt, null, 'resetSyncCursor must clear the cursor');
modeStore.setItem('psat_progress', JSON.stringify(grown));
const third = await PSAT_ENGINE.pushToCloud(modeStore, modeServer.fetch.bind(modeServer), 'e2e_test_student', PROD_LOC);
assert.strictEqual(third.syncMode, 'full', 'after a cursor reset the next push must be full again');
assert.strictEqual(Object.keys(modeServer.state.posts[2].progress).length, 3, 'the recovery full push carries all 3 entries');
ok('resetSyncCursor restores the full-state fallback (used after reset/import/restore)');


// ===========================================================================
section('Transactional destructive actions: restore never deletes records');
// ===========================================================================

// --- 5a. A MISSING pre-demo backup must leave real data untouched -----------
// Roadmap §1.3 and CLAUDE.md mode 7 (the Round-8 rule): "a fallback path may never
// be more destructive than the primary path". Before WI-11, restoreRealData() with
// no psat_pre_sample_backup deleted all four state keys and returned true.
const noBackupStore = makeStore({
  psat_progress: JSON.stringify(V1_PROGRESS),
  psat_srs: JSON.stringify(V1_SRS),
  psat_sessions: JSON.stringify(V1_SESSIONS),
  psat_exam_history: JSON.stringify(V1_HISTORY),
  psat_sample_data_active: 'true'
});
const beforeNoBackup = JSON.parse(JSON.stringify(noBackupStore.map));
const noBackupResult = PSAT_ENGINE.restoreRealData(noBackupStore, null, null, PROD_LOC);
assert.strictEqual(noBackupResult, false, 'restore with no backup must report failure, not success');
assert.deepStrictEqual(noBackupStore.map, beforeNoBackup, 'restore with no backup must change NOTHING at all');
assert.ok(noBackupStore.getItem('psat_progress'), 'psat_progress must still exist');
assert.ok(noBackupStore.getItem('psat_srs'), 'psat_srs must still exist');
assert.ok(noBackupStore.getItem('psat_sessions'), 'psat_sessions must still exist');
assert.ok(noBackupStore.getItem('psat_exam_history'), 'psat_exam_history must still exist');
ok('restoreRealData with a missing backup deletes nothing and returns false');

// --- 5b. A CORRUPT backup is treated the same way ---------------------------
const corruptStore = makeStore({
  psat_progress: JSON.stringify(V1_PROGRESS),
  psat_srs: JSON.stringify(V1_SRS),
  psat_pre_sample_backup: '{not valid json',
  psat_sample_data_active: 'true'
});
const beforeCorrupt = JSON.parse(JSON.stringify(corruptStore.map));
assert.strictEqual(PSAT_ENGINE.restoreRealData(corruptStore, null, null, PROD_LOC), false, 'a corrupt backup must fail the restore');
assert.deepStrictEqual(corruptStore.map, beforeCorrupt, 'a corrupt backup must leave every key untouched');
ok('restoreRealData with a corrupt backup deletes nothing and returns false');

// --- 5c. A VALID backup still restores exactly as before --------------------
const realProgress = { real_q: { answered: true, isCorrect: true, timestamp: T0 } };
const realHistory = [{ examId: 'real_exam', completedAt: T0 }];
const goodStore = makeStore({ psat_progress: JSON.stringify(realProgress), psat_exam_history: JSON.stringify(realHistory) });
assert.strictEqual(PSAT_ENGINE.backupRealData(goodStore, null, null, PROD_LOC), true, 'backup must succeed');
goodStore.setItem('psat_sample_data_active', 'true');
goodStore.setItem('psat_progress', JSON.stringify({ sample_q: { answered: true } }));
assert.strictEqual(PSAT_ENGINE.restoreRealData(goodStore, null, null, PROD_LOC), true, 'a valid backup must restore');
assert.deepStrictEqual(JSON.parse(goodStore.getItem('psat_progress')), realProgress, 'real progress must come back');
assert.deepStrictEqual(JSON.parse(goodStore.getItem('psat_exam_history')), realHistory, 'real exam history must come back');
assert.strictEqual(goodStore.getItem('psat_sample_data_active'), null, 'the demo flag must be cleared');
assert.strictEqual(goodStore.getItem('psat_pre_sample_backup'), null, 'the consumed backup must be cleared');
ok('restoreRealData with a valid backup restores every key and clears the demo flag');

// --- 5d. A destructive action whose snapshot fails must abort ---------------
const abortStore = makeStore({ psat_progress: JSON.stringify(realProgress) });
const abortSet = abortStore.setItem.bind(abortStore);
abortStore.setItem = function (k, v) {
  if (k.indexOf('psat_snapshot_') === 0) throw new Error('QuotaExceededError');
  return abortSet(k, v);
};
let mutationRan = false;
const aborted = PSAT_ENGINE.runTransactionalAction(abortStore, 'reset_all_progress', function () {
  mutationRan = true;
  abortSet('psat_progress', '{}');
  return { success: true };
}, PROD_LOC);
abortStore.setItem = abortSet;
assert.strictEqual(aborted.success, false, 'a failing snapshot must abort the action');
assert.strictEqual(aborted.aborted, true, 'the abort must be reported as such');
assert.strictEqual(mutationRan, false, 'the destructive mutation must never have run');
assert.deepStrictEqual(JSON.parse(abortStore.getItem('psat_progress')), realProgress, 'data must be exactly as it was');
ok('runTransactionalAction aborts before the mutation when the safety snapshot fails');

})().then(function () {
  console.log('\nALL WI-11 STORAGE/SYNC TESTS PASSED');
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});
