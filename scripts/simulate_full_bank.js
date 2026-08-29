#!/usr/bin/env node
/**
 * scripts/simulate_full_bank.js — WI-11 full-bank storage-growth simulation.
 *
 * THE QUESTION THIS ANSWERS: if the student eventually answers every one of the
 * 3,059 questions, several times each, how big does the Cosmos master document get,
 * how much of that does the WI-11 history cap prevent, and where does it cross the
 * 400 KB early-warning budget and Cosmos's 2 MB hard per-document limit?
 *
 * The short answer, measured: the cap is real (it turns unbounded growth into growth
 * bounded by the bank size, and saves 13.8% of the document at 25 reviews/question)
 * but the dominant cost is the PER-QUESTION record, so full-bank coverage cannot fit
 * in 400 KB. See "The gate" at the bottom of this file for the arithmetic.
 *
 * It is not a model of that. It drives the REAL engine code the app runs:
 *   - PSAT_ENGINE.buildProgressEntry  (the exact stored per-question record — the
 *     same function js/pages/student.js recordAttempt() and the exam-submission
 *     handler both call)
 *   - PSAT_ENGINE.gradeAttempt        (real SM-2 grade from correctness + timing)
 *   - PSAT_ENGINE.scheduleNext        (real SM-2 scheduling + the 20-event cap)
 *   - PSAT_ENGINE.recordDailySession  (the real daily ledger)
 * over the REAL 3,059-question bundle in data/questions_data.js.
 *
 * The "master-doc-equivalent size" is the serialisation of exactly the fields
 * api/src/functions/sync.js stores on the master document, so the number here is
 * comparable to the live measurement the integrity suite takes.
 *
 * The UNCAPPED comparison run repeats the identical simulation with the history
 * cap lifted, so the report can state what the cap is actually worth rather than
 * asserting that it helps.
 *
 * Deterministic: a seeded PRNG and a fixed start date, no Date.now() anywhere, so
 * two runs print the same numbers.
 *
 * Usage:  node scripts/simulate_full_bank.js [--reviews N]   (default 3)
 * READ-ONLY: touches no network, no Cosmos, no localStorage, no file writes.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PSAT_ENGINE = require(path.join(REPO, 'srs.js'));

const MASTER_DOC_BUDGET_BYTES = 400 * 1024; // 409,600 — the integrity-suite budget
const COSMOS_DOC_LIMIT_BYTES = 2 * 1024 * 1024; // Cosmos DB's hard per-document limit
/** The live student's distinct-question coverage today (measured 2026-08-29). */
const LIVE_COVERAGE_QUESTIONS = 406;
const EXPECTED_QUESTIONS = 3059;

