/**
 * tests/test_pause_and_short_score.js — WI-35. Two new features.
 *
 * 1. PAUSE. The module timer is a wall-clock DEADLINE, not a countdown, so a pause
 *    cannot just stop a tick — the deadline would keep arriving while the student was
 *    away. Pausing banks the remaining seconds and DROPS the deadline; resuming mints
 *    a new one from the bank. However long they are gone costs them nothing.
 *
 * 2. SHORT-TEST SCALED SCORE. Two independent gates: at least
 *    MIN_SCORED_TEST_QUESTIONS answered overall before any score, and the existing
 *    MIN_PER_SECTION before a SECTION gets a number. A composite therefore needs 15 in
 *    each section — 30 questions — and a 20-question single-subject test correctly
 *    yields one section estimate and no total. Reporting a total from one section
 *    would be inventing the other half (CLAUDE.md mode 1).
 *
 * Clock-free: every call takes `now`. Expected values hand-written.
 */
const assert = require('assert');
const PSAT_ENGINE = require('../srs.js');

let n = 0;
const ok = (name) => { n++; console.log('  ok ' + n + ' — ' + name); };

const T0 = 1788000000000;
const snap = (over) => Object.assign({
  phase: 'module', moduleDeadline: T0 + 35 * 60 * 1000,
  pausedAt: null, pausedRemainingSeconds: null, pauseCount: 0, totalPausedMs: 0
}, over || {});

// ---------------------------------------------------------------------------
// PAUSE
// ---------------------------------------------------------------------------
{
  const at = T0 + 10 * 60 * 1000;              // ten minutes in
  const r = PSAT_ENGINE.pauseExam(snap(), at);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.snapshot.phase, 'paused');
  assert.strictEqual(r.snapshot.pausedRemainingSeconds, 1500, '25 minutes banked, by hand');
  assert.strictEqual(r.snapshot.moduleDeadline, null,
    'the deadline must be REMOVED — a surviving deadline is how a paused exam expires while nobody is looking');
  assert.strictEqual(r.snapshot.pauseCount, 1);
}
ok('pausing banks the exact remaining time and drops the deadline');

{
  const at = T0 + 10 * 60 * 1000;
  const paused = PSAT_ENGINE.pauseExam(snap(), at).snapshot;
  const backMuchLater = at + 6 * 60 * 60 * 1000;      // away six hours
  const r = PSAT_ENGINE.resumeFromPause(paused, backMuchLater);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.snapshot.phase, 'module');
  assert.strictEqual(
    PSAT_ENGINE.computeRemainingSeconds(r.snapshot.moduleDeadline, backMuchLater), 1500,
    'six hours away must cost ZERO exam time — this is the whole feature');
  assert.strictEqual(r.snapshot.totalPausedMs, 6 * 60 * 60 * 1000, 'and the away time is recorded');
  assert.strictEqual(r.snapshot.pausedRemainingSeconds, null, 'the bank is cleared on resume');
}
ok('six hours paused costs no exam time, and the pause is recorded');

{
  // Repeated pauses accumulate honestly rather than resetting.
  let s = snap();
  s = PSAT_ENGINE.pauseExam(s, T0 + 60000).snapshot;
  s = PSAT_ENGINE.resumeFromPause(s, T0 + 60000 + 30000).snapshot;
  s = PSAT_ENGINE.pauseExam(s, T0 + 120000).snapshot;
  s = PSAT_ENGINE.resumeFromPause(s, T0 + 120000 + 45000).snapshot;
  assert.strictEqual(s.pauseCount, 2, 'both pauses counted');
  assert.strictEqual(s.totalPausedMs, 75000, '30s + 45s, hand-added');
}
ok('repeated pauses accumulate count and duration');

{
  const paused = PSAT_ENGINE.pauseExam(snap(), T0 + 60000).snapshot;
  assert.strictEqual(PSAT_ENGINE.pauseExam(paused, T0 + 70000).ok, false, 'cannot double-pause');
  assert.strictEqual(PSAT_ENGINE.pauseExam(snap({ phase: 'break' }), T0).ok, false, 'a break is not pausable');
  assert.strictEqual(PSAT_ENGINE.pauseExam(snap({ phase: 'review' }), T0).ok, false, 'a review screen is not pausable');
  assert.strictEqual(PSAT_ENGINE.pauseExam(null, T0).ok, false, 'nothing to pause');
  const expired = snap({ moduleDeadline: T0 - 1000 });
  assert.strictEqual(PSAT_ENGINE.pauseExam(expired, T0).ok, false,
    'pausing an already-expired module would hand back time the student no longer has');
}
ok('pause refuses every state where it would be meaningless or generous');

