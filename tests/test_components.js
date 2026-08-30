/**
 * tests/test_components.js — WI-12 unit tests for js/components/*.js.
 *
 * Two things are pinned here, both from CLAUDE.md mode 1 and the WI-12 brief:
 *   1. statCard's `value: number|null` API renders "—" for `null` BY
 *      CONSTRUCTION — there is no code path that turns a missing metric into
 *      a fabricated "0". Demonstrated red first (see the WI-12 completion
 *      report for the pasted red-run output): with statCard temporarily
 *      edited to `formatMetric(value ?? 0, ...)`, this suite's Test 1 failed
 *      with "expected match for /^—$/, got '0'" before the real
 *      implementation was restored.
 *   2. Every component helper escapes HTML found in its text-bearing props
 *      (CLAUDE.md's broader "never trust content going into markup" rule,
 *      already the norm in js/shared/html.js#esc and every js/pages/*.js
 *      caller of it).
 *
 * Loading strategy: these are ES modules (import/export), and this repo's
 * package.json is CommonJS (no "type": "module"), so a plain `require()`
 * cannot load them. tests/helpers/page_source.js already solves exactly this
 * problem for js/pages/*.js by flattening the import graph into one
 * evaluable script (`pageScript`); `moduleScript()` is the same mechanism
 * exposed for a single arbitrary module rather than a full page (added in
 * this commit, reusing flatten()/readModule() rather than reimplementing
 * import-stripping a second time — CLAUDE.md mode 2).
 */
const assert = require('assert');
const { moduleScript } = require('./helpers/page_source');

console.log('Testing js/components/*.js (WI-12)...');

function load(relPath, ...names) {
  const code = moduleScript(relPath);
  const fn = new Function(`${code}\nreturn { ${names.join(', ')} };`);
  return fn();
}

const XSS = '<img src=x onerror=alert(1)>';
function assertEscaped(html, label) {
  assert.ok(!html.includes(XSS), `${label}: raw XSS payload must not appear unescaped:\n${html}`);
  assert.ok(html.includes('&lt;img'), `${label}: escaped payload must appear (esc() output):\n${html}`);
}

// ---------------------------------------------------------------------------
// 1. statCard — the null/estimate/number contract.
// ---------------------------------------------------------------------------
{
  const { statCard } = load('js/components/statCard.js', 'statCard');

  const nullHtml = statCard({ value: null, label: 'Mastery' });
  assert.ok(/>—</.test(nullHtml), `statCard(null) must render the em dash "—", got:\n${nullHtml}`);
  assert.ok(/is-null/.test(nullHtml), 'statCard(null) must carry the is-null class');
  assert.ok(!/>0</.test(nullHtml), 'statCard(null) must NEVER render a fabricated "0"');
  console.log('  ✓ statCard({value:null}) renders "—", never "0"');

  const numHtml = statCard({ value: 42, label: 'Questions answered' });
  assert.ok(/>42</.test(numHtml), `statCard(42) must render the real number, got:\n${numHtml}`);
  assert.ok(!/is-null/.test(numHtml), 'statCard(42) must not carry the is-null class');
  console.log('  ✓ statCard({value:42}) renders the real number');

  const estimateHtml = statCard({ value: 1180, label: 'Projected score', isEstimate: true });
  assert.ok(/>1180</.test(estimateHtml), 'statCard(isEstimate) must still render the value');
  assert.ok(/Estimate/.test(estimateHtml), 'statCard({isEstimate:true}) must render a visible "Estimate" affordance');
  const noEstimateHtml = statCard({ value: 1180, label: 'Projected score', isEstimate: false });
  assert.ok(!/Estimate/.test(noEstimateHtml), 'statCard({isEstimate:false}) must NOT render an "Estimate" affordance');
  console.log('  ✓ statCard({isEstimate:true}) renders a visible estimate affordance; false does not');

  const zeroHtml = statCard({ value: 0, label: 'Missed today' });
  assert.ok(/>0</.test(zeroHtml), 'statCard(0) is a REAL zero and must render 0, not "—"');
  assert.ok(!/is-null/.test(zeroHtml), 'statCard(0) must not be treated as null');
  console.log('  ✓ statCard({value:0}) (a real zero) renders 0, not "—" — null and zero are distinct');

  assertEscaped(statCard({ value: 5, label: XSS }), 'statCard label');
}

// ---------------------------------------------------------------------------
// 2. banner — variant + escaping.
// ---------------------------------------------------------------------------
{
  const { banner } = load('js/components/banner.js', 'banner');
  const html = banner({ variant: 'danger', title: 'Backup overdue', message: 'Last backup was 40 hours ago.' });
  assert.ok(/banner-danger/.test(html), 'banner(danger) must carry the banner-danger class');
  assert.ok(/role="alert"/.test(html), 'banner(danger) must be role="alert"');
  assertEscaped(banner({ variant: 'info', title: XSS, message: XSS }), 'banner title/message');
  console.log('  ✓ banner() variant classes + role + escaping');
}

// ---------------------------------------------------------------------------
// 3. modal — escaping title/body/button labels.
// ---------------------------------------------------------------------------
{
  const { modal } = load('js/components/modal.js', 'modal');
  const html = modal({ title: 'Delete this attempt?', body: 'This cannot be undone.', buttons: [{ label: 'Cancel' }, { label: 'Delete', variant: 'danger' }] });
  assert.ok(/role="dialog"/.test(html), 'modal must render role="dialog"');
  assert.ok(/btn-danger/.test(html), 'modal buttons must compose the existing .btn-* classes');
  assertEscaped(modal({ title: XSS, body: XSS, buttons: [{ label: XSS }] }), 'modal title/body/button label');
  console.log('  ✓ modal() structure + escaping');
}