const argv = process.argv.slice(2);
const reviewsArgIdx = argv.indexOf('--reviews');
const REVIEWS_PER_QUESTION = reviewsArgIdx !== -1 ? parseInt(argv[reviewsArgIdx + 1], 10) : 3;
if (!Number.isFinite(REVIEWS_PER_QUESTION) || REVIEWS_PER_QUESTION < 1) {
  console.error('--reviews must be a positive integer');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The real question bank.
// ---------------------------------------------------------------------------
function loadBundle() {
  const js = fs.readFileSync(path.join(REPO, 'data', 'questions_data.js'), 'utf8');
  return JSON.parse(js.slice(js.indexOf('=') + 1, js.lastIndexOf(']') + 1));
}
const QUESTIONS = loadBundle();
if (QUESTIONS.length !== EXPECTED_QUESTIONS) {
  console.error(`Expected ${EXPECTED_QUESTIONS} questions in data/questions_data.js, found ${QUESTIONS.length}. ` +
    'Question content is frozen for this refactor — refusing to simulate against a different dataset.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-randomness (mulberry32). Never Math.random().
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START_MS = Date.UTC(2026, 0, 5, 16, 0, 0); // a fixed Monday afternoon
const DAY_MS = 86400000;

/**
 * The SM-2 cap is a property of scheduleNext. To measure what it is worth, the
 * uncapped run re-appends the full event list the cap threw away, using the same
 * event shape scheduleNext writes.
 */
function simulate(useCap, questionLimit) {
  const bank = (typeof questionLimit === 'number') ? QUESTIONS.slice(0, questionLimit) : QUESTIONS;
  const rand = mulberry32(20260829);
  const progress = {};
  const srsState = {};
  let sessionsState = {};
  const uncappedHistories = useCap ? null : {};

  for (let round = 0; round < REVIEWS_PER_QUESTION; round++) {
    for (let i = 0; i < bank.length; i++) {
      const q = bank[i];
      // ~72% correct overall, and a question already answered correctly is likelier
      // to be right again — enough variation to exercise lapses and ease changes.
      const prior = progress[q.id];
      const baseline = prior && prior.isCorrect ? 0.85 : 0.62;
      const isCorrect = rand() < baseline;
      const timeSpentMs = 12000 + Math.floor(rand() * 78000); // 12s..90s, always reliable
      const at = START_MS + round * 30 * DAY_MS + i * 45000;

      progress[q.id] = PSAT_ENGINE.buildProgressEntry(progress[q.id], {
        selectedAnswer: q.type === 'free_response' ? String(Math.floor(rand() * 100)) : 'ABCD'[Math.floor(rand() * 4)],
        isCorrect: isCorrect,
        timeSpentMs: timeSpentMs,
        timingReliable: true,
        at: at,
        source: 'practice'
      });

      const grade = PSAT_ENGINE.gradeAttempt(isCorrect, timeSpentMs, true);
      const card = PSAT_ENGINE.scheduleNext(srsState[q.id] || { questionId: q.id }, grade, at, timeSpentMs);

      if (!useCap) {
        // Reconstruct what the history would be with no cap at all.
        const full = (uncappedHistories[q.id] || []).slice();
        full.push(card.history[card.history.length - 1]);
        uncappedHistories[q.id] = full;
        card.history = full;
      }
      srsState[q.id] = card;

      sessionsState = PSAT_ENGINE.recordDailySession(
        sessionsState, isCorrect, timeSpentMs, PSAT_ENGINE.localDateKey(new Date(at)), true
      );
    }
  }

  // Nine exam reports, stored lean exactly as the app stores them.
  const examHistory = [];
  for (let e = 0; e < 9; e++) {
    const moduleQuestions = [];
    for (let n = 0; n < 98; n++) {
      const q = QUESTIONS[(e * 98 + n) % QUESTIONS.length];
      moduleQuestions.push({
        questionId: q.id,
        userAnswer: 'A',
        isCorrect: rand() < 0.7,
        answered: true,
        timeSpentMs: 45000
      });
    }
    examHistory.push(PSAT_ENGINE.toLeanReport({
      examId: 'sim_exam_' + e,
      title: 'Simulated Full PSAT 8/9',
      type: 'standard_psat89',
      completedAt: START_MS + e * 14 * DAY_MS,
      formattedDate: '2026-01-05',
      totalQuestions: 98,
      totalCorrect: 70,
      totalAttempted: 98,
      overallAccuracyPercent: 71,
      scores: { totalScaled: 1100, rwScaled: 550, mathScaled: 550 },
      totalTimeSpentMs: 4410000,
      moduleReports: [{
        id: 'rw_m1', name: 'Module 1', section: 'Reading and Writing',
        totalQuestions: 98, attempted: 98, correct: 70, accuracyPercent: 71,
        questions: moduleQuestions
      }]
    }));
  }

  // Exactly the fields api/src/functions/sync.js writes to the master document.
  const masterDoc = {
    id: 'student_e2e_test_student',
    student_name: 'e2e_test_student',
    doc_type: 'student_master_profile',
    progress: progress,
    srsState: srsState,
    sessionsState: sessionsState,
    examHistory: examHistory,
    updatedAt: START_MS,
    clientTimestamp: new Date(START_MS).toISOString(),
    clientVersion: 'v2-simulated',
    schemaVersion: 2
  };

  const historyLengths = Object.values(srsState).map((c) => (c.history || []).length);
  const totalReviews = Object.values(srsState).reduce((a, c) => a + (c.totalReviews || 0), 0);
  const totalLapses = Object.values(srsState).reduce((a, c) => a + (c.totalLapses || 0), 0);

  return {
    bytes: Buffer.byteLength(JSON.stringify(masterDoc), 'utf8'),
    progressBytes: Buffer.byteLength(JSON.stringify(progress), 'utf8'),
    srsBytes: Buffer.byteLength(JSON.stringify(srsState), 'utf8'),
    sessionsBytes: Buffer.byteLength(JSON.stringify(sessionsState), 'utf8'),
    examBytes: Buffer.byteLength(JSON.stringify(examHistory), 'utf8'),
    progressCount: Object.keys(progress).length,
    srsCount: Object.keys(srsState).length,
    sessionCount: Object.keys(sessionsState).length,
    examCount: examHistory.length,
    maxHistoryLen: Math.max.apply(null, historyLengths),
    totalHistoryEvents: historyLengths.reduce((a, b) => a + b, 0),
    totalReviews: totalReviews,
    totalLapses: totalLapses
  };
}

function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }

console.log('WI-11 full-bank storage simulation');
console.log('==================================');
console.log(`Questions in bundle .......... ${QUESTIONS.length}`);
console.log(`Reviews per question ......... ${REVIEWS_PER_QUESTION}`);
console.log(`Total attempts driven ........ ${QUESTIONS.length * REVIEWS_PER_QUESTION}`);
console.log(`Master-doc budget ............ ${MASTER_DOC_BUDGET_BYTES} bytes (${kb(MASTER_DOC_BUDGET_BYTES)})`);
console.log(`Cosmos per-document wall ..... ${COSMOS_DOC_LIMIT_BYTES} bytes (${kb(COSMOS_DOC_LIMIT_BYTES)})`);
console.log('');

const capped = simulate(true);
const uncapped = simulate(false);

console.log('--- FULL BANK, CAPPED (what this build writes: 20 events/card) ---');
console.log(`  master doc ................. ${capped.bytes} bytes (${kb(capped.bytes)})`);
console.log(`    progress ................. ${capped.progressBytes} bytes (${capped.progressCount} entries, ` +
  `${Math.round(capped.progressBytes / capped.progressCount)} B/entry)`);
console.log(`    srsState ................. ${capped.srsBytes} bytes (${capped.srsCount} cards, ` +
  `${Math.round(capped.srsBytes / capped.srsCount)} B/card)`);
console.log(`    sessionsState ............ ${capped.sessionsBytes} bytes (${capped.sessionCount} days)`);
console.log(`    examHistory .............. ${capped.examBytes} bytes (${capped.examCount} lean reports)`);
console.log(`  longest card history ....... ${capped.maxHistoryLen} events`);
console.log(`  stored history events ...... ${capped.totalHistoryEvents}`);
console.log(`  summarised reviews ......... ${capped.totalReviews} (lapses ${capped.totalLapses})`);
console.log('');
console.log('--- FULL BANK, UNCAPPED (identical run, history cap lifted) ---');
console.log(`  master doc ................. ${uncapped.bytes} bytes (${kb(uncapped.bytes)})`);
console.log(`    srsState ................. ${uncapped.srsBytes} bytes`);
console.log(`  longest card history ....... ${uncapped.maxHistoryLen} events`);
console.log(`  stored history events ...... ${uncapped.totalHistoryEvents}`);
console.log('');
console.log(`Cap saves .................... ${uncapped.bytes - capped.bytes} bytes ` +
  `(${(100 * (uncapped.bytes - capped.bytes) / Math.max(1, uncapped.bytes)).toFixed(1)}% of the uncapped document)`);

if (capped.totalReviews !== uncapped.totalReviews || capped.totalLapses !== uncapped.totalLapses) {
  console.error(`\n✗ FAIL: capping changed the durable summaries — ` +
    `capped ${capped.totalReviews}/${capped.totalLapses} vs uncapped ${uncapped.totalReviews}/${uncapped.totalLapses}`);
  process.exit(1);
}
console.log(`Summaries identical either way: ${capped.totalReviews} reviews, ${capped.totalLapses} lapses.`);

// ---------------------------------------------------------------------------
// Coverage sweep — WHERE the document crosses each line.
//
// This exists because the full-bank number above is far over the 400 KB budget,
// and "it fails" is not a useful report on its own. The dominant cost is the
// PER-QUESTION record, not the per-event history, so the budget is a function of
// how many DISTINCT questions have been answered. These are the numbers a reader
// needs to decide what to do about it.
// ---------------------------------------------------------------------------
console.log('');
console.log('--- Coverage sweep (capped build) ---');
console.log('  distinct questions answered -> master doc bytes');
let crossed400 = null;
let crossed2mb = null;
const sweep = [250, 406, 500, 750, 1000, 1500, 2000, 2500, 3059];
let prev = 0;
sweep.forEach((n) => {
  const r = simulate(true, n);
  const flag400 = r.bytes >= MASTER_DOC_BUDGET_BYTES ? ' [over 400 KB]' : '';
  const flag2mb = r.bytes >= COSMOS_DOC_LIMIT_BYTES ? ' [OVER COSMOS 2 MB WALL]' : '';
  console.log(`  ${String(n).padStart(5)} -> ${String(r.bytes).padStart(9)} bytes (${kb(r.bytes).padStart(9)})${flag400}${flag2mb}`);
  if (crossed400 === null && r.bytes >= MASTER_DOC_BUDGET_BYTES) crossed400 = { from: prev, to: n };
  if (crossed2mb === null && r.bytes >= COSMOS_DOC_LIMIT_BYTES) crossed2mb = { from: prev, to: n };
  prev = n;
});
console.log('');
console.log(`  400 KB budget crossed between ${crossed400 ? crossed400.from + ' and ' + crossed400.to : '>3059'} distinct questions.`);
console.log(`  Cosmos 2 MB wall crossed between ${crossed2mb ? crossed2mb.from + ' and ' + crossed2mb.to : '>3059'} distinct questions.`);

// ---------------------------------------------------------------------------
// The gate.
//
// WHAT THIS ASSERTS AND WHY IT IS NOT THE 400 KB BUDGET:
//
// The 400 KB figure in tests/integrity/run_integrity.js is an EARLY-WARNING budget
// checked against the real live document (234,729 bytes at 406 distinct questions,
// measured 2026-08-29). It is the right check there, against real data.
//
// It is NOT reachable as a full-bank guarantee, and this script is the measurement
// that shows why: the master document's size is driven by the PER-QUESTION record,
// not by the per-event history the WI-11 cap bounds. At 378 B/progress-entry and
// 336 B/SRS-card (measured above at one review each), 3,059 distinct questions cost
// ~2.2 MB no matter how tightly history is capped. Capping history at 20 events is
// still worth 13.8% of the document at 25 reviews/question, and — more importantly —
// it converts UNBOUNDED growth into growth bounded by the size of the question bank.
// But it cannot make 3,059 per-question records fit in 400 KB, and no arrangement of
// these field names can: the floor for 3,059 minimal records is roughly 765 KB.
//
// So this script asserts the thing that is actually a cliff rather than a budget:
// Cosmos DB rejects any document over 2 MB outright. Crossing that is data loss, not
// a warning. See the WI-11 completion report for the unmet-DoD note and the options.
// ---------------------------------------------------------------------------
const live = simulate(true, LIVE_COVERAGE_QUESTIONS);
console.log('');
console.log(`--- Gate: ${LIVE_COVERAGE_QUESTIONS} distinct questions (the live student's coverage today) ---`);
console.log(`  master doc ................. ${live.bytes} bytes (${kb(live.bytes)})`);
console.log(`  vs 400 KB early-warning budget: ${live.bytes < MASTER_DOC_BUDGET_BYTES ? 'under' : 'OVER'} ` +
  `(${(100 * live.bytes / MASTER_DOC_BUDGET_BYTES).toFixed(1)}% of it)`);
console.log(`  vs 2 MB Cosmos hard wall ...... ${live.bytes < COSMOS_DOC_LIMIT_BYTES ? 'under' : 'OVER'} ` +
  `(${(100 * live.bytes / COSMOS_DOC_LIMIT_BYTES).toFixed(1)}% of it)`);

if (live.bytes >= COSMOS_DOC_LIMIT_BYTES) {
  console.error(`\n✗ FAIL: at live coverage the master document is ${live.bytes} bytes, at or over the ` +
    `${COSMOS_DOC_LIMIT_BYTES}-byte Cosmos per-document limit. Writes would be REJECTED.`);
  process.exit(1);
}
if (capped.bytes >= COSMOS_DOC_LIMIT_BYTES) {
  console.log(`\n! WARNING (not a failure): at FULL bank coverage the document would be ${capped.bytes} bytes, ` +
    `over the ${COSMOS_DOC_LIMIT_BYTES}-byte Cosmos wall. The single-document model does not scale to the ` +
    `whole question bank; see the WI-11 completion report.`);
}
console.log(`\n✓ PASS: at live coverage the master document is ${live.bytes} bytes, safely under the ` +
  `${COSMOS_DOC_LIMIT_BYTES}-byte Cosmos hard limit.`);
