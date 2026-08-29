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

// 5b. Adaptive vs Linear Exam Generation
const adaptiveExam = PSAT_ENGINE.generateStandardPSAT89Exam(mockFullBank, { isAdaptive: true });
assert.strictEqual(adaptiveExam.isAdaptive, true);
assert.ok(adaptiveExam.adaptivePools.rwM2Hard.length >= 27, 'Must have RW Hard pool');
assert.ok(adaptiveExam.adaptivePools.rwM2Easy.length >= 27, 'Must have RW Easy pool');
assert.ok(adaptiveExam.adaptivePools.mathM2Hard.length >= 22, 'Must have Math Hard pool');
assert.ok(adaptiveExam.adaptivePools.mathM2Easy.length >= 22, 'Must have Math Easy pool');

const linearExam = PSAT_ENGINE.generateStandardPSAT89Exam(mockFullBank, { isAdaptive: false });
assert.strictEqual(linearExam.isAdaptive, false);
assert.strictEqual(linearExam.adaptivePools, null);

// 5c. Mini Adaptive Exam Generation
const miniAdaptive = PSAT_ENGINE.generateMiniPSAT89Exam(mockFullBank, { isAdaptive: true });
assert.strictEqual(miniAdaptive.isAdaptive, true);
assert.ok(miniAdaptive.adaptivePools.mathM2Hard.length >= 4);
assert.ok(miniAdaptive.adaptivePools.mathM2Easy.length >= 4);

// 5d. Bank Coverage & Unseen Prioritization Guarantee
const seenProgress = {
  'rw_1': { answered: true, timesSeen: 2 },
  'rw_2': { answered: true, timesSeen: 1 }
};
const prioritizedRw = PSAT_ENGINE._prioritizeUnseen(mockFullBank.filter(q => q.test === 'Reading and Writing'), seenProgress);
assert.notStrictEqual(prioritizedRw[0].id, 'rw_1', 'Seen question rw_1 must not take precedence over unseen');
assert.notStrictEqual(prioritizedRw[0].id, 'rw_2', 'Seen question rw_2 must not take precedence over unseen');
const lastItems = prioritizedRw.slice(-2).map(q => q.id);
assert.ok(lastItems.includes('rw_1'), 'Frequently seen item rw_1 must be sorted to the end of the rotation queue');

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

// I: Mini PSAT 8/9 Quick Simulation (8 Qs End-to-End Test Mode)
const miniExam = PSAT_ENGINE.generateMiniPSAT89Exam(realBank);
assert.strictEqual(miniExam.totalQuestions, 8, 'Mini exam must have 8 questions');
assert.strictEqual(miniExam.totalTimeMinutes, 10, 'Mini exam duration must be 10 minutes');
assert.strictEqual(miniExam.breakMinutes, 1, 'Mini exam break must be 1 minute');
assert.strictEqual(miniExam.modules.length, 2, 'Mini exam must have 2 modules (RW & Math)');
assert.strictEqual(miniExam.modules[0].questions.length, 4, 'RW module must have 4 questions');
assert.strictEqual(miniExam.modules[1].questions.length, 4, 'Math module must have 4 questions');

const miniMathSprCount = miniExam.modules[1].questions.filter(q => (q.type || q.question_type) === 'free_response').length;
assert.strictEqual(miniMathSprCount, 1, 'Mini Math module must have exactly 1 free-response SPR item');

const miniAnswers = {};
miniExam.modules.forEach(m => {
  m.questions.forEach(q => {
    const forms = PSAT_ENGINE.extractAcceptedForms(q.correct_answer);
    miniAnswers[q.id] = forms.length > 0 ? forms[0] : q.correct_answer;
  });
});
const miniReport = PSAT_ENGINE.scoreStandardExam(miniExam, miniAnswers, {});
assert.strictEqual(miniReport.totalQuestions, 8);
assert.strictEqual(miniReport.totalCorrect, 8);
assert.strictEqual(miniReport.scores.isScaledReady, false, 'Mini exam (<15 Qs per section) must NOT mark scaled score ready');
assert.strictEqual(miniReport.scores.totalScaled, null, 'Mini exam must have totalScaled null');
assert.strictEqual(miniReport.scores.provisionalScaled, undefined, 'provisionalScaled must be removed to prevent gate bypass');

assert.strictEqual(realReport.scores.isScaledReady, true, 'Full exam (98 Qs) must mark scaled score ready');
assert.strictEqual(realReport.scores.totalScaled, 1440, 'Full exam must report 1440 scaled score');
assert.strictEqual(realReport.scores.provisionalScaled, undefined, 'provisionalScaled must be removed from full exam too');

const miniLean = PSAT_ENGINE.toLeanReport(miniReport);
const miniRehydrated = PSAT_ENGINE.rehydrateReport(miniLean, realBank);
assert.strictEqual(miniRehydrated.totalQuestions, 8);
assert.strictEqual(miniRehydrated.moduleReports[0].questions[0].question_text.length > 0, true);

// J: Sample Diagnostic Generator Payload & Integrity
const samplePayload = PSAT_ENGINE.generateSampleDiagnosticPayload(realBank, '2026-08-24');
const sampleProgressKeys = Object.keys(samplePayload.progress);
assert.strictEqual(sampleProgressKeys.length, 24, 'Sample payload must contain exactly 24 practice attempts');

let sampleCollisionCount = 0;
sampleProgressKeys.forEach(qid => {
  const attempt = samplePayload.progress[qid];
  assert.strictEqual(attempt.isSample, true, 'Every sample attempt must be stamped isSample: true');
  const q = realBank.find(item => item.id === qid);
  if (!attempt.isCorrect) {
    if ((q.type || q.question_type) === 'free_response') {
      const forms = PSAT_ENGINE.extractAcceptedForms(q.correct_answer);
      if (forms.includes(attempt.selectedAnswer)) sampleCollisionCount++;
    } else {
      if (String(attempt.selectedAnswer).trim().toUpperCase() === String(q.correct_answer).trim().toUpperCase()) {
        sampleCollisionCount++;
      }
    }
  }
});
assert.strictEqual(sampleCollisionCount, 0, 'No sample incorrect attempt may match the correct key');

// K: Demo Mode Guarded Backup (Load -> Load -> Restore Sequence)
class MockStorage {
  constructor() { this.store = {}; }
  getItem(key) { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null; }
  setItem(key, val) { this.store[key] = String(val); }
  removeItem(key) { delete this.store[key]; }
}

const mockStore = new MockStorage();
const realInitialProgress = { 'real_q_100': { answered: true, isCorrect: true, timeSpentMs: 45000 } };
const realInitialHistory = [{ examId: 'real_standard_exam_001', totalScore: 1380 }];
mockStore.setItem('psat_progress', JSON.stringify(realInitialProgress));
mockStore.setItem('psat_exam_history', JSON.stringify(realInitialHistory));

// 1st Load: Must create backup of real data and activate demo mode
const backedUp1 = PSAT_ENGINE.backupRealData(mockStore);
assert.strictEqual(backedUp1, true, 'First backup must succeed');
mockStore.setItem('psat_sample_data_active', 'true');
mockStore.setItem('psat_progress', JSON.stringify(samplePayload.progress));
mockStore.setItem('psat_exam_history', JSON.stringify(samplePayload.examHistory));

// 2nd Load: Demo mode is already active -> backup MUST NOT overwrite real backup with sample data
const backedUp2 = PSAT_ENGINE.backupRealData(mockStore);
assert.strictEqual(backedUp2, false, 'Second backup must refuse to overwrite while demo mode is active');