{
  assert.strictEqual(PSAT_ENGINE.resumeFromPause(snap(), T0).ok, false, 'cannot resume a running module');
  const noBank = snap({ phase: 'paused', pausedRemainingSeconds: null });
  const r = PSAT_ENGINE.resumeFromPause(noBank, T0);
  assert.strictEqual(r.ok, false,
    'with no banked remainder the time left is unknowable, and guessing would rob or gift the student');
}
ok('resume refuses rather than inventing a duration it cannot know');

// ---------------------------------------------------------------------------
// SHORT-TEST SCALED SCORE
// ---------------------------------------------------------------------------
const mk = (count, test, prefix) =>
  Array.from({ length: count }, (_, i) => ({ id: prefix + i, test: test }));
const answer = (qs, correctCount) =>
  Object.fromEntries(qs.map((q, i) => [q.id, { answered: true, isCorrect: i < correctCount }]));

{
  const qs = mk(19, 'Math', 'm');
  const r = PSAT_ENGINE.scoreShortTest(qs, answer(qs, 15));
  assert.strictEqual(r.isScored, false, '19 answered is below the 20-question gate');
  assert.strictEqual(r.totalScore, null);
  assert.ok(/at least 20/.test(r.reason), 'and it says why, in plain words');
}
ok('a test below 20 answered questions gets no score at all');

{
  const qs = mk(20, 'Math', 'm');
  const r = PSAT_ENGINE.scoreShortTest(qs, answer(qs, 15));
  assert.strictEqual(r.isScored, true, '20 answered clears the test gate');
  assert.ok(typeof r.mathScore === 'number', 'Math has 20 >= 15, so it gets a section estimate');
  assert.strictEqual(r.rwScore, null, 'Reading and Writing had none, so it gets nothing');
  assert.strictEqual(r.totalScore, null,
    'a composite needs 15 in EACH section; half measured and half invented is not a total');
  assert.ok(/one section/.test(r.reason), 'and the reason names that explicitly');
  assert.strictEqual(r.isSingleTestEstimate, true, 'never confusable with the bank-wide score');
}
ok('20 single-subject questions give one section estimate and NO composite');

{
  const qs = mk(15, 'Math', 'm').concat(mk(15, 'Reading and Writing', 'r'));
  const ans = Object.assign(answer(mk(15, 'Math', 'm'), 12), answer(mk(15, 'Reading and Writing', 'r'), 9));
  const r = PSAT_ENGINE.scoreShortTest(qs, ans);
  assert.strictEqual(r.isScored, true);
  assert.strictEqual(r.mathAttempted, 15);
  assert.strictEqual(r.rwAttempted, 15);
  assert.ok(typeof r.totalScore === 'number', 'both sections cleared the gate, so a composite is legitimate');
  assert.strictEqual(r.totalScore, r.rwScore + r.mathScore, 'the total is the two sections, not a re-derivation');
  assert.ok(r.totalRange[0] <= r.totalScore && r.totalScore <= r.totalRange[1],
    'and the score sits inside its own interval');
}
ok('15 + 15 gives both sections and a composite');

{
  const qs = mk(25, 'Math', 'm');
  const partial = Object.fromEntries(qs.map((q, i) => [q.id, { answered: i < 18, isCorrect: i < 10 }]));
  const r = PSAT_ENGINE.scoreShortTest(qs, partial);
  assert.strictEqual(r.mathAttempted, 18, 'unanswered questions are not counted as attempted');
  assert.strictEqual(r.isScored, false, '18 answered is still below the 20-question gate');
}
ok('skipped questions count as unanswered, not as wrong');

{
  const qs = mk(20, 'Math', 'm');
  const r = PSAT_ENGINE.scoreShortTest(qs, answer(qs, 20));
  assert.ok(/estimate/i.test(r.label) && /not comparable to an official score/i.test(r.disclosure),
    'a short-test number must always carry that it is an estimate, never presented as official');
  assert.ok(/not included in exam trends/i.test(r.disclosure),
    'and must say it stays out of full-exam trends');
}
ok('every short-test score is labelled an estimate and excluded from trends');

console.log('\n✓ All ' + n + ' pause and short-score checks passed.\n');
