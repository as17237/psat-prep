const assert = require('assert');
const PSAT_ENGINE = require('../srs.js');

console.log('Testing Spaced Repetition (SM-2) & Scoring Engine...');

// 1. Grade Attempt timing thresholds and unreliable timing
assert.strictEqual(PSAT_ENGINE.gradeAttempt(false, 10000), 1, 'Incorrect answer must yield grade 1');
assert.strictEqual(PSAT_ENGINE.gradeAttempt(true, 30000), 5, 'Correct in 30s must yield grade 5');
assert.strictEqual(PSAT_ENGINE.gradeAttempt(true, 60000), 4, 'Correct in 60s must yield grade 4');
assert.strictEqual(PSAT_ENGINE.gradeAttempt(true, 120000), 3, 'Correct in 120s must yield grade 3');
assert.strictEqual(PSAT_ENGINE.gradeAttempt(true, null), 3, 'Missing timing must fall back to conservative grade 3');
assert.strictEqual(PSAT_ENGINE.gradeAttempt(true, 30000, false), 3, 'Unreliable timing flag must yield grade 3');

// 2. SM-2 Ladder progression
const now = Date.now();
let card = { questionId: 'test_q1', repetitions: 0, intervalDays: 1, easeFactor: 2.5 };

// Attempt 1: Fast correct (grade 5) -> EF = 2.6, interval = 1
card = PSAT_ENGINE.scheduleNext(card, 5, now);
assert.strictEqual(card.repetitions, 1);
assert.strictEqual(card.intervalDays, 1);
assert.strictEqual(card.easeFactor, 2.6);

// Attempt 2: Proficient correct (grade 4) -> EF = 2.6, interval = 3
card = PSAT_ENGINE.scheduleNext(card, 4, now);
assert.strictEqual(card.repetitions, 2);
assert.strictEqual(card.intervalDays, 3);
assert.strictEqual(card.easeFactor, 2.6);

// Attempt 3: Fast correct (grade 5) -> EF = 2.7, interval = 7
card = PSAT_ENGINE.scheduleNext(card, 5, now);
assert.strictEqual(card.repetitions, 3);
assert.strictEqual(card.intervalDays, 7);
assert.strictEqual(card.easeFactor, 2.7);

// Attempt 4: Fast correct (grade 5) -> EF = 2.8, interval = round(7 * 2.8) = 20
card = PSAT_ENGINE.scheduleNext(card, 5, now);
assert.strictEqual(card.repetitions, 4);
assert.strictEqual(card.intervalDays, 20);
assert.strictEqual(card.easeFactor, 2.8);

// Attempt 5: Incorrect answer (grade 1) -> Reset interval to 1 day, drop EF per formula
card = PSAT_ENGINE.scheduleNext(card, 1, now);
assert.strictEqual(card.repetitions, 0, 'Reps must reset to 0 on failure');
assert.strictEqual(card.intervalDays, 1, 'Interval must reset to 1 day on failure');
assert.strictEqual(card.easeFactor, 2.26);

// 3. Section-Score and Total Score Gating
const mockQuestions = [];
const mockProgress = {};

for (let i = 1; i <= 20; i++) {
  const rwId = `rw_${i}`;
  mockQuestions.push({ id: rwId, test: 'Reading and Writing' });
  if (i <= 15) {
    mockProgress[rwId] = { answered: true, isCorrect: true };
  }
}
for (let i = 1; i <= 20; i++) {
  const mathId = `math_${i}`;
  mockQuestions.push({ id: mathId, test: 'Math' });
  if (i <= 5) {
    mockProgress[mathId] = { answered: true, isCorrect: true };
  }
}

// 15 RW attempts (100%), 5 Math attempts (100%)
let scoreInfo = PSAT_ENGINE.calculateScaledScore(mockQuestions, mockProgress);
assert.strictEqual(scoreInfo.rwReady, true, 'RW with 15 attempts should be ready');
assert.strictEqual(scoreInfo.rwScore, 720, '15/15 RW should score 720');
assert.strictEqual(scoreInfo.mathReady, false, 'Math with 5 attempts should NOT be ready');
assert.strictEqual(scoreInfo.mathScore, null, 'Unready Math section score must be null');
assert.strictEqual(scoreInfo.isReady, false, 'Total score should NOT be ready when one section is unready');
assert.strictEqual(scoreInfo.totalScore, null);

