#!/usr/bin/env node
/**
 * scripts/simulate_full_bank.js — full-bank storage-growth simulation.
 *
 * THE QUESTION THIS ANSWERS: if the student eventually answers every one of the 3,059
 * questions, reviews some of them many times, and completes a full history of mock
 * exams — how big does every stored document get, and does anything approach Cosmos
 * DB's 2 MB hard per-document wall?
 *
 * ---------------------------------------------------------------------------
 * WHAT WI-11.5 FIXED IN THIS SCRIPT (read this before trusting an old run)
 * ---------------------------------------------------------------------------
 * The WI-11 version of this file had two defects that made its headline numbers
 * unrepresentative of the worst case it claimed to measure:
 *
 *   1. It drove exactly `--reviews` (default 3) reviews per question, uniformly. The
 *      SRS history cap is 20 events, so the cap NEVER ENGAGED: longest history was 3,
 *      "cap saves" was 0 bytes, and the script's own conclusion — "the cap is worth
 *      nothing" — was an artefact of the scenario, not a property of the code.
 *      Fixed: a DEEP subset (default: 400 questions × 25 extra reviews) now drives the
 *      cap past 20 events, so the capped/uncapped comparison measures something real.
 *
 *   2. It generated 9 exams. The master document keeps EXAM_HISTORY_CAP = 50, and a
 *      98-question mock's lean report is ~8-9 KB, so the honest worst case for exam
 *      history is ~5x what the script was measuring. Fixed: it now drives the cap.
 *
 * It drives the REAL engine code the app runs, over the REAL 3,059-question bundle:
 *   PSAT_ENGINE.buildProgressEntry / gradeAttempt / scheduleNext / recordDailySession /
 *   toLeanReport, plus api/src/lib/datamodel.js and api/src/lib/shardsync.js — the exact
 *   slimming, bucketing and document-planning the server performs on every POST.
 *
 * Deterministic: seeded PRNG, fixed start date, no Date.now(). Two runs print the same
 * numbers. READ-ONLY: no network, no Cosmos, no localStorage, no file writes.
 *
 * Usage:
 *   node scripts/simulate_full_bank.js
 *   node scripts/simulate_full_bank.js --reviews 3 --deep-questions 400 --deep-reviews 25 --exams 50
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PSAT_ENGINE = require(path.join(REPO, 'srs.js'));
const dm = require(path.join(REPO, 'api', 'src', 'lib', 'datamodel.js'));
const shardsync = require(path.join(REPO, 'api', 'src', 'lib', 'shardsync.js'));
const { EXAM_HISTORY_CAP } = require(path.join(REPO, 'api', 'src', 'lib', 'merge.js'));

const DOC_BUDGET_BYTES = 400 * 1024;            // 409,600 — the integrity-suite budget
const COSMOS_DOC_LIMIT_BYTES = 2 * 1024 * 1024; // Cosmos DB's hard per-document limit
const EXPECTED_QUESTIONS = 3059;

/**
 * The pre-WI-11.5 measurement this run is compared against: the single-master-document
 * model at full bank with the OLD scenario (3 reviews/question, 9 exams, no deep subset).
 * Reproduced exactly by this script's `--legacy-baseline` scenario, so the comparison is
 * a measurement rather than a remembered figure.
 */
const WI11_BASELINE_BYTES = 3367863;

function intArg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = parseInt(process.argv[i + 1], 10);
  if (!Number.isFinite(v) || v < 0) {
    console.error(`--${name} must be a non-negative integer`);
    process.exit(2);
  }
  return v;
}

const REVIEWS_PER_QUESTION = intArg('reviews', 3);
const DEEP_QUESTIONS = intArg('deep-questions', 400);
const DEEP_REVIEWS = intArg('deep-reviews', 25);
const EXAM_COUNT = intArg('exams', EXAM_HISTORY_CAP);

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
 * Drives the real engine over a scenario and returns the resulting state.
 *
 * @param {Object} sc
 * @param {boolean} sc.useCap      false re-appends the events the 20-event cap dropped,
 *                                 so the two runs differ ONLY by the cap
 * @param {number} sc.coverage     distinct questions answered
 * @param {number} sc.reviews      reviews for every covered question
 * @param {number} sc.deepQuestions questions that additionally get `deepReviews` reviews
 * @param {number} sc.deepReviews
 * @param {number} sc.exams        completed full mocks
 */
