/**
 * tests/test_exam_state.js — WI-22 / Milestone 1: the exam lifecycle state machine.
 *
 * Covers js/engine/exam_state.js, one section per numbered requirement of the work
 * item plus one section per reproduced defect (EX-01..EX-04), each named in its
 * assertion messages.
 *
 * CLAUDE.md mode 4 rules honoured here:
 *   - every expected value is a hand-written literal. No expectation is produced by
 *     calling the function under test (the ceil arithmetic, the byte-count bound,
 *     the migrated answer map and the lock sets were all worked out on paper);
 *   - nothing is monkeypatched for time: every function under test takes `now` as
 *     an explicit parameter, so each scenario just passes the instant it means;
 *   - the snapshot-size section builds a 98-question exam out of the REAL
 *     data/questions_data.js bundle and prints the measured byte count.
 *
 * Run: node tests/test_exam_state.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ES = require('../js/engine/exam_state.js');

let sectionCount = 0;
function section(title) {
  sectionCount++;
  console.log(`\n--- ${sectionCount}. ${title} ---`);
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

/** A fixed instant. Every deadline below is expressed relative to it. */
const T0 = 1750000000000;
const MIN = 60000;

// ---------------------------------------------------------------------------
// Fixtures. Small, hand-written, and deliberately fat: the question objects
// carry text/options/rationale so the leanness test has something to catch.
// ---------------------------------------------------------------------------
function fatQuestion(id) {
  return {
    id: id,
    test: 'Math',
    domain: 'Algebra',
    skill: 'Linear equations in one variable',
    difficulty: 'Medium',
    type: 'multiple_choice',
    question_text: 'THIS_IS_QUESTION_TEXT_' + id + ' ' + 'x'.repeat(200),
    options: [
      { key: 'A', text: 'THIS_IS_OPTION_TEXT_A ' + 'y'.repeat(60) },
      { key: 'B', text: 'THIS_IS_OPTION_TEXT_B ' + 'y'.repeat(60) },
      { key: 'C', text: 'THIS_IS_OPTION_TEXT_C ' + 'y'.repeat(60) },
      { key: 'D', text: 'THIS_IS_OPTION_TEXT_D ' + 'y'.repeat(60) }
    ],
    correct_answer: 'B',
    rationale: 'THIS_IS_RATIONALE_TEXT ' + 'z'.repeat(400),
    has_image: false
  };
}

