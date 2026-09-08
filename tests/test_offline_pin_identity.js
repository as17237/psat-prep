/**
 * tests/test_offline_pin_identity.js — WI-27. Review finding 5.
 *
 * "Prepare for offline" always generated a full adaptive exam and the pin described
 * only that. A parent-built focused test — seven Craft and Structure questions, a
 * 15-minute session — could be prepared online and come back offline as a different
 * test: wrong length, wrong topics, wrong timing.
 *
 * A pin must preserve the test's IDENTITY, not just a bag of question ids.
 * Expected values are hand-written; the real 3,059-question bundle is used for the
 * round-trip so this is the actual code path (CLAUDE.md gate 1).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PSAT_ENGINE = require('../srs.js');

let n = 0;
const ok = (name) => { n++; console.log('  ok ' + n + ' — ' + name); };

const src = fs.readFileSync(path.join(__dirname, '..', 'data', 'questions_data.js'), 'utf8');
const BANK = JSON.parse(src.slice(src.indexOf('=') + 1, src.lastIndexOf(']') + 1));
assert.strictEqual(BANK.length, 3059, 'real bundle');

function focusedTest(opts) {
  const t = PSAT_ENGINE.generateCustomTest(BANK, opts);
  t.examCategory = 'focused_test';
  t.customPlan = { sizeMode: 'count', requestedCount: opts.count, domains: opts.domains };
  t.isUntimed = opts.isUntimed === true;
  t.modules = [{
    id: 'm1', section: opts.test, moduleNumber: 1, name: 'Focused',
    questionsCount: t.questions.length,
    timeLimitSeconds: (opts.timeLimitMinutes || 0) * 60,
    questions: t.questions
  }];
  return t;
}

// -- the literal finding-5 case ----------------------------------------------
{
  const t = focusedTest({ test: 'Reading and Writing', domains: ['Craft and Structure'],
                          count: 7, timeLimitMinutes: 12 });
  assert.strictEqual(t.questions.length, 7, 'seven questions requested and selected');

  const pin = PSAT_ENGINE.toOfflineExamPin(t, { imageTotal: 7, imageCached: 7, preparedAt: 1 });
  const back = PSAT_ENGINE.rehydrateOfflineExamPin(pin, BANK);

  assert.strictEqual(back.ok, true);
  assert.strictEqual(back.exam.modules[0].questions.length, 7,
    'FINDING 5: a focused test must come back offline with its OWN length, not 98');
  assert.deepStrictEqual(back.exam.modules[0].questions.map((q) => q.domain),
    new Array(7).fill('Craft and Structure'),
    'and with its own topics');
  assert.strictEqual(back.exam.examCategory, 'focused_test',
    'the category must survive, or the result is scored as a full exam');
  assert.deepStrictEqual(back.exam.customPlan,
    { sizeMode: 'count', requestedCount: 7, domains: ['Craft and Structure'] });
  assert.strictEqual(back.exam.timeLimitMinutes, 12, 'and its timing');
  ok('FINDING 5: a 7-question Craft and Structure test round-trips as itself');
}

// -- untimed practice ---------------------------------------------------------
{
  const t = focusedTest({ test: 'Math', domains: ['Algebra'], count: 5, isUntimed: true });
  const back = PSAT_ENGINE.rehydrateOfflineExamPin(
    PSAT_ENGINE.toOfflineExamPin(t, {}), BANK);
  assert.strictEqual(back.exam.isUntimed, true,
    'untimed practice must not come back with a countdown attached');
  assert.strictEqual(back.exam.modules[0].questions.length, 5);
  ok('untimed practice keeps its untimed flag');
}

// -- the full exam is unchanged by this -------------------------------------
{
  const full = PSAT_ENGINE.generateStandardPSAT89Exam(BANK, { isAdaptive: true });
  const back = PSAT_ENGINE.rehydrateOfflineExamPin(
    PSAT_ENGINE.toOfflineExamPin(full, {}), BANK);
  assert.strictEqual(back.ok, true);
  assert.strictEqual(back.exam.modules.length, 4);
  assert.strictEqual(
    back.exam.modules.reduce((a, m) => a + m.questions.length, 0), 98,
    'the standard 98-question path still round-trips whole');
  assert.ok(back.exam.adaptivePools && back.exam.adaptivePools.rwM2Hard.length > 0,
    'and both adaptive branches are still pinned');
  assert.strictEqual(back.exam.examCategory, null,
    'a standard exam has no custom plan, and none is invented (mode 1)');
  ok('the full adaptive exam is unaffected: 98 questions, both routes, no invented plan');
}

// -- absent provenance stays absent ------------------------------------------
{
  const bare = { id: 'x', title: 'T', type: 'custom_test', modules: [
    { id: 'm', section: 'Math', moduleNumber: 1, name: 'M', questionsCount: 1,
      timeLimitSeconds: 60, questions: [BANK[0]] } ] };
  const back = PSAT_ENGINE.rehydrateOfflineExamPin(PSAT_ENGINE.toOfflineExamPin(bare, {}), BANK);
  assert.strictEqual(back.exam.customPlan, null);
  assert.strictEqual(back.exam.blueprintVersion, null);
  assert.strictEqual(back.exam.isHighYield, null,
    'unknown provenance stays null rather than defaulting to false');
  ok('missing provenance stays null, never invented');
}

// -- a missing question still refuses to start -------------------------------
{
  const t = focusedTest({ test: 'Math', domains: ['Algebra'], count: 3, timeLimitMinutes: 5 });
  const pin = PSAT_ENGINE.toOfflineExamPin(t, {});
  pin.examMeta.modules[0].questionIds.push('does_not_exist');
  const back = PSAT_ENGINE.rehydrateOfflineExamPin(pin, BANK);
  assert.strictEqual(back.ok, false, 'an unresolvable id must block the start');
  assert.deepStrictEqual(back.missingIds, ['does_not_exist']);
  ok('an unresolvable question still refuses to start rather than running short');
}

console.log('\n✓ All ' + n + ' offline pin identity checks passed.\n');