function drive(sc) {
  const bank = QUESTIONS.slice(0, sc.coverage);
  const rand = mulberry32(20260829);
  const progress = {};
  const srsState = {};
  let sessionsState = {};
  const uncappedHistories = sc.useCap ? null : {};
  let round = 0;

  function pass(subset, rounds) {
    for (let r = 0; r < rounds; r++, round++) {
      for (let i = 0; i < subset.length; i++) {
        const q = subset[i];
        // ~72% correct overall, and a question already answered correctly is likelier to
        // be right again — enough variation to exercise lapses and ease changes.
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

        if (!sc.useCap) {
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
  }

  // 1. Broad pass: every covered question, `reviews` times.
  pass(bank, sc.reviews);
  // 2. Deep pass: the questions the student keeps getting wrong come back far more often.
  //    THIS is what drives an SRS card past the 20-event cap; without it the cap is never
  //    exercised and the capped/uncapped comparison is meaningless.
  const deep = bank.slice(0, Math.min(sc.deepQuestions, bank.length));
  if (deep.length && sc.deepReviews) pass(deep, sc.deepReviews);

  // Completed full mocks, stored lean exactly as the app stores them.
  const examHistory = [];
  for (let e = 0; e < sc.exams; e++) {
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

  const historyLengths = Object.values(srsState).map((c) => (c.history || []).length);
  return {
    progress: progress,
    srsState: srsState,
    sessionsState: sessionsState,
    examHistory: examHistory,
    maxHistoryLen: historyLengths.length ? Math.max.apply(null, historyLengths) : 0,
    totalHistoryEvents: historyLengths.reduce((a, b) => a + b, 0),
    totalReviews: Object.values(srsState).reduce((a, c) => a + (c.totalReviews || 0), 0),
    totalLapses: Object.values(srsState).reduce((a, c) => a + (c.totalLapses || 0), 0)
  };
}

/** The PRE-WI-11.5 storage model: one document holding everything. */
function legacyMasterDoc(state) {
  return {
    id: 'student_e2e_test_student',
    student_name: 'e2e_test_student',
    doc_type: 'student_master_profile',
    progress: state.progress,
    srsState: state.srsState,
    sessionsState: state.sessionsState,
    examHistory: state.examHistory,
    updatedAt: START_MS,
    clientTimestamp: new Date(START_MS).toISOString(),
    clientVersion: 'v2-simulated',
    schemaVersion: 2
  };
}

/**
 * The WI-11.5 storage model, planned by the SAME pure code the server runs
 * (api/src/lib/shardsync.js), against a freshly-migrated student.
 */
function shardedDocs(state) {
  const plan = shardsync.planWrite({
    studentName: 'e2e_test_student',
    body: {
      progress: state.progress,
      srsState: state.srsState,
      sessionsState: state.sessionsState,
      examHistory: state.examHistory,
      client_version: 'v2-simulated',
      schemaVersion: 2
    },
    // A migrated, verified document: legacy fields frozen empty (this student never had
    // a pre-shard life), shards authoritative.
    existingMaster: {
      id: 'student_e2e_test_student',
      student_name: 'e2e_test_student',
      doc_type: 'student_master_profile',
      progress: {},
      srsState: {},
      schemaVersion: 2,
      createdAt: START_MS,
      shardsVerifiedAt: START_MS
    },
    existingProgressShards: [],
    existingSrsShards: [],
    durableExamIds: state.examHistory.map((e) => e.examId),
    now: START_MS
  });
  return plan;
}

function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }
function pad(n, w) { return String(n).padStart(w); }

// ===========================================================================
console.log('WI-11.5 full-bank storage simulation (slim records + sharded documents)');
console.log('=======================================================================');
console.log(`Questions in bundle .............. ${QUESTIONS.length}`);
console.log(`Broad pass ....................... ${REVIEWS_PER_QUESTION} review(s) x ${QUESTIONS.length} questions`);
console.log(`Deep pass ........................ ${DEEP_REVIEWS} extra review(s) x ${DEEP_QUESTIONS} questions  <-- what makes the 20-event cap engage`);
console.log(`Completed full mocks ............. ${EXAM_COUNT} (EXAM_HISTORY_CAP = ${EXAM_HISTORY_CAP})`);
console.log(`Per-document budget .............. ${DOC_BUDGET_BYTES} bytes (${kb(DOC_BUDGET_BYTES)})`);
console.log(`Cosmos per-document wall ......... ${COSMOS_DOC_LIMIT_BYTES} bytes (${kb(COSMOS_DOC_LIMIT_BYTES)})`);
console.log('');

const scenario = {
  useCap: true,
  coverage: QUESTIONS.length,
  reviews: REVIEWS_PER_QUESTION,
  deepQuestions: DEEP_QUESTIONS,
  deepReviews: DEEP_REVIEWS,
  exams: EXAM_COUNT
};
const capped = drive(scenario);
const uncapped = drive(Object.assign({}, scenario, { useCap: false }));

// ---------------------------------------------------------------------------
// 1. Does the SRS history cap now actually engage?
// ---------------------------------------------------------------------------
console.log('--- 1. Is the 20-event SRS history cap exercised at all? ---');
const cappedLegacyBytes = dm.bytesOf(legacyMasterDoc(capped));
const uncappedLegacyBytes = dm.bytesOf(legacyMasterDoc(uncapped));
console.log(`  longest card history, capped ..... ${capped.maxHistoryLen} events   (must be 20 for the cap to be under test)`);
console.log(`  longest card history, uncapped ... ${uncapped.maxHistoryLen} events`);
console.log(`  stored history events, capped .... ${capped.totalHistoryEvents}`);
console.log(`  stored history events, uncapped .. ${uncapped.totalHistoryEvents}`);
console.log(`  cap saves ........................ ${uncappedLegacyBytes - cappedLegacyBytes} bytes ` +
  `(${(100 * (uncappedLegacyBytes - cappedLegacyBytes) / Math.max(1, uncappedLegacyBytes)).toFixed(1)}% of the uncapped document)`);
if (capped.totalReviews !== uncapped.totalReviews || capped.totalLapses !== uncapped.totalLapses) {
  console.error(`\n✗ FAIL: capping changed the durable summaries — ` +
    `capped ${capped.totalReviews}/${capped.totalLapses} vs uncapped ${uncapped.totalReviews}/${uncapped.totalLapses}`);
  process.exit(1);
}
console.log(`  summaries identical either way ... ${capped.totalReviews} reviews, ${capped.totalLapses} lapses`);
console.log('');

// ---------------------------------------------------------------------------
// 2. The pre-change model, for contrast.
// ---------------------------------------------------------------------------
console.log('--- 2. BEFORE: one master document holds everything (the pre-WI-11.5 model) ---');
const legacyDoc = legacyMasterDoc(capped);
console.log(`  master doc ....................... ${cappedLegacyBytes} bytes (${kb(cappedLegacyBytes)})` +
  (cappedLegacyBytes >= COSMOS_DOC_LIMIT_BYTES ? '   *** OVER THE 2 MB COSMOS WALL — WRITES REJECTED ***' : ''));
console.log(`    progress ....................... ${pad(dm.bytesOf(legacyDoc.progress), 9)} bytes ` +
  `(${Object.keys(legacyDoc.progress).length} entries, ${Math.round(dm.bytesOf(legacyDoc.progress) / Object.keys(legacyDoc.progress).length)} B/entry)`);
console.log(`    srsState ....................... ${pad(dm.bytesOf(legacyDoc.srsState), 9)} bytes ` +
  `(${Object.keys(legacyDoc.srsState).length} cards, ${Math.round(dm.bytesOf(legacyDoc.srsState) / Object.keys(legacyDoc.srsState).length)} B/card)`);
console.log(`    sessionsState .................. ${pad(dm.bytesOf(legacyDoc.sessionsState), 9)} bytes (${Object.keys(legacyDoc.sessionsState).length} days)`);
console.log(`    examHistory .................... ${pad(dm.bytesOf(legacyDoc.examHistory), 9)} bytes (${legacyDoc.examHistory.length} lean reports)`);

// Reproduce WI-11's published baseline exactly, so the "3.29 MB" figure in the plan is a
// number this script still prints rather than a remembered one.
const legacyBaseline = drive({ useCap: true, coverage: QUESTIONS.length, reviews: 3, deepQuestions: 0, deepReviews: 0, exams: 9 });
const legacyBaselineBytes = dm.bytesOf(legacyMasterDoc(legacyBaseline));
console.log(`  WI-11's published baseline scenario (3 reviews, 9 exams, no deep pass):`);
console.log(`    reproduced here ................ ${legacyBaselineBytes} bytes (${kb(legacyBaselineBytes)})` +
  `   [WI-11 reported ${WI11_BASELINE_BYTES}]`);
console.log('');

// ---------------------------------------------------------------------------
// 3. The WI-11.5 model.
// ---------------------------------------------------------------------------
console.log('--- 3. AFTER: slim records in bucketed shard documents (WI-11.5) ---');
const plan = shardedDocs(capped);
const docs = [{ label: 'master profile', doc: plan.masterDoc }]
  .concat(plan.shardDocs.map((d) => ({ label: d.doc_type, doc: d })));

let worst = null;
let total = 0;
docs.forEach((d) => {
  const b = dm.bytesOf(d.doc);
  total += b;
  if (!worst || b > worst.bytes) worst = { id: d.doc.id, bytes: b, label: d.label };
});

console.log(`  documents written ................ ${docs.length} (1 master + ${plan.shardDocs.length} shards, ` +
  `${dm.SHARD_COUNT} buckets per collection)`);
console.log(`  codec verbatim fallbacks ......... ${plan.fallbacks}  (records the slim codec refused to compress; 0 is expected)`);
console.log(`  mode ............................. ${plan.mode}`);
console.log('');
console.log('  document                              bytes        KB   % of 400 KB budget');
docs.forEach((d) => {
  const b = dm.bytesOf(d.doc);
  const flag = b >= DOC_BUDGET_BYTES ? '  [OVER BUDGET]' : (b >= COSMOS_DOC_LIMIT_BYTES ? '  [OVER COSMOS WALL]' : '');
  console.log(`  ${d.doc.id.padEnd(34)} ${pad(b, 9)} ${pad(kb(b), 10)} ${pad(((100 * b) / DOC_BUDGET_BYTES).toFixed(1) + '%', 8)}${flag}`);
});
console.log('');
console.log(`  largest document ................. ${worst.id} @ ${worst.bytes} bytes (${kb(worst.bytes)})`);
console.log(`  total bytes across all documents .. ${total} (${kb(total)})`);
console.log(`  vs the single-document model ...... ${cappedLegacyBytes} bytes -> ${total} bytes ` +
  `(${(100 * (cappedLegacyBytes - total) / cappedLegacyBytes).toFixed(1)}% smaller in total, and no single document over ${kb(worst.bytes)})`);
console.log('');

// ---------------------------------------------------------------------------
// 4. Per-entry slimming, measured.
// ---------------------------------------------------------------------------
console.log('--- 4. Per-record slimming at full bank ---');
const pSlim = dm.slimProgressMap(capped.progress);
const sSlim = dm.slimSrsMap(capped.srsState);
const pm = dm.measureReduction(capped.progress, pSlim.slim);
const sm = dm.measureReduction(capped.srsState, sSlim.slim);
console.log(`  progress : ${pm.count} entries  ${pm.beforePerEntry.toFixed(1)} B -> ${pm.afterPerEntry.toFixed(1)} B per entry  ` +
  `(${pm.reductionPercent.toFixed(1)}% smaller)`);
console.log(`  srsState : ${sm.count} cards    ${sm.beforePerEntry.toFixed(1)} B -> ${sm.afterPerEntry.toFixed(1)} B per card   ` +
  `(${sm.reductionPercent.toFixed(1)}% smaller)`);
console.log(`  codec fallbacks: progress ${pSlim.fallbacks}, srs ${sSlim.fallbacks}`);
console.log('');

// ---------------------------------------------------------------------------
// 5. The gate.
// ---------------------------------------------------------------------------
console.log('--- 5. Gate ---');
let failed = false;
if (capped.maxHistoryLen !== 20) {
  console.error(`✗ FAIL: longest card history is ${capped.maxHistoryLen}, not 20 — the scenario does not exercise ` +
    'the SRS history cap, so its capped/uncapped comparison would be meaningless. Raise --deep-reviews.');
  failed = true;
}
if (uncappedLegacyBytes - cappedLegacyBytes <= 0) {
  console.error(`✗ FAIL: the cap saved ${uncappedLegacyBytes - cappedLegacyBytes} bytes — it is not engaging.`);
  failed = true;
}
const overBudget = docs.filter((d) => dm.bytesOf(d.doc) >= DOC_BUDGET_BYTES);
if (overBudget.length) {
  console.error(`✗ FAIL: ${overBudget.length} document(s) at or over the ${DOC_BUDGET_BYTES}-byte budget at full bank: ` +
    overBudget.map((d) => `${d.doc.id}=${dm.bytesOf(d.doc)}`).join(', '));
  failed = true;
}
if (failed) process.exit(1);

console.log(`✓ PASS: the SRS history cap engages (longest history ${capped.maxHistoryLen} events, saving ` +
  `${uncappedLegacyBytes - cappedLegacyBytes} bytes).`);
console.log(`✓ PASS: at FULL ${QUESTIONS.length}-question coverage with ${EXAM_COUNT} completed mocks, every one of the ` +
  `${docs.length} documents is under ${kb(DOC_BUDGET_BYTES)}; the largest is ${worst.bytes} bytes ` +
  `(${((100 * worst.bytes) / COSMOS_DOC_LIMIT_BYTES).toFixed(1)}% of the 2 MB Cosmos wall).`);
console.log(`  For contrast, the pre-WI-11.5 single-document model on the same scenario: ${cappedLegacyBytes} bytes ` +
  `(${kb(cappedLegacyBytes)}) — ${(cappedLegacyBytes / COSMOS_DOC_LIMIT_BYTES).toFixed(2)}x the Cosmos wall.`);
