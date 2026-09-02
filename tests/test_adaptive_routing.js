/**
 * test_adaptive_routing.js — WI-16 adaptive full-mock verification matrix.
 *
 * Written BEFORE the config extraction (test-first). It pins:
 *  1. routeAdaptiveTrack(rawRatio) — the ROUTING_THRESHOLD (0.58) decision, with
 *     hand-derived boundaries (RW 15 vs 16 of 27; Math 12 vs 13 of 22; 0.58 inclusive).
 *     This function does NOT exist yet — this section is RED until WI-16 adds it.
 *  2. scaleSectionRawScore — hand-computed scaled scores off the documented curve
 *     (Standard 120+r*600; Hard 120+r^0.85*600; Easy min(580, 120+r^1.1*600)).
 *  3. generateStandardPSAT89Exam against the REAL bundle: module sizes 27/27/22/22,
 *     free-response mix per blueprint (Math = 5/module), and NO question repeats
 *     across module 1 and either module-2 pool.
 *
 * Expected values are written by hand (CLAUDE.md mode 4), not by calling the code
 * under test. The 58%-boundary cases are the red-demo pins: shifting
 * ROUTING_THRESHOLD must flip route(15/27)/route(12/22) and fail this suite.
 */
const assert = require('assert');
const fs = require('fs');
const PSAT_ENGINE = require('../srs.js');

const js = fs.readFileSync('data/questions_data.js', 'utf8');
const BANK = JSON.parse(js.slice(js.indexOf('=') + 1, js.lastIndexOf(']') + 1));
const S = PSAT_ENGINE.SCALING_ASSUMPTIONS;

console.log('Testing WI-16 adaptive full-mock routing + scoring matrix...');

// ---------------------------------------------------------------------------
// 1. Routing threshold — routeAdaptiveTrack(rawRatio). ROUTING_THRESHOLD = 0.58.
//    0.58 * 27 = 15.66 -> RW upper needs >= 16/27; 0.58 * 22 = 12.76 -> Math >= 13/22.
// ---------------------------------------------------------------------------
{
  const route = PSAT_ENGINE.routeAdaptiveTrack;
  assert.strictEqual(typeof route, 'function', 'routeAdaptiveTrack must be exported by the engine');
  assert.strictEqual(route(16 / 27), 'Hard', 'RW 16/27 (0.593) routes to the upper (Hard) track');
  assert.strictEqual(route(15 / 27), 'Easy', 'RW 15/27 (0.556) routes to the lower (Easy) track');
  assert.strictEqual(route(13 / 22), 'Hard', 'Math 13/22 (0.591) routes to the upper (Hard) track');
  assert.strictEqual(route(12 / 22), 'Easy', 'Math 12/22 (0.545) routes to the lower (Easy) track');
  assert.strictEqual(route(0.58), 'Hard', 'exactly 0.58 is inclusive -> upper track');
  assert.strictEqual(route(0), 'Easy', '0% -> lower track');
  assert.strictEqual(route(1), 'Hard', '100% -> upper track');
  console.log('  ✓ routeAdaptiveTrack boundaries: RW 15|16 of 27, Math 12|13 of 22, 0.58 inclusive');
}

// ---------------------------------------------------------------------------
// 2. Scaled-score curve — hand-computed integers from the documented formula.
// ---------------------------------------------------------------------------
{
  const sc = (r, t, a) => PSAT_ENGINE.scaleSectionRawScore(r, t, a);
  assert.strictEqual(sc(1.0, 'Standard', false), 720, 'Standard 100% -> 720');
  assert.strictEqual(sc(0.5, 'Standard', false), 420, 'Standard 50% -> 120 + 0.5*600');
  assert.strictEqual(sc(0.0, 'Standard', false), 120, 'Standard 0% -> floor 120');
  assert.strictEqual(sc(1.0, 'Hard', true), 720, 'Hard 100% -> 720');
  assert.strictEqual(sc(0.75, 'Hard', true), 590, 'Hard 75% -> round(120 + 0.75^0.85*600)');
  assert.strictEqual(sc(0.0, 'Hard', true), 120, 'Hard 0% -> floor 120');
  assert.strictEqual(sc(1.0, 'Easy', true), 580, 'Easy 100% -> capped at EASY_TRACK_MAX (580)');
  assert.strictEqual(sc(0.5, 'Easy', true), 335, 'Easy 50% -> round(120 + 0.5^1.1*460)');
  assert.strictEqual(sc(0.0, 'Easy', true), 120, 'Easy 0% -> floor 120');
  console.log('  ✓ scaleSectionRawScore hand-computed curve (Standard / Hard / Easy)');
}