// ---------------------------------------------------------------------------
// 4. progressBar — null vs. real value, escaping label.
// ---------------------------------------------------------------------------
{
  const { progressBar } = load('js/components/progressBar.js', 'progressBar');
  const nullHtml = progressBar({ value: null, max: 20, label: 'SRS reviews due' });
  assert.ok(/No data yet/.test(nullHtml), 'progressBar(null) must say "No data yet", not a fabricated percentage');
  assert.ok(/is-empty/.test(nullHtml), 'progressBar(null) must render the empty-track class');
  assert.ok(!/aria-valuenow/.test(nullHtml), 'progressBar(null) must not claim an aria-valuenow it does not have');

  const realHtml = progressBar({ value: 12, max: 20, label: 'SRS reviews due' });
  assert.ok(/aria-valuenow="12"/.test(realHtml), 'progressBar(12/20) must expose the real value via aria-valuenow');
  assert.ok(/width:60%/.test(realHtml), 'progressBar(12/20) must fill to 60%');
  console.log('  ✓ progressBar() null-vs-real + width math');

  assertEscaped(progressBar({ value: 1, max: 2, label: XSS }), 'progressBar label');
}

// ---------------------------------------------------------------------------
// 5. questionCard — real record shape, options as an array, escaping.
// ---------------------------------------------------------------------------
{
  const { questionCard } = load('js/components/questionCard.js', 'questionCard');
  const question = {
    question_text: 'Which choice completes the text?',
    domain: 'Information and Ideas',
    skill: 'Command of Evidence',
    difficulty: 'Easy',
    options: [{ key: 'A', text: '2000–2004.' }, { key: 'B', text: '1995–1999.' }],
    correct_answer: 'B',
  };
  const html = questionCard({ question, testId: 'q1' });
  assert.ok(/Information and Ideas/.test(html), 'questionCard must render the real domain');
  assert.ok(/data-option-key="A"/.test(html) && /data-option-key="B"/.test(html), 'questionCard must render one button per option, keyed');
  assert.ok(!/undefined/.test(html), 'questionCard must not leak "undefined" into markup');

  const revealed = questionCard({ question, selectedKey: 'A', revealAnswer: true, testId: 'q1' });
  assert.ok(/is-correct/.test(revealed), 'questionCard(revealAnswer) must mark the correct option');
  assert.ok(/is-incorrect/.test(revealed), 'questionCard(revealAnswer, wrong selection) must mark the selected wrong option');

  const emptyHtml = questionCard({ state: 'empty' });
  assert.ok(/No question queued/.test(emptyHtml), 'questionCard(empty) must say so explicitly, not render blank');

  assertEscaped(
    questionCard({ question: { question_text: XSS, domain: XSS, skill: XSS, options: [{ key: 'A', text: XSS }], correct_answer: 'A' } }),
    'questionCard text fields'
  );
  console.log('  ✓ questionCard() real-shape rendering + empty state + escaping');
}

// ---------------------------------------------------------------------------
// 6. navTabs — active state, escaping.
// ---------------------------------------------------------------------------
{
  const { navTabs } = load('js/components/navTabs.js', 'navTabs');
  const html = navTabs({ tabs: [{ id: 'practice', label: 'Practice', isActive: true }, { id: 'exams', label: 'Exams' }] });
  assert.ok(/is-active/.test(html), 'navTabs must mark the active tab');
  assert.ok(/aria-selected="true"/.test(html) && /aria-selected="false"/.test(html), 'navTabs must set aria-selected per tab');
  assertEscaped(navTabs({ tabs: [{ id: 'x', label: XSS }] }), 'navTabs label');
  console.log('  ✓ navTabs() active state + escaping');
}

// ---------------------------------------------------------------------------
// 7. emptyState — empty vs. error variant, escaping.
// ---------------------------------------------------------------------------
{
  const { emptyState } = load('js/components/emptyState.js', 'emptyState');
  const errHtml = emptyState({ variant: 'error', title: 'Could not load history' });
  assert.ok(/is-error/.test(errHtml), 'emptyState(error) must carry the is-error class');
  assertEscaped(emptyState({ title: XSS, description: XSS, actionLabel: XSS }), 'emptyState text fields');
  console.log('  ✓ emptyState() error variant + escaping');
}

// ---------------------------------------------------------------------------
// 8. dataTable — null cells render the em dash, empty/error states, escaping.
// ---------------------------------------------------------------------------
{
  const { dataTable } = load('js/components/dataTable.js', 'dataTable');
  const columns = [{ key: 'skill', label: 'Skill' }, { key: 'accuracy', label: 'Accuracy' }];
  const withNull = dataTable({ columns, rows: [{ skill: 'Transitions', accuracy: null }] });
  assert.ok(/>—</.test(withNull), 'dataTable must render "—" for a null cell, never a blank or fabricated 0');

  const emptyHtml = dataTable({ columns, rows: [] });
  assert.ok(/No data yet/.test(emptyHtml), 'dataTable([]) must render an explicit empty state');

  const errorHtml = dataTable({ columns, rows: [{ skill: 'x', accuracy: 1 }], state: 'error' });
  assert.ok(/is-error/.test(errorHtml), 'dataTable(state:"error") must render the error empty-state, even with rows present');

  assertEscaped(dataTable({ columns: [{ key: 'a', label: XSS }], rows: [{ a: XSS }] }), 'dataTable column label / cell value');
  console.log('  ✓ dataTable() null cells + empty/error states + escaping');
}

console.log('✓ All WI-12 component tests passed!');
