#!/usr/bin/env node
/**
 * tests/integrity/test_merge_semantics.js — WI-22 CORRECTED merge semantics
 *
 * Companion to tests/integrity/test_merge_pins.js. That file pins the merge rules that
 * shipped (including the surprising ones, so a change to them is deliberate). THIS file
 * asserts the two rules WI-22 deliberately changed, and the invariants that must hold
 * afterwards:
 *
 *   DATA-02 (P0, FIXED)      — an incoming session day can never subtract from a stored
 *                              day. The old code replaced a stored day outright when the
 *                              incoming `questionsAnswered` was falsy; a stored day with
 *                              ten answers became zero, permanently, in Cosmos.
 *
 *   DATA-01 (P1, MITIGATED)  — per-question counters are now MONOTONIC across a merge:
 *                              timesSeen / timesCorrect / timesIncorrect take the
 *                              per-field maximum, so they can never go down.
 *                              This does NOT make DATA-01 return the true count — see
 *                              section 2, which asserts the REAL post-fix number (2, not
 *                              3) rather than pretending the finding is closed.
 *
 * Everything here is OFFLINE: hand-written fixtures, no Cosmos, no network, no clock
 * reads. Every expected value below was computed BY HAND, never by running the code and
 * copying its output (CLAUDE.md mode 4).
 *
 * Run: node tests/integrity/test_merge_semantics.js
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

/**
 * Calls `fn(a, b, ...rest)` and asserts that NEITHER argument was mutated, using deep
 * before/after snapshots. sync.js reuses `existingMaster` after merging, so a mutating
 * merge would corrupt the very document it is about to write back.
 */
function callPure(fn, name, a, b, ...rest) {
  const aBefore = JSON.stringify(a);
  const bBefore = JSON.stringify(b);
  const out = fn(a, b, ...rest);
  assert.strictEqual(JSON.stringify(a), aBefore, `${name} must not mutate its first argument`);
  assert.strictEqual(JSON.stringify(b), bBefore, `${name} must not mutate its second argument`);
  return out;
}

console.log('WI-22 corrected merge semantics (offline, hand-written fixtures)\n');

// =========================================================================
// 1. DATA-02 — an incoming zero day must never erase a stored day.
// =========================================================================
console.log('1. DATA-02 — mergeSessions can never subtract');
{
  // The literal reproduction from the product review: "a stored day with ten answers is
  // replaced by an incoming day with zero answers."
  const stored = {
    '2026-09-01': { date: '2026-09-01', questionsAnswered: 10, correct: 7, totalTimeMs: 640000 }
  };
  const incomingZero = {
    '2026-09-01': { date: '2026-09-01', questionsAnswered: 0, correct: 0, totalTimeMs: 0 }
  };

  const merged = callPure(mergeSessions, 'mergeSessions', stored, incomingZero);

  // Hand-written: max(10,0)=10, max(7,0)=7, max(640000,0)=640000 — the stored day survives
  // in full. Under the old code this assertion produced {questionsAnswered: 0, ...}.
  assert.deepStrictEqual(merged, {
    '2026-09-01': { date: '2026-09-01', questionsAnswered: 10, correct: 7, totalTimeMs: 640000 }
  }, 'DATA-02: a stored day with ten answers must survive an incoming day with zero');
  ok('the literal DATA-02 reproduction: 10 stored answers survive an incoming 0 (exact object asserted)');
}

{
  // Every other shape of "falsy questionsAnswered" that used to hit the destructive
  // branch: missing, null, undefined, NaN, empty string, false.
  const stored = { d: { date: 'd', questionsAnswered: 4, correct: 3, totalTimeMs: 9000 } };
  const survives = { d: { date: 'd', questionsAnswered: 4, correct: 3, totalTimeMs: 9000 } };

  [
    { date: 'd' },
    { date: 'd', questionsAnswered: null, correct: null, totalTimeMs: null },
    { date: 'd', questionsAnswered: undefined },
    { date: 'd', questionsAnswered: NaN, correct: 0, totalTimeMs: 0 },
    { date: 'd', questionsAnswered: '', correct: 0, totalTimeMs: 0 },
    { date: 'd', questionsAnswered: false, correct: 0, totalTimeMs: 0 }
  ].forEach((bad, i) => {
    const merged = mergeSessions(stored, { d: bad });
    assert.deepStrictEqual(merged, survives,
      `DATA-02 variant ${i}: a falsy incoming questionsAnswered must not subtract`);
  });
  ok('every falsy questionsAnswered shape (missing/null/undefined/NaN/""/false) leaves the stored day intact');
}

