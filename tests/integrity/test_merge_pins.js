/**
 * tests/integrity/test_merge_pins.js — WI-07 merge-semantics pin tests
 *
 * These tests pin the four server-side merge blocks that `api/src/functions/sync.js`
 * applies to every POST /api/sync. That merge is THE contract that makes a v1 client
 * (prod/beta lane) and a v2 client (/v2/ lane) safe to run against the SAME Cosmos
 * documents at the same time: a write from either lane must never destroy the other
 * lane's data. If a future work item weakens one of these rules, a student loses
 * answered questions silently — the UI would still say "synced".
 *
 * Everything here is OFFLINE: hand-written fixtures, no Cosmos, no network, no clock
 * reads (CLAUDE.md mode 4 — a test must not reuse the implementation to build its own
 * expectations, so every expected value below is written out by hand).
 *
 * IMPORTANT — these tests pin what the code DOES, not what it ideally should do.
 * In particular the tie-break on EQUAL timestamps favours the INCOMING write
 * (`>=`, not `>`). That is the current production behaviour; it is pinned here so a
 * change to it is a deliberate, visible decision rather than an accident.
 */

const assert = require('assert');

const {
  mergeProgress,
  mergeSrsState,
  mergeSessions,
  mergeExamHistory,
  EXAM_HISTORY_CAP
} = require('../../api/src/lib/merge.js');

let checks = 0;
function ok(msg) {
  checks++;
  console.log(`  ✓ ${msg}`);
}

console.log('WI-07 merge-semantics pin tests (offline, hand-written fixtures)\n');

// =========================================================================
// 1. mergeProgress — newer timestamp wins; older NEVER overwrites newer.
// =========================================================================
console.log('1. mergeProgress');
{
  // Fixture: server already holds a NEWER attempt for q1 than the client is pushing.
  const existing = {
    q1: { answered: true, isCorrect: true, timestamp: 2000, timesSeen: 2 },
    q2: { answered: true, isCorrect: false, timestamp: 1000, timesSeen: 1 }
  };
  const incoming = {
    q1: { answered: true, isCorrect: false, timestamp: 1500, timesSeen: 1 }, // STALE
    q2: { answered: true, isCorrect: true, timestamp: 3000, timesSeen: 4 },  // fresher
    q3: { answered: true, isCorrect: true, timestamp: 500, timesSeen: 1 }    // brand new key
  };

  // Deep snapshots taken BEFORE the call, so a merge that mutates its arguments is caught.
  const existingBefore = JSON.stringify(existing);
  const incomingBefore = JSON.stringify(incoming);

  const merged = mergeProgress(existing, incoming);

  // Hand-written expectation — q1 keeps the SERVER copy, q2 takes the CLIENT copy,
  // q3 is added, and nothing at all is dropped.
  assert.deepStrictEqual(merged, {
    q1: { answered: true, isCorrect: true, timestamp: 2000, timesSeen: 2 },
    q2: { answered: true, isCorrect: true, timestamp: 3000, timesSeen: 4 },
    q3: { answered: true, isCorrect: true, timestamp: 500, timesSeen: 1 }
  });
  ok('older incoming timestamp never overwrites a newer stored entry (q1 kept at ts=2000)');
  ok('newer incoming timestamp does overwrite the stored entry (q2 -> ts=3000)');
  ok('a key present only in the incoming payload is added (q3)');

  // The merge must not mutate its inputs — sync.js reuses `existingMaster` afterwards.
  assert.strictEqual(JSON.stringify(existing), existingBefore, 'mergeProgress must not mutate `existing`');
  assert.strictEqual(JSON.stringify(incoming), incomingBefore, 'mergeProgress must not mutate `incoming`');
  ok('inputs are not mutated (deep before/after comparison)');
}

{
  // Equal timestamps: the CURRENT code uses `>=`, so the incoming write wins.
  const merged = mergeProgress(
    { q1: { isCorrect: false, timestamp: 1000, tag: 'server' } },
    { q1: { isCorrect: true, timestamp: 1000, tag: 'client' } }
  );
  assert.strictEqual(merged.q1.tag, 'client', 'equal timestamps must favour the incoming write (>= semantics)');
  assert.strictEqual(merged.q1.isCorrect, true);
  ok('equal timestamps favour incoming (pins the current `>=` behaviour)');
}