// 4. Local Date and Deterministic Streak Tests
const localToday = PSAT_ENGINE.localDateKey();
assert.strictEqual(typeof localToday, 'string');
assert.match(localToday, /^\d{4}-\d{2}-\d{2}$/);

// Case A: Streak crossing month boundary (31 Aug -> 1 Sep with reference today '2026-09-01')
const sessionsMonthBoundary = {
  '2026-08-31': { questionsAnswered: 10 },
  '2026-09-01': { questionsAnswered: 8 }
};
assert.strictEqual(PSAT_ENGINE.calculateStreak(sessionsMonthBoundary, '2026-09-01'), 2, 'Month boundary streak must be 2');

// Case B: Streak ending yesterday (30 Aug -> 31 Aug with reference today '2026-09-01')
const sessionsEndedYesterday = {
  '2026-08-30': { questionsAnswered: 5 },
  '2026-08-31': { questionsAnswered: 10 }
};
assert.strictEqual(PSAT_ENGINE.calculateStreak(sessionsEndedYesterday, '2026-09-01'), 2, 'Yesterday streak must be 2');

// Case C: Broken streak in the past (30 Aug -> 31 Aug with reference today '2026-09-10')
assert.strictEqual(PSAT_ENGINE.calculateStreak(sessionsEndedYesterday, '2026-09-10'), 0, 'Stale session streak must be 0');

// Case D: Future-dated sessions relative to injected today (session on '2026-09-15' with today '2026-09-01')
const sessionsFuture = {
  '2026-09-15': { questionsAnswered: 12 }
};
assert.strictEqual(PSAT_ENGINE.calculateStreak(sessionsFuture, '2026-09-01'), 0, 'Future session must NOT count toward streak');

// 5. Standard PSAT 8/9 Exam Generation
const mockFullBank = [];
for (let i = 1; i <= 100; i++) {
  mockFullBank.push({
    id: `rw_${i}`,
    test: 'Reading and Writing',
    domain: 'Information and Ideas',
    skill: 'Inferences',
    difficulty: i % 3 === 0 ? 'Hard' : (i % 2 === 0 ? 'Medium' : 'Easy'),
    question_type: 'multiple_choice',
    correct_answer: 'A'
  });
}
for (let i = 1; i <= 100; i++) {
  mockFullBank.push({
    id: `math_${i}`,
    test: 'Math',
    domain: 'Algebra',
    skill: 'Linear equations',
    difficulty: i % 3 === 0 ? 'Hard' : (i % 2 === 0 ? 'Medium' : 'Easy'),
    question_type: i <= 20 ? 'free_response' : 'multiple_choice',
    correct_answer: i <= 20 ? '42' : 'B'
  });
}

const standardExam = PSAT_ENGINE.generateStandardPSAT89Exam(mockFullBank);
assert.strictEqual(standardExam.totalQuestions, 98, 'Total exam questions must be 98');
assert.strictEqual(standardExam.totalTimeMinutes, 134, 'Total exam time must be 134 minutes (2h 14m)');
assert.strictEqual(standardExam.breakMinutes, 10, 'Exam break must be 10 minutes');
assert.strictEqual(standardExam.modules.length, 4, 'Must contain 4 distinct modules');
assert.strictEqual(standardExam.modules[0].questionsCount, 27, 'R&W Module 1 must have 27 Qs');
assert.strictEqual(standardExam.modules[0].timeLimitSeconds, 32 * 60, 'R&W Module 1 time must be 32m');
assert.strictEqual(standardExam.modules[1].questionsCount, 27, 'R&W Module 2 must have 27 Qs');
assert.strictEqual(standardExam.modules[2].questionsCount, 22, 'Math Module 1 must have 22 Qs');
assert.strictEqual(standardExam.modules[2].timeLimitSeconds, 35 * 60, 'Math Module 1 time must be 35m');
assert.strictEqual(standardExam.modules[3].questionsCount, 22, 'Math Module 2 must have 22 Qs');