{
  // The other direction still works: a HIGHER incoming value wins, per field and
  // independently, so neither device can subtract from the other.
  const merged = callPure(mergeSessions, 'mergeSessions',
    { d: { date: 'd', questionsAnswered: 10, correct: 2, totalTimeMs: 100 } },
    { d: { date: 'd', questionsAnswered: 3, correct: 9, totalTimeMs: 50 } }
  );
  // Hand-written: max(10,3)=10, max(2,9)=9, max(100,50)=100.
  assert.deepStrictEqual(merged, {
    d: { date: 'd', questionsAnswered: 10, correct: 9, totalTimeMs: 100 }
  });
  ok('a higher incoming value still wins PER FIELD (10/9/100 from 10/2/100 and 3/9/50)');
}

{
  // A day the stored document has never seen is still added verbatim — that path was
  // always correct and must stay correct, including when its counts are zero.
  const merged = callPure(mergeSessions, 'mergeSessions',
    { '2026-09-01': { date: '2026-09-01', questionsAnswered: 5, correct: 5, totalTimeMs: 10 } },
    {
      '2026-09-02': { date: '2026-09-02', questionsAnswered: 8, correct: 6, totalTimeMs: 400000 },
      '2026-09-03': { date: '2026-09-03', questionsAnswered: 0, correct: 0, totalTimeMs: 0 }
    }
  );
  assert.deepStrictEqual(merged, {
    '2026-09-01': { date: '2026-09-01', questionsAnswered: 5, correct: 5, totalTimeMs: 10 },
    '2026-09-02': { date: '2026-09-02', questionsAnswered: 8, correct: 6, totalTimeMs: 400000 },
    '2026-09-03': { date: '2026-09-03', questionsAnswered: 0, correct: 0, totalTimeMs: 0 }
  });
  ok('a day only the incoming side knows about is still added as-is (including a genuine 0 day)');
}

{
  // Merging in BOTH directions must give the same totals — an order-dependent merge is a
  // race waiting to lose data.
  const a = { d: { date: 'd', questionsAnswered: 12, correct: 3, totalTimeMs: 700 } };
  const b = { d: { date: 'd', questionsAnswered: 0, correct: 11, totalTimeMs: 0 } };
  const ab = mergeSessions(a, b);
  const ba = mergeSessions(b, a);
  assert.deepStrictEqual(ab, { d: { date: 'd', questionsAnswered: 12, correct: 11, totalTimeMs: 700 } });
  assert.deepStrictEqual(ba, { d: { date: 'd', questionsAnswered: 12, correct: 11, totalTimeMs: 700 } });
  ok('mergeSessions is order-independent for a shared day (A<-B equals B<-A)');
}

