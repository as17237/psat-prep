/**
 * srs.js - Core Algorithms for Free-Response Grading, Spaced Repetition (SM-2), and Score Modeling
 * Dependency-free: runs in both browser and Node.js.
 *
 * ---------------------------------------------------------------------------
 * WI-10: this file is now a COMPATIBILITY FACADE, not an implementation.
 * ---------------------------------------------------------------------------
 * The engine lives in js/engine/{grading,scheduler,scoring,storage,examgen,sync}.js.
 * srs.js recomposes those six parts into the exact same `PSAT_ENGINE` object
 * every page and every Node suite has always imported — same 56 symbols, same
 * storage keys, same endpoint, same constant values. The contract is pinned by
 * tests/test_engine_api_surface.js.
 *
 *   Node    : require('./srs.js')            -> the composed API object
 *   Browser : <script src="srs.js">          -> window.PSAT_ENGINE
 *
 * In the browser the parts must already be loaded (they publish themselves on
 * window.__PSAT_ENGINE_PARTS), in this order:
 *
 *   js/engine/grading.js
 *   js/engine/scheduler.js
 *   js/engine/scoring.js
 *   js/engine/storage.js
 *   js/engine/examgen.js
 *   js/engine/sync.js
 *   srs.js
 *
 * If any part — or any single symbol a part owes — is absent, this file THROWS.
 * It never publishes a partial PSAT_ENGINE: a half-built engine would give the
 * student a page that renders and then silently does nothing
 * (CLAUDE.md failure mode 5, "swallowing failures").
 */

(function (root, factory) {
  var PART_NAMES = ['grading', 'scheduler', 'scoring', 'storage', 'examgen', 'sync'];
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    var loaded = {};
    PART_NAMES.forEach(function (name) { loaded[name] = require('./js/engine/' + name + '.js'); });
    module.exports = factory(loaded);
  } else {
    root.PSAT_ENGINE = factory(root.__PSAT_ENGINE_PARTS || {});
  }
})(typeof self !== 'undefined' ? self : this, function (parts) {

  /**
   * The frozen public API, listed part by part. This is the single place that
   * decides what PSAT_ENGINE exposes; tests/test_engine_api_surface.js holds an
   * independent hand-written copy of the same list and fails on any drift in
   * either direction.
   */
  var API_MANIFEST = {
    grading: [
      'parseNumeric',
      'extractAcceptedForms',
      'gradeFreeResponse',
      'formatAcceptedAnswers',
      'gradeAttempt',
      'renderRationale',
      'evaluateScientificExpression'
    ],
    scheduler: [
      'localDateKey',
      'scheduleNext',
      'compactSrsState',
      'recordDailySession',
      'calculateStreak'
    ],
    scoring: [
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
      'calculateErrorTagTrends'
    ],
    examgen: [
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
      '_assembleModuleByBlueprint'
    ],
    storage: [
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
      'clearOutbox'
    ],
    sync: [
      'getClientVersion',
      'pushToCloud',
      'pullFromCloud',
      'mergeProgress',
      'mergeSrsState',
      'mergeSessionsState',
      'mergeExamHistory'
    ]
  };

  var partNames = Object.keys(API_MANIFEST);

  var absentParts = partNames.filter(function (name) {
    return !parts[name] || typeof parts[name] !== 'object';
  });
  if (absentParts.length) {
    throw new Error(
      'srs.js: engine part(s) not loaded: ' + absentParts.join(', ') + '. ' +
      'In the browser, add <script src="js/engine/<part>.js"> for each of ' +
      partNames.join(', ') + ' BEFORE the srs.js tag. ' +
      'Refusing to publish a partial PSAT_ENGINE.'
    );
  }

  var api = {};
  var absentSymbols = [];
  partNames.forEach(function (name) {
    API_MANIFEST[name].forEach(function (symbol) {
      var value = parts[name][symbol];
      if (value === undefined || value === null) {
        absentSymbols.push(name + '.' + symbol);
        return;
      }
      api[symbol] = value;
    });
  });
  if (absentSymbols.length) {
    throw new Error(
      'srs.js: engine part(s) loaded but did not export: ' + absentSymbols.join(', ') + '. ' +
      'The public API is frozen (tests/test_engine_api_surface.js) — refusing to ' +
      'publish a PSAT_ENGINE that is missing symbols its callers rely on.'
    );
  }

  return api;
});