{
  // Missing / null entries in the incoming payload are SKIPPED, never written —
  // a client that sends `{q1: null}` must not blank out a real stored attempt.
  const merged = mergeProgress(
    { q1: { isCorrect: true, timestamp: 5000 }, q2: { isCorrect: true, timestamp: 5000 } },
    { q1: null, q2: undefined, q3: null }
  );
  assert.deepStrictEqual(merged, {
    q1: { isCorrect: true, timestamp: 5000 },
    q2: { isCorrect: true, timestamp: 5000 }
  });
  ok('null/undefined incoming entries are skipped and never blank a stored entry');
  assert.ok(!('q3' in merged), 'a null-only key must not be created');
  ok('a key whose incoming value is null is not created');
}

{
  // Missing timestamps: 13 of the 406 live progress entries have NO `timestamp`
  // field (measured 2026-08-29). The code coerces a missing timestamp to 0, so an
  // incoming entry with any timestamp beats a stored one that has none, and an
  // incoming entry with none still wins over a stored one with none (0 >= 0).
  const noTsBoth = mergeProgress({ q1: { isCorrect: false, tag: 'server' } }, { q1: { isCorrect: true, tag: 'client' } });
  assert.strictEqual(noTsBoth.q1.tag, 'client', 'both missing timestamps -> 0 >= 0 -> incoming wins');
  ok('entries with no timestamp on either side resolve to incoming (0 >= 0)');

  const storedHasTs = mergeProgress({ q1: { timestamp: 9000, tag: 'server' } }, { q1: { tag: 'client' } });
  assert.strictEqual(storedHasTs.q1.tag, 'server', 'a timestamp-less incoming entry must not beat a timestamped stored one');
  ok('a timestamp-less incoming entry loses to a timestamped stored entry');
}

{
  // Absent / non-object arguments must degrade to an empty merge, not throw:
  // sync.js calls this with `existingMaster?.progress || {}` on a first-ever push.
  assert.deepStrictEqual(mergeProgress(null, null), {});
  assert.deepStrictEqual(mergeProgress(undefined, { q1: { timestamp: 1 } }), { q1: { timestamp: 1 } });
  assert.deepStrictEqual(mergeProgress({ q1: { timestamp: 1 } }, undefined), { q1: { timestamp: 1 } });
  ok('null/undefined arguments degrade to an empty merge instead of throwing');
}

// =========================================================================
// 2. mergeSrsState — newer lastReviewedAt wins.
// =========================================================================
console.log('\n2. mergeSrsState');
{
  // NOTE (CLAUDE.md mode 3): the live cards use camelCase `easeFactor` /
  // `lastReviewedAt` / `intervalDays` — verified against student_default_student
  // (392 cards, 2026-08-29). There is no `ease_factor` field anywhere in the data.
  const existing = {
    q1: { questionId: '', repetitions: 3, intervalDays: 6, easeFactor: 2.5, lastReviewedAt: 2000 },
    q2: { questionId: '', repetitions: 1, intervalDays: 1, easeFactor: 2.6, lastReviewedAt: 1000 }
  };
  const incoming = {
    q1: { questionId: '', repetitions: 1, intervalDays: 1, easeFactor: 1.96, lastReviewedAt: 1500 }, // STALE
    q2: { questionId: '', repetitions: 2, intervalDays: 3, easeFactor: 2.5, lastReviewedAt: 4000 },  // fresher
    q3: { questionId: '', repetitions: 0, intervalDays: 0, easeFactor: 2.5, lastReviewedAt: 10 }     // new
  };

  const existingBefore = JSON.stringify(existing);
  const incomingBefore = JSON.stringify(incoming);

  const merged = mergeSrsState(existing, incoming);

  assert.deepStrictEqual(merged, {
    q1: { questionId: '', repetitions: 3, intervalDays: 6, easeFactor: 2.5, lastReviewedAt: 2000 },
    q2: { questionId: '', repetitions: 2, intervalDays: 3, easeFactor: 2.5, lastReviewedAt: 4000 },
    q3: { questionId: '', repetitions: 0, intervalDays: 0, easeFactor: 2.5, lastReviewedAt: 10 }
  });
  ok('a stale card (older lastReviewedAt) never overwrites a newer scheduled card');
  ok('a fresher card replaces the stored one wholesale');
  ok('a card present only in the incoming payload is added');

  assert.strictEqual(JSON.stringify(existing), existingBefore, 'mergeSrsState must not mutate `existing`');
  assert.strictEqual(JSON.stringify(incoming), incomingBefore, 'mergeSrsState must not mutate `incoming`');
  ok('inputs are not mutated (deep before/after comparison)');
}