// =========================================================================
// 2. DATA-01 — monotonic counters. Mitigated, NOT closed.
// =========================================================================
console.log('\n2. DATA-01 — mergeProgress counters are monotonic (mitigated, not closed)');
{
  // The literal reproduction from the review: a shared BASE attempt, then two devices
  // that each answer the SAME question independently, then a merge.
  //
  // Shapes follow js/engine/storage.js buildProgressEntry exactly.
  //
  //   t=1000  base attempt, WRONG   -> seen 1, correct 0, incorrect 1
  //   t=2000  device A answers RIGHT-> seen 2, correct 1, incorrect 1   (A's local state)
  //   t=3000  device B answers RIGHT-> seen 2, correct 1, incorrect 1   (B's local state)
  //
  // TRUE totals across the three real attempts: seen 3, correct 2, incorrect 1.
  const baseAttempt = { at: 1000, selectedAnswer: 'B', isCorrect: false, timeSpentMs: 21000, source: 'practice' };
  const deviceAAttempt = { at: 2000, selectedAnswer: 'C', isCorrect: true, timeSpentMs: 18000, source: 'practice' };
  const deviceBAttempt = { at: 3000, selectedAnswer: 'C', isCorrect: true, timeSpentMs: 12000, source: 'practice' };

  const deviceA = {
    q1: {
      answered: true, selectedAnswer: 'C', isCorrect: true, timeSpentMs: 18000, timingReliable: true,
      timestamp: 2000, isFlagged: false, errorTag: null, historicalErrorTags: [],
      timesSeen: 2, timesCorrect: 1, timesIncorrect: 1, accuracyPercent: 50,
      attempts: [baseAttempt, deviceAAttempt]
    }
  };
  const deviceB = {
    q1: {
      answered: true, selectedAnswer: 'C', isCorrect: true, timeSpentMs: 12000, timingReliable: true,
      timestamp: 3000, isFlagged: false, errorTag: null, historicalErrorTags: [],
      timesSeen: 2, timesCorrect: 1, timesIncorrect: 1, accuracyPercent: 50,
      attempts: [baseAttempt, deviceBAttempt]
    }
  };

  const merged = callPure(mergeProgress, 'mergeProgress', deviceA, deviceB);
  const q = merged.q1;

  // Content: B's write is newer (3000 >= 2000), so B wins the answer fields.
  assert.strictEqual(q.timestamp, 3000, 'the newer write still wins the answer content');
  assert.strictEqual(q.timeSpentMs, 12000, "the newer write's timing is kept");
  ok("the newer device's answer content wins (timestamp 3000, timeSpentMs 12000)");

  // *** The honest number. ***
  // max(2, 2) = 2. The TRUE count is 3. Two independent branches off a shared base are
  // indistinguishable without stable per-attempt identity, which is Milestone 3
  // (durable append-only attempt events), NOT this change.
  assert.strictEqual(q.timesSeen, 2,
    'DATA-01 is MITIGATED, NOT CLOSED: two independent branches off a shared base still ' +
    'merge to timesSeen 2, while the true count is 3. This assertion records the REAL ' +
    'post-fix value. Do not read it as a claim that DATA-01 is fixed — the fix is stable ' +
    'attempt ids + event derivation (Milestone 3). What WI-22 guarantees is only that the ' +
    'counter never goes DOWN.');
  assert.strictEqual(q.timesCorrect, 1,
    'likewise max(1,1)=1 where the true correct count is 2 — monotonic, not exact');
  assert.strictEqual(q.timesIncorrect, 1, 'max(1,1)=1, which here happens to be the true value');
  assert.strictEqual(q.accuracyPercent, 50, 'accuracyPercent is recomputed from the merged counters (1/2)');
  ok('DATA-01 reproduction returns timesSeen 2 (true 3) — recorded honestly as monotonic-not-exact');

  // The attempt LOG does union to all three distinct `at` values, so the evidence of the
  // third attempt is retained on disk even though the counter cannot see it. The counters
  // are deliberately NOT derived from this array — it is capped and lossy, and deriving
  // from it is how counters end up going DOWN.
  assert.deepStrictEqual(q.attempts, [baseAttempt, deviceAAttempt, deviceBAttempt],
    'the attempt log unions all three distinct attempts, oldest first');
  assert.strictEqual(q.attempts.length, 3);
  assert.notStrictEqual(q.timesSeen, q.attempts.length,
    'timesSeen must NOT be derived from the capped attempt log (here they legitimately differ)');
  ok('the attempt log preserves all 3 attempts while timesSeen stays 2 — counters are never derived from the capped log');
}

