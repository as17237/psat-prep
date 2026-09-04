/**
 * tests/test_offline_exam.js — WI-20 offline exam mode.
 *
 * Exercises the pure offline helpers (collectExamQuestionIds / toOfflineExamPin /
 * rehydrateOfflineExamPin) against the REAL question bundle
 * (data/questions_data.js), not a fixture — this repo's #1 rule is "run the real
 * code path against the real dataset." Expected values are recomputed here
 * independently (a Set built directly, an exact recount), never by calling the
 * helper under test, so the test can actually catch the helper being wrong
 * (CLAUDE.md failure mode 4). Includes the drop-detection case that is the whole
 * point of the integrity result: a question missing from the bank must make the
 * exam refuse to start, not run short and be scored as full.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../srs.js');

// Load the real bundle exactly the way index.html's <script> does.
const js = fs.readFileSync(path.join(__dirname, '..', 'data', 'questions_data.js'), 'utf8');
const QUESTIONS = JSON.parse(js.slice(js.indexOf('=') + 1, js.lastIndexOf(']') + 1));

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); checks++; };

eq(QUESTIONS.length, 3059, 'real bundle has 3059 questions');

// --- generate a real Standard adaptive exam ---------------------------------
const exam = E.generateStandardPSAT89Exam(QUESTIONS, { isAdaptive: true });
ok(exam && Array.isArray(exam.modules) && exam.modules.length === 4, 'standard exam has 4 modules');
ok(exam.adaptivePools, 'adaptive exam carries adaptivePools');

// --- collectExamQuestionIds: independent recount ----------------------------
// Recompute the expected id set BY HAND (a Set built directly), not by calling
// the helper, so a wrong helper is actually caught.
const expected = new Set();
exam.modules.forEach(m => m.questions.forEach(q => expected.add(q.id)));
['rwM2Hard', 'rwM2Easy', 'mathM2Hard', 'mathM2Easy'].forEach(k =>
  (exam.adaptivePools[k] || []).forEach(q => expected.add(q.id)));

const ids = E.collectExamQuestionIds(exam);
eq(new Set(ids).size, ids.length, 'collectExamQuestionIds returns no duplicates');
eq(ids.length, expected.size, 'collected id count == hand-recounted unique id set');
ok(ids.every(id => expected.has(id)), 'every collected id is in the hand set');
ok([...expected].every(id => ids.includes(id)), 'every hand id was collected (pools included)');

// Union MUST exceed the 98 module questions — proof the adaptive pools are
// included. Missing them would leave a whole routing branch's images uncached.
const moduleOnly = new Set();
exam.modules.forEach(m => m.questions.forEach(q => moduleOnly.add(q.id)));
ok(ids.length > moduleOnly.size, `pool questions included (${ids.length} > ${moduleOnly.size} module-only)`);

// Every collected id resolves to a real record WITH an image to prefetch.
const qMap = {}; QUESTIONS.forEach(q => { qMap[q.id] = q; });
ok(ids.every(id => qMap[id]), 'every collected id resolves in the bundle');
ok(ids.every(id => qMap[id].question_image), 'every collected question has an image path to cache');

// --- toOfflineExamPin: lean + honest tally ----------------------------------
const pin = E.toOfflineExamPin(exam, { imageTotal: ids.length, imageCached: ids.length, preparedAt: 111 });
eq(pin.imageTotal, ids.length, 'pin records the real image total');
eq(pin.imageCached, ids.length, 'pin records the real cached count');
eq(pin.preparedAt, 111, 'pin keeps the provided preparedAt');
ok(pin.examMeta.modules.every(m => Array.isArray(m.questionIds) && !('questions' in m)),
  'pin modules are lean (ids only, no full question objects)');

// Absent tally stays null — never invented as 0 (failure mode 1).
const pin2 = E.toOfflineExamPin(exam, {});
eq(pin2.imageTotal, null, 'absent image tally is null, not 0');
eq(pin2.imageCached, null, 'absent cached tally is null, not 0');

// Lean pin is small enough to store (nowhere near the resume-snapshot bloat).
const pinBytes = JSON.stringify(pin).length;
ok(pinBytes < 60000, `lean pin is small (${pinBytes} bytes < 60KB)`);

// --- rehydrateOfflineExamPin: round-trip with zero loss ---------------------
const r = E.rehydrateOfflineExamPin(pin, QUESTIONS);
eq(r.ok, true, 'rehydrate ok against the full bundle');
eq(r.missingIds.length, 0, 'no missing module ids on round-trip');
eq(r.exam.modules.length, exam.modules.length, 'module count preserved');
exam.modules.forEach((m, i) => {
  eq(r.exam.modules[i].questions.length, m.questions.length, `module ${i} question count preserved`);
  eq(r.exam.modules[i].questions.map(q => q.id).join(','), m.questions.map(q => q.id).join(','),
    `module ${i} exact question ids AND order preserved`);
});
ok(r.exam.adaptivePools && r.exam.adaptivePools.rwM2Hard.length === exam.adaptivePools.rwM2Hard.length,
  'rwM2Hard pool rehydrated fully');
ok(r.exam.adaptivePools.mathM2Easy.length === exam.adaptivePools.mathM2Easy.length,
  'mathM2Easy pool rehydrated fully');

// --- the whole point: rehydrate DETECTS a dropped question ------------------
const victim = exam.modules[0].questions[0].id;
const bankMinusOne = QUESTIONS.filter(q => q.id !== victim);
const rBad = E.rehydrateOfflineExamPin(pin, bankMinusOne);
eq(rBad.ok, false, 'rehydrate reports NOT ok when a module question is missing from the bank');
ok(rBad.missingIds.includes(victim), 'the missing module id is named in missingIds');

// A missing POOL id is reported but not fatal on its own (other branch intact).
const poolVictim = exam.adaptivePools.rwM2Easy[0].id;
if (!moduleOnly.has(poolVictim)) {
  const bankMinusPool = QUESTIONS.filter(q => q.id !== poolVictim);
  const rPool = E.rehydrateOfflineExamPin(pin, bankMinusPool);
  ok(rPool.missingPoolIds.includes(poolVictim), 'a missing pool id is reported in missingPoolIds');
  eq(rPool.ok, true, 'a pool-only miss does not make the exam un-startable');
}

// --- guards on junk input ---------------------------------------------------
eq(E.collectExamQuestionIds(null).length, 0, 'collect handles null exam');
eq(E.collectExamQuestionIds({}).length, 0, 'collect handles empty exam');
eq(E.toOfflineExamPin(null), null, 'pin of null is null');
eq(E.rehydrateOfflineExamPin(null, QUESTIONS).ok, false, 'rehydrate of null pin is not ok');
eq(E.rehydrateOfflineExamPin({}, QUESTIONS).ok, false, 'rehydrate of pin with no examMeta is not ok');

console.log(`✓ offline exam helpers: ${checks} checks against the real 3059-question bundle`);
