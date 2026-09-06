/**
 * tests/test_attempt.js — the ephemeral attempt lifecycle (js/engine/attempt.js).
 *
 * These tests exist because of PRODUCT_REVIEW_AND_IMPLEMENTATION_PLAN.md defects
 * SRS-01 / SRS-02 / SRS-03. SRS-03 is the reason they are written the way they are:
 * the existing browser specs dodged the bug by EMPTYING psat_progress before testing
 * a mature card, so the previously-answered case — the only case that reproduces
 * SRS-01 and SRS-02 — was never exercised. Every fixture here therefore seeds a
 * REALISTIC prior progress entry together with its overdue SRS card.
 *
 * Every expected value below is written by hand. Nothing calls the function under
 * test to build its own expectation (CLAUDE.md mode 4).
 */
const assert = require('assert');
const ATTEMPT = require('../js/engine/attempt.js');
const PSAT_ENGINE = require('../srs.js');

let checks = 0;
function check(label, fn) {
  fn();
  checks++;
  console.log('  ok ' + checks + ' — ' + label);
}

console.log('Testing ephemeral attempt lifecycle (SRS-01 / SRS-02 / SRS-03)...');

// ---------------------------------------------------------------------------
// Fixtures. Fixed clock: 2026-09-06T00:00:00.000Z expressed in ms, hand-chosen.
// ---------------------------------------------------------------------------
const DAY = 86400000;
const NOW = 1757116800000;
const QID = 'math_q_1042';

// A realistic prior entry: the student answered this question WRONG nine days ago,
// tagged the miss, and the tag is still open. Written out by hand in the exact shape
// buildProgressEntry produces.
function priorEntryFixture() {
  return {
    answered: true,
    selectedAnswer: 'B',
    isCorrect: false,
    timeSpentMs: 41000,
    timingReliable: true,
    timestamp: NOW - 9 * DAY,
    isFlagged: false,
    errorTag: 'careless_arithmetic',
    historicalErrorTags: [],
    timesSeen: 1,
    timesCorrect: 0,
    timesIncorrect: 1,
    accuracyPercent: 0,
    attempts: [
      { at: NOW - 9 * DAY, selectedAnswer: 'B', isCorrect: false, timeSpentMs: 41000, source: 'practice' }
    ]
  };
}

// Its SM-2 card, lapsed and now three days overdue.
function overdueCardFixture() {
  return {
    questionId: QID,
    repetitions: 0,
    intervalDays: 6,
    easeFactor: 2.16,
    lastReviewedAt: NOW - 9 * DAY,
    firstReviewedAt: NOW - 9 * DAY,
    totalReviews: 1,
    totalLapses: 1,
    avgResponseTimeMs: 41000,
    dueAt: NOW - 3 * DAY,
    lastGrade: 1,
    history: [{ reviewedAt: NOW - 9 * DAY, grade: 1, intervalDays: 6, responseTimeMs: 41000 }]
  };
}

// ---------------------------------------------------------------------------
// 1. SRS-01 — a previously answered question with an overdue card is a REVIEW,
//    and the review hides the prior answer.
// ---------------------------------------------------------------------------
const overdueMode = ATTEMPT.resolveAttemptMode(priorEntryFixture(), overdueCardFixture(), 'all', NOW);
check('SRS-01: answered question + 3-day-overdue card resolves to mode srs_review', () => {
  assert.strictEqual(overdueMode, 'srs_review',
    'SRS-01: a previously answered question whose card is overdue must be an srs_review attempt, not practice');
});

const reviewAttempt = ATTEMPT.startAttempt({
  questionId: QID,
  mode: overdueMode,
  progressEntry: priorEntryFixture(),
  srsCard: overdueCardFixture(),
  now: NOW
});

check('SRS-01: shouldHidePriorAnswer is true for an open review of an answered question', () => {
  assert.strictEqual(ATTEMPT.shouldHidePriorAnswer(reviewAttempt), true,
    'SRS-01: loadQuestion branched on the LIFETIME progress[q.id].answered, so the due card rendered as ' +
    'already-answered — old answer and rationale visible, option buttons with no click handler. ' +
    'shouldHidePriorAnswer must be true here so the page hides the prior answer and wires live controls.');
  assert.strictEqual(reviewAttempt.priorAnswered, true,
    'the attempt must still KNOW the question was answered before — history is preserved, not erased');
});