{
  // Counters never decrease, in EITHER merge direction. Stored is ahead on seen/correct,
  // incoming is ahead on incorrect and newer in time.
  const stored = {
    q1: { answered: true, isCorrect: true, timestamp: 1000, timesSeen: 9, timesCorrect: 7, timesIncorrect: 2, accuracyPercent: 78 }
  };
  const incoming = {
    q1: { answered: true, isCorrect: false, timestamp: 5000, timesSeen: 4, timesCorrect: 1, timesIncorrect: 3, accuracyPercent: 25 }
  };

  const forward = callPure(mergeProgress, 'mergeProgress', stored, incoming);
  const backward = callPure(mergeProgress, 'mergeProgress', incoming, stored);

  // Hand-written: seen max(9,4)=9, correct max(7,1)=7, incorrect max(2,3)=3,
  // accuracy = round(7/9*100) = round(77.77) = 78.
  [['stored<-incoming', forward], ['incoming<-stored', backward]].forEach(([label, m]) => {
    assert.strictEqual(m.q1.timesSeen, 9, `${label}: timesSeen must not decrease`);
    assert.strictEqual(m.q1.timesCorrect, 7, `${label}: timesCorrect must not decrease`);
    assert.strictEqual(m.q1.timesIncorrect, 3, `${label}: timesIncorrect must not decrease`);
    assert.strictEqual(m.q1.accuracyPercent, 78, `${label}: accuracyPercent recomputed from 7/9`);
  });
  ok('counters take the per-field max and never decrease, in both merge directions (9/7/3, 78%)');

  // Content still follows the newer timestamp in the direction where it is newer.
  assert.strictEqual(forward.q1.timestamp, 5000, 'newer incoming wins the content');
  assert.strictEqual(forward.q1.isCorrect, false);
  assert.strictEqual(backward.q1.timestamp, 5000, 'the newer record still wins when the sides swap');
  ok('the newer record wins the content regardless of which side it arrives on');

  // NOTE, stated rather than hidden: independent maxima can break the
  // timesSeen === timesCorrect + timesIncorrect invariant (9 !== 7 + 3). That is accepted
  // deliberately — an inconsistent counter that never shrinks is safer than a derived
  // counter that can. api/src/lib/datamodel.js round-trips it losslessly via its `$v`
  // override for derived fields.
  assert.notStrictEqual(forward.q1.timesSeen, forward.q1.timesCorrect + forward.q1.timesIncorrect);
  ok('the seen === correct + incorrect invariant may break under independent maxima (asserted, not hidden)');
}

{
  // A stale incoming record cannot pull a counter down even though it loses the content
  // race — this is the shape that actually reaches production when a device syncs late.
  const merged = mergeProgress(
    { q1: { answered: true, isCorrect: true, timestamp: 9000, timesSeen: 6, timesCorrect: 5, timesIncorrect: 1, accuracyPercent: 83 } },
    { q1: { answered: true, isCorrect: false, timestamp: 100, timesSeen: 1, timesCorrect: 0, timesIncorrect: 1, accuracyPercent: 0 } }
  );
  assert.strictEqual(merged.q1.timestamp, 9000, 'the stale write must not win the content');
  assert.strictEqual(merged.q1.timesSeen, 6);
  assert.strictEqual(merged.q1.timesCorrect, 5);
  assert.strictEqual(merged.q1.timesIncorrect, 1);
  assert.strictEqual(merged.q1.accuracyPercent, 83, 'round(5/6*100) = round(83.33) = 83');
  ok('a stale incoming record loses the content race AND cannot lower any counter');
}

{
  // A key only the incoming side holds is added as-is, untouched — no counters invented,
  // no attempts array conjured.
  const incomingOnly = { q9: { answered: true, isCorrect: true, timestamp: 42 } };
  const merged = callPure(mergeProgress, 'mergeProgress', { q1: { timestamp: 1 } }, incomingOnly);
  assert.deepStrictEqual(merged.q9, { answered: true, isCorrect: true, timestamp: 42 });
  assert.ok(!('timesSeen' in merged.q9), 'a brand-new key must not gain invented counters');
  assert.ok(!('attempts' in merged.q9), 'a brand-new key must not gain an invented attempts array');
  ok('a question only the incoming side knows about is added verbatim, with nothing invented');
}