{
  const merged = mergeSrsState(
    { q1: { easeFactor: 2.5, lastReviewedAt: 777, tag: 'server' } },
    { q1: { easeFactor: 1.3, lastReviewedAt: 777, tag: 'client' } }
  );
  assert.strictEqual(merged.q1.tag, 'client', 'equal lastReviewedAt must favour the incoming card (>= semantics)');
  ok('equal lastReviewedAt favours incoming (pins the current `>=` behaviour)');
}

{
  const merged = mergeSrsState(
    { q1: { easeFactor: 2.5, lastReviewedAt: 500 }, q2: { easeFactor: 2.5, lastReviewedAt: 500 } },
    { q1: null, q2: undefined, q3: null }
  );
  assert.deepStrictEqual(merged, {
    q1: { easeFactor: 2.5, lastReviewedAt: 500 },
    q2: { easeFactor: 2.5, lastReviewedAt: 500 }
  });
  ok('null/undefined incoming cards are skipped and never blank a stored card');

  assert.deepStrictEqual(mergeSrsState(null, null), {});
  ok('null/undefined arguments degrade to an empty merge instead of throwing');
}

// =========================================================================
// 3. mergeSessions — per-field MAX wins for a day already stored.
// =========================================================================
console.log('\n3. mergeSessions');
{
  const existing = {
    '2026-08-25': { date: '2026-08-25', questionsAnswered: 117, correct: 96, totalTimeMs: 8087928 },
    '2026-08-26': { date: '2026-08-26', questionsAnswered: 104, correct: 86, totalTimeMs: 9235949 }
  };
  const incoming = {
    // A second device that saw fewer answers but MORE time on that day: each field
    // must take the max independently, so neither device's work is lost.
    '2026-08-25': { date: '2026-08-25', questionsAnswered: 90, correct: 99, totalTimeMs: 9000000 },
    '2026-08-27': { date: '2026-08-27', questionsAnswered: 98, correct: 85, totalTimeMs: 10937457 }
  };

  const existingBefore = JSON.stringify(existing);
  const incomingBefore = JSON.stringify(incoming);

  const merged = mergeSessions(existing, incoming);

  // Hand-computed: 25th takes max(117,90)=117, max(96,99)=99, max(8087928,9000000)=9000000.
  assert.deepStrictEqual(merged, {
    '2026-08-25': { date: '2026-08-25', questionsAnswered: 117, correct: 99, totalTimeMs: 9000000 },
    '2026-08-26': { date: '2026-08-26', questionsAnswered: 104, correct: 86, totalTimeMs: 9235949 },
    '2026-08-27': { date: '2026-08-27', questionsAnswered: 98, correct: 85, totalTimeMs: 10937457 }
  });
  ok('an existing day takes the per-field MAX of stored and incoming');
  ok('a day only the server knows about is preserved');
  ok('a day only the client knows about is added verbatim');

  assert.strictEqual(JSON.stringify(existing), existingBefore, 'mergeSessions must not mutate `existing`');
  assert.strictEqual(JSON.stringify(incoming), incomingBefore, 'mergeSessions must not mutate `incoming`');
  ok('inputs are not mutated (deep before/after comparison)');
}