check('SRS-01: the attempt id is content-derived, matching the outbox att_<qid>_<ts> convention', () => {
  assert.strictEqual(reviewAttempt.attemptId, 'att_math_q_1042_1757116800000');
  assert.strictEqual(reviewAttempt.status, 'open');
  assert.strictEqual(reviewAttempt.gradedAt, null);
  assert.strictEqual(reviewAttempt.startedAt, NOW);
  assert.strictEqual(reviewAttempt.schemaVersion, 1);
  assert.strictEqual(reviewAttempt.priorTimesSeen, 1);
  assert.strictEqual(reviewAttempt.priorDueAt, NOW - 3 * DAY);
});

check('closeAttempt returns a NEW attempt and leaves the one it was given open', () => {
  // Self-contained on purpose: this must go red on its own assertion when closeAttempt
  // starts mutating its input, not as a knock-on error further down the file.
  const a = ATTEMPT.startAttempt({
    questionId: QID, mode: 'srs_review', progressEntry: priorEntryFixture(), srsCard: overdueCardFixture(), now: NOW
  });
  const closed = ATTEMPT.closeAttempt(a, { selectedAnswer: 'C', isCorrect: true, timeSpentMs: 22000, timingReliable: true }, NOW + 22000);
  assert.strictEqual(a.status, 'open', 'the attempt handed to closeAttempt must not be mutated');
  assert.strictEqual(a.gradedAt, null);
  assert.notStrictEqual(closed.attempt, a, 'closeAttempt must return a distinct object');
  assert.strictEqual(closed.attempt.status, 'graded');
});

// ---------------------------------------------------------------------------
// 2. resolveAttemptMode — every branch, with its precedence stated.
// ---------------------------------------------------------------------------
check('a question with no progress entry at all is first_seen', () => {
  assert.strictEqual(ATTEMPT.resolveAttemptMode(null, null, 'all', NOW), 'first_seen');
});

check('a flag-only entry ({answered:false, isFlagged:true}) is still first_seen', () => {
  // toggleFlagCurrentQuestion in js/pages/student.js really does create this shape.
  assert.strictEqual(ATTEMPT.resolveAttemptMode({ answered: false, isFlagged: true }, null, 'all', NOW), 'first_seen');
});

check('an unanswered question reached through the due filter is first_seen, not srs_review', () => {
  assert.strictEqual(ATTEMPT.resolveAttemptMode(null, null, 'due', NOW), 'first_seen');
});

check('answered + card due in 5 days + filter all is practice', () => {
  const future = overdueCardFixture();
  future.dueAt = NOW + 5 * DAY;
  assert.strictEqual(ATTEMPT.resolveAttemptMode(priorEntryFixture(), future, 'all', NOW), 'practice');
});

check('answered + card not due but reached through the due filter is srs_review', () => {
  const future = overdueCardFixture();
  future.dueAt = NOW + 5 * DAY;
  assert.strictEqual(ATTEMPT.resolveAttemptMode(priorEntryFixture(), future, 'due', NOW), 'srs_review');
});

check('dueAt exactly equal to now counts as due (matches applyFilters card.dueAt > now)', () => {
  const exact = overdueCardFixture();
  exact.dueAt = NOW;
  assert.strictEqual(ATTEMPT.resolveAttemptMode(priorEntryFixture(), exact, 'all', NOW), 'srs_review');
});

check('answered with no SRS card at all is practice', () => {
  assert.strictEqual(ATTEMPT.resolveAttemptMode(priorEntryFixture(), null, 'all', NOW), 'practice');
});

check('resolveAttemptMode throws rather than guessing when now is not a number', () => {
  assert.throws(() => ATTEMPT.resolveAttemptMode(priorEntryFixture(), overdueCardFixture(), 'all', undefined), TypeError);
});

