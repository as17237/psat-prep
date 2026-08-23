const assert = require('assert');
const PSAT_ENGINE = require('../srs.js');

console.log('Testing Spaced Repetition (SM-2) Engine...');

// 1. Grade Attempt timing thresholds
assert.strictEqual(PSAT_ENGINE.gradeAttempt(false, 10000), 1, 'Incorrect answer must yield grade 1');
assert.strictEqual(PSAT_ENGINE.gradeAttempt(true, 30000), 5, 'Correct in 30s must yield grade 5');
assert.strictEqual(PSAT_ENGINE.gradeAttempt(true, 60000), 4, 'Correct in 60s must yield grade 4');
assert.strictEqual(PSAT_ENGINE.gradeAttempt(true, 120000), 3, 'Correct in 120s must yield grade 3');

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

// 3. Scaled score modeling
const mockQuestions = [
  { id: 'q1', test: 'Reading and Writing' },
  { id: 'q2', test: 'Reading and Writing' },
  { id: 'q3', test: 'Math' },
  { id: 'q4', test: 'Math' }
];
const mockProgress = {
  q1: { answered: true, isCorrect: true },
  q2: { answered: true, isCorrect: false }
};
const scoreInfo = PSAT_ENGINE.calculateScaledScore(mockQuestions, mockProgress);
assert.strictEqual(scoreInfo.isReady, false, 'Score should not be ready with <15 attempts');
assert.strictEqual(scoreInfo.totalScore, null);

// 4. Streak Calculation
const sessions = {
  '2026-08-21': { questionsAnswered: 5 },
  '2026-08-22': { questionsAnswered: 10 },
  '2026-08-23': { questionsAnswered: 8 }
};
assert.strictEqual(PSAT_ENGINE.calculateStreak(sessions), 3, 'Consecutive 3 days must give streak 3');

console.log('✓ All Spaced Repetition (SM-2) tests passed!');