{
  // An incoming day with questionsAnswered falsy (0 / missing) REPLACES the stored
  // record outright — this is what the current code does (`existing && sess.questionsAnswered`),
  // and it is pinned here precisely because it is the surprising branch.
  const merged = mergeSessions(
    { d: { date: 'd', questionsAnswered: 5, correct: 5, totalTimeMs: 1000 } },
    { d: { date: 'd', questionsAnswered: 0, correct: 0, totalTimeMs: 0 } }
  );
  assert.deepStrictEqual(merged, { d: { date: 'd', questionsAnswered: 0, correct: 0, totalTimeMs: 0 } });
  ok('an incoming day with questionsAnswered=0 replaces the stored day (pins current behaviour)');

  // The max branch only fills the four known fields — extra fields on the incoming
  // record are dropped when merging into an existing day. Pinned, not endorsed.
  const dropped = mergeSessions(
    { d: { date: 'd', questionsAnswered: 1, correct: 1, totalTimeMs: 1 } },
    { d: { date: 'd', questionsAnswered: 2, correct: 2, totalTimeMs: 2, extra: 'x' } }
  );
  assert.deepStrictEqual(dropped, { d: { date: 'd', questionsAnswered: 2, correct: 2, totalTimeMs: 2 } });
  ok('the max branch emits exactly {date, questionsAnswered, correct, totalTimeMs}');
}

{
  const merged = mergeSessions({ d: { date: 'd', questionsAnswered: 7 } }, { d: null, e: null });
  assert.deepStrictEqual(merged, { d: { date: 'd', questionsAnswered: 7 } });
  ok('null/undefined incoming days are skipped and never blank a stored day');

  assert.deepStrictEqual(mergeSessions(null, null), {});
  ok('null/undefined arguments degrade to an empty merge instead of throwing');
}

// =========================================================================
// 4. mergeExamHistory — dedupe by examId, sort by completedAt DESC, cap.
// =========================================================================
console.log('\n4. mergeExamHistory');
{
  const existing = [
    { examId: 'exam_a', completedAt: 1000, score: 'server_a' },
    { examId: 'exam_b', completedAt: 3000, score: 'server_b' }
  ];
  const incoming = [
    { examId: 'exam_a', completedAt: 1000, score: 'client_a' }, // duplicate examId
    { examId: 'exam_c', completedAt: 2000, score: 'client_c' }
  ];

  const existingBefore = JSON.stringify(existing);
  const incomingBefore = JSON.stringify(incoming);

  const merged = mergeExamHistory(existing, incoming);

  // Hand-written: 3 distinct examIds, incoming wins the exam_a collision, ordered
  // newest-first by completedAt (3000, 2000, 1000).
  assert.deepStrictEqual(merged, [
    { examId: 'exam_b', completedAt: 3000, score: 'server_b' },
    { examId: 'exam_c', completedAt: 2000, score: 'client_c' },
    { examId: 'exam_a', completedAt: 1000, score: 'client_a' }
  ]);
  ok('duplicate examIds collapse to one entry, incoming version winning');
  ok('result is sorted by completedAt descending (newest exam first)');
  ok('an exam only the server holds is never dropped');

  assert.strictEqual(JSON.stringify(existing), existingBefore, 'mergeExamHistory must not mutate `existing`');
  assert.strictEqual(JSON.stringify(incoming), incomingBefore, 'mergeExamHistory must not mutate `incoming`');
  ok('inputs are not mutated (deep before/after comparison)');
}

{
  // Entries with no examId cannot be deduped and are DROPPED (current behaviour).
  const merged = mergeExamHistory(
    [{ completedAt: 5000 }, null, { examId: 'ok', completedAt: 1 }],
    [{ examId: '', completedAt: 6000 }, undefined]
  );
  assert.deepStrictEqual(merged, [{ examId: 'ok', completedAt: 1 }]);
  ok('entries missing/blank examId, and null entries, are dropped on both sides');
}

{
  // Missing completedAt sorts as 0 — i.e. to the end.
  const merged = mergeExamHistory([{ examId: 'x' }], [{ examId: 'y', completedAt: 1 }]);
  assert.deepStrictEqual(merged.map(e => e.examId), ['y', 'x']);
  ok('an entry with no completedAt sorts last (coerced to 0)');
}

