/**
 * tests/test_option_text_guard.js — WI-23.
 *
 * A student reported that question f463a4f4 was "wrong". The answer KEY was correct
 * (y = x² − 1, y = 3 → x = ±2 → (2,3) and (−2,3) → A, which is what the record says).
 * What was wrong is that all four buttons rendered the literal string 'and', because
 * the PDF extraction collapsed the multi-line choices.
 *
 * He answered that one correctly off the card. Two others with the same defect he did
 * NOT: f4d98e1c (all four buttons read '%') and 86d35711 (all four read
 * 'Value Frequency'). Those are recorded as genuine misses feeding his accuracy and
 * his SRS schedule, on questions whose choices the app never displayed.
 *
 * Nothing caught this because `text_complete` describes the question STEM, and it is
 * true for every affected record. Expected values below are hand-written.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PSAT_ENGINE = require('../srs.js');

let n = 0;
function check(name, fn) { fn(); n++; console.log('  ok ' + n + ' — ' + name); }

const mc = (texts) => ({
  type: 'multiple_choice',
  options: texts.map((t, i) => ({ key: 'ABCD'[i], text: t }))
});

// ---------------------------------------------------------------------------
// 1. The four shapes, hand-written.
// ---------------------------------------------------------------------------
check('real distinct choices report no issue', () => {
  assert.strictEqual(PSAT_ENGINE.optionTextIssue(mc(['10%', '12%', '70%', '75%'])), null);
});

check('literal "Option A".."Option D" placeholders are useless', () => {
  const r = PSAT_ENGINE.optionTextIssue(mc(['Option A', 'Option B', 'Option C', 'Option D']));
  assert.strictEqual(r.code, 'placeholder');
  assert.strictEqual(r.useless, true, 'a button reading "Option A" tells the student nothing');
});

check('all-identical text is useless — the f463a4f4 shape', () => {
  const r = PSAT_ENGINE.optionTextIssue(mc(['and', 'and', 'and', 'and']));
  assert.strictEqual(r.code, 'identical');
  assert.strictEqual(r.useless, true);
});

check('partially duplicated text is flagged but the text is still shown', () => {
  const r = PSAT_ENGINE.optionTextIssue(mc(['x', 'x', 'y', 'z']));
  assert.strictEqual(r.code, 'duplicate');
  assert.strictEqual(r.useless, false,
    'only SOME choices collide here — blanking all four would destroy usable text');
});

check('absent options are useless, never a silent pass', () => {
  assert.strictEqual(PSAT_ENGINE.optionTextIssue({ type: 'multiple_choice' }).code, 'missing');
  assert.strictEqual(PSAT_ENGINE.optionTextIssue({ type: 'multiple_choice', options: [] }).code, 'missing');
});

check('free-response questions are never flagged', () => {
  assert.strictEqual(PSAT_ENGINE.optionTextIssue({ type: 'free_response' }), null);
  assert.strictEqual(PSAT_ENGINE.optionTextIssue(null), null);
});

check('every issue carries a message that points at the card', () => {
  ['placeholder', 'identical', 'duplicate'].forEach((code) => {
    const sample = { placeholder: ['Option A', 'Option B'], identical: ['and', 'and'], duplicate: ['x', 'x', 'y'] }[code];
    const r = PSAT_ENGINE.optionTextIssue(mc(sample));
    assert.strictEqual(r.code, code);
    assert.ok(/card/i.test(r.message), code + ' message must tell the student where the choices are');
  });
});

// ---------------------------------------------------------------------------
// 2. Against the REAL bank. CLAUDE.md: new filtering logic needs a test that runs
//    on data/questions_data.js and asserts real counts.
// ---------------------------------------------------------------------------
const bank = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'ela_questions.json'), 'utf8')
).concat(
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'math_questions.json'), 'utf8'))
);

check('the real bank: 2694 MC records, 917 affected, counted by code', () => {
  const mcRecords = bank.filter((q) => q.type === 'multiple_choice');
  assert.strictEqual(mcRecords.length, 2694);
  const tally = { placeholder: 0, identical: 0, duplicate: 0, missing: 0, ok: 0 };
  mcRecords.forEach((q) => {
    const r = PSAT_ENGINE.optionTextIssue(q);
    tally[r ? r.code : 'ok']++;
  });
  assert.deepStrictEqual(tally, { placeholder: 876, identical: 17, duplicate: 24, missing: 0, ok: 1777 },
    'measured 2026-09-07 against the shipped bank');
});

check('the three questions the student actually hit are all flagged', () => {
  [['f463a4f4', 'identical'], ['f4d98e1c', 'identical'], ['86d35711', 'identical']].forEach(([id, code]) => {
    const q = bank.find((x) => x.id === id);
    assert.ok(q, id + ' must exist in the bank');
    const r = PSAT_ENGINE.optionTextIssue(q);
    assert.ok(r, id + ' must be flagged — the student answered this one blind');
    assert.strictEqual(r.code, code);
    assert.strictEqual(r.useless, true);
  });
});

check('f463a4f4: the ANSWER KEY is correct — only the display was broken', () => {
  const q = bank.find((x) => x.id === 'f463a4f4');
  // y = x^2 - 1 and y = 3  ->  3 = x^2 - 1  ->  x^2 = 4  ->  x = +/-2  ->  (2,3), (-2,3)
  assert.strictEqual(q.correct_answer, 'A', 'read off data/images/f463a4f4_question.png by hand');
  assert.strictEqual(q.rationale_letter_mismatch, false);
});

check('every affected record has a card to fall back to', () => {
  const affected = bank.filter((q) => PSAT_ENGINE.optionTextIssue(q));
  assert.strictEqual(affected.length, 917);
  const noCard = affected.filter((q) => !q.has_image || !q.question_image);
  assert.deepStrictEqual(noCard.map((q) => q.id), [],
    'the guard tells the student to read the card, so every flagged record must HAVE one');
  const onDisk = affected.filter((q) =>
    fs.existsSync(path.join(__dirname, '..', 'data', q.question_image)));
  assert.strictEqual(onDisk.length, 917, 'every referenced card file must exist on disk');
});

check('text_complete covers the 876 placeholders and MISSES the 41 that bit the student', () => {
  // The split is exact and it explains the incident precisely. The 876 records whose
  // options are literal "Option A" placeholders are ALSO marked text_complete:false,
  // so the pre-existing stem warning already fired for them. The 41 records whose
  // options are identical or duplicated have text_complete:true — a perfectly good
  // stem with unusable choices — so nothing warned, and all three questions the
  // student answered blind are in that 41.
  const split = { placeholder: { t: 0, f: 0 }, identical: { t: 0, f: 0 }, duplicate: { t: 0, f: 0 } };
  bank.forEach((q) => {
    const r = PSAT_ENGINE.optionTextIssue(q);
    if (!r) return;
    split[r.code][q.text_complete === false ? 'f' : 't']++;
  });
  assert.deepStrictEqual(split, {
    placeholder: { t: 0, f: 876 },
    identical: { t: 17, f: 0 },
    duplicate: { t: 24, f: 0 }
  }, 'measured 2026-09-07: text_complete is false for every placeholder and true for every other defect');

  ['f463a4f4', 'f4d98e1c', '86d35711'].forEach((id) => {
    const q = bank.find((x) => x.id === id);
    assert.strictEqual(q.text_complete, true,
      id + ' has a complete STEM, so the old warning stayed silent while its choices were unreadable');
  });
});

console.log('\n✓ All ' + n + ' option-text guard checks passed.\n');