// ---------------------------------------------------------------------------
// 3. Module generation against the REAL bundle.
// ---------------------------------------------------------------------------
{
  const exam = PSAT_ENGINE.generateStandardPSAT89Exam(BANK, { isAdaptive: true });
  const m = exam.modules, p = exam.adaptivePools;
  const fr = (a) => a.filter((q) => q.type === 'free_response').length;
  const overlap = (a, b) => { const s = new Set(a.map((q) => q.id)); return b.filter((q) => s.has(q.id)).length; };

  assert.strictEqual(m.length, 4, '4 modules: RW M1, RW M2, Math M1, Math M2');
  assert.strictEqual(m[0].questions.length, 27, 'RW module 1 = 27');
  assert.strictEqual(m[2].questions.length, 22, 'Math module 1 = 22');
  assert.strictEqual(p.rwM2Hard.length, 27, 'RW M2 Hard pool = 27');
  assert.strictEqual(p.rwM2Easy.length, 27, 'RW M2 Easy pool = 27');
  assert.strictEqual(p.mathM2Hard.length, 22, 'Math M2 Hard pool = 22');
  assert.strictEqual(p.mathM2Easy.length, 22, 'Math M2 Easy pool = 22');
  assert.strictEqual(fr(m[2].questions), 5, 'Math M1 free-response = 5 (blueprint)');
  assert.strictEqual(fr(p.mathM2Hard), 5, 'Math M2 Hard free-response = 5');
  assert.strictEqual(fr(p.mathM2Easy), 5, 'Math M2 Easy free-response = 5');
  assert.strictEqual(overlap(m[0].questions, p.rwM2Hard), 0, 'no repeat: RW M1 vs M2 Hard');
  assert.strictEqual(overlap(m[0].questions, p.rwM2Easy), 0, 'no repeat: RW M1 vs M2 Easy');
  assert.strictEqual(overlap(m[2].questions, p.mathM2Hard), 0, 'no repeat: Math M1 vs M2 Hard');
  assert.strictEqual(overlap(m[2].questions, p.mathM2Easy), 0, 'no repeat: Math M1 vs M2 Easy');
  console.log('  ✓ generateStandardPSAT89Exam: 27/27/22/22, FR=5/module, no cross-module repeats (real bundle)');
}

// ---------------------------------------------------------------------------
// 4. Routing matrix table (module-1 profiles x section) — DoD "matrix printed".
// ---------------------------------------------------------------------------
console.log('\n  Routing matrix (ROUTING_THRESHOLD = ' + S.ROUTING_THRESHOLD + '):');
console.log('  profile | RW correct/27 -> track | Math correct/22 -> track');
[0, 0.25, 0.55, 15 / 27, 16 / 27, 0.75, 1.0].forEach((r) => {
  const t = PSAT_ENGINE.routeAdaptiveTrack(r);
  const line = '  ' + (r * 100).toFixed(0).padStart(4) + '%  |  ' +
    String(Math.round(r * 27)).padStart(2) + '/27 -> ' + t.padEnd(5) + '     |  ' +
    String(Math.round(r * 22)).padStart(2) + '/22 -> ' + t;
  console.log(line);
});

console.log('\nAll WI-16 adaptive routing tests passed.');