{
  // Legacy entries that predate the counters must not gain invented ones (CLAUDE.md
  // mode 1: never fabricate a number). 13 of the 406 live progress entries carry no
  // timestamp, and older generations carry no counters at all.
  const merged = mergeProgress(
    { q1: { answered: true, isCorrect: true, timestamp: 1000 } },
    { q1: { answered: true, isCorrect: false, timestamp: 2000 } }
  );
  assert.deepStrictEqual(merged.q1, { answered: true, isCorrect: false, timestamp: 2000 },
    'neither side carried a counter, so none may be created');
  ok('when neither side has counters, none are invented (legacy entries stay legacy)');

  // But when ONE side has them, the other side's implied value (answered -> 1) is used as
  // the floor, matching js/engine/sync.js. Stored is legacy-but-answered-correctly
  // (implied seen 1 / correct 1 / incorrect 0); incoming carries 3/2/1 and is newer.
  const oneSided = mergeProgress(
    { q1: { answered: true, isCorrect: true, timestamp: 1000 } },
    { q1: { answered: true, isCorrect: true, timestamp: 2000, timesSeen: 3, timesCorrect: 2, timesIncorrect: 1, accuracyPercent: 67 } }
  );
  // Hand-written: seen max(1,3)=3, correct max(1,2)=2, incorrect max(0,1)=1,
  // accuracy = round(2/3*100) = round(66.67) = 67.
  assert.strictEqual(oneSided.q1.timesSeen, 3);
  assert.strictEqual(oneSided.q1.timesCorrect, 2);
  assert.strictEqual(oneSided.q1.timesIncorrect, 1);
  assert.strictEqual(oneSided.q1.accuracyPercent, 67);
  ok("a legacy side's implied counts (answered -> 1) act as a floor when the other side has real counters");

  // And the floor genuinely protects: a legacy stored answer must not be erased to 0 by
  // an incoming record that claims zero.
  const floored = mergeProgress(
    { q1: { answered: true, isCorrect: true, timestamp: 1000 } },
    { q1: { answered: true, isCorrect: true, timestamp: 2000, timesSeen: 0, timesCorrect: 0, timesIncorrect: 0 } }
  );
  assert.strictEqual(floored.q1.timesSeen, 1, 'a legacy answered entry implies at least one sighting');
  assert.strictEqual(floored.q1.timesCorrect, 1, 'a legacy answered+correct entry implies at least one correct');
  assert.strictEqual(floored.q1.accuracyPercent, 100);
  ok('an incoming zero counter cannot erase a legacy answered entry (implied floor of 1)');
}

// =========================================================================
// 3. mergeProgress — attempts union, error tags, flags.
// =========================================================================
console.log('\n3. mergeProgress — attempts / historicalErrorTags / isFlagged');
{
  // The client cap is 3: js/engine/storage.js buildProgressEntry ends with
  // `attempts: attempts.slice(-3)`, and js/engine/sync.js's client merge uses the same
  // `.slice(-3)`. Read from the source, not guessed, and not changed here.
  const a1 = { at: 100, selectedAnswer: 'A', isCorrect: false, timeSpentMs: 1000, source: 'practice' };
  const a2 = { at: 200, selectedAnswer: 'B', isCorrect: false, timeSpentMs: 2000, source: 'practice' };
  const a3 = { at: 300, selectedAnswer: 'C', isCorrect: true, timeSpentMs: 3000, source: 'exam' };
  const a4 = { at: 400, selectedAnswer: 'D', isCorrect: true, timeSpentMs: 4000, source: 'practice' };
  const a5 = { at: 500, selectedAnswer: 'A', isCorrect: true, timeSpentMs: 5000, source: 'drill' };

  const merged = callPure(mergeProgress, 'mergeProgress',
    { q1: { timestamp: 300, attempts: [a1, a3, a5] } },
    { q1: { timestamp: 400, attempts: [a1, a2, a4] } }
  );
  // Hand-written: union of `at` = {100,200,300,400,500}; sorted oldest-first; the newest 3
  // survive the cap, so a1(100) and a2(200) are dropped.
  assert.deepStrictEqual(merged.q1.attempts, [a3, a4, a5],
    'attempts union dedupes by `at`, sorts oldest-first, and keeps the newest 3');
  ok('attempts union dedupes by `at` (a1 appears on both sides, once in the result) and respects the cap of 3');

  // A duplicate `at` collapses to ONE entry, so a re-push can never inflate the log.
  const dup = mergeProgress(
    { q1: { timestamp: 1, attempts: [a1, a2] } },
    { q1: { timestamp: 1, attempts: [a1, a2] } }
  );
  assert.deepStrictEqual(dup.q1.attempts, [a1, a2], 're-pushing the identical log must be a no-op');
  ok('re-pushing an identical attempt log is idempotent (no duplicate `at` entries)');

  // Only one side has a log -> that log survives intact.
  const oneSide = mergeProgress({ q1: { timestamp: 1, attempts: [a1] } }, { q1: { timestamp: 2 } });
  assert.deepStrictEqual(oneSide.q1.attempts, [a1], "the stored log survives a payload that omits it");
  ok('a stored attempts log survives an incoming record that has none');

  // Neither side has one -> the field is not invented.
  const none = mergeProgress({ q1: { timestamp: 1 } }, { q1: { timestamp: 2 } });
  assert.ok(!('attempts' in none.q1), 'an attempts array must not be conjured from nothing');
  ok('no attempts array is invented when neither side has one');
}

