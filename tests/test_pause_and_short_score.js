/**
 * tests/test_pause_and_short_score.js — WI-35. Two new features.
 *
 * 1. PAUSE. The module timer is a wall-clock DEADLINE, not a countdown, so a pause
 *    cannot just stop a tick — the deadline would keep arriving while the student was
 *    away. Pausing banks the remaining seconds and DROPS the deadline; resuming mints
 *    a new one from the bank. However long they are gone costs them nothing.
 *
 * 2. SHORT-TEST SCALED SCORE. At least MIN_PER_SECTION (15) answered in EACH section,
 *    which makes MIN_SCORED_TEST_QUESTIONS (30) the arithmetic floor. Nothing is
 *    scored otherwise — not even a single section. A topic-filtered test is biased by
 *    construction, so a section score drawn from one would look official while
 *    measuring something far narrower than the section it names (CLAUDE.md mode 1).
 *    Below the gate the report still has accuracy, timing and topics, which are
 *    measurements rather than estimates.
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
  const qs = mk(29, 'Math', 'm');
  const r = PSAT_ENGINE.scoreShortTest(qs, answer(qs, 20));
  assert.strictEqual(r.isScored, false, '29 answered is below the 30-question threshold');
  assert.strictEqual(r.totalScore, null);
  assert.ok(/at least 30/.test(r.reason), 'and it says why');
}
ok('a test below 30 answered questions gets no scaled score');

{
  // The rule the user set: 15 in EACH section, so 30 is the floor. A single-subject
  // test gets no scaled number however long it is — a topic-filtered test is biased by
  // construction, and scaling it would look official while measuring something much
  // narrower than the section it names.
  const qs = mk(40, 'Math', 'm');
  const r = PSAT_ENGINE.scoreShortTest(qs, answer(qs, 30));
  assert.strictEqual(r.isScored, false,
    'forty Math questions still yield no scaled score — a section needs the OTHER section too');
  assert.strictEqual(r.mathScore, null, 'not even a section estimate is produced');
  assert.strictEqual(r.totalScore, null);
  assert.ok(/EACH/.test(r.reason), 'the reason states the per-section requirement');
  assert.ok(/Accuracy and topic breakdown/.test(r.reason),
    'and points at what IS measured, rather than just refusing');
}
ok('a single-subject test is never scaled, however long — bias by construction');

{
  const qs = mk(20, 'Math', 'm').concat(mk(14, 'Reading and Writing', 'r'));
  const r = PSAT_ENGINE.scoreShortTest(qs, answer(qs, 25));
  assert.strictEqual(r.isScored, false,
    '34 questions but Reading and Writing is one short of 15 — the per-section gate is not a total');
  assert.strictEqual(r.rwAttempted, 14);
  assert.strictEqual(r.mathAttempted, 20);
}
ok('34 questions still fails when one section is one question short');

{
  const mq = mk(15, 'Math', 'm');
  const rq = mk(15, 'Reading and Writing', 'r');
  const ans = Object.assign(answer(mq, 12), answer(rq, 9));
  const r = PSAT_ENGINE.scoreShortTest(mq.concat(rq), ans);
  assert.strictEqual(r.isScored, true, 'exactly 15 + 15 is the minimum scorable test');
  assert.strictEqual(r.totalAttempted, 30);
  assert.ok(typeof r.rwScore === 'number' && typeof r.mathScore === 'number');
  assert.strictEqual(r.totalScore, r.rwScore + r.mathScore,
    'the total is the two sections, not a re-derivation');
  assert.ok(r.totalRange[0] <= r.totalScore && r.totalScore <= r.totalRange[1],
    'and the score sits inside its own interval');
}
ok('exactly 15 + 15 scores, and the total is the sum of its sections');

{
  const mq = mk(20, 'Math', 'm');
  const rq = mk(20, 'Reading and Writing', 'r');
  const partial = Object.assign(
    Object.fromEntries(mq.map((q, i) => [q.id, { answered: i < 14, isCorrect: i < 10 }])),
    answer(rq, 15)
  );
  const r = PSAT_ENGINE.scoreShortTest(mq.concat(rq), partial);
  assert.strictEqual(r.mathAttempted, 14, 'unanswered questions are not counted as attempted');
  assert.strictEqual(r.isScored, false,
    'skipping down to 14 in a section withdraws the score — answered, not delivered, is what counts');
}
ok('skipped questions count as unanswered and can drop a test below the gate');

{
  const mq = mk(15, 'Math', 'm');
  const rq = mk(15, 'Reading and Writing', 'r');
  const r = PSAT_ENGINE.scoreShortTest(mq.concat(rq), Object.assign(answer(mq, 15), answer(rq, 15)));
  assert.strictEqual(r.isSingleTestEstimate, true, 'never confusable with the bank-wide score');
  assert.ok(/estimate/i.test(r.label) && /not comparable to an official score/i.test(r.disclosure),
    'a short-test number must always carry that it is an estimate, never presented as official');
  assert.ok(/not included in exam trends/i.test(r.disclosure),
    'and must say it stays out of full-exam trends');
}
ok('every short-test score is labelled an estimate and excluded from trends');

console.log('\n✓ All ' + n + ' pause and short-score checks passed.\n');

{
  const fs = require('fs');
  const text = fs.readFileSync(require('path').join(__dirname, '../data/questions_data.js'), 'utf8');
  const bank = JSON.parse(text.slice(text.indexOf('=') + 1, text.lastIndexOf(']') + 1));
  const selected = ['Reading and Writing', 'Math'].flatMap(section => bank.filter(q => q.test === section).slice(0, 15));
  const report = { examId: 'persisted-report', type: 'focused_custom_test', pauseCount: 2,
    totalPausedMs: 65000, moduleReports: [{ questions: selected.map(q => ({questionId:q.id, answered:true, isCorrect:true})) }] };
  report.shortTestEstimate = PSAT_ENGINE.summarizeExamReport(report, bank).shortTestEstimate;
  assert.strictEqual(report.shortTestEstimate.totalScore, 1440);
  const lean = JSON.parse(JSON.stringify(PSAT_ENGINE.toLeanReport(report)));
  const restored = PSAT_ENGINE.rehydrateReport(lean, bank);
  assert.strictEqual(restored.pauseCount, 2);
  assert.strictEqual(restored.totalPausedMs, 65000);
  assert.deepStrictEqual(restored.shortTestEstimate, report.shortTestEstimate);
  assert.ok(PSAT_ENGINE.summarizeExamReport(restored, bank).pauseText.includes('65.0 seconds away'));
  assert.strictEqual(PSAT_ENGINE.summarizeExamReport({type:'standard_psat89'}, bank).pauseText, '');
  assert.strictEqual(PSAT_ENGINE.summarizeExamReport({type:'standard_psat89'}, bank).shortTestEstimate, null);
  console.log('Real-bank report round-trip: 30/30 correct, 1440 estimate, 2 pauses, 65 seconds retained.');
}