// 6. Exam Scoring Engine
const userAnswers = {};
standardExam.modules.forEach(mod => {
  mod.questions.forEach(q => {
    userAnswers[q.id] = q.correct_answer; // 100% correct
  });
});
const examReport = PSAT_ENGINE.scoreStandardExam(standardExam, userAnswers, {});
assert.strictEqual(examReport.scores.totalScaled, 1440, '100% accuracy must score 1440');
assert.strictEqual(examReport.scores.rwScaled, 720, '100% RW accuracy must score 720');
assert.strictEqual(examReport.scores.mathScaled, 720, '100% Math accuracy must score 720');
assert.strictEqual(examReport.overallAccuracyPercent, 100);

// 7. Spaced Repetition Gap-Targeted Selection
const mockSrs = {
  'rw_1': { dueAt: Date.now() - 100000, repetitions: 1 } // Overdue
};
const mockProgressMap = {
  'rw_2': { answered: true, isCorrect: false }, // Missed
  'math_1': { answered: true, isCorrect: true }
};
const gapDrill = PSAT_ENGINE.generateGapTargetedDrill(mockFullBank, mockProgressMap, mockSrs, { count: 10 });
assert.strictEqual(gapDrill.questions.length, 10);
assert.strictEqual(gapDrill.questions[0].id, 'rw_1', 'Overdue SRS card must be highest priority');
assert.strictEqual(gapDrill.questions[1].id, 'rw_2', 'Missed question must be second priority');

// 8. Custom Filtered Test Builder
const customTest = PSAT_ENGINE.generateCustomTest(mockFullBank, {
  test: 'Math',
  questionType: 'spr',
  count: 5
});
assert.strictEqual(customTest.questions.length, 5);
assert.ok(customTest.questions.every(q => q.test === 'Math' && (q.type || q.question_type) === 'free_response'));

// 9. Integration with REAL Dataset (3,059 questions from data/*.json)
const fs = require('fs');
const path = require('path');
const realEla = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/ela_questions.json'), 'utf8'));
const realMath = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/math_questions.json'), 'utf8'));
const realBank = realEla.concat(realMath);

assert.strictEqual(realBank.length, 3059, 'Real bank must have 3,059 items');

// A: Standard PSAT 8/9 Exam from real dataset
const realStandardExam = PSAT_ENGINE.generateStandardPSAT89Exam(realBank);
assert.strictEqual(realStandardExam.totalQuestions, 98, 'Real dataset standard exam must have 98 questions');
assert.strictEqual(realStandardExam.modules.length, 4, 'Must have 4 modules');
assert.strictEqual(realStandardExam.modules[0].questions.length, 27, 'RW M1 must have 27 Qs');
assert.strictEqual(realStandardExam.modules[1].questions.length, 27, 'RW M2 must have 27 Qs');
assert.strictEqual(realStandardExam.modules[2].questions.length, 22, 'Math M1 must have 22 Qs');
assert.strictEqual(realStandardExam.modules[3].questions.length, 22, 'Math M2 must have 22 Qs');

// Verify realistic MCQ & SPR mix in Math modules
const m1SprCount = realStandardExam.modules[2].questions.filter(q => (q.type || q.question_type) === 'free_response').length;
const m2SprCount = realStandardExam.modules[3].questions.filter(q => (q.type || q.question_type) === 'free_response').length;
assert.strictEqual(m1SprCount, 5, 'Math M1 must contain 5 free-response SPR items');
assert.strictEqual(m2SprCount, 5, 'Math M2 must contain 5 free-response SPR items');

// B: Real Custom Test SPR Filter
const realSprCustom = PSAT_ENGINE.generateCustomTest(realBank, { questionType: 'spr', count: 10 });
assert.strictEqual(realSprCustom.questions.length, 10, 'Real SPR custom filter must return 10 items');
assert.ok(realSprCustom.questions.every(q => (q.type || q.question_type) === 'free_response'), 'All returned items must be SPR');