{
  // historicalErrorTags: union, deduplicated by tag, newer record first.
  const merged = callPure(mergeProgress, 'mergeProgress',
    { q1: { timestamp: 1, historicalErrorTags: [{ tag: 'careless', resolvedAt: 100 }, { tag: 'concept', resolvedAt: 200 }] } },
    { q1: { timestamp: 2, historicalErrorTags: [{ tag: 'careless', resolvedAt: 999 }, { tag: 'timing', resolvedAt: 300 }] } }
  );
  assert.deepStrictEqual(merged.q1.historicalErrorTags, [
    { tag: 'careless', resolvedAt: 999 },
    { tag: 'timing', resolvedAt: 300 },
    { tag: 'concept', resolvedAt: 200 }
  ], 'union by tag: careless appears once (newer copy), concept survives, timing is added');
  ok('historicalErrorTags unions both sides and dedupes by tag (3 tags from 2+2)');

  // The stored side's tag history must survive a newer write that omits it — this is the
  // exact shape that used to be lost to whole-entry replacement.
  const kept = mergeProgress(
    { q1: { timestamp: 1, historicalErrorTags: [{ tag: 'concept', resolvedAt: 5 }] } },
    { q1: { timestamp: 9999 } }
  );
  assert.deepStrictEqual(kept.q1.historicalErrorTags, [{ tag: 'concept', resolvedAt: 5 }]);
  ok('a newer write that omits historicalErrorTags no longer discards the stored history');

  const none = mergeProgress({ q1: { timestamp: 1 } }, { q1: { timestamp: 2 } });
  assert.ok(!('historicalErrorTags' in none.q1), 'the array must not be invented');
  ok('no historicalErrorTags array is invented when neither side has one');
}

{
  // isFlagged: true if EITHER side flagged it — a flag raised on one device is not
  // cleared by a sync from another.
  assert.strictEqual(mergeProgress({ q1: { timestamp: 1, isFlagged: true } }, { q1: { timestamp: 2, isFlagged: false } }).q1.isFlagged, true);
  assert.strictEqual(mergeProgress({ q1: { timestamp: 2, isFlagged: false } }, { q1: { timestamp: 1, isFlagged: true } }).q1.isFlagged, true);
  assert.strictEqual(mergeProgress({ q1: { timestamp: 1, isFlagged: false } }, { q1: { timestamp: 2, isFlagged: false } }).q1.isFlagged, false);
  ok('isFlagged is true when either side has it, and stays false when neither does');

  const none = mergeProgress({ q1: { timestamp: 1 } }, { q1: { timestamp: 2 } });
  assert.ok(!('isFlagged' in none.q1), 'isFlagged must not be invented onto a record that never had it');
  ok('isFlagged is not invented when neither side carries the field');
}

