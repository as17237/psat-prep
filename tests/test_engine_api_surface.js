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
 *
 * ---------------------------------------------------------------------------
 * CONTRACT CHANGE LOG — additions only. Nothing has ever been removed or
 * renamed; every symbol from the original 56 is still present with its
 * original kind and value.
 *
 *   WI-10 (baseline, srs.js @66c88cc) ........................ 56 symbols
 *   WI-11 (storage & sync hardening) .......................... +11 = 67
 *       scheduler: SRS_HISTORY_CAP, summarizeSrsCard
 *           the 20-event cap constant and the exact durable per-card summary
 *           (totalReviews / totalLapses / firstReviewedAt / lastReviewedAt)
 *           that has to stay correct after history is truncated.
 *       storage:   SCHEMA_VERSION, readSchemaMeta, migrateLocalStateToV2,
 *                  rollbackLocalStateToV1, buildStateEnvelope,
 *                  buildProgressEntry
 *           the versioned local envelope and its idempotent, reversible
 *           v1 -> v2 migration, plus the single stored-attempt record builder
 *           that replaced two diverged copies inside js/pages/student.js.
 *       sync:      buildSyncDelta, getSyncCursor, resetSyncCursor
 *           delta-push selection and the ack cursor that drives it.
 *   Note SRS_HISTORY_CAP and SCHEMA_VERSION are NUMBER constants, so the
 *   kind table below grew a third category (it previously assumed every
 *   non-object was a function).
 * ---------------------------------------------------------------------------
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
  'SRS_HISTORY_CAP',      // WI-11
  'summarizeSrsCard',     // WI-11
  'scheduleNext',
  'compactSrsState',
  'recordDailySession',
  'calculateStreak',

  // --- score modelling, blueprints, exam scoring, diagnostics --------------
  'SCALING_ASSUMPTIONS',
  'scaleSectionRawScore',
  'routeAdaptiveTrack',
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
  'buildProgressEntry',    // WI-11
  'enqueueOutboxOp',
  'getOutboxOps',
  'ackOutboxOps',
  'clearOutbox',
  'SCHEMA_VERSION',         // WI-11
  'readSchemaMeta',         // WI-11
  'migrateLocalStateToV2',  // WI-11
  'rollbackLocalStateToV1', // WI-11
  'buildStateEnvelope',     // WI-11

  // --- cloud sync client + field-level merge -------------------------------
  'getClientVersion',
  'isReadOnlyMode',   // WI-18
  'pushToCloud',
  'pullFromCloud',
  'mergeProgress',
  'mergeSrsState',
  'mergeSessionsState',
  'mergeExamHistory',
  'buildSyncDelta',    // WI-11
  'getSyncCursor',     // WI-11
  'resetSyncCursor',   // WI-11
];