// Generate 2nd sample payload
const samplePayload2 = PSAT_ENGINE.generateSampleDiagnosticPayload(realBank, '2026-08-24');
mockStore.setItem('psat_progress', JSON.stringify(samplePayload2.progress));

// Verify that the backup STILL contains the real data
const backupJson = JSON.parse(mockStore.getItem('psat_pre_sample_backup'));
assert.deepStrictEqual(backupJson.progress, realInitialProgress, 'Backup must still hold initial real progress after 2nd sample load');
assert.deepStrictEqual(backupJson.examHistory, realInitialHistory, 'Backup must still hold initial real exam history after 2nd sample load');

// 3. Restore: Must restore original real student data completely
const restored = PSAT_ENGINE.restoreRealData(mockStore);
assert.strictEqual(restored, true, 'Restore must succeed');
assert.deepStrictEqual(JSON.parse(mockStore.getItem('psat_progress')), realInitialProgress, 'Progress must be restored to realInitialProgress');
assert.deepStrictEqual(JSON.parse(mockStore.getItem('psat_exam_history')), realInitialHistory, 'Exam history must be restored to realInitialHistory');
assert.strictEqual(mockStore.getItem('psat_sample_data_active'), null, 'psat_sample_data_active flag must be cleared');
assert.strictEqual(mockStore.getItem('psat_pre_sample_backup'), null, 'psat_pre_sample_backup must be cleared');

// L: Cloud Sync (Cosmos DB Sync Push & Pull Simulation)
let mockCloudDb = {};
let mockServerFail = false;

const mockFetch = async (url, opts) => {
  if (mockServerFail) {
    return {
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal Cosmos DB Error' })
    };
  }
  if (!opts || opts.method === 'GET' || !opts.method) {
    const sName = url.includes('student_name=') ? decodeURIComponent(url.split('student_name=')[1]) : 'default_student';
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        exists: Boolean(mockCloudDb[sName]),
        data: mockCloudDb[sName] || null
      })
    };
  }
  if (opts.method === 'POST') {
    const body = JSON.parse(opts.body);
    const sName = body.student_name || 'default_student';
    const existing = mockCloudDb[sName] || {};
    mockCloudDb[sName] = {
      id: `student_${sName}`,
      student_name: sName,
      progress: Object.assign({}, existing.progress || {}, body.progress || {}),
      srsState: Object.assign({}, existing.srsState || {}, body.srsState || {}),
      sessionsState: Object.assign({}, existing.sessionsState || {}, body.sessionsState || {}),
      examHistory: (body.examHistory || []).concat(existing.examHistory || []),
      updatedAt: Date.now()
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, updatedAt: Date.now() })
    };
  }
};