// =========================================================================
// 4. Degenerate inputs — every exported function, every empty shape.
// =========================================================================
console.log('\n4. Null / undefined / empty inputs on every exported function');
{
  // The very first push for a student has no stored document at all: sync.js calls these
  // with `existingMaster?.progress` on a document that does not exist yet.
  const emptyish = [null, undefined, {}];

  emptyish.forEach(a => emptyish.forEach(b => {
    assert.deepStrictEqual(mergeProgress(a, b), {}, `mergeProgress(${a}, ${b}) must be {}`);
    assert.deepStrictEqual(mergeSrsState(a, b), {}, `mergeSrsState(${a}, ${b}) must be {}`);
    assert.deepStrictEqual(mergeSessions(a, b), {}, `mergeSessions(${a}, ${b}) must be {}`);
  }));
  ok('mergeProgress / mergeSrsState / mergeSessions return {} for all 9 null/undefined/empty combinations');

  [null, undefined, []].forEach(a => [null, undefined, []].forEach(b => {
    assert.deepStrictEqual(mergeExamHistory(a, b), [], 'mergeExamHistory must return [] for empty inputs');
    assert.deepStrictEqual(mergeExamHistory(a, b, EXAM_HISTORY_CAP), [], 'and with a cap too');
  }));
  ok('mergeExamHistory returns [] for all 9 null/undefined/empty combinations, capped or not');

  // Non-object junk must degrade, not throw.
  [0, '', false, 42, 'x', true].forEach(junk => {
    assert.deepStrictEqual(mergeProgress(junk, junk), {}, 'non-object arguments degrade to {}');
    assert.deepStrictEqual(mergeSrsState(junk, junk), {}, 'non-object arguments degrade to {}');
    assert.deepStrictEqual(mergeSessions(junk, junk), {}, 'non-object arguments degrade to {}');
    assert.deepStrictEqual(mergeExamHistory(junk, junk), [], 'non-array arguments degrade to []');
  });
  ok('non-object / non-array arguments degrade to an empty merge instead of throwing');

  // One side populated, the other absent: the populated side must come through whole.
  const p = { q1: { answered: true, timestamp: 7, timesSeen: 3, timesCorrect: 2, timesIncorrect: 1, accuracyPercent: 67 } };
  assert.deepStrictEqual(mergeProgress(p, null), p, 'a null incoming payload must not touch stored progress');
  assert.deepStrictEqual(mergeProgress(null, p), p, 'a null stored map must accept the incoming payload whole');
  ok('a populated side survives a null/absent counterpart unchanged, in both positions');

  // A null entry for a key that EXISTS must not blank it — the delta-push safety property.
  const notBlanked = mergeProgress(p, { q1: null });
  assert.deepStrictEqual(notBlanked, p, 'an explicit null entry must never blank a stored question');
  ok('an explicit `{q1: null}` incoming entry cannot blank a stored question');

  const daysNotBlanked = mergeSessions({ d: { date: 'd', questionsAnswered: 9 } }, { d: null, e: undefined });
  assert.deepStrictEqual(daysNotBlanked, { d: { date: 'd', questionsAnswered: 9 } });
  ok('an explicit null/undefined incoming day cannot blank a stored day, and creates no key');
}