{
  // Cap: sync.js stores `.slice(0, 50)` into the master document. Build 60 exams
  // with strictly increasing completedAt and assert the 50 NEWEST survive, in order.
  const many = [];
  for (let i = 1; i <= 60; i++) many.push({ examId: `e${i}`, completedAt: i * 1000 });

  const capped = mergeExamHistory([], many, 50);
  assert.strictEqual(capped.length, 50, 'cap=50 must keep exactly 50 entries');
  assert.strictEqual(capped[0].examId, 'e60', 'the newest exam must be first');
  assert.strictEqual(capped[49].examId, 'e11', 'the 50th kept exam must be e11 (e10..e1 dropped)');
  ok('cap keeps the 50 newest exams (e60 first, e11 last), dropping e10..e1');

  const uncapped = mergeExamHistory([], many);
  assert.strictEqual(uncapped.length, 60, 'no cap argument means no truncation (the GET path)');
  ok('omitting the cap returns every exam (the GET /api/sync path relies on this)');

  assert.strictEqual(EXAM_HISTORY_CAP, 50, 'the master-document exam cap is 50');
  ok('EXAM_HISTORY_CAP === 50 matches the .slice(0, 50) sync.js has always applied');
}

{
  assert.deepStrictEqual(mergeExamHistory(null, null), []);
  assert.deepStrictEqual(mergeExamHistory(undefined, [{ examId: 'a', completedAt: 1 }]), [{ examId: 'a', completedAt: 1 }]);
  ok('null/undefined arguments degrade to an empty merge instead of throwing');
}

// =========================================================================
// 5. Regression fixture drawn from the REAL live document shape.
// =========================================================================
console.log('\n5. Live-shaped regression fixture');
{
  // Shapes copied by hand from student_default_student (measured 2026-08-29):
  // a progress entry WITH a timestamp, a progress entry WITHOUT one (13 such live),
  // a real SRS card, real session days, and a real examId.
  const storedProgress = {
    '15074829': { answered: true, selectedAnswer: 'A', isCorrect: true, timeSpentMs: 33659, timingReliable: true, isFlagged: false, timestamp: 1787702485906, timesSeen: 1, timesCorrect: 1, timesIncorrect: 0, accuracyPercent: 100 },
    '27754367': { answered: true, isCorrect: true, timesSeen: 1, timesCorrect: 1, timesIncorrect: 0, accuracyPercent: 100, attempts: [] }
  };
  // A v1 client that has never seen 27754367 pushes only its own single attempt.
  const clientProgress = {
    '15074829': { answered: true, selectedAnswer: 'B', isCorrect: false, timeSpentMs: 1000, timingReliable: true, isFlagged: false, timestamp: 1787702000000, timesSeen: 1, timesCorrect: 0, timesIncorrect: 1, accuracyPercent: 0 }
  };

  const merged = mergeProgress(storedProgress, clientProgress);
  assert.strictEqual(Object.keys(merged).length, 2, 'the untouched question must survive a partial client push');
  assert.strictEqual(merged['15074829'].selectedAnswer, 'A', 'the stale client attempt must not overwrite the newer stored one');
  assert.deepStrictEqual(merged['27754367'], storedProgress['27754367']);
  ok('a v1 client pushing a stale subset loses no stored question and overwrites nothing newer');

  const mergedSrs = mergeSrsState(
    { '15074829': { questionId: '', repetitions: 1, intervalDays: 1, easeFactor: 2.6, lastReviewedAt: 1787702485906, dueAt: 1787788885906, lastGrade: 5, history: [] } },
    {}
  );
  assert.strictEqual(Object.keys(mergedSrs).length, 1);
  assert.strictEqual(mergedSrs['15074829'].easeFactor, 2.6);
  ok('an empty client srsState push preserves every stored card');

  const mergedExams = mergeExamHistory(
    [{ examId: 'exam_sim_1', completedAt: 1787969612316 }, { examId: 'custom_test_1787933862100', completedAt: 1787933862100 }],
    [],
    50
  );
  assert.deepStrictEqual(mergedExams.map(e => e.examId), ['exam_sim_1', 'custom_test_1787933862100']);
  ok('an empty client examHistory push preserves every stored exam, newest first');
}

console.log(`\n✓ All ${checks} WI-07 merge-semantics pins passed.\n`);
