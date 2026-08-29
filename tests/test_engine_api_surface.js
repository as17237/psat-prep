/**
 * tests/test_engine_api_surface.js — the frozen public contract of PSAT_ENGINE.
 *
 * WHY THIS EXISTS (REFACTOR_PLAN.md WI-10):
 * `srs.js` is being decomposed into js/engine/{grading,scheduler,examgen,
 * scoring,storage,sync}.js with `srs.js` reduced to a UMD facade. Every page
 * and every existing Node suite reaches the engine through that one object, so
 * the decomposition is only correct if the object's shape does not move by a
 * single key. A missing key is a broken page; an EXTRA key is an internal that
 * leaked out of a part module and silently became public API.
 *
 * The list below is HAND-WRITTEN from srs.js at commit 66c88cc (before any
 * decomposition). It is deliberately NOT derived from the code it checks —
 * CLAUDE.md failure mode 4 ("a test that cannot fail"): a test that builds its
 * expectations with the thing under test compares the implementation to itself.
 *
 * Red-demonstrated before being committed: deleting `calculateStreak` from the
 * srs.js return object makes this suite exit non-zero with
 *   MISSING from PSAT_ENGINE (the facade dropped them): calculateStreak
 */
const assert = require('assert');
const PSAT_ENGINE = require('../srs.js');

console.log('Testing PSAT_ENGINE public API surface (frozen contract)...');

// ---------------------------------------------------------------------------
// The contract. Typed out by hand, grouped the way the engine reads, so a
// future reviewer can see at a glance what a part module is allowed to own.
// ---------------------------------------------------------------------------
const EXPECTED_SYMBOLS = [
  // --- free-response grading + answer presentation -------------------------
  'parseNumeric',
  'extractAcceptedForms',
  'gradeFreeResponse',
  'formatAcceptedAnswers',
  'gradeAttempt',
  'renderRationale',
  'evaluateScientificExpression',

  // --- SM-2 scheduling, daily sessions, streaks ----------------------------
  'localDateKey',
  'scheduleNext',
  'compactSrsState',
  'recordDailySession',
  'calculateStreak',

  // --- score modelling, blueprints, exam scoring, diagnostics --------------
  'SCALING_ASSUMPTIONS',
  'scaleSectionRawScore',
  'calculateWilsonScoreInterval',
  'calculateScaledScore',
  'calculateSectionScaledScore',
  'PSAT_89_SPECS',
  'OFFICIAL_BLUEPRINTS',
  'scoreStandardExam',
  'buildTroubleSpots',
  'ERROR_TAGS',
  'aggregateErrorTags',
  'calculateErrorTagTrends',

  // --- exam / drill generation ---------------------------------------------
  'generateStandardPSAT89Exam',
  'generateMiniPSAT89Exam',
  'generateGapTargetedDrill',
  'generateCustomTest',
  'generateTagCoachingDrill',
  'generatePostExamRecoveryPlan',
  'generateSampleDiagnosticPayload',
  'calculateGapFocusMetrics',
  '_shuffle',
  '_prioritizeUnseen',
  '_assembleModuleByBlueprint',

  // --- client storage: demo mode, snapshots, outbox, report payloads -------
  'getEnvironmentConfig',
  'isDemoModeActive',
  'backupRealData',
  'restoreRealData',
  'toLeanReport',
  'rehydrateReport',
  'createClientSnapshot',
  'listClientSnapshots',
  'restoreClientSnapshot',
  'runTransactionalAction',
  'enqueueOutboxOp',
  'getOutboxOps',
  'ackOutboxOps',
  'clearOutbox',

  // --- cloud sync client + field-level merge -------------------------------
  'getClientVersion',
  'pushToCloud',
  'pullFromCloud',
  'mergeProgress',
  'mergeSrsState',
  'mergeSessionsState',
  'mergeExamHistory',
];

// A typo that duplicated an entry would quietly shrink the contract.
const dupes = EXPECTED_SYMBOLS.filter((s, i) => EXPECTED_SYMBOLS.indexOf(s) !== i);
assert.deepStrictEqual(dupes, [], `EXPECTED_SYMBOLS contains duplicates: ${dupes.join(', ')}`);
assert.strictEqual(
  EXPECTED_SYMBOLS.length,
  56,
  `The hand-written contract must list exactly 56 symbols (srs.js @66c88cc); found ${EXPECTED_SYMBOLS.length}. ` +
    'If the API genuinely changed, that is a deliberate contract change: update the count and say so in the PR.'
);

// ---------------------------------------------------------------------------
// 1. Exact set equality — missing OR extra both fail.
// ---------------------------------------------------------------------------
const actual = Object.keys(PSAT_ENGINE);
const missing = EXPECTED_SYMBOLS.filter((s) => actual.indexOf(s) === -1);
const extra = actual.filter((s) => EXPECTED_SYMBOLS.indexOf(s) === -1);

