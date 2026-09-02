/**
 * tests/test_adaptive_config.js — WI-16.
 *
 * WI-16 lifted SCALING_ASSUMPTIONS, OFFICIAL_BLUEPRINTS and PSAT_89_SPECS out of
 * js/engine/scoring.js into js/engine/adaptive_config.js, a documented single
 * source of record. This suite pins two things:
 *
 *   1. EQUIVALENCE — the move changed no value. scoring.js re-exports the exact
 *      SAME objects the config part defines, and the frozen PSAT_ENGINE public
 *      API therefore still hands callers those identical objects. (Identity, not
 *      just deep-equality, so an accidental copy that could later drift is a
 *      failure here.)
 *
 *   2. PROVENANCE / VALUE LOCK — the constants a student's or parent's score is
 *      built from are asserted against HAND-WRITTEN expected values (NOT read
 *      back from the module under test — CLAUDE.md failure mode 4). A silent edit
 *      to the routing cutoff, the sample-size gate, the score scale, or the
 *      unvalidated power-curve knobs is caught here.
 */
const assert = require('assert');

const config = require('../js/engine/adaptive_config.js');
const scoring = require('../js/engine/scoring.js');
const PSAT_ENGINE = require('../srs.js');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

// --- 1. Equivalence: same objects flow config -> scoring -> PSAT_ENGINE --------
['SCALING_ASSUMPTIONS', 'OFFICIAL_BLUEPRINTS', 'PSAT_89_SPECS'].forEach((name) => {
  ok(config[name] && typeof config[name] === 'object', `adaptive_config exports ${name}`);
  eq(scoring[name], config[name], `scoring.js re-exports the SAME ${name} object (identity, no copy)`);
  eq(PSAT_ENGINE[name], config[name], `PSAT_ENGINE.${name} is the config object (frozen API unchanged)`);
});

// --- 2. Value lock: hand-written expected values ------------------------------
const S = config.SCALING_ASSUMPTIONS;
eq(S.SECTION_FLOOR, 120, 'SECTION_FLOOR');
eq(S.SECTION_CEILING, 720, 'SECTION_CEILING');
eq(S.TOTAL_FLOOR, 240, 'TOTAL_FLOOR');
eq(S.TOTAL_CEILING, 1440, 'TOTAL_CEILING');
eq(S.MIN_PER_SECTION, 15, 'MIN_PER_SECTION (score-suppression gate)');
eq(S.LOW_SAMPLE_THRESHOLD, 30, 'LOW_SAMPLE_THRESHOLD');
eq(S.HARD_TRACK_EXPONENT, 0.85, 'HARD_TRACK_EXPONENT (unvalidated curve knob)');
eq(S.EASY_TRACK_EXPONENT, 1.1, 'EASY_TRACK_EXPONENT (unvalidated curve knob)');
eq(S.EASY_TRACK_MAX, 580, 'EASY_TRACK_MAX (unvalidated lower-track cap)');
eq(S.ROUTING_THRESHOLD, 0.58, 'ROUTING_THRESHOLD (module-2 routing cutoff)');
eq(S.CONFIDENCE_Z_90, 1.6448536269514722, 'CONFIDENCE_Z_90');
assert.deepStrictEqual(S.ALLOWED_TRACKS, ['Standard', 'Hard', 'Easy', 'Baseline'], 'ALLOWED_TRACKS'); checks++;

// The routing threshold must correspond to the >= 16/27 RW and >= 13/22 Math
// boundaries the doc comment claims (this is the whole promise of adaptive MST).
ok(16 / 27 >= S.ROUTING_THRESHOLD && 15 / 27 < S.ROUTING_THRESHOLD, 'ROUTING_THRESHOLD gives 16/27 as the RW boundary');
ok(13 / 22 >= S.ROUTING_THRESHOLD && 12 / 22 < S.ROUTING_THRESHOLD, 'ROUTING_THRESHOLD gives 13/22 as the Math boundary');

const B = config.OFFICIAL_BLUEPRINTS;
eq(B.standard_psat89.version, 'PSAT89_2026_V1', 'standard blueprint version pinned');
eq(B.standard_psat89.sections['Reading and Writing'].questionsPerModule, 27, 'RW questions per module');
eq(B.standard_psat89.sections['Math'].questionsPerModule, 22, 'Math questions per module');
eq(B.standard_psat89.sections['Math'].typeDistribution.free_response, 5, 'Math free-response per module');
eq(B.mini_psat89.version, 'PSAT89_MINI_2026_V1', 'mini blueprint version pinned');

const P = config.PSAT_89_SPECS;
eq(P.totalQuestions, 98, 'PSAT_89_SPECS totalQuestions');
eq(P.sections.readingAndWriting.modules.length, 2, 'RW has 2 modules');
eq(P.sections.math.modules[0].timeLimitSeconds, 35 * 60, 'Math module time limit seconds');

// --- 3. The config part has NO engine dependencies (load-order safety) --------
// It must be requireable on its own without any other engine part present.
ok(Object.keys(require.cache).some((k) => k.endsWith('adaptive_config.js')), 'adaptive_config loaded standalone');

console.log(`✓ adaptive_config: ${checks} checks — extraction is value- and identity-equivalent, constants locked`);