// C: Real MCQ Options Resolution
const realMcq = realEla[0];
assert.ok(Array.isArray(realMcq.options), 'Options must be an array of {key, text}');
const optA = realMcq.options.find(o => o.key === 'A');
assert.ok(optA && optA.text && optA.text.length > 0, 'Choice A must have valid resolved text');

// D: Exam Scoring on Real Dataset
const realAnswers = {};
realStandardExam.modules.forEach(mod => {
  mod.questions.forEach(q => {
    const forms = PSAT_ENGINE.extractAcceptedForms(q.correct_answer);
    realAnswers[q.id] = forms.length > 0 ? forms[0] : q.correct_answer;
  });
});
const realReport = PSAT_ENGINE.scoreStandardExam(realStandardExam, realAnswers, {});
// E: Session Logging & Streak Integrity (Round 5 Finding 2)
let testSessions = {};
testSessions = PSAT_ENGINE.recordDailySession(testSessions, true, 45000, null, true);
const todayKey = PSAT_ENGINE.localDateKey();
assert.ok(testSessions[todayKey], 'Session must be logged under valid YYYY-MM-DD key');
assert.strictEqual(testSessions[todayKey].questionsAnswered, 1);
assert.strictEqual(testSessions['true'], undefined, 'Must NEVER log session under key "true"');

// Ensure junk keys from corrupted logs do not break streak calculation
testSessions['true'] = { questionsAnswered: 5 };
testSessions['invalid-date'] = { questionsAnswered: 10 };
const streakWithJunk = PSAT_ENGINE.calculateStreak(testSessions, todayKey);
assert.strictEqual(streakWithJunk, 1, 'Streak calculation must ignore malformed non-date keys');

// F: Parent Portal Custom Test Builder Type Filter Counts (Round 5 Finding 3)
const realMcqCount = realBank.filter(q => {
  const type = q.type || q.question_type || 'multiple_choice';
  return type !== 'free_response';
}).length;
const realSprCount = realBank.filter(q => {
  const type = q.type || q.question_type || 'multiple_choice';
  return type === 'free_response';
}).length;
assert.strictEqual(realMcqCount, 2694, 'Real MCQ count must be exactly 2,694');
assert.strictEqual(realSprCount, 365, 'Real SPR count must be exactly 365');
assert.strictEqual(realMcqCount + realSprCount, 3059, 'Total must equal 3,059');

// G: Lean Exam Report Compression & Rehydration (Round 5 Finding 1)
const lean = PSAT_ENGINE.toLeanReport(realReport);
const leanBytes = Buffer.byteLength(JSON.stringify(lean));
const fullBytes = Buffer.byteLength(JSON.stringify(realReport));
assert.ok(leanBytes < 25000, `Lean report size (${leanBytes} B) must be <25KB`);
assert.ok(leanBytes < fullBytes * 0.2, 'Lean report must compress at least 80% of payload');

const rehydrated = PSAT_ENGINE.rehydrateReport(lean, realBank);
assert.strictEqual(rehydrated.moduleReports[0].questions[0].question_text, realReport.moduleReports[0].questions[0].question_text, 'Rehydrated question text must match');
assert.strictEqual(rehydrated.moduleReports[0].questions[0].rationale, realReport.moduleReports[0].questions[0].rationale, 'Rehydrated rationale must match');
assert.strictEqual(rehydrated.scores.totalScaled, 1440, 'Rehydrated scores must match');

// H: scoreStandardExam totalAttempted ignores extraneous keys in answers
const answersWithExtraneous = Object.assign({}, realAnswers, { 'non_existent_qid_123': 'A', 'another_fake_qid': 'B' });
const reportExtraneous = PSAT_ENGINE.scoreStandardExam(realStandardExam, answersWithExtraneous, {});
assert.strictEqual(reportExtraneous.totalAttempted, 98, 'totalAttempted must count only questions in the active exam');

console.log('✓ All Spaced Repetition (SM-2), Real Dataset Exam Generation, and Scoring tests passed!');