// ---------------------------------------------------------------------------
// 3. A fresh, never-answered question: first_seen, and nothing is hidden.
// ---------------------------------------------------------------------------
const freshAttempt = ATTEMPT.startAttempt({
  questionId: 'ela_q_7',
  mode: ATTEMPT.resolveAttemptMode(null, null, 'all', NOW),
  progressEntry: null,
  srsCard: null,
  now: NOW
});

check('a fresh unanswered question yields first_seen and hides nothing', () => {
  assert.strictEqual(freshAttempt.mode, 'first_seen');
  assert.strictEqual(ATTEMPT.shouldHidePriorAnswer(freshAttempt), false,
    'there is no prior answer on a first sighting, so there is nothing to hide');
  assert.strictEqual(freshAttempt.priorAnswered, false);
  assert.strictEqual(freshAttempt.priorTimesSeen, null,
    'absent data is null, never an invented 0/1 (CLAUDE.md mode 1)');
  assert.strictEqual(freshAttempt.priorDueAt, null);
  assert.strictEqual(freshAttempt.attemptId, 'att_ela_q_7_1757116800000');
});

check('shouldHidePriorAnswer is false for a graded attempt (revisit shows the result)', () => {
  const graded = ATTEMPT.closeAttempt(reviewAttempt,
    { selectedAnswer: 'C', isCorrect: true, timeSpentMs: 22000, timingReliable: true }, NOW + 22000).attempt;
  assert.strictEqual(graded.status, 'graded');
  assert.strictEqual(ATTEMPT.shouldHidePriorAnswer(graded), false);
});

check('shouldHidePriorAnswer is false for a missing attempt', () => {
  assert.strictEqual(ATTEMPT.shouldHidePriorAnswer(null), false);
  assert.strictEqual(ATTEMPT.shouldHidePriorAnswer(undefined), false);
});

// ---------------------------------------------------------------------------
// 4. startAttempt input validation — a bad input fails loudly.
// ---------------------------------------------------------------------------
check('startAttempt throws on a missing questionId, an unknown mode, or a non-numeric now', () => {
  assert.throws(() => ATTEMPT.startAttempt({ mode: 'practice', now: NOW }), TypeError);
  assert.throws(() => ATTEMPT.startAttempt({ questionId: QID, mode: 'review', now: NOW }), TypeError);
  assert.throws(() => ATTEMPT.startAttempt({ questionId: QID, mode: 'practice', now: null }), TypeError);
});

// ---------------------------------------------------------------------------
// 5. canSubmitAttempt — the ONE guard, with distinct reasons.
// ---------------------------------------------------------------------------
const openGate = ATTEMPT.canSubmitAttempt(reviewAttempt, NOW + 1000);
const missingGate = ATTEMPT.canSubmitAttempt(null, NOW + 1000);
const gradedOnce = ATTEMPT.closeAttempt(reviewAttempt,
  { selectedAnswer: 'C', isCorrect: true, timeSpentMs: 22000, timingReliable: true }, NOW + 22000);
const gradedGate = ATTEMPT.canSubmitAttempt(gradedOnce.attempt, NOW + 23000);

check('canSubmitAttempt allows an open attempt and refuses a missing one and a graded one', () => {
  assert.strictEqual(openGate.allowed, true);
  assert.strictEqual(openGate.reason, '');
  assert.strictEqual(missingGate.allowed, false);
  assert.strictEqual(gradedGate.allowed, false);
  assert.ok(missingGate.reason.length > 0 && gradedGate.reason.length > 0, 'both refusals carry a reason');
  assert.notStrictEqual(missingGate.reason, gradedGate.reason,
    'the two refusals must be distinguishable in plain English, not one generic string');
  assert.ok(/already been graded/.test(gradedGate.reason), 'graded refusal names the real cause');
});

check('canSubmitAttempt refuses when now is not a real timestamp', () => {
  const r = ATTEMPT.canSubmitAttempt(reviewAttempt, undefined);
  assert.strictEqual(r.allowed, false);
  assert.notStrictEqual(r.reason, gradedGate.reason);
});