if (missing.length) {
  console.error('MISSING from PSAT_ENGINE (the facade dropped them): ' + missing.join(', '));
}
if (extra.length) {
  console.error('EXTRA on PSAT_ENGINE (an internal leaked into the public API): ' + extra.join(', '));
}
assert.deepStrictEqual(missing, [], 'PSAT_ENGINE is missing frozen public symbols');
assert.deepStrictEqual(extra, [], 'PSAT_ENGINE exposes symbols that are not part of the frozen contract');
assert.strictEqual(actual.length, EXPECTED_SYMBOLS.length, 'PSAT_ENGINE key count changed');
console.log(`✓ exact set equality: ${actual.length} symbols, none missing, none extra`);

// ---------------------------------------------------------------------------
// 2. Kinds are frozen too: a function must stay a function, a constant an
//    object. Re-exporting a constant as a getter-shaped function would keep
//    the key set identical while breaking every caller.
// ---------------------------------------------------------------------------
const CONSTANT_SYMBOLS = [
  'SCALING_ASSUMPTIONS',
  'PSAT_89_SPECS',
  'OFFICIAL_BLUEPRINTS',
  'ERROR_TAGS',
];
EXPECTED_SYMBOLS.forEach((name) => {
  const expectedKind = CONSTANT_SYMBOLS.indexOf(name) === -1 ? 'function' : 'object';
  assert.strictEqual(
    typeof PSAT_ENGINE[name],
    expectedKind,
    `PSAT_ENGINE.${name} must be a ${expectedKind}, got ${typeof PSAT_ENGINE[name]}`
  );
});
console.log(`✓ kinds frozen: ${EXPECTED_SYMBOLS.length - CONSTANT_SYMBOLS.length} functions, ${CONSTANT_SYMBOLS.length} constant objects`);

// ---------------------------------------------------------------------------
// 3. Constant VALUES that other code (and other tests) depend on numerically.
//    Hand-written from the pre-decomposition source; these are the values the
//    parent portal and the student page gate their displayed scores on
//    (CLAUDE.md mode 1/2), so a move between modules must not perturb them.
// ---------------------------------------------------------------------------
assert.strictEqual(PSAT_ENGINE.SCALING_ASSUMPTIONS.MIN_PER_SECTION, 15, 'MIN_PER_SECTION is frozen at 15');
assert.strictEqual(PSAT_ENGINE.SCALING_ASSUMPTIONS.SECTION_FLOOR, 120, 'SECTION_FLOOR is frozen at 120');
assert.strictEqual(PSAT_ENGINE.SCALING_ASSUMPTIONS.SECTION_CEILING, 720, 'SECTION_CEILING is frozen at 720');
assert.strictEqual(PSAT_ENGINE.SCALING_ASSUMPTIONS.TOTAL_FLOOR, 240, 'TOTAL_FLOOR is frozen at 240');
assert.strictEqual(PSAT_ENGINE.SCALING_ASSUMPTIONS.TOTAL_CEILING, 1440, 'TOTAL_CEILING is frozen at 1440');
assert.strictEqual(PSAT_ENGINE.SCALING_ASSUMPTIONS.ROUTING_THRESHOLD, 0.58, 'adaptive routing threshold is frozen at 0.58');
assert.strictEqual(PSAT_ENGINE.PSAT_89_SPECS.totalQuestions, 98, 'a full PSAT 8/9 mock is 98 questions');
const RW_MODULES = PSAT_ENGINE.PSAT_89_SPECS.sections.readingAndWriting.modules;
const MATH_MODULES = PSAT_ENGINE.PSAT_89_SPECS.sections.math.modules;
assert.deepStrictEqual(RW_MODULES.map((m) => m.questionsCount), [27, 27], 'RW modules are 27 + 27');
assert.deepStrictEqual(MATH_MODULES.map((m) => m.questionsCount), [22, 22], 'Math modules are 22 + 22');
assert.deepStrictEqual(RW_MODULES.map((m) => m.id), ['rw_m1', 'rw_m2'], 'RW module ids are frozen');
assert.deepStrictEqual(MATH_MODULES.map((m) => m.id), ['math_m1', 'math_m2'], 'Math module ids are frozen');
assert.ok(Object.keys(PSAT_ENGINE.ERROR_TAGS).length > 0, 'ERROR_TAGS must not be empty');
assert.ok(Object.keys(PSAT_ENGINE.OFFICIAL_BLUEPRINTS).length > 0, 'OFFICIAL_BLUEPRINTS must not be empty');
console.log('✓ frozen constant values intact (MIN_PER_SECTION=15, RW 27+27, Math 22+22)');

// ---------------------------------------------------------------------------
// 4. The facade must be a single shared object, not rebuilt per require().
// ---------------------------------------------------------------------------
assert.strictEqual(require('../srs.js'), PSAT_ENGINE, 'require("../srs.js") must be idempotent (module cache)');
console.log('✓ facade identity stable across require()');

console.log(`\nAll PSAT_ENGINE API-surface tests passed (${actual.length}/${EXPECTED_SYMBOLS.length} symbols).`);