const Q = {};
['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].forEach(function (id) { Q[id] = fatQuestion(id); });
const QUESTION_MAP = Q;

function twoModuleExam() {
  return {
    id: 'exam_fixture_1',
    title: 'Fixture Exam',
    type: 'standard_psat89',
    isAdaptive: false,
    totalQuestions: 6,
    totalTimeMinutes: 64,
    breakMinutes: 10,
    createdAt: T0 - 5 * MIN,
    modules: [
      { id: 'rw_m1', section: 'Reading and Writing', moduleNumber: 1, name: 'RW — Module 1', questionsCount: 3, timeLimitSeconds: 1920, questions: [Q.q1, Q.q2, Q.q3] },
      { id: 'rw_m2', section: 'Reading and Writing', moduleNumber: 2, name: 'RW — Module 2', questionsCount: 3, timeLimitSeconds: 1920, questions: [Q.q4, Q.q5, Q.q6] }
    ]
  };
}

// ===========================================================================
section('Requirement 2 — computeRemainingSeconds is the one deadline computation');
// ===========================================================================
// Hand-computed. Ceil, so the value is 0 if and only if `now` reached the deadline.
assert.strictEqual(ES.computeRemainingSeconds(T0 + 90000, T0), 90, '90 s of headroom reads as 90');
assert.strictEqual(ES.computeRemainingSeconds(T0 + 1, T0), 1, '1 ms left still reads as 1 s, never 0');
assert.strictEqual(ES.computeRemainingSeconds(T0 + 1000, T0), 1, 'exactly 1000 ms left reads as 1 s');
assert.strictEqual(ES.computeRemainingSeconds(T0 + 1001, T0), 2, '1001 ms left rounds up to 2 s');
assert.strictEqual(ES.computeRemainingSeconds(T0, T0), 0, 'at the deadline the answer is 0');
assert.strictEqual(ES.computeRemainingSeconds(T0 - 5000, T0), 0, 'past the deadline it clamps at 0, never negative');
ok('remaining seconds clamp at 0 and never go negative');

assert.strictEqual(ES.computeRemainingSeconds(null, T0), 0, 'a missing deadline yields 0');
assert.strictEqual(ES.computeRemainingSeconds(undefined, T0), 0, 'an undefined deadline yields 0');
assert.strictEqual(ES.computeRemainingSeconds(NaN, T0), 0, 'a NaN deadline yields 0');
assert.strictEqual(ES.computeRemainingSeconds('1750000090000', T0), 0, 'a string deadline is not a number and yields 0');
assert.strictEqual(ES.computeRemainingSeconds(T0 + 90000, NaN), 0, 'a NaN clock yields 0');
ok('a missing/NaN deadline returns 0 rather than throwing or inventing time');

// A missing deadline is REPORTED on resume, not swallowed.
const noDeadlineSnap = ES.buildExamSnapshot({
  exam: twoModuleExam(),
  phase: ES.EXAM_PHASES.MODULE,
  currentModuleIndex: 0,
  moduleDeadline: null,
  answers: { q1: 'A' },
  now: T0
});
const noDeadlineResume = ES.resumeExamSnapshot(noDeadlineSnap, QUESTION_MAP, T0 + MIN);
assert.strictEqual(noDeadlineResume.ok, true, 'a snapshot with no deadline still resumes');
assert.strictEqual(noDeadlineResume.state.remainingSeconds, 0, 'no deadline means no time can be shown');
assert.ok(
  noDeadlineResume.warnings.some(function (w) { return w.indexOf('no recorded module deadline') !== -1; }),
  'the missing deadline is reported in warnings, not silently treated as 0'
);
assert.strictEqual(noDeadlineResume.state.answers.q1, 'A', 'the answer survives a missing deadline');
ok('a missing deadline is reported in warnings and the answers are kept');

// ===========================================================================
section('Requirement 6 — the snapshot is lean (question IDs only)');
// ===========================================================================
const fatSnapshot = ES.buildExamSnapshot({
  exam: twoModuleExam(),
  phase: ES.EXAM_PHASES.MODULE,
  currentModuleIndex: 0,
  currentQuestionIndex: 1,
  moduleDeadline: T0 + 20 * MIN,
  answers: { q1: 'A', q2: 'C' },
  times: { q1: 41000, q2: 13000 },
  markedForReview: { q2: true },
  now: T0
});
const fatJson = JSON.stringify(fatSnapshot);
assert.strictEqual(fatJson.indexOf('THIS_IS_QUESTION_TEXT_'), -1, 'no question text may reach the snapshot');
assert.strictEqual(fatJson.indexOf('THIS_IS_OPTION_TEXT_'), -1, 'no option text may reach the snapshot');
assert.strictEqual(fatJson.indexOf('THIS_IS_RATIONALE_TEXT'), -1, 'no rationale may reach the snapshot');
assert.deepStrictEqual(fatSnapshot.examMeta.modules[0].questionIds, ['q1', 'q2', 'q3'], 'modules store IDs, in order');
assert.strictEqual(fatSnapshot.examMeta.modules[0].questions, undefined, 'no rehydrated question array is stored');
ok('question text, option text and rationales never enter the snapshot');

// --- the real-data measurement: a 98-question adaptive exam -----------------
const bundlePath = path.join(__dirname, '..', 'data', 'questions_data.js');
const bundleSrc = fs.readFileSync(bundlePath, 'utf8');
const ALL_QUESTIONS = JSON.parse(bundleSrc.slice(bundleSrc.indexOf('=') + 1, bundleSrc.lastIndexOf(']') + 1));
assert.ok(ALL_QUESTIONS.length > 3000, 'the real question bundle loaded');

const rw = ALL_QUESTIONS.filter(function (q) { return q.test === 'Reading and Writing'; });
const math = ALL_QUESTIONS.filter(function (q) { return q.test === 'Math'; });
assert.ok(rw.length >= 108 && math.length >= 88, 'enough real questions for a full adaptive form');

const bigExam = {
  id: 'exam_' + T0,
  title: 'Full-Length PSAT 8/9 Practice Exam',
  type: 'standard_psat89',
  isAdaptive: true,
  routingTracks: { rw: 'Baseline', math: 'Baseline' },
  totalQuestions: 98,
  totalTimeMinutes: 134,
  breakMinutes: 10,
  createdAt: T0,
  adaptivePools: {
    rwM2Hard: rw.slice(54, 81),
    rwM2Easy: rw.slice(81, 108),
    mathM2Hard: math.slice(44, 66),
    mathM2Easy: math.slice(66, 88)
  },
  modules: [
    { id: 'rw_m1', section: 'Reading and Writing', moduleNumber: 1, name: 'Reading and Writing — Module 1', questionsCount: 27, timeLimitSeconds: 1920, questions: rw.slice(0, 27) },
    { id: 'rw_m2', section: 'Reading and Writing', moduleNumber: 2, name: 'Reading and Writing — Module 2', questionsCount: 27, timeLimitSeconds: 1920, questions: rw.slice(27, 54) },
    { id: 'math_m1', section: 'Math', moduleNumber: 1, name: 'Math — Module 1', questionsCount: 22, timeLimitSeconds: 2100, questions: math.slice(0, 22) },
    { id: 'math_m2', section: 'Math', moduleNumber: 2, name: 'Math — Module 2', questionsCount: 22, timeLimitSeconds: 2100, questions: math.slice(22, 44) }
  ]
};
const bigQuestions = bigExam.modules.reduce(function (acc, m) { return acc.concat(m.questions); }, []);
assert.strictEqual(bigQuestions.length, 98, 'the realistic exam really is 98 questions');

const bigAnswers = {};
const bigTimes = {};
const bigMarks = {};
bigQuestions.forEach(function (q, idx) {
  bigAnswers[q.id] = (q.type === 'free_response') ? '13.75' : ['A', 'B', 'C', 'D'][idx % 4];
  bigTimes[q.id] = 41000 + idx;
  if (idx % 10 === 0) bigMarks[q.id] = true;
});

const bigSnapshot = ES.buildExamSnapshot({
  exam: bigExam,
  phase: ES.EXAM_PHASES.MODULE,
  currentModuleIndex: 3,
  currentQuestionIndex: 21,
  moduleDeadline: T0 + 2100000,
  submittedModules: [0, 1, 2],
  submittedAt: { 0: T0 + 1920000, 1: T0 + 3840000, 2: T0 + 6000000 },
  answers: bigAnswers,
  times: bigTimes,
  markedForReview: bigMarks,
  viewMode: 'card',
  blueprintVersion: 'psat89-2026.1',
  isHighYield: false,
  now: T0 + 7000000
});
const bigBytes = Buffer.byteLength(JSON.stringify(bigSnapshot), 'utf8');
console.log(`  measured: a 98-question, fully-answered adaptive snapshot is ${bigBytes} bytes (${(bigBytes / 1024).toFixed(1)} KB)`);
assert.ok(bigBytes < 20480, `EX/lean: a 98-question snapshot must stay under 20 KB; measured ${bigBytes} bytes`);
assert.strictEqual(Object.keys(bigSnapshot.answers).length, 98, 'all 98 answers are in the snapshot');
ok('the realistic 98-question snapshot is under 20 KB with every answer in it');

// ===========================================================================
section('Requirement 3 / EX-03 — canAcceptAnswer is the answer-writing guard');
// ===========================================================================
function liveState(over) {
  const base = {
    phase: ES.EXAM_PHASES.MODULE,
    currentModuleIndex: 1,
    moduleDeadline: T0 + 10 * MIN,
    submittedModules: [0],
    moduleExpired: false
  };
  return Object.assign(base, over || {});
}

const allowIt = ES.canAcceptAnswer(liveState(), 1, T0);
assert.strictEqual(allowIt.allowed, true, 'an in-time, unsubmitted, current module accepts answers');
assert.strictEqual(allowIt.code, 'ok', 'the allowed code is "ok"');
ok('the normal case is allowed');

const expiredGuard = ES.canAcceptAnswer(liveState(), 1, T0 + 10 * MIN + 1);
assert.strictEqual(expiredGuard.allowed, false, 'EX-03: after the deadline the answer handler must refuse the write');
assert.strictEqual(expiredGuard.code, 'expired', 'EX-03: the refusal code is "expired"');
assert.ok(expiredGuard.reason.indexOf('Time is up') !== -1, 'EX-03: the expiry reason is plain English for the student');
assert.ok(expiredGuard.reason.indexOf('saved') !== -1, 'EX-03: the expiry message says the existing answers are kept');
ok('EX-03: an expired module refuses new answers, and says the saved ones are kept');

const submittedGuard = ES.canAcceptAnswer(liveState({ currentModuleIndex: 0 }), 0, T0);
assert.strictEqual(submittedGuard.allowed, false, 'a submitted module refuses answers');
assert.strictEqual(submittedGuard.code, 'submitted', 'the refusal code is "submitted"');
assert.ok(submittedGuard.reason.indexOf('already submitted') !== -1, 'the submitted reason is plain English');
ok('a submitted module refuses answers');

const breakGuard = ES.canAcceptAnswer(liveState({ phase: ES.EXAM_PHASES.BREAK }), 1, T0);
assert.strictEqual(breakGuard.allowed, false, 'the break phase refuses answers');
assert.strictEqual(breakGuard.code, 'wrong_phase', 'the break refusal code is "wrong_phase"');
assert.ok(breakGuard.reason.indexOf('break') !== -1, 'the break reason mentions the break');

const reviewGuard = ES.canAcceptAnswer(liveState({ phase: ES.EXAM_PHASES.REVIEW }), 1, T0);
assert.strictEqual(reviewGuard.allowed, false, 'the review phase refuses answers');
assert.strictEqual(reviewGuard.code, 'wrong_phase', 'the review refusal code is "wrong_phase"');

const doneGuard = ES.canAcceptAnswer(liveState({ phase: ES.EXAM_PHASES.COMPLETED_PENDING_SAVE }), 1, T0);
assert.strictEqual(doneGuard.allowed, false, 'a finished exam refuses answers');
assert.strictEqual(doneGuard.code, 'wrong_phase', 'the finished refusal code is "wrong_phase"');
assert.notStrictEqual(breakGuard.reason, reviewGuard.reason, 'each phase gets its own message');
assert.notStrictEqual(breakGuard.reason, doneGuard.reason, 'each phase gets its own message');
ok('every non-module phase refuses answers with its own plain-English message');

const wrongModule = ES.canAcceptAnswer(liveState(), 2, T0);
assert.strictEqual(wrongModule.allowed, false, 'a different module index refuses answers');
assert.strictEqual(wrongModule.code, 'wrong_module', 'the refusal code is "wrong_module"');

const noState = ES.canAcceptAnswer(null, 0, T0);
assert.strictEqual(noState.allowed, false, 'no state refuses answers');
assert.strictEqual(noState.code, 'no_state', 'the refusal code is "no_state"');
ok('a wrong module index and a missing state are both refused, with distinct codes');

// ===========================================================================
section('EX-01 — an expired module NEVER destroys the saved answers');
// ===========================================================================
const ex01Snapshot = ES.buildExamSnapshot({
  exam: twoModuleExam(),
  phase: ES.EXAM_PHASES.MODULE,
  currentModuleIndex: 0,
  currentQuestionIndex: 2,
  moduleDeadline: T0 + 32 * MIN,
  answers: { q1: 'B', q3: '7/2' },
  times: { q1: 55000, q3: 91000 },
  markedForReview: { q3: true },
  now: T0
});

// Reload one hour later: the module deadline passed 28 minutes ago. The old app
// called clearActiveExamState() here and the two answers below were deleted.
const ex01 = ES.resumeExamSnapshot(ex01Snapshot, QUESTION_MAP, T0 + 60 * MIN);
assert.strictEqual(ex01.ok, true, 'EX-01: an expired snapshot must still resume — never "discard it"');
assert.strictEqual(ex01.state.answers.q1, 'B', 'EX-01: the answer to q1 survives module expiry');
assert.strictEqual(ex01.state.answers.q3, '7/2', 'EX-01: the grid-in answer to q3 survives module expiry');
assert.strictEqual(ex01.state.times.q3, 91000, 'EX-01: the recorded time survives module expiry');
assert.strictEqual(ex01.state.markedForReview.q3, true, 'EX-01: the mark-for-review survives module expiry');
assert.strictEqual(ex01.state.moduleExpired, true, 'EX-01: the expired module is reported as expired');
assert.strictEqual(ex01.state.moduleLocked, true, 'EX-01: the expired module is locked, not deleted');
assert.strictEqual(ex01.state.remainingSeconds, 0, 'EX-01: the expired module has 0 seconds left');
assert.strictEqual(ex01.state.continuation, 'open_module_review_locked',
  'EX-01: expiry states a continuation path (locked review) instead of clearing');
ok('EX-01: expiry locks the module and keeps every answer, time and mark');

// The functions in this module are pure: the stored snapshot is untouched.
assert.strictEqual(ex01Snapshot.answers.q1, 'B', 'EX-01: resuming does not mutate the stored snapshot');
assert.strictEqual(Object.keys(ex01Snapshot.answers).length, 2, 'EX-01: the stored snapshot still holds both answers');
ok('EX-01: resume is pure — the stored snapshot is not mutated');

// Missing questions used to clear the snapshot too. They must not.
const partialBank = { q1: Q.q1, q2: Q.q2 }; // q3..q6 absent from this device's bank
const ex01b = ES.resumeExamSnapshot(ex01Snapshot, partialBank, T0 + MIN);
assert.strictEqual(ex01b.ok, true, 'EX-01: a snapshot with unloadable questions still resumes');
assert.strictEqual(ex01b.state.answers.q3, '7/2', 'EX-01: answers survive even when their question is missing from the bank');
assert.strictEqual(ex01b.state.integrity.complete, false, 'EX-01: the incomplete rehydration is reported');
assert.deepStrictEqual(ex01b.state.integrity.missingQuestionIds, ['q3', 'q4', 'q5', 'q6'],
  'EX-01: exactly the four missing IDs are named');
assert.strictEqual(ex01b.state.continuation, 'repair_required', 'EX-01: the continuation path is repair, not deletion');
ok('EX-01: missing questions are reported, and the answers are still kept');

// ===========================================================================
section('EX-03 — resume recomputes the remaining seconds (the timer used to read 00:00)');
// ===========================================================================
// Deadline is T0 + 32 min; we reload at T0 + 12 min, so 20 minutes = 1200 s remain.
const ex03Snapshot = ES.buildExamSnapshot({
  exam: twoModuleExam(),
  phase: ES.EXAM_PHASES.MODULE,
  currentModuleIndex: 0,
  currentQuestionIndex: 1,
  moduleDeadline: T0 + 32 * MIN,
  answers: { q1: 'A' },
  now: T0
});
const ex03 = ES.resumeExamSnapshot(ex03Snapshot, QUESTION_MAP, T0 + 12 * MIN);
assert.strictEqual(ex03.ok, true, 'EX-03: a mid-module snapshot resumes');
assert.strictEqual(ex03.state.remainingSeconds, 1200, 'EX-03: the resumed timer reads 1200 s, not 0');
assert.strictEqual(ex03.state.moduleExpired, false, 'EX-03: a module with time left is not expired');
assert.strictEqual(ex03.state.moduleLocked, false, 'EX-03: a module with time left is not locked');
assert.strictEqual(ex03.state.continuation, 'resume_module', 'EX-03: the student is returned to the module');
assert.strictEqual(ES.canAcceptAnswer(ex03.state, 0, T0 + 12 * MIN).allowed, true,
  'EX-03: with time left, answers are still accepted');
ok('EX-03: the resumed timer shows the real remaining seconds and answering still works');

// Same snapshot, resumed after expiry: the review screen must be read-only.
const ex03late = ES.resumeExamSnapshot(ex03Snapshot, QUESTION_MAP, T0 + 40 * MIN);
assert.strictEqual(ex03late.state.moduleExpired, true, 'EX-03: resume after the deadline sets moduleExpired');
const ex03Guard = ES.canAcceptAnswer(ex03late.state, 0, T0 + 40 * MIN);
assert.strictEqual(ex03Guard.allowed, false, 'EX-03: the review screen may not save a new answer after expiry');
assert.strictEqual(ex03Guard.code, 'expired', 'EX-03: the refusal is specifically expiry');
assert.strictEqual(ex03late.state.answers.q1, 'A', 'EX-03: the answer written before expiry is still there');
ok('EX-03: after expiry the resumed state refuses edits but keeps the work');

// ===========================================================================
section('Requirement 4 / EX-04 — the break has an absolute deadline and locks submissions');
// ===========================================================================
// The student submits RW M2 at T0 + 64 min and takes the 10-minute break.
const beforeBreak = ES.buildExamSnapshot({
  exam: twoModuleExam(),
  phase: ES.EXAM_PHASES.MODULE,
  currentModuleIndex: 1,
  currentQuestionIndex: 2,
  moduleDeadline: T0 + 64 * MIN,
  submittedModules: [0],
  answers: { q1: 'B', q4: 'C', q5: 'D' },
  now: T0 + 60 * MIN
});
const submitted = ES.markModuleSubmitted(beforeBreak, 1, T0 + 64 * MIN);
assert.deepStrictEqual(submitted.submittedModules, [0, 1], 'both finished modules are recorded as submitted');
assert.strictEqual(submitted.submittedAt[1], T0 + 64 * MIN, 'the submission time is recorded as given');
assert.strictEqual(submitted.answers.q4, 'C', 'submitting a module keeps its answers');
assert.strictEqual(beforeBreak.submittedModules.length, 1, 'markModuleSubmitted does not mutate its input');

const resubmitted = ES.markModuleSubmitted(submitted, 1, T0 + 65 * MIN);
assert.deepStrictEqual(resubmitted.submittedModules, [0, 1], 'submitting the same module twice adds nothing');
assert.strictEqual(resubmitted.submittedAt[1], T0 + 64 * MIN, 'the first submission time is not overwritten');
ok('markModuleSubmitted is additive, idempotent and non-destructive');

const onBreak = ES.enterBreak(submitted, 600, T0 + 64 * MIN);
assert.strictEqual(onBreak.phase, 'break', 'entering the break sets the break phase');
assert.strictEqual(onBreak.breakDeadline, T0 + 74 * MIN, 'the break stores an ABSOLUTE deadline (64 min + 10 min)');
assert.strictEqual(onBreak.breakDurationSeconds, 600, 'the nominal break length is recorded');
assert.strictEqual(typeof onBreak.breakDeadline, 'number', 'the break deadline is an instant, not a countdown');
ok('the break is persisted as an absolute wall-clock deadline');

// Reload 4 minutes into the break: 6 minutes = 360 s of break remain.
const ex04 = ES.resumeExamSnapshot(onBreak, QUESTION_MAP, T0 + 68 * MIN);
assert.strictEqual(ex04.ok, true, 'EX-04: a break snapshot resumes');
assert.strictEqual(ex04.state.phase, 'break', 'EX-04: a reload during the break resumes as a break, not as a module');
assert.strictEqual(ex04.state.breakRemainingSeconds, 360, 'EX-04: the break resumes with 360 s left, not a fresh 600');
assert.strictEqual(ex04.state.continuation, 'resume_break', 'EX-04: the continuation path is the break itself');
assert.deepStrictEqual(ex04.state.submittedModules, [0, 1], 'EX-04: the submitted modules survive the reload');
assert.strictEqual(ES.isModuleLocked(ex04.state, 1, T0 + 68 * MIN), true,
  'EX-04: the already-submitted RW M2 must NOT reopen as editable after a reload');
const ex04Guard = ES.canAcceptAnswer(ex04.state, 1, T0 + 68 * MIN);
assert.strictEqual(ex04Guard.allowed, false, 'EX-04: the submitted module refuses new answers after the reload');
assert.strictEqual(ex04Guard.code, 'submitted', 'EX-04: the refusal names the submission, not the clock');
assert.strictEqual(ex04.state.answers.q4, 'C', 'EX-04: the submitted module\'s answers are still there');
ok('EX-04: the break resumes as a break with the right remaining time, and the submitted module stays locked');

// Once the break deadline passes, the continuation is the next module.
const afterBreak = ES.resumeExamSnapshot(onBreak, QUESTION_MAP, T0 + 80 * MIN);
assert.strictEqual(afterBreak.state.breakRemainingSeconds, 0, 'EX-04: an elapsed break has 0 seconds left');
assert.strictEqual(afterBreak.state.continuation, 'start_next_module', 'EX-04: an elapsed break points at the next module');
ok('EX-04: an elapsed break resumes pointing at the next module');

// An unusable break length is reported, not invented.
const badBreak = ES.enterBreak(submitted, null, T0 + 64 * MIN);
assert.strictEqual(badBreak.breakDeadline, null, 'an invalid break length yields no invented deadline');
const badBreakResume = ES.resumeExamSnapshot(badBreak, QUESTION_MAP, T0 + 65 * MIN);
assert.ok(
  badBreakResume.warnings.some(function (w) { return w.indexOf('no recorded end time') !== -1; }),
  'a break with no end time is reported in warnings'
);
ok('an invalid break length produces null plus a warning, never a made-up duration');

// ===========================================================================
section('Requirement 5 — a submitted module can never be reopened');
// ===========================================================================
const lockState = {
  currentModuleIndex: 2,
  submittedModules: [0, 1],
  moduleDeadline: T0 + 30 * MIN,
  moduleExpired: false
};
assert.strictEqual(ES.isModuleLocked(lockState, 0, T0), true, 'submitted module 0 is locked');
assert.strictEqual(ES.isModuleLocked(lockState, 1, T0), true, 'submitted module 1 is locked');
assert.strictEqual(ES.isModuleLocked(lockState, 2, T0), false, 'the current, in-time module is open');
assert.strictEqual(ES.isModuleLocked(lockState, 3, T0), false, 'a module not started yet is not locked');
assert.strictEqual(ES.isModuleLocked(lockState, 2, T0 + 31 * MIN), true, 'the current module locks once its deadline passes');
// A module behind the current one is locked even if the submission list lost it.
assert.strictEqual(ES.isModuleLocked({ currentModuleIndex: 2, submittedModules: [] }, 1, T0), true,
  'a module the student has moved past is locked even with an empty submission list');
ok('locks cover submitted modules, passed modules and the expired current module');

// ===========================================================================
section('Requirement 7 / EX-02 — the completed report stays recoverable until history is written');
// ===========================================================================
const leanReport = {
  examId: 'exam_fixture_1',
  title: 'Fixture Exam',
  type: 'standard_psat89',
  completedAt: T0 + 90 * MIN,
  totalQuestions: 6,
  totalCorrect: 4,
  scores: { totalScaled: 1010 },
  moduleReports: [{ id: 'rw_m1', questions: [{ questionId: 'q1', userAnswer: 'B', isCorrect: true, answered: true, timeSpentMs: 55000 }] }]
};

const pending = ES.buildPendingCompletion(submitted, leanReport, T0 + 90 * MIN);
assert.strictEqual(pending.phase, 'completed_pending_save', 'EX-02: the finished exam enters completed_pending_save');
assert.ok(pending.pendingCompletion.report,
  'EX-02: the finished report must be retained inside the active-exam snapshot until history is written');
assert.strictEqual(pending.pendingCompletion.report.scores.totalScaled, 1010,
  'EX-02: the full lean report is carried inside the active-exam snapshot');
assert.strictEqual(pending.pendingCompletion.examId, 'exam_fixture_1', 'EX-02: the pending completion knows its exam id');
assert.strictEqual(pending.pendingCompletion.savedToHistory, false, 'EX-02: it starts out as NOT saved');
assert.strictEqual(pending.pendingCompletion.builtAt, T0 + 90 * MIN, 'EX-02: the build time is the instant passed in');
assert.deepStrictEqual(pending.submittedModules, [0, 1], 'EX-02: every module of a finished exam is locked');
assert.strictEqual(pending.answers.q4, 'C', 'EX-02: the raw answers are kept alongside the report');
assert.strictEqual(ES.canAcceptAnswer(pending, 1, T0 + 91 * MIN).allowed, false,
  'EX-02: a finished exam accepts no further answers');
ok('EX-02: a finished exam keeps a recoverable report AND the raw answers in the active key');

// Idempotent re-save: the history write failed, so nothing is recorded yet.
const emptyHistory = [];
assert.strictEqual(ES.isCompletionRecorded(emptyHistory, 'exam_fixture_1'), false,
  'EX-02: a failed history write means the completion is not recorded');
const historyAfter = [{ examId: 'exam_fixture_1', totalCorrect: 4 }, { examId: 'exam_other', totalCorrect: 1 }];
assert.strictEqual(ES.isCompletionRecorded(historyAfter, 'exam_fixture_1'), true,
  'EX-02: once written, the completion is recognised so a retry cannot double-count');
assert.strictEqual(ES.isCompletionRecorded(historyAfter, 'exam_never_taken'), false, 'a different exam is not recorded');
assert.strictEqual(ES.isCompletionRecorded(null, 'exam_fixture_1'), false, 'an unreadable history is not proof of a save');
assert.strictEqual(ES.isCompletionRecorded(historyAfter, null), false, 'a missing exam id is never "already recorded"');
ok('EX-02: isCompletionRecorded makes the retry idempotent and never claims a save it cannot see');

// A reload while the save is still pending must resume into the save path.
const pendingResume = ES.resumeExamSnapshot(pending, QUESTION_MAP, T0 + 95 * MIN);
assert.strictEqual(pendingResume.ok, true, 'EX-02: a pending-save snapshot resumes');
assert.strictEqual(pendingResume.state.continuation, 'save_pending_report',
  'EX-02: the continuation path is to finish saving the report');
assert.strictEqual(pendingResume.state.pendingCompletion.report.totalCorrect, 4,
  'EX-02: the report survives a reload and can still be re-saved');
ok('EX-02: a reload before the save completes resumes straight into the save path');

const savedNow = ES.markCompletionSaved(pending, T0 + 96 * MIN);
assert.strictEqual(savedNow.pendingCompletion.savedToHistory, true, 'EX-02: a confirmed save is recorded');
assert.strictEqual(savedNow.pendingCompletion.savedAt, T0 + 96 * MIN, 'EX-02: the save time is the instant passed in');
assert.strictEqual(pending.pendingCompletion.savedToHistory, false, 'EX-02: markCompletionSaved does not mutate its input');
ok('EX-02: the save confirmation is explicit and non-mutating');

// ===========================================================================
section('Requirement 8 — migrateExamSnapshot upgrades a real v1 snapshot losslessly');
// ===========================================================================
// Hand-written v1 fixture: exactly the shape persistActiveExamState() wrote before
// WI-22 (no schemaVersion, no phase, no submittedModules, no break deadline).
const v1Snapshot = {
  activeExamMeta: {
    id: 'exam_1749999999999',
    title: 'Full-Length PSAT 8/9 Practice Exam',
    type: 'standard_psat89',
    isAdaptive: true,
    routingTracks: { rw: 'Hard', math: 'Baseline' },
    adaptivePools: {
      rwM2Hard: ['a1', 'a2'],
      rwM2Easy: ['b1', 'b2'],
      mathM2Hard: ['c1'],
      mathM2Easy: ['d1']
    },
    totalQuestions: 6,
    totalTimeMinutes: 134,
    breakMinutes: 10,
    createdAt: T0 - 70 * MIN,
    modules: [
      { id: 'rw_m1', section: 'Reading and Writing', moduleNumber: 1, name: 'RW — Module 1', track: 'Standard', questionsCount: 3, timeLimitSeconds: 1920, questionIds: ['q1', 'q2', 'q3'] },
      { id: 'rw_m2', section: 'Reading and Writing', moduleNumber: 2, name: 'RW — Module 2', track: 'Hard', questionsCount: 3, timeLimitSeconds: 1920, questionIds: ['q4', 'q5', 'q6'] }
    ]
  },
  currentModuleIndex: 1,
  currentExamQIndex: 2,
  examModuleDeadline: T0 + 15 * MIN,
  examUserAnswers: { q1: 'A', q2: 'D', q3: '3/4', q4: 'B', q5: '-12' },
  examUserTimes: { q1: 31000, q2: 47000, q3: 120000, q4: 8000, q5: 62000 },
  examMarkedForReview: { q2: true, q5: true },
  examViewMode: 'text',
  savedAt: T0 - 30000
};

const migrated = ES.migrateExamSnapshot(v1Snapshot, T0);
assert.strictEqual(migrated.schemaVersion, 2, 'the migrated snapshot is v2');
assert.strictEqual(ES.EXAM_STATE_SCHEMA_VERSION, 2, 'the module writes schema version 2');
// Every one of the five answers, by hand:
assert.strictEqual(migrated.answers.q1, 'A', 'v1 answer q1 preserved');
assert.strictEqual(migrated.answers.q2, 'D', 'v1 answer q2 preserved');
assert.strictEqual(migrated.answers.q3, '3/4', 'v1 grid-in answer q3 preserved');
assert.strictEqual(migrated.answers.q4, 'B', 'v1 answer q4 preserved');
assert.strictEqual(migrated.answers.q5, '-12', 'v1 negative grid-in answer q5 preserved');
assert.strictEqual(Object.keys(migrated.answers).length, 5, 'exactly the five v1 answers came across, no more');
assert.strictEqual(migrated.times.q3, 120000, 'v1 per-question times preserved');
assert.strictEqual(Object.keys(migrated.times).length, 5, 'all five v1 times came across');
assert.strictEqual(migrated.markedForReview.q5, true, 'v1 marks preserved');
assert.strictEqual(migrated.viewMode, 'text', 'the v1 view mode preserved');
assert.strictEqual(migrated.currentModuleIndex, 1, 'the v1 module index preserved');
assert.strictEqual(migrated.currentQuestionIndex, 2, 'currentExamQIndex became currentQuestionIndex');
assert.strictEqual(migrated.moduleDeadline, T0 + 15 * MIN, 'the v1 absolute module deadline preserved');
assert.strictEqual(migrated.savedAt, T0 - 30000, 'the v1 savedAt measurement is kept, not replaced by now');
assert.strictEqual(migrated.examMeta.id, 'exam_1749999999999', 'the exam identity preserved');
assert.strictEqual(migrated.examMeta.routingTracks.rw, 'Hard', 'the adaptive routing decision preserved');
assert.deepStrictEqual(migrated.examMeta.adaptivePools.rwM2Hard, ['a1', 'a2'], 'the adaptive pools preserved');
assert.deepStrictEqual(migrated.examMeta.modules[1].questionIds, ['q4', 'q5', 'q6'], 'the module form preserved');
assert.strictEqual(migrated.examMeta.modules[1].track, 'Hard', 'the module track preserved');
assert.strictEqual(migrated.phase, 'module', 'a v1 snapshot could only be a module snapshot');
assert.deepStrictEqual(migrated.submittedModules, [0], 'module 0 is inferred submitted (v1 only advanced after a submit)');
assert.strictEqual(migrated.submittedModulesInferred, true, 'the inference is labelled as an inference, not a measurement');
assert.strictEqual(migrated.migratedFrom, 1, 'the migration records where it came from');
ok('a hand-written v1 snapshot migrates with every answer, time, mark and route intact');

// The migrated snapshot behaves: it resumes, and the inferred lock holds.
const migResume = ES.resumeExamSnapshot(v1Snapshot, QUESTION_MAP, T0 + 5 * MIN);
assert.strictEqual(migResume.ok, true, 'a v1 snapshot from real localStorage resumes without being cleared');
assert.strictEqual(migResume.state.remainingSeconds, 600, 'the v1 deadline drives the resumed timer (10 min left)');
assert.strictEqual(migResume.state.answers.q3, '3/4', 'the v1 answers reach the resumed state');
assert.strictEqual(ES.isModuleLocked(migResume.state, 0, T0 + 5 * MIN), true, 'the already-finished v1 module stays locked');
assert.ok(
  migResume.warnings.some(function (w) { return w.indexOf('older version') !== -1; }),
  'the upgrade-on-load is reported to the caller'
);
ok('resumeExamSnapshot migrates a v1 snapshot on load and reports that it did');

// Unknown v1 fields are never dropped, and migrating twice changes nothing.
const v1Extra = Object.assign({}, v1Snapshot, { someFutureField: { keepMe: 42 } });
const migratedExtra = ES.migrateExamSnapshot(v1Extra, T0);
assert.strictEqual(migratedExtra.legacyFields.someFutureField.keepMe, 42, 'unknown v1 fields are preserved verbatim');
const twice = ES.migrateExamSnapshot(migrated, T0 + MIN);
assert.deepStrictEqual(twice, migrated, 'migrating an already-v2 snapshot is a no-op');
assert.strictEqual(ES.migrateExamSnapshot(null, T0), null, 'there is nothing to migrate from nothing');
ok('the migration is additive and idempotent');

// ===========================================================================
section('Requirement 9 — provenance is carried through, and unknown stays null');
// ===========================================================================
const withProvenance = ES.buildExamSnapshot({
  exam: twoModuleExam(),
  moduleDeadline: T0 + MIN,
  blueprintVersion: 'psat89-2026.1',
  isHighYield: true,
  now: T0
});
assert.strictEqual(withProvenance.examMeta.blueprintVersion, 'psat89-2026.1', 'the blueprint version is carried into the snapshot');
assert.strictEqual(withProvenance.examMeta.isHighYield, true, 'the high-yield flag is carried into the snapshot');
const provResume = ES.resumeExamSnapshot(withProvenance, QUESTION_MAP, T0);
assert.strictEqual(provResume.state.provenance.blueprintVersion, 'psat89-2026.1', 'the blueprint version survives a reload');
assert.strictEqual(provResume.state.provenance.isHighYield, true, 'the high-yield flag survives a reload');
assert.strictEqual(provResume.state.provenance.known, true, 'known provenance is reported as known');

const noProvenance = ES.buildExamSnapshot({ exam: twoModuleExam(), moduleDeadline: T0 + MIN, now: T0 });
assert.strictEqual(noProvenance.examMeta.blueprintVersion, null, 'unknown blueprint version is null, never a made-up default');
assert.strictEqual(noProvenance.examMeta.isHighYield, null, 'unknown high-yield status is null, never false-by-default');
const noProvResume = ES.resumeExamSnapshot(noProvenance, QUESTION_MAP, T0);
assert.strictEqual(noProvResume.state.provenance.known, false, 'unknown provenance is reported as unknown');
assert.strictEqual(migrated.examMeta.isHighYield, null, 'a v1 snapshot recorded no provenance, so it stays null');
ok('provenance is carried when supplied and stays null — flagged unknown — when it is not');

// ===========================================================================
section('Requirement 1 — no function in this module ever discards state');
// ===========================================================================
// Every transition returns a snapshot that still holds the answers.
const chainStart = ES.buildExamSnapshot({
  exam: twoModuleExam(),
  moduleDeadline: T0 + 10 * MIN,
  currentModuleIndex: 0,
  answers: { q1: 'A', q2: 'B', q3: 'C' },
  times: { q1: 1000, q2: 2000, q3: 3000 },
  now: T0
});
const chain = [
  ES.markModuleSubmitted(chainStart, 0, T0 + 10 * MIN),
  ES.enterBreak(ES.markModuleSubmitted(chainStart, 0, T0 + 10 * MIN), 600, T0 + 10 * MIN),
  ES.buildPendingCompletion(chainStart, leanReport, T0 + 20 * MIN),
  ES.markCompletionSaved(ES.buildPendingCompletion(chainStart, leanReport, T0 + 20 * MIN), T0 + 21 * MIN),
  ES.migrateExamSnapshot(v1Snapshot, T0)
];
chain.forEach(function (snap, i) {
  assert.ok(snap && typeof snap === 'object', 'transition ' + i + ' returns a snapshot');
  assert.ok(Object.keys(snap.answers).length >= 3, 'transition ' + i + ' keeps at least the three answers it was given');
});
ok('every transition returns a snapshot that still carries the student\'s answers');

// The only ok:false results are "there is nothing here", and neither says "clear it".
const nothing = ES.resumeExamSnapshot(null, QUESTION_MAP, T0);
assert.strictEqual(nothing.ok, false, 'a null snapshot cannot be resumed');
assert.strictEqual(nothing.reason, 'no_saved_exam', 'the reason is that there is no saved exam');
assert.strictEqual(nothing.state, null, 'there is no state to return');

const emptyModules = ES.resumeExamSnapshot({ schemaVersion: 2, examMeta: { modules: [] }, answers: { q1: 'A' } }, QUESTION_MAP, T0);
assert.strictEqual(emptyModules.ok, false, 'a snapshot with no modules cannot be reopened');
assert.ok(
  emptyModules.warnings.join(' ').indexOf('left in place') !== -1,
  'even the unusable case states that the saved answers were left alone'
);
const exportedFns = Object.keys(ES);
assert.strictEqual(exportedFns.filter(function (k) { return /clear|delete|discard|purge|reset/i.test(k); }).length, 0,
  'the module exports no clearing, deleting, discarding or resetting function at all');
ok('the module has no destructive entry point, and the unusable cases still preserve the record');

console.log('\nALL WI-22 EXAM LIFECYCLE STATE TESTS PASSED');
