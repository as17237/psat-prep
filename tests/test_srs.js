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

// 4. Local Date and Streak Calculation across month boundaries
const localToday = PSAT_ENGINE.localDateKey();
assert.strictEqual(typeof localToday, 'string');
assert.match(localToday, /^\d{4}-\d{2}-\d{2}$/);

// Streak crossing month boundary (30 Aug -> 31 Aug -> 1 Sep -> 2 Sep)
const sessionsMonthBoundary = {
  '2026-08-30': { questionsAnswered: 5 },
  '2026-08-31': { questionsAnswered: 10 },
  '2026-09-01': { questionsAnswered: 8 }
};
// If tested on 2026-09-01
// Test day difference logic:
function testStreakDates(datesList, referenceToday) {
  const map = {};
  datesList.forEach(d => { map[d] = { questionsAnswered: 5 }; });
  // override localDateKey inside test scope
  const original = PSAT_ENGINE.localDateKey;
  PSAT_ENGINE.localDateKey = () => referenceToday;
  const res = PSAT_ENGINE.calculateStreak(map);
  PSAT_ENGINE.localDateKey = original;
  return res;
}

assert.strictEqual(testStreakDates(['2026-08-31', '2026-09-01'], '2026-09-01'), 2, 'Month boundary streak must be 2');
assert.strictEqual(testStreakDates(['2026-08-30', '2026-08-31', '2026-09-01'], '2026-09-01'), 3, 'Month boundary streak must be 3');

console.log('✓ All Spaced Repetition (SM-2) and Scoring tests passed!');