(async () => {
  // 1. Two devices, same-day work additive merge test using real engine functions
  const t0 = new Date('2026-08-25T10:00:00').getTime();
  const morningTabletStore = new MockStorage();
  let tabletSessions = {};
  for (let i = 0; i < 10; i++) tabletSessions = PSAT_ENGINE.recordDailySession(tabletSessions, true, 10000, '2026-08-25', true);
  for (let i = 0; i < 2; i++) tabletSessions = PSAT_ENGINE.recordDailySession(tabletSessions, false, 10000, '2026-08-25', true);
  morningTabletStore.setItem('psat_sessions', JSON.stringify(tabletSessions));

  const tabletProgress = { 'q1': { answered: true, isCorrect: false, timeSpentMs: 10000, timestamp: t0 } };
  for (let i = 2; i <= 10; i++) tabletProgress[`tab_${i}`] = { answered: true, isCorrect: true, timeSpentMs: 10000, timestamp: t0 + i * 1000 };
  for (let i = 11; i <= 12; i++) tabletProgress[`tab_${i}`] = { answered: true, isCorrect: false, timeSpentMs: 10000, timestamp: t0 + i * 1000 };
  morningTabletStore.setItem('psat_progress', JSON.stringify(tabletProgress));

  const tabletCard = PSAT_ENGINE.scheduleNext({ questionId: 'q1' }, 2, t0); // Fail at t0
  morningTabletStore.setItem('psat_srs', JSON.stringify({ 'q1': tabletCard }));

  // Tablet pushes to cloud
  await PSAT_ENGINE.pushToCloud(morningTabletStore, mockFetch, 'default_student');

  // Evening Laptop: 4 correct, 1 incorrect, and passed q1 at t0 + 20000
  const eveningLaptopStore = new MockStorage();
  let laptopSessions = {};
  for (let i = 0; i < 4; i++) laptopSessions = PSAT_ENGINE.recordDailySession(laptopSessions, true, 10000, '2026-08-25', true);
  for (let i = 0; i < 1; i++) laptopSessions = PSAT_ENGINE.recordDailySession(laptopSessions, false, 10000, '2026-08-25', true);
  eveningLaptopStore.setItem('psat_sessions', JSON.stringify(laptopSessions));

  const laptopProgress = { 'q1': { answered: true, isCorrect: true, timeSpentMs: 10000, timestamp: t0 + 20000 } };
  for (let i = 2; i <= 5; i++) laptopProgress[`lap_${i}`] = { answered: true, isCorrect: true, timeSpentMs: 10000, timestamp: t0 + 20000 + i * 1000 };
  laptopProgress['lap_6'] = { answered: true, isCorrect: false, timeSpentMs: 10000, timestamp: t0 + 26000 };
  eveningLaptopStore.setItem('psat_progress', JSON.stringify(laptopProgress));

  const laptopCard = PSAT_ENGINE.scheduleNext({ questionId: 'q1' }, 5, t0 + 20000); // Pass at t0 + 20000
  eveningLaptopStore.setItem('psat_srs', JSON.stringify({ 'q1': laptopCard }));

  // Laptop pulls from cloud
  const pullRes1 = await PSAT_ENGINE.pullFromCloud(eveningLaptopStore, mockFetch, 'default_student');
  assert.strictEqual(pullRes1.success, true);
  assert.strictEqual(pullRes1.updated, true);

  const mergedSessions = JSON.parse(eveningLaptopStore.getItem('psat_sessions'));
  assert.strictEqual(mergedSessions['2026-08-25'].questionsAnswered, 17, 'Same-day session questionsAnswered must be additive (12 + 5 = 17)');
  assert.strictEqual(mergedSessions['2026-08-25'].correct, 14, 'Same-day session correct must be additive (10 + 4 = 14)');
  assert.strictEqual(mergedSessions['2026-08-25'].totalTimeMs, 170000);
  assert.strictEqual(PSAT_ENGINE.calculateStreak(mergedSessions, '2026-08-25'), 1, 'calculateStreak must find active streak from merged session');

  // Assert idempotency across successive pulls/refreshes (zero session count inflation)
  for (let r = 0; r < 5; r++) {
    await PSAT_ENGINE.pullFromCloud(eveningLaptopStore, mockFetch, 'default_student');
    const refreshSess = JSON.parse(eveningLaptopStore.getItem('psat_sessions'));
    assert.strictEqual(refreshSess['2026-08-25'].questionsAnswered, 17, `Session count must not inflate on refresh ${r + 1}`);
    assert.strictEqual(refreshSess['2026-08-25'].correct, 14);
    assert.strictEqual(refreshSess['2026-08-25'].totalTimeMs, 170000);
  }

  const mergedProgress = JSON.parse(eveningLaptopStore.getItem('psat_progress'));
  assert.strictEqual(mergedProgress['q1'].isCorrect, true, 'Newer attempt at t0+20000 must win over older attempt at t0');
  assert.strictEqual(mergedProgress['q1'].timestamp, t0 + 20000);

  // Test newer failure vs older pass (where older pass had a much larger dueAt)
  const monCardPass = PSAT_ENGINE.scheduleNext({ repetitions: 2, intervalDays: 6, easeFactor: 2.5 }, 5, 1000); // Mon pass: interval=15, dueAt=1000+15d
  const tueCardFail = PSAT_ENGINE.scheduleNext(monCardPass, 1, 2000); // Tue fail: interval=1, dueAt=2000+1d
  assert.ok(monCardPass.dueAt > tueCardFail.dueAt, 'Precondition: older pass dueAt dominates newer fail dueAt');

  const mergedSrsDirect = PSAT_ENGINE.mergeSrsState({ 'q_fail': monCardPass }, { 'q_fail': tueCardFail });
  assert.strictEqual(mergedSrsDirect['q_fail'].lastReviewedAt, 2000, 'Newer review timestamp must win');
  assert.strictEqual(mergedSrsDirect['q_fail'].intervalDays, 1, 'Failed review interval of 1 day must not be overwritten by older 15-day pass');
  assert.strictEqual(mergedSrsDirect['q_fail'].repetitions, 0, 'Repetitions must reset to 0 on failure');
  assert.strictEqual(mergedSrsDirect['q_fail'].lastGrade, 1, 'Last grade must be failure (1)');

  // 2. 120-exam cloud pull capped at 15 exams & local size test
  const manyExams = [];
  for (let i = 0; i < 120; i++) {
    manyExams.push({
      examId: `exam_${i}`,
      title: `Test #${i}`,
      completedAt: 1700000000000 + i * 86400000,
      totalQuestions: 20,
      totalCorrect: 18,
      overallAccuracyPercent: 90,
      scores: { rwCorrect: 9, rwTotal: 10, mathCorrect: 9, mathTotal: 10 },
      moduleReports: [
        { name: 'RW', totalQuestions: 10, correct: 9, questions: [{ questionId: 'q1', userAnswer: 'A', isCorrect: true }] },
        { name: 'Math', totalQuestions: 10, correct: 9, questions: [{ questionId: 'q2', userAnswer: '1.5', isCorrect: true }] }
      ]
    });
  }

  mockCloudDb.default_student.examHistory = manyExams;

  const testStore = new MockStorage();
  const pullRes2 = await PSAT_ENGINE.pullFromCloud(testStore, mockFetch, 'default_student');
  assert.strictEqual(pullRes2.success, true);
  const localHistory = JSON.parse(testStore.getItem('psat_exam_history'));
  assert.strictEqual(localHistory.length, 15, 'Merged local exam history must be capped at 15 items');
  assert.strictEqual(localHistory[0].examId, 'exam_119', 'Latest exam must be at index 0');

  const historyByteSize = Buffer.byteLength(testStore.getItem('psat_exam_history'), 'utf8');
  assert.ok(historyByteSize < 25000, `psat_exam_history size (${historyByteSize} B) must be well under 25KB`);

  // 3. Error Handling Test (500 Server Error)
  mockServerFail = true;
  const failRes = await PSAT_ENGINE.pullFromCloud(testStore, mockFetch, 'default_student');
  assert.strictEqual(failRes.success, false, 'Failed server response must return success: false');
  assert.strictEqual(failRes.error, 'HTTP_500', 'Error code must report HTTP status');

  // 4. Partial Quota Failure Rollback Test
  mockServerFail = false;
  const rollbackStore = new MockStorage();
  rollbackStore.setItem('psat_progress', JSON.stringify({ 'orig_q': { isCorrect: true } }));
  // psat_srs does not exist initially

  const failingSetter = (key, val) => {
    if (key === 'psat_sessions') return false; // Consistently fail on sessions write
    rollbackStore.setItem(key, JSON.stringify(val));
    return true;
  };

  const quotaFailRes = await PSAT_ENGINE.pullFromCloud(rollbackStore, mockFetch, 'default_student', failingSetter);
  assert.strictEqual(quotaFailRes.success, false);
  // 5. Cleared Browser Preservation & Non-Destructive Cloud State Test
  // Device 1 answers 20 questions and pushes to cloud
  const dev1Store = new MockStorage();
  const dev1Prog = {};
  for (let i = 1; i <= 20; i++) {
    dev1Prog[`q_${i}`] = { answered: true, isCorrect: true, timeSpentMs: 30000, timestamp: 1000 + i };
  }
  dev1Store.setItem('psat_progress', JSON.stringify(dev1Prog));
  dev1Store.setItem('psat_sessions', JSON.stringify({ '2026-08-25': { date: '2026-08-25', questionsAnswered: 20, correct: 20, totalTimeMs: 600000 } }));
  await PSAT_ENGINE.pushToCloud(dev1Store, mockFetch, 'test_student_preserve');

  // Device 2 is a brand-new or cleared browser (completely empty localStorage)
  const dev2ClearedStore = new MockStorage();
  assert.strictEqual(dev2ClearedStore.getItem('psat_progress'), null, 'Cleared browser has null progress');

  // Device 2 pulls from cloud
  const dev2PullRes = await PSAT_ENGINE.pullFromCloud(dev2ClearedStore, mockFetch, 'test_student_preserve');
  assert.strictEqual(dev2PullRes.success, true);
  assert.strictEqual(dev2PullRes.totalAttempts, 20, 'Cleared browser must receive all 20 attempts from cloud');

  const dev2RecoveredProg = JSON.parse(dev2ClearedStore.getItem('psat_progress'));
  assert.strictEqual(Object.keys(dev2RecoveredProg).length, 20, 'Recovered progress must contain all 20 questions');

  // Device 2 answers 5 new questions and pushes
  for (let i = 21; i <= 25; i++) {
    dev2RecoveredProg[`q_${i}`] = { answered: true, isCorrect: true, timeSpentMs: 25000, timestamp: 2000 + i };
  }
  dev2ClearedStore.setItem('psat_progress', JSON.stringify(dev2RecoveredProg));
  await PSAT_ENGINE.pushToCloud(dev2ClearedStore, mockFetch, 'test_student_preserve');

  // Device 1 pulls from cloud: must have all 25 attempts
  await PSAT_ENGINE.pullFromCloud(dev1Store, mockFetch, 'test_student_preserve');
  const dev1FinalProg = JSON.parse(dev1Store.getItem('psat_progress'));
  assert.strictEqual(Object.keys(dev1FinalProg).length, 25, 'All 25 attempts must be unified and preserved across devices');

  // 6. Full Exam Score, Lean Compression, and Rehydration Verification
  const sampleRealExam = {
    id: 'test_drill_real',
    title: '5-Question Drill',
    type: 'gap_drill',
    totalQuestions: 5,
    modules: [{
      id: 'm1',
      section: 'Reading and Writing',
      moduleNumber: 1,
      questions: [
        { id: '15074829', test: 'Reading and Writing', skill: 'Information and Ideas', correct_answer: 'A', question_text: 'Sample prompt 1' },
        { id: '16832745', test: 'Math', skill: 'Algebra', correct_answer: '450', question_text: 'Sample prompt 2' }
      ]
    }]
  };
  const mockUserAnswers = { '15074829': 'A', '16832745': '450' };
  const mockUserTimes = { '15074829': 30000, '16832745': 25000 };
  const fullScoreReport = PSAT_ENGINE.scoreStandardExam(sampleRealExam, mockUserAnswers, mockUserTimes);
  assert.strictEqual(fullScoreReport.totalCorrect, 2);
  assert.strictEqual(fullScoreReport.overallAccuracyPercent, 100);

  const leanScoreReport = PSAT_ENGINE.toLeanReport(fullScoreReport);
  assert.strictEqual(leanScoreReport.overallAccuracyPercent, 100);
  assert.strictEqual(leanScoreReport.moduleReports[0].questions.length, 2);
  assert.strictEqual(leanScoreReport.moduleReports[0].questions[0].question_text, undefined, 'Lean report must strip redundant prompt text');

  const rehydratedReport = PSAT_ENGINE.rehydrateReport(leanScoreReport, sampleRealExam.modules[0].questions);
  assert.strictEqual(rehydratedReport.moduleReports[0].questions[0].question_text, 'Sample prompt 1', 'Rehydration must restore question text');
  assert.strictEqual(rehydratedReport.moduleReports[0].questions[0].isCorrect, true);

  // 7. Comprehensive Monotonicity & Section Scaling Verification
  // -------------------------------------------------------------
  // Test A: Monotonicity across all possible raw correct counts (0..54 for RW, 0..44 for Math)
  ['Standard', 'Hard', 'Easy'].forEach(track => {
    let prevScore = 0;
    for (let c = 0; c <= 54; c++) {
      const score = PSAT_ENGINE.calculateSectionScaledScore(c, 54, track, track !== 'Standard');
      assert.ok(score >= prevScore, `Score must be monotonic non-decreasing: at ${c}/54 (${track}), got ${score} < prev ${prevScore}`);
      assert.ok(score >= 120, `Score must never drop below section floor 120: got ${score}`);
      assert.ok(score <= 720, `Score must never exceed 720: got ${score}`);
      if (c === 0) {
        assert.strictEqual(score, 120, `0 correct on ${track} track MUST equal 120 baseline floor, never an artificial jump`);
      }
      prevScore = score;
    }
    if (track === 'Easy') {
      assert.ok(prevScore <= 580, `Easy track maximum score must be capped at 580: got ${prevScore}`);
    } else {
      assert.strictEqual(prevScore, 720, `100% accuracy on ${track} track must reach 720`);
    }
  });

  // Test B: Verify no artificial 480 floor jump for abandoned M2 on Hard track
  const abandonedM2Score = PSAT_ENGINE.calculateSectionScaledScore(16, 54, 'Hard', true);
  assert.ok(abandonedM2Score < 400, `Abandoned M2 (16/54 correct on Hard track) must score ~332, not >=480: got ${abandonedM2Score}`);

  // 8. MST Routing Cutoff Verification (>=58% accuracy threshold)
  // -------------------------------------------------------------
  const rwM1Total = 27;
  const rwPassing = 16; // 16/27 = 59.26% >= 58%
  const rwFailing = 15; // 15/27 = 55.56% < 58%
  assert.ok(rwPassing / rwM1Total >= 0.58, '16/27 must qualify for Upper Hard track');
  assert.ok(rwFailing / rwM1Total < 0.58, '15/27 must route to Standard Easy track');

  const mathM1Total = 22;
  const mathPassing = 13; // 13/22 = 59.09% >= 58%
  const mathFailing = 12; // 12/22 = 54.55% < 58%
  assert.ok(mathPassing / mathM1Total >= 0.58, '13/22 must qualify for Upper Hard track');
  assert.ok(mathFailing / mathM1Total < 0.58, '12/22 must route to Standard Easy track');

  // 9. Unified buildTroubleSpots Aggregation Verification
  // -----------------------------------------------------
  const mockTroubleProgress = {
    'q_trouble_1': { answered: true, isCorrect: false, timesIncorrect: 3, timesCorrect: 1, timesSeen: 4, timestamp: 1000 },
    'q_trouble_2': { answered: true, isCorrect: true, timesIncorrect: 0, timesCorrect: 2, timesSeen: 2, timestamp: 1001 }
  };
  const mockTroubleHistory = [
    {
      completedAt: 1005,
      moduleReports: [{
        questions: [
          { id: 'q_trouble_1', answered: true, isCorrect: false, userAnswer: 'B', timeSpentMs: 40000 },
          { id: 'q_trouble_3', answered: true, isCorrect: false, userAnswer: 'C', timeSpentMs: 35000 }
        ]
      }]
    }
  ];
  const mockQuestionsData = [
    { id: 'q_trouble_1', test: 'Math', skill: 'Algebra' },
    { id: 'q_trouble_2', test: 'Reading and Writing', skill: 'Information and Ideas' },
    { id: 'q_trouble_3', test: 'Math', skill: 'Geometry' }
  ];
  const aggregatedTrouble = PSAT_ENGINE.buildTroubleSpots(mockTroubleProgress, mockTroubleHistory, mockQuestionsData);
  assert.strictEqual(aggregatedTrouble.length, 2, 'Must contain exactly 2 missed items (q_trouble_1 and q_trouble_3)');
  const item1 = aggregatedTrouble.find(t => t.questionId === 'q_trouble_1');
  const item3 = aggregatedTrouble.find(t => t.questionId === 'q_trouble_3');
  assert.strictEqual(item1.timesWrong, 3, 'q_trouble_1 must reflect 3 misses');
  assert.strictEqual(item3.timesWrong, 1, 'q_trouble_3 from exam history must reflect 1 miss');

  // 10. mergeProgress with Disjoint Attempt Logs
  // --------------------------------------------
  const cloudProg = {
    'q_disjoint': {
      answered: true,
      isCorrect: true,
      timestamp: 1000,
      attempts: [
        { at: 1000, isCorrect: true, selectedAnswer: 'A', timeSpentMs: 30000 }
      ]
    }
  };
  const localProg = {
    'q_disjoint': {
      answered: true,
      isCorrect: false,
      timestamp: 2000,
      attempts: [
        { at: 2000, isCorrect: false, selectedAnswer: 'B', timeSpentMs: 25000 }
      ]
    }
  };
  const mergedDisjoint = PSAT_ENGINE.mergeProgress(cloudProg, localProg);
  const qRes = mergedDisjoint['q_disjoint'];
  assert.strictEqual(qRes.timesSeen, 2, '2 disjoint attempts must produce timesSeen = 2');
  assert.strictEqual(qRes.timesCorrect, 1, '1 correct attempt must produce timesCorrect = 1');
  assert.strictEqual(qRes.timesIncorrect, 1, '1 incorrect attempt must produce timesIncorrect = 1');
  assert.strictEqual(qRes.accuracyPercent, 50);
  assert.strictEqual(qRes.attempts.length, 2);

  // 11. Multi-Sync Non-Decay Test for Authoritative Lifetime Counters
  // ------------------------------------------------------------------
  let progressiveCloud = {
    'q_fifteen': {
      answered: true,
      isCorrect: true,
      timesSeen: 15,
      timesCorrect: 10,
      timesIncorrect: 5,
      accuracyPercent: 67,
      timestamp: 3000,
      attempts: [
        { at: 2800, isCorrect: true, selectedAnswer: 'A', timeSpentMs: 20000 },
        { at: 2900, isCorrect: false, selectedAnswer: 'B', timeSpentMs: 25000 },
        { at: 3000, isCorrect: true, selectedAnswer: 'A', timeSpentMs: 22000 }
      ]
    }
  };
  let progressiveLocal = {
    'q_fifteen': {
      answered: true,
      isCorrect: true,
      timesSeen: 15,
      timesCorrect: 10,
      timesIncorrect: 5,
      accuracyPercent: 67,
      timestamp: 3000,
      attempts: [
        { at: 3000, isCorrect: true, selectedAnswer: 'A', timeSpentMs: 22000 }
      ]
    }
  };

  // Sync 1, 2, and 3 must keep timesSeen=15 and timesIncorrect=5
  for (let syncCount = 1; syncCount <= 3; syncCount++) {
    const res = PSAT_ENGINE.mergeProgress(progressiveCloud, progressiveLocal);
    assert.strictEqual(res['q_fifteen'].timesSeen, 15, `Sync #${syncCount} must retain timesSeen = 15`);
    assert.strictEqual(res['q_fifteen'].timesIncorrect, 5, `Sync #${syncCount} must retain timesIncorrect = 5`);
    assert.strictEqual(res['q_fifteen'].timesCorrect, 10, `Sync #${syncCount} must retain timesCorrect = 10`);
    assert.strictEqual(res['q_fifteen'].attempts.length, 3, 'Attempts array must be capped at 3');
    progressiveCloud = res;
    progressiveLocal = res;
  }

  // 12. High-Yield Sprint Mode Prioritization Test
  // ------------------------------------------------------------------
  const mockPool = [
    { id: 'q_easy_unimportant', difficulty: 'Easy', domain: 'Expression of Ideas', test: 'Reading and Writing' },
    { id: 'q_hard_algebra', difficulty: 'Hard', domain: 'Algebra', test: 'Math' },
    { id: 'q_med_info_ideas', difficulty: 'Medium', domain: 'Information and Ideas', test: 'Reading and Writing' }
  ];

  const standardDraw = PSAT_ENGINE._prioritizeUnseen(mockPool, {}, { isHighYield: false });
  const highYieldDraw = PSAT_ENGINE._prioritizeUnseen(mockPool, {}, { isHighYield: true });

  assert.strictEqual(highYieldDraw.length, 3, 'High yield draw must include all items');
  // First two items in highYieldDraw must be the hard algebra and medium info ideas questions
  const top2Ids = [highYieldDraw[0].id, highYieldDraw[1].id];
  assert.ok(top2Ids.includes('q_hard_algebra'), 'Hard Algebra must be prioritized in top items');
  assert.ok(top2Ids.includes('q_med_info_ideas'), 'Medium Information & Ideas must be prioritized in top items');
  assert.strictEqual(highYieldDraw[2].id, 'q_easy_unimportant', 'Easy standard domain item must be placed after high-yield pool');

  // 13. Post-Exam Recovery Plan Generator (Regression & Real Dataset Tests)
  // ------------------------------------------------------------------
  // 13A. Real Mini Exam with 8/8 Perfect Answers -> Must NEVER create direct-miss recovery questions
  const realMiniForPlan = PSAT_ENGINE.generateMiniPSAT89Exam(realBank);
  const perfectMiniAnswers = {};
  realMiniForPlan.modules.forEach(m => {
    m.questions.forEach(q => {
      const forms = PSAT_ENGINE.extractAcceptedForms(q.correct_answer);
      perfectMiniAnswers[q.id] = forms.length > 0 ? forms[0] : q.correct_answer;
    });
  });

  const perfectReport = PSAT_ENGINE.scoreStandardExam(realMiniForPlan, perfectMiniAnswers, {});
  assert.strictEqual(perfectReport.totalCorrect, 8, 'All 8 answers must be scored correct');

  const perfectPlan = PSAT_ENGINE.generatePostExamRecoveryPlan(perfectReport, realBank, {});
  assert.ok(perfectPlan, 'Recovery plan must be generated');
  assert.strictEqual(perfectPlan.directMissesCount, 0, 'Perfect 8/8 exam must produce directMissesCount === 0');
  const directReviewInPerfect = perfectPlan.questions.filter(q => q._recoveryRole === 'missed_review');
  assert.strictEqual(directReviewInPerfect.length, 0, 'No questions in 8/8 plan can have _recoveryRole missed_review');

  // 13B. Real Mini Exam with Known Misses -> Assert ONLY those missed IDs appear as direct-review questions
  const flawedMiniAnswers = Object.assign({}, perfectMiniAnswers);
  const knownMiss1 = realMiniForPlan.modules[0].questions[0]; // RW miss
  const knownMiss2 = realMiniForPlan.modules[1].questions[0]; // Math miss
  flawedMiniAnswers[knownMiss1.id] = 'INCORRECT_CHOICE_XYZ';
  flawedMiniAnswers[knownMiss2.id] = '999999999';

  const flawedReport = PSAT_ENGINE.scoreStandardExam(realMiniForPlan, flawedMiniAnswers, {});
  assert.strictEqual(flawedReport.totalCorrect, 6, 'Must score exactly 6/8 correct');

  const flawedPlan = PSAT_ENGINE.generatePostExamRecoveryPlan(flawedReport, realBank, {});
  assert.ok(flawedPlan, 'Recovery plan must be generated');
  assert.strictEqual(flawedPlan.directMissesCount, 2, 'Must report exactly 2 direct misses');

  const missedReviewQuestions = flawedPlan.questions.filter(q => q._recoveryRole === 'missed_review');
  assert.strictEqual(missedReviewQuestions.length, 2, 'Exactly 2 questions must have _recoveryRole missed_review');
  const directMissIds = missedReviewQuestions.map(q => q.id).sort();
  const expectedMissIds = [knownMiss1.id, knownMiss2.id].sort();
  assert.deepStrictEqual(directMissIds, expectedMissIds, 'Direct review questions must strictly match the 2 known missed IDs');

  const transferQuestions = flawedPlan.questions.filter(q => q._recoveryRole === 'transfer_sibling');
  assert.strictEqual(transferQuestions.length, 2, 'Must include 2 transfer siblings matching the missed skills');

  // 15. Beta Environment Isolation Test
  // ------------------------------------------------------------------
  const prodEnv = PSAT_ENGINE.getEnvironmentConfig({ pathname: '/index.html', search: '' });
  assert.strictEqual(prodEnv.isBeta, false, 'Root path must resolve to production');
  assert.strictEqual(prodEnv.storagePrefix, '', 'Production storage prefix must be empty');
  assert.strictEqual(prodEnv.studentName, 'default_student', 'Production student profile must be default_student');

  const betaEnv = PSAT_ENGINE.getEnvironmentConfig({ pathname: '/beta/index.html', search: '' });
  assert.strictEqual(betaEnv.isBeta, true, '/beta/ path must resolve to beta');
  assert.strictEqual(betaEnv.storagePrefix, 'beta_', 'Beta storage prefix must be beta_');
  assert.strictEqual(betaEnv.studentName, 'beta_default_student', 'Beta student profile must be beta_default_student');

  const betaSearchEnv = PSAT_ENGINE.getEnvironmentConfig({ pathname: '/index.html', search: '?env=beta' });
  assert.strictEqual(betaSearchEnv.isBeta, true, '?env=beta query param must resolve to beta');
  assert.strictEqual(betaSearchEnv.storagePrefix, 'beta_');

  // 16. Client-Side Pre-Action Safety Snapshot & Bounding Test
  // ------------------------------------------------------------------
  const mockStorageMap = {};
  const mockStorage = {
    getItem: function(k) { return mockStorageMap[k] !== undefined ? mockStorageMap[k] : null; },
    setItem: function(k, v) { mockStorageMap[k] = String(v); },
    removeItem: function(k) { delete mockStorageMap[k]; }
  };

  mockStorage.setItem('psat_progress', JSON.stringify({ 'q1': { answered: true, isCorrect: true } }));
  mockStorage.setItem('psat_srs', JSON.stringify({ 'q1': { repetitions: 2 } }));

  // Create 7 snapshots to test pruning to max 5
  for (let i = 1; i <= 7; i++) {
    const snapResult = PSAT_ENGINE.createClientSnapshot(mockStorage, 'test_action_' + i);
    assert.strictEqual(snapResult.success, true, `Snapshot ${i} must succeed`);
  }

  const snapshotList = PSAT_ENGINE.listClientSnapshots(mockStorage);
  assert.strictEqual(snapshotList.length, 5, 'Client snapshots must be bounded to 5 items maximum');
  assert.strictEqual(snapshotList[0].reason, 'test_action_7', 'Newest snapshot must be at index 0');

  // Test Snapshot Rollback
  mockStorage.setItem('psat_progress', JSON.stringify({ 'corrupted_q': true }));
  const restoreRes = PSAT_ENGINE.restoreClientSnapshot(mockStorage, snapshotList[0].id);
  assert.strictEqual(restoreRes.success, true, 'Snapshot restore must succeed');
  const restoredProg = JSON.parse(mockStorage.getItem('psat_progress'));
  assert.ok(restoredProg.q1 && restoredProg.q1.isCorrect, 'Original data must be restored from snapshot');

  // 17. Beta Cloud Pull via Browser Storage Adapter (No Double Prefixing)
  // ------------------------------------------------------------------
  const betaStore = {};
  const betaStorageMock = {
    getItem: k => betaStore[k] !== undefined ? betaStore[k] : null,
    setItem: (k, v) => { betaStore[k] = String(v); },
    removeItem: k => { delete betaStore[k]; }
  };
  const browserSafeSetStorage = (key, val) => {
    betaStorageMock.setItem('beta_' + key, JSON.stringify(val));
    return true;
  };
  const fakeBetaFetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      success: true,
      exists: true,
      data: {
        progress: { 'q_beta_1': { answered: true, isCorrect: true, selectedAnswer: 'A' } },
        srsState: { 'q_beta_1': { repetitions: 1 } },
        sessionsState: {},
        examHistory: []
      }
    })
  });
  const pullBetaRes = await PSAT_ENGINE.pullFromCloud(betaStorageMock, fakeBetaFetch, 'beta_default_student', browserSafeSetStorage, { pathname: '/beta/index.html' });
  assert.strictEqual(pullBetaRes.success, true, 'Beta cloud pull must succeed');
  assert.ok(betaStore['beta_psat_progress'], 'Data must land at beta_psat_progress');
  const betaProgObj = JSON.parse(betaStore['beta_psat_progress']);
  assert.ok(betaProgObj['q_beta_1'] && betaProgObj['q_beta_1'].isCorrect, 'Beta question data must be stored correctly');
  assert.strictEqual(betaStore['beta_beta_psat_progress'], undefined, 'Must NEVER double-prefix to beta_beta_psat_progress');

  // 18. Pre-Restore Snapshot Failure Abort Guard Test
  // ------------------------------------------------------------------
  const failingStorageMap = {
    'psat_progress': JSON.stringify({ 'original_q': { answered: true, isCorrect: true } }),
    'psat_snapshot_snap_valid': JSON.stringify({
      id: 'snap_valid',
      timestamp: 12345,
      reason: 'backup',
      data: { progress: { 'restored_q': true }, srs: {}, sessions: {}, examHistory: [] }
    }),
    'psat_client_snapshots': JSON.stringify([{ id: 'snap_valid', key: 'psat_snapshot_snap_valid' }])
  };
  let failQuotaOnSnapshot = false;
  const failingStorage = {
    getItem: k => failingStorageMap[k] !== undefined ? failingStorageMap[k] : null,
    setItem: (k, v) => {
      if (failQuotaOnSnapshot && k.indexOf('psat_snapshot_') !== -1) {
        throw new Error('QuotaExceededError');
      }
      failingStorageMap[k] = String(v);
    },
    removeItem: k => { delete failingStorageMap[k]; }
  };
  failQuotaOnSnapshot = true;
  const abortRestoreRes = PSAT_ENGINE.restoreClientSnapshot(failingStorage, 'snap_valid', { pathname: '/index.html' });
  assert.strictEqual(abortRestoreRes.success, false, 'restoreClientSnapshot must fail if pre-restore snapshot fails');
  assert.ok(abortRestoreRes.error && abortRestoreRes.error.indexOf('Pre-restore safety snapshot failed') !== -1);
  const uncorruptedProg = JSON.parse(failingStorage.getItem('psat_progress'));
  assert.ok(uncorruptedProg.original_q && uncorruptedProg.original_q.isCorrect, 'Original progress must remain 100% untouched after aborted restore');
  assert.strictEqual(uncorruptedProg.restored_q, undefined, 'Restored data must NOT have been written');

  // 19. Environment-Aware Demo Mode Isolation Test (Beta vs Production)
  // ------------------------------------------------------------------
  const prodDataString = JSON.stringify({ 'prod_q1': { answered: true, isCorrect: true, selectedAnswer: 'B' } });
  const prodSrsString = JSON.stringify({ 'prod_q1': { repetitions: 3, intervalDays: 6 } });
  const prodHistString = JSON.stringify([{ id: 'prod_exam_1', title: 'Prod Exam 1' }]);
  
  const combinedStorageMap = {
    'psat_progress': prodDataString,
    'psat_srs': prodSrsString,
    'psat_exam_history': prodHistString,
    'psat_sessions': '{}',
    'beta_psat_progress': JSON.stringify({ 'beta_orig': { answered: true, isCorrect: true } }),
    'beta_psat_srs': '{}',
    'beta_psat_sessions': '{}',
    'beta_psat_exam_history': '[]'
  };
  const combinedStorage = {
    getItem: k => combinedStorageMap[k] !== undefined ? combinedStorageMap[k] : null,
    setItem: (k, v) => { combinedStorageMap[k] = String(v); },
    removeItem: k => { delete combinedStorageMap[k]; }
  };
  
  const betaLoc = { pathname: '/beta/index.html' };
  const prodLoc = { pathname: '/index.html' };
  
  // 1. Beta backup real data
  const backedUp = PSAT_ENGINE.backupRealData(combinedStorage, null, null, betaLoc);
  assert.strictEqual(backedUp, true, 'Beta backup real data must succeed');
  assert.ok(combinedStorageMap['beta_psat_pre_sample_backup'], 'Beta backup key must exist');
  assert.strictEqual(combinedStorageMap['psat_pre_sample_backup'], undefined, 'Production backup key must NOT be created');
  
  combinedStorage.setItem('beta_psat_sample_data_active', 'true');
  assert.strictEqual(PSAT_ENGINE.isDemoModeActive(combinedStorage, betaLoc), true, 'Beta demo mode must be active');
  assert.strictEqual(PSAT_ENGINE.isDemoModeActive(combinedStorage, prodLoc), false, 'Prod demo mode must NOT be active');
  
  // 2. Beta load sample data
  combinedStorage.setItem('beta_psat_progress', JSON.stringify({ 'beta_sample_q': true }));
  
  // 3. Beta restore real data
  const restoredBeta = PSAT_ENGINE.restoreRealData(combinedStorage, null, null, betaLoc);
  assert.strictEqual(restoredBeta, true, 'Beta restore real data must succeed');
  assert.strictEqual(PSAT_ENGINE.isDemoModeActive(combinedStorage, betaLoc), false, 'Beta demo mode must be deactivated');
  
  const restoredBetaProg = JSON.parse(combinedStorageMap['beta_psat_progress']);
  assert.ok(restoredBetaProg.beta_orig, 'Beta real data must be restored');
  assert.strictEqual(restoredBetaProg.beta_sample_q, undefined, 'Beta sample data must be removed');
  
  // 4. Assert production keys are byte-for-byte identical
  assert.strictEqual(combinedStorageMap['psat_progress'], prodDataString, 'psat_progress must be byte-for-byte unchanged');
  assert.strictEqual(combinedStorageMap['psat_srs'], prodSrsString, 'psat_srs must be byte-for-byte unchanged');
  assert.strictEqual(combinedStorageMap['psat_exam_history'], prodHistString, 'psat_exam_history must be byte-for-byte unchanged');
  assert.strictEqual(combinedStorageMap['psat_sample_data_active'], undefined, 'Production sample data flag must never be created');
  // 20. DATA-04: Durable Sync Outbox Tests
  // ------------------------------------------------------------------
  const outboxStoreMap = {};
  const outboxStorage = {
    getItem: k => outboxStoreMap[k] !== undefined ? outboxStoreMap[k] : null,
    setItem: (k, v) => { outboxStoreMap[k] = String(v); },
    removeItem: k => { delete outboxStoreMap[k]; }
  };

  // 20A. Enqueue question attempt
  const op1 = PSAT_ENGINE.enqueueOutboxOp(outboxStorage, 'question_attempt', { questionId: 'q_outbox_1', isCorrect: true }, prodLoc);
  assert.ok(op1 && op1.id, 'Enqueued op must have a unique ID');
  assert.strictEqual(op1.type, 'question_attempt');

  const op2 = PSAT_ENGINE.enqueueOutboxOp(outboxStorage, 'exam_completed', { examId: 'exam_outbox_1', totalScore: 1180 }, prodLoc);
  assert.ok(op2 && op2.id);

  // 20B. Get pending ops
  let pendingOps = PSAT_ENGINE.getOutboxOps(outboxStorage, prodLoc);
  assert.strictEqual(pendingOps.length, 2, 'Must return 2 pending outbox ops');
  assert.strictEqual(pendingOps[0].id, op1.id);
  assert.strictEqual(pendingOps[1].id, op2.id);

  // 20C. Acknowledge op1
  const ackedCount = PSAT_ENGINE.ackOutboxOps(outboxStorage, [op1.id], prodLoc);
  assert.strictEqual(ackedCount, 1, 'Must ack exactly 1 op');
  pendingOps = PSAT_ENGINE.getOutboxOps(outboxStorage, prodLoc);
  assert.strictEqual(pendingOps.length, 1, 'Only op2 must remain pending');
  assert.strictEqual(pendingOps[0].id, op2.id);

  // 20D. pushToCloud flushes outbox and acknowledges returned IDs
  let sentOutboxOps = [];
  const fakeOutboxFetch = (url, opts) => {
    const body = JSON.parse(opts.body);
    sentOutboxOps = body.outboxOps;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        success: true,
        ackOpIds: body.outboxOps.map(o => o.id),
        updatedAt: Date.now()
      })
    });
  };

  const pushOutboxRes = await PSAT_ENGINE.pushToCloud(outboxStorage, fakeOutboxFetch, 'default_student', prodLoc);
  assert.strictEqual(pushOutboxRes.success, true);
  assert.strictEqual(sentOutboxOps.length, 1, 'Must send the 1 remaining pending op');
  assert.strictEqual(sentOutboxOps[0].id, op2.id);
  assert.strictEqual(PSAT_ENGINE.getOutboxOps(outboxStorage, prodLoc).length, 0, 'Outbox must be completely empty after successful ack');

  // 21. DATA-05: Transactional Destructive Actions Tests
  // ------------------------------------------------------------------
  const transStoreMap = {
    'psat_progress': JSON.stringify({ 'orig_q': { answered: true, isCorrect: true } }),
    'psat_srs': JSON.stringify({ 'orig_q': { repetitions: 2 } }),
    'psat_sessions': '{}',
    'psat_exam_history': '[]',
    'psat_active_exam_state': JSON.stringify({ inProgressExamId: 'active_123' })
  };
  const transStorage = {
    getItem: k => transStoreMap[k] !== undefined ? transStoreMap[k] : null,
    setItem: (k, v) => { transStoreMap[k] = String(v); },
    removeItem: k => { delete transStoreMap[k]; }
  };

  // 21A. Successful Transactional Action
  const successActionRes = PSAT_ENGINE.runTransactionalAction(transStorage, 'test_success_action', function(ctx) {
    transStorage.setItem('psat_progress', JSON.stringify({ 'new_q': { answered: true } }));
    return { success: true, count: 1 };
  }, prodLoc);

  assert.strictEqual(successActionRes.success, true, 'Action must succeed');
  assert.ok(successActionRes.snapshotId, 'Must generate a safety snapshot ID');
  assert.ok(JSON.parse(transStorage.getItem('psat_progress')).new_q, 'New data must be committed');

  // 21B. Failed Transactional Action (Throws Exception) -> Automatic Rollback
  const failActionRes = PSAT_ENGINE.runTransactionalAction(transStorage, 'test_fail_action', function(ctx) {
    transStorage.setItem('psat_progress', JSON.stringify({ 'corrupted_state': true }));
    throw new Error('Disk quota exceeded halfway through write');
  }, prodLoc);

  assert.strictEqual(failActionRes.success, false, 'Action must report failure');
  assert.strictEqual(failActionRes.rolledBack, true, 'Action must flag automatic rollback');
  const progAfterRollback = JSON.parse(transStorage.getItem('psat_progress'));
  assert.ok(progAfterRollback.new_q, 'State must be cleanly restored to snapshot state before the failed action');
  assert.strictEqual(progAfterRollback.corrupted_state, undefined, 'Corrupted data must be completely discarded');

  // 22. DATA-06: Compact Long-Term SRS State & 20-Event Bounding Tests
  // ------------------------------------------------------------------
  let srsCard = { questionId: 'q_srs_compact', repetitions: 0, intervalDays: 1, easeFactor: 2.5, history: [] };

  // Simulate 35 consecutive reviews
  for (let rev = 1; rev <= 35; rev++) {
    srsCard = PSAT_ENGINE.scheduleNext(srsCard, 5, 1700000000000 + rev * 86400000, 30000);
  }

  assert.strictEqual(srsCard.totalReviews, 35, 'Must accurately retain totalReviews = 35');
  assert.strictEqual(srsCard.totalLapses, 0, 'totalLapses must be 0');
  assert.strictEqual(srsCard.history.length, 20, 'History log array must be bounded to newest 20 events');
  assert.strictEqual(srsCard.avgResponseTimeMs, 30000, 'Average response time must be 30,000ms');

  // Simulate a lapse
  srsCard = PSAT_ENGINE.scheduleNext(srsCard, 1, 1700000000000 + 36 * 86400000, 45000);
  assert.strictEqual(srsCard.totalReviews, 36);
  assert.strictEqual(srsCard.totalLapses, 1, 'Lapse must increment totalLapses counter');
  assert.strictEqual(srsCard.repetitions, 0, 'Repetitions must reset to 0 on failure');
  assert.strictEqual(srsCard.history.length, 20, 'History log array must remain bounded at 20 events');

  // Test compactSrsState helper on uncompacted legacy object
  const legacySrsState = {
    'q_legacy': {
      questionId: 'q_legacy',
      repetitions: 5,
      intervalDays: 10,
      easeFactor: 2.6,
      history: new Array(50).fill({ at: 1000, grade: 4, responseTimeMs: 25000 })
    }
  };
  const compacted = PSAT_ENGINE.compactSrsState(legacySrsState);
  assert.strictEqual(compacted.q_legacy.history.length, 20, 'compactSrsState must prune history array to 20 events');

  // 23. SCORE-01: Blueprint-Balanced Exam Generation & Duplicate-Free Guarantee
  // ------------------------------------------------------------------
  const fullExam = PSAT_ENGINE.generateStandardPSAT89Exam(realBank, { isAdaptive: false });
  assert.strictEqual(fullExam.blueprintVersion, 'PSAT89_2026_V1');
  assert.strictEqual(fullExam.totalQuestions, 98);

  const linearExamIds = [];
  fullExam.modules.forEach(mod => {
    mod.questions.forEach(q => { linearExamIds.push(q.id); });
  });
  assert.strictEqual(linearExamIds.length, 98);
  const uniqueLinearIds = new Set(linearExamIds);
  assert.strictEqual(uniqueLinearIds.size, 98, 'Every question in full standard exam must be strictly unique');

  // Validate RW Module 1 Domain Balance
  const rwM1 = fullExam.modules[0];
  assert.strictEqual(rwM1.questions.length, 27);
  const rwDomainCounts = {};
  rwM1.questions.forEach(q => { rwDomainCounts[q.domain] = (rwDomainCounts[q.domain] || 0) + 1; });
  assert.ok(rwDomainCounts['Craft and Structure'] >= 5, 'Craft and Structure must have at least 5 questions');
  assert.ok(rwDomainCounts['Information and Ideas'] >= 5, 'Information and Ideas must have at least 5 questions');
  assert.ok(rwDomainCounts['Standard English Conventions'] >= 5, 'Standard English Conventions must have at least 5 questions');
  assert.ok(rwDomainCounts['Expression of Ideas'] >= 4, 'Expression of Ideas must have at least 4 questions');

  // Validate Math Module 1 Domain & Type Balance
  const mathM1 = fullExam.modules[2];
  assert.strictEqual(mathM1.questions.length, 22);
  const mathDomainCounts = {};
  let mathSprCount = 0;
  mathM1.questions.forEach(q => {
    const norm = String(q.domain).replace(/[-\s]+/g, ' ').trim();
    mathDomainCounts[norm] = (mathDomainCounts[norm] || 0) + 1;
    if ((q.type || q.question_type) === 'free_response') mathSprCount++;
  });
  assert.ok(mathDomainCounts['Algebra'] >= 6, 'Algebra must have at least 6 questions');
  assert.ok(mathDomainCounts['Advanced Math'] >= 4, 'Advanced Math must have at least 4 questions');
  assert.ok(mathDomainCounts['Problem Solving and Data Analysis'] >= 3, 'Problem Solving must have at least 3 questions');
  assert.ok(mathDomainCounts['Geometry and Trigonometry'] >= 2, 'Geometry must have at least 2 questions');
  assert.strictEqual(mathSprCount, 5, 'Math Module 1 must contain exactly 5 student-produced responses');

  // Mini Exam Blueprint Verification
  const miniExam = PSAT_ENGINE.generateMiniPSAT89Exam(realBank, { isAdaptive: false });
  assert.strictEqual(miniExam.totalQuestions, 8);
  assert.strictEqual(miniExam.blueprintVersion, 'PSAT89_MINI_2026_V1');
  const miniIds = [];
  miniExam.modules.forEach(mod => { mod.questions.forEach(q => { miniIds.push(q.id); }); });
  assert.strictEqual(new Set(miniIds).size, 8, 'Mini exam must have 8 unique questions');

  // 24. SCORE-01: Calibrated Scaled Score Ranges, Confidence Metrics & Data Basis
  // ------------------------------------------------------------------
  // Score standard exam
  const fullExamAnswers = {};
  fullExam.modules.forEach(mod => {
    mod.questions.forEach((q, idx) => {
      if (idx % 4 !== 0) fullExamAnswers[q.id] = q.correct_answer; // 75% accuracy
    });
  });
  const fullScored = PSAT_ENGINE.scoreStandardExam(fullExam, fullExamAnswers, {});
  assert.strictEqual(fullScored.scores.isScaledReady, true);
  assert.ok(typeof fullScored.scores.totalScaled === 'number');
  assert.ok(Array.isArray(fullScored.scores.totalRange) && fullScored.scores.totalRange.length === 2);
  assert.ok(fullScored.scores.totalRange[0] <= fullScored.scores.totalScaled);
  assert.ok(fullScored.scores.totalRange[1] >= fullScored.scores.totalScaled);
  assert.ok(typeof fullScored.scores.totalRangeFormatted === 'string');
  assert.strictEqual(fullScored.scores.confidenceInterval, '90% Confidence Interval');
  assert.strictEqual(fullScored.scores.examCategory, 'standard_benchmark');
  assert.ok(fullScored.scores.rwRangeFormatted);
  assert.ok(fullScored.scores.mathRangeFormatted);

  // calculateScaledScore helper checks
  const dummyProg = {};
  realEla.slice(0, 20).forEach((q, idx) => {
    dummyProg[q.id] = { answered: true, isCorrect: idx % 2 === 0 };
  });
  realMath.slice(0, 20).forEach((q, idx) => {
    dummyProg[q.id] = { answered: true, isCorrect: idx % 2 === 0 };
  });
  const bankScore = PSAT_ENGINE.calculateScaledScore(realBank, dummyProg);
  assert.strictEqual(bankScore.isReady, true);
  assert.ok(bankScore.totalRangeFormatted);
  assert.ok(bankScore.rwRangeFormatted);
  assert.ok(bankScore.mathRangeFormatted);
  assert.ok(bankScore.confidenceInterval);
  assert.ok(bankScore.dataBasis);

  // 25. SRS-02: Tag-Driven Adaptive Coaching Interventions & Longitudinal Trends
  // ------------------------------------------------------------------
  const tagProg = {};
  const conceptQ1 = realBank[0];
  const conceptQ2 = realBank[1];
  const timeQ1 = realBank[2];
  tagProg[conceptQ1.id] = { answered: true, isCorrect: false, errorTag: 'concept_gap', timestamp: Date.now() };
  tagProg[conceptQ2.id] = { answered: true, isCorrect: false, errorTag: 'concept_gap', timestamp: Date.now() };
  tagProg[timeQ1.id] = { answered: true, isCorrect: false, errorTag: 'time_pressure', timestamp: Date.now() - 10 * 86400000 };

  const conceptDrill = PSAT_ENGINE.generateTagCoachingDrill(realBank, tagProg, 'concept_gap', { count: 8 });
  assert.strictEqual(conceptDrill.tagId, 'concept_gap');
  assert.ok(conceptDrill.questions.length >= 2);
  assert.strictEqual(conceptDrill.isSpeedRound, false);

  const speedDrill = PSAT_ENGINE.generateTagCoachingDrill(realBank, tagProg, 'time_pressure', { count: 6 });
  assert.strictEqual(speedDrill.tagId, 'time_pressure');
  assert.strictEqual(speedDrill.isSpeedRound, true);
  assert.strictEqual(speedDrill.timeLimitPerQuestionSeconds, 45, 'Time pressure drills must use 45s speed timer');

  const errorTrends = PSAT_ENGINE.calculateErrorTagTrends(tagProg, []);
  assert.strictEqual(errorTrends.currentWeek.concept_gap, 2, 'Must count 2 concept gaps this week');
  assert.strictEqual(errorTrends.priorWeek.time_pressure, 1, 'Must count 1 time pressure error in prior week');
  assert.strictEqual(errorTrends.lifetime.concept_gap, 2);
  assert.strictEqual(errorTrends.lifetime.time_pressure, 1);

  console.log('✓ All Spaced Repetition (SM-2), Real Dataset Exam Generation, Mini Exam Simulation, Monotonicity Scaling, Trouble Spot Aggregation, Lifetime Counter Retention, High-Yield Prioritization, Post-Exam Recovery Plan Generator, Error Tagging, Beta Isolation, Client Safety Snapshots, Beta Adapter Pull, Snapshot Restore Abort, Demo Mode Isolation, Durable Sync Outbox, Transactional Destructive Actions, Compact Long-Term SRS State, Blueprint-Balanced Modules, Calibrated Score Confidence Ranges, Error Tag Coaching Drills, Longitudinal Error Trends, and Cosmos DB Cloud Sync tests passed!');
})();