// ---------------------------------------------------------------------------
// 6. SRS-02 — the literal reproduction.
//    "Two clicks increased timesSeen from 1 to 3." Guarded, two clicks must move
//    it from 1 to 2. Both numbers are real output of PSAT_ENGINE.buildProgressEntry.
// ---------------------------------------------------------------------------
const GRADED_AT = NOW + 22000;

// --- guarded sequence: click, then click again 1.2 s later ------------------
const guardedPrior = priorEntryFixture();
let guardedEntry = guardedPrior;
let guardedWrites = 0;
let guardedAttempt = ATTEMPT.startAttempt({
  questionId: QID, mode: 'srs_review', progressEntry: guardedPrior, srsCard: overdueCardFixture(), now: NOW
});
[GRADED_AT, GRADED_AT + 1200].forEach(function (clickAt) {
  const gate = ATTEMPT.canSubmitAttempt(guardedAttempt, clickAt);
  if (!gate.allowed) return;                       // <- the single guard both paths use
  const closed = ATTEMPT.closeAttempt(guardedAttempt,
    { selectedAnswer: 'C', isCorrect: true, timeSpentMs: 22000, timingReliable: true }, clickAt);
  guardedAttempt = closed.attempt;
  guardedEntry = PSAT_ENGINE.buildProgressEntry(guardedEntry, ATTEMPT.toProgressAttemptInput(closed.event, 'practice'));
  guardedWrites++;
});

// --- unguarded sequence: the SRS-02 bug, buildProgressEntry called per click --
const unguardedPrior = priorEntryFixture();
const frozenInput = {
  selectedAnswer: 'C', isCorrect: true, timeSpentMs: 22000, timingReliable: true, at: GRADED_AT, source: 'practice'
};
let unguardedEntry = PSAT_ENGINE.buildProgressEntry(unguardedPrior, frozenInput);
unguardedEntry = PSAT_ENGINE.buildProgressEntry(unguardedEntry, frozenInput);

console.log('  SRS-02 reproduction — prior timesSeen = 1');
console.log('    guarded (canSubmitAttempt between the two clicks): timesSeen = ' + guardedEntry.timesSeen +
            ', buildProgressEntry calls = ' + guardedWrites);
console.log('    unguarded (the shipped bug, one write per click):  timesSeen = ' + unguardedEntry.timesSeen);

check('SRS-02: guarded double-click records exactly one attempt (timesSeen 1 -> 2)', () => {
  assert.strictEqual(guardedWrites, 1, 'SRS-02: the second click must not reach buildProgressEntry');
  assert.strictEqual(guardedEntry.timesSeen, 2,
    'SRS-02: two clicks on one attempt must move timesSeen from 1 to 2, not 1 to 3');
  assert.strictEqual(guardedEntry.timesCorrect, 1);
  assert.strictEqual(guardedEntry.timesIncorrect, 1, 'the original miss survives');
  assert.strictEqual(guardedEntry.attempts.length, 2, 'the new evidence is APPENDED to the old attempt');
  assert.strictEqual(guardedEntry.attempts[0].selectedAnswer, 'B', 'the nine-day-old wrong answer is still there');
  assert.strictEqual(guardedEntry.attempts[1].selectedAnswer, 'C');
  assert.strictEqual(guardedEntry.accuracyPercent, 50);
});

check('SRS-02: the unshielded double-write reproduces the reported timesSeen 1 -> 3', () => {
  assert.strictEqual(unguardedEntry.timesSeen, 3,
    'the review reported timesSeen going 1 -> 3 on two clicks; this is that path, unguarded');
});

check('SRS-02 repair keeps error-tag history: the open tag is resolved, not deleted', () => {
  assert.strictEqual(guardedEntry.errorTag, null, 'a correct answer clears the open tag');
  assert.strictEqual(guardedEntry.historicalErrorTags.length, 1);
  assert.strictEqual(guardedEntry.historicalErrorTags[0].tag, 'careless_arithmetic');
  assert.strictEqual(guardedEntry.historicalErrorTags[0].resolvedAt, GRADED_AT);
});