// A typo that duplicated an entry would quietly shrink the contract.
const dupes = EXPECTED_SYMBOLS.filter((s, i) => EXPECTED_SYMBOLS.indexOf(s) !== i);
assert.deepStrictEqual(dupes, [], `EXPECTED_SYMBOLS contains duplicates: ${dupes.join(', ')}`);
assert.strictEqual(
  EXPECTED_SYMBOLS.length,
  69,
  `The hand-written contract must list exactly 69 symbols (56 @66c88cc + 11 from WI-11 + routeAdaptiveTrack from WI-16 + isReadOnlyMode from WI-18); found ${EXPECTED_SYMBOLS.length}. ` +
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
// WI-11 added two plain NUMBER constants; before that every non-object was a function.
const NUMBER_SYMBOLS = [
  'SRS_HISTORY_CAP',
  'SCHEMA_VERSION',
];
EXPECTED_SYMBOLS.forEach((name) => {
  let expectedKind = 'function';
  if (CONSTANT_SYMBOLS.indexOf(name) !== -1) expectedKind = 'object';
  else if (NUMBER_SYMBOLS.indexOf(name) !== -1) expectedKind = 'number';
  assert.strictEqual(
    typeof PSAT_ENGINE[name],
    expectedKind,
    `PSAT_ENGINE.${name} must be a ${expectedKind}, got ${typeof PSAT_ENGINE[name]}`
  );
});
console.log(`✓ kinds frozen: ${EXPECTED_SYMBOLS.length - CONSTANT_SYMBOLS.length - NUMBER_SYMBOLS.length} functions, ${CONSTANT_SYMBOLS.length} constant objects, ${NUMBER_SYMBOLS.length} number constants`);
assert.strictEqual(PSAT_ENGINE.SRS_HISTORY_CAP, 20, 'the SRS history cap is frozen at 20 events per card (WI-11)');
assert.strictEqual(PSAT_ENGINE.SCHEMA_VERSION, 2, 'the local/synced state envelope version is frozen at 2 (WI-11)');

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

// ---------------------------------------------------------------------------
// 5. The BROWSER load path — added when WI-10 split srs.js into js/engine/*.js.
//
// Node reaches the engine through require(); the four pages reach it through
// plain <script> tags in dependency order. Those are two different code paths
// through the same UMD wrappers, and only one of them is covered by everything
// above. CLAUDE.md failure mode 2 ("a rule applied in one place but not its
// twin") is exactly this shape, so the browser path is exercised here too, in
// a `vm` sandbox with no `module`/`exports` — the same conditions a page has.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
// adaptive_config is a no-dep constants part scoring.js depends on; it must load
// before scoring exactly as the pages' <script> order has it (WI-16).
const LOAD_ORDER = ['adaptive_config', 'grading', 'scheduler', 'scoring', 'storage', 'examgen', 'sync'];

/** Evaluates the given files as classic <script>s in a fresh browser-ish global. */
function loadInBrowserSandbox(files) {
  const sandbox = { console: console, Date: Date, Math: Math, JSON: JSON, fetch: undefined };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  files.forEach((rel) => {
    vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), sandbox, { filename: rel });
  });
  return sandbox;
}

const partFiles = LOAD_ORDER.map((p) => `js/engine/${p}.js`);
const browser = loadInBrowserSandbox(partFiles.concat(['srs.js']));
assert.ok(browser.PSAT_ENGINE, 'a page loading the six parts then srs.js must get window.PSAT_ENGINE');
assert.deepStrictEqual(
  Object.keys(browser.PSAT_ENGINE).sort(),
  EXPECTED_SYMBOLS.slice().sort(),
  'window.PSAT_ENGINE must expose the identical frozen surface that require() does'
);
console.log(`✓ browser <script> path builds the same ${Object.keys(browser.PSAT_ENGINE).length}-symbol surface`);

// The pages must not be able to half-load the engine. Both failure shapes
// throw loudly rather than publishing a partial API (CLAUDE.md mode 5).
assert.throws(
  () => loadInBrowserSandbox(['srs.js']),
  /engine part\(s\) not loaded/,
  'srs.js with no parts loaded must throw, not publish a partial PSAT_ENGINE'
);
assert.throws(
  () => loadInBrowserSandbox(['js/engine/scoring.js']),
  /requires js\/engine\/adaptive_config\.js/,
  'a part loaded before its dependency must throw and name the missing file'
);
// partFiles is [adaptive_config, grading, ..., sync]; take adaptive_config + the
// first five of srs.js's six parts so only `sync` is missing when srs.js loads.
assert.throws(
  () => loadInBrowserSandbox(partFiles.slice(0, 6).concat(['srs.js'])),
  /engine part\(s\) not loaded: sync/,
  'srs.js with five of six parts must name the missing part'
);
console.log('✓ partial loads fail loudly (no parts / wrong order / one part missing)');

console.log(`\nAll PSAT_ENGINE API-surface tests passed (${actual.length}/${EXPECTED_SYMBOLS.length} symbols).`);