// =========================================================================
// 5. Purity — no argument is mutated by any exported function.
// =========================================================================
console.log('\n5. Purity — neither argument is mutated');
{
  // Nested structures, because a shallow-copy bug shows up in the arrays first.
  const storedProgress = {
    q1: {
      answered: true, selectedAnswer: 'A', isCorrect: true, timestamp: 1000, isFlagged: false,
      timesSeen: 2, timesCorrect: 2, timesIncorrect: 0, accuracyPercent: 100,
      attempts: [{ at: 100, isCorrect: true }, { at: 900, isCorrect: true }],
      historicalErrorTags: [{ tag: 'careless', resolvedAt: 900 }]
    }
  };
  const incomingProgress = {
    q1: {
      answered: true, selectedAnswer: 'B', isCorrect: false, timestamp: 2000, isFlagged: true,
      timesSeen: 1, timesCorrect: 0, timesIncorrect: 1, accuracyPercent: 0,
      attempts: [{ at: 2000, isCorrect: false }],
      historicalErrorTags: [{ tag: 'timing', resolvedAt: 1500 }]
    }
  };

  const out = callPure(mergeProgress, 'mergeProgress', storedProgress, incomingProgress);

  // Hand-written result: incoming wins content (2000 > 1000); seen max(2,1)=2,
  // correct max(2,0)=2, incorrect max(0,1)=1, accuracy round(2/2*100)=100;
  // attempts union {100, 900, 2000} = 3 entries, exactly at the cap; tags unioned;
  // isFlagged true because incoming had it.
  assert.deepStrictEqual(out.q1, {
    answered: true, selectedAnswer: 'B', isCorrect: false, timestamp: 2000, isFlagged: true,
    timesSeen: 2, timesCorrect: 2, timesIncorrect: 1, accuracyPercent: 100,
    attempts: [{ at: 100, isCorrect: true }, { at: 900, isCorrect: true }, { at: 2000, isCorrect: false }],
    historicalErrorTags: [{ tag: 'timing', resolvedAt: 1500 }, { tag: 'careless', resolvedAt: 900 }]
  }, 'the full hand-computed merged entry');
  ok('a nested real-shaped merge produces the exact hand-computed entry without mutating either input');

  // The merged output must not ALIAS either input's nested arrays, or a later mutation of
  // the result would silently edit the document sync.js is about to write back.
  assert.notStrictEqual(out.q1, incomingProgress.q1, 'the merged entry must be a copy, not the incoming object');
  assert.notStrictEqual(out.q1.attempts, storedProgress.q1.attempts, 'the merged attempts array must be new');
  assert.notStrictEqual(out.q1.attempts, incomingProgress.q1.attempts, 'the merged attempts array must be new');
  assert.notStrictEqual(out.q1.historicalErrorTags, storedProgress.q1.historicalErrorTags, 'the merged tag array must be new');
  ok('the merged entry and its arrays are fresh objects, never aliases of an argument');

  // The other three functions, same purity check with realistic fixtures.
  const srsA = { q1: { questionId: '', repetitions: 3, intervalDays: 6, easeFactor: 2.5, lastReviewedAt: 2000, history: [{ reviewedAt: 2000, grade: 5 }] } };
  const srsB = { q1: { questionId: '', repetitions: 4, intervalDays: 15, easeFactor: 2.6, lastReviewedAt: 4000, history: [{ reviewedAt: 4000, grade: 4 }] } };
  const srsOut = callPure(mergeSrsState, 'mergeSrsState', srsA, srsB);
  assert.strictEqual(srsOut.q1.lastReviewedAt, 4000, 'the newer card wins wholesale (unchanged rule)');
  ok('mergeSrsState still replaces the card wholesale on a newer lastReviewedAt, without mutating inputs');

  const sessA = { '2026-09-01': { date: '2026-09-01', questionsAnswered: 3, correct: 2, totalTimeMs: 100 } };
  const sessB = { '2026-09-01': { date: '2026-09-01', questionsAnswered: 0, correct: 0, totalTimeMs: 0 } };
  callPure(mergeSessions, 'mergeSessions', sessA, sessB);
  ok('mergeSessions does not mutate either argument on the corrected zero path');

  const examA = [{ examId: 'e1', completedAt: 1000, report: { sections: [{ raw: 12 }] } }];
  const examB = [{ examId: 'e2', completedAt: 2000, report: { sections: [{ raw: 15 }] } }];
  const examOut = callPure(mergeExamHistory, 'mergeExamHistory', examA, examB, EXAM_HISTORY_CAP);
  assert.deepStrictEqual(examOut.map(e => e.examId), ['e2', 'e1']);
  ok('mergeExamHistory does not mutate either argument (nested report objects included)');
}

console.log(`\n✓ All ${checks} WI-22 corrected-merge-semantics checks passed.`);
console.log('  NOTE: DATA-01 is MITIGATED (counters are monotonic), NOT closed —');
console.log('        section 2 asserts the real post-fix value of 2 where the true count is 3.\n');