// ---------------------------------------------------------------------------
// 7. Missing / unreliable timing stays null, and grades conservatively.
// ---------------------------------------------------------------------------
const unreliableAttempt = ATTEMPT.startAttempt({
  questionId: QID, mode: 'srs_review', progressEntry: priorEntryFixture(), srsCard: overdueCardFixture(), now: NOW
});
const unreliableEvent = ATTEMPT.closeAttempt(unreliableAttempt,
  { selectedAnswer: 'C', isCorrect: true, timeSpentMs: 250, timingReliable: false }, NOW + 250).event;

check('unreliable timing records timeSpentMs null / timingReliable false — no invented default', () => {
  assert.strictEqual(unreliableEvent.timeSpentMs, null,
    'CLAUDE.md mode 1: never substitute a 30s/60s default for missing timing');
  assert.strictEqual(unreliableEvent.timingReliable, false);
  assert.strictEqual(unreliableEvent.isCorrect, true);
});

check('unreliable timing grades 3 (Hesitant) through PSAT_ENGINE.gradeAttempt, never 5', () => {
  assert.strictEqual(
    PSAT_ENGINE.gradeAttempt(unreliableEvent.isCorrect, unreliableEvent.timeSpentMs, unreliableEvent.timingReliable),
    3,
    'an invented 250ms would have earned grade 5, the BEST SM-2 grade, on an unmeasured answer');
});

check('a null timeSpentMs with timingReliable true is still null / false', () => {
  const a = ATTEMPT.startAttempt({ questionId: QID, mode: 'first_seen', progressEntry: null, srsCard: null, now: NOW });
  const e = ATTEMPT.closeAttempt(a, { selectedAnswer: '17', isCorrect: false, timeSpentMs: null, timingReliable: true }, NOW + 5000).event;
  assert.strictEqual(e.timeSpentMs, null);
  assert.strictEqual(e.timingReliable, false);
  assert.strictEqual(PSAT_ENGINE.gradeAttempt(e.isCorrect, e.timeSpentMs, e.timingReliable), 1, 'incorrect is grade 1');
});

check('real measured timing is passed through untouched and grades 5 at 22s', () => {
  assert.strictEqual(gradedOnce.event.timeSpentMs, 22000);
  assert.strictEqual(gradedOnce.event.timingReliable, true);
  assert.strictEqual(PSAT_ENGINE.gradeAttempt(true, 22000, true), 5);
});

// ---------------------------------------------------------------------------
// 8. Immutability: nothing mutates its inputs, and the event is frozen.
// ---------------------------------------------------------------------------
check('closeAttempt does not mutate the open attempt it was given', () => {
  assert.strictEqual(reviewAttempt.status, 'open', 'the original attempt object is untouched');
  assert.strictEqual(reviewAttempt.gradedAt, null);
  assert.strictEqual(gradedOnce.attempt.status, 'graded');
  assert.strictEqual(gradedOnce.attempt.gradedAt, NOW + 22000);
});

check('the emitted event is frozen and carries the full required field set', () => {
  assert.strictEqual(Object.isFrozen(gradedOnce.event), true);
  ['attemptId', 'questionId', 'mode', 'selectedAnswer', 'isCorrect', 'timeSpentMs',
   'timingReliable', 'startedAt', 'gradedAt', 'schemaVersion'].forEach(function (f) {
    assert.ok(Object.prototype.hasOwnProperty.call(gradedOnce.event, f), 'event must carry ' + f);
  });
  assert.strictEqual(gradedOnce.event.attemptId, 'att_math_q_1042_1757116800000');
  assert.strictEqual(gradedOnce.event.mode, 'srs_review');
  assert.strictEqual(gradedOnce.event.startedAt, NOW);
  assert.strictEqual(gradedOnce.event.gradedAt, NOW + 22000);
});

check('no call mutates the prior progress entry or the SRS card', () => {
  const p = priorEntryFixture();
  const c = overdueCardFixture();
  const a = ATTEMPT.startAttempt({ questionId: QID, mode: 'srs_review', progressEntry: p, srsCard: c, now: NOW });
  ATTEMPT.shouldHidePriorAnswer(a);
  ATTEMPT.canSubmitAttempt(a, NOW + 100);
  ATTEMPT.resolveAttemptMode(p, c, 'due', NOW);
  ATTEMPT.closeAttempt(a, { selectedAnswer: 'C', isCorrect: true, timeSpentMs: 22000, timingReliable: true }, GRADED_AT);
  assert.strictEqual(p.answered, true);
  assert.strictEqual(p.timesSeen, 1);
  assert.strictEqual(p.timesCorrect, 0);
  assert.strictEqual(p.selectedAnswer, 'B');
  assert.strictEqual(p.errorTag, 'careless_arithmetic');
  assert.strictEqual(p.historicalErrorTags.length, 0);
  assert.strictEqual(p.attempts.length, 1);
  assert.strictEqual(c.totalReviews, 1);
  assert.strictEqual(c.dueAt, NOW - 3 * DAY);
  assert.strictEqual(c.history.length, 1);
});

// ---------------------------------------------------------------------------
// 9. closeAttempt on an already-graded attempt throws rather than silently
//    recording a second answer.
// ---------------------------------------------------------------------------
check('a second closeAttempt on the same attempt throws', () => {
  assert.throws(
    () => ATTEMPT.closeAttempt(gradedOnce.attempt,
      { selectedAnswer: 'C', isCorrect: true, timeSpentMs: 22000, timingReliable: true }, NOW + 30000),
    /already been graded/);
});

// ---------------------------------------------------------------------------
// 10. The outbox op id and the attempt id are the same string, and a replay of
//     the same attempt de-duplicates instead of counting twice.
// ---------------------------------------------------------------------------
const fakeStore = (function () {
  const data = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
})();
const prodLoc = { pathname: '/index.html', search: '' };
const op1 = PSAT_ENGINE.enqueueOutboxOp(fakeStore, 'question_attempt', ATTEMPT.toOutboxPayload(gradedOnce.event), prodLoc);
const op2 = PSAT_ENGINE.enqueueOutboxOp(fakeStore, 'question_attempt', ATTEMPT.toOutboxPayload(gradedOnce.event), prodLoc);
const queued = PSAT_ENGINE.getOutboxOps(fakeStore, prodLoc);

check('the outbox op id equals the attempt id, and a replay enqueues nothing new', () => {
  assert.strictEqual(op1.id, 'att_math_q_1042_1757116800000');
  assert.strictEqual(op1.id, gradedOnce.event.attemptId);
  assert.strictEqual(op2.id, op1.id);
  assert.strictEqual(queued.length, 1, 'the same attempt replayed must not become two deliveries');
  assert.strictEqual(queued[0].payload.timestamp, NOW, 'the op timestamp is the attempt START, so the id is stable');
});

// ---------------------------------------------------------------------------
// 11. Exported surface.
// ---------------------------------------------------------------------------
check('the module exports the surface the page and the facade integrate against', () => {
  assert.strictEqual(ATTEMPT.ATTEMPT_SCHEMA_VERSION, 1);
  assert.deepStrictEqual(ATTEMPT.ATTEMPT_MODES, { PRACTICE: 'practice', SRS_REVIEW: 'srs_review', FIRST_SEEN: 'first_seen' });
  assert.deepStrictEqual(ATTEMPT.ATTEMPT_STATUS, { OPEN: 'open', GRADED: 'graded' });
  ['startAttempt', 'shouldHidePriorAnswer', 'canSubmitAttempt', 'closeAttempt', 'resolveAttemptMode',
   'toProgressAttemptInput', 'toOutboxPayload', 'deriveAttemptId'].forEach(function (fn) {
    assert.strictEqual(typeof ATTEMPT[fn], 'function', fn + ' must be exported');
  });
});

console.log('✓ All ' + checks + ' ephemeral attempt lifecycle checks passed (SRS-01, SRS-02, SRS-03 fixtures).');
