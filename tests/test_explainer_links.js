/**
 * tests/test_explainer_links.js — WI-21 explainer index integrity.
 *
 * The explainer feature maps a question id to a step-by-step page. This test
 * proves the map is not lying: every file it names exists on disk and actually
 * contains the #q-<id> anchor it claims. Anchor presence is recomputed HERE by
 * reading the HTML directly (never by trusting index.json's own count), so a
 * stale or hand-edited index is caught — CLAUDE.md failure mode 4.
 *
 * It also pins the two rules that decide WHERE a student lands:
 *
 *  1. PRIMARY PRECEDENCE. The model-first cluster pages carry `<!-- primary -->`
 *     and cover the same miss ids as the older single-question pages they
 *     supersede. Without precedence, plain alphabetical order would silently
 *     decide which page the student opens. Every shared id must resolve to the
 *     cluster page, and no id may resolve to a superseded page.
 *
 *  2. BETA QUARANTINE (mechanism retained for future unverified pages). A page
 *     carrying `<!-- beta -->` registers ONLY in `betaQuestions`, which the app
 *     reveals solely when APP_ENV.isBeta. Nothing in the always-on `questions`
 *     map may be flagged beta — that is the invariant that keeps unverified
 *     numbers off the real student's screen (CLAUDE.md failure mode 1).
 *
 * Run:  node tests/test_explainer_links.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'explanations', 'index.json'), 'utf8'));

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); checks++; };

// Expected values written BY HAND (not derived from the index), so a wrong index
// is actually caught.
const COE_GRAPHS = 'explanations/command-of-evidence-graphs.html';
const NONLINEAR_MODEL = 'explanations/nonlinear-functions-model.html';
const COE_SLOW = 'explanations/command-of-evidence.html';
const NONLINEAR_SLOW = 'explanations/nonlinear-functions.html';

// Every id the two cluster pages own: worked misses (<section class="qsec">)
// plus practice/drill items (<div class="pq">).
const CLUSTER_IDS = {
  '858be80e': COE_GRAPHS, '6488f498': COE_GRAPHS, '1b9fa866': COE_GRAPHS,
  '7c1e22ca': COE_GRAPHS, '9f55dec4': COE_GRAPHS, 'a795332a': COE_GRAPHS,
  'cc4d3cac': COE_GRAPHS, 'ac8cfb10': COE_GRAPHS,
  '0664c858': NONLINEAR_MODEL, '25161d0e': NONLINEAR_MODEL, 'ce6b914c': NONLINEAR_MODEL,
  '987887cd': NONLINEAR_MODEL, '4aab1fa5': NONLINEAR_MODEL, '36e2afc3': NONLINEAR_MODEL,
};

ok(idx.questions && typeof idx.questions === 'object', 'index has a questions map');
ok(idx.betaQuestions && typeof idx.betaQuestions === 'object', 'index has a betaQuestions map');
ok(idx.pages && typeof idx.pages === 'object', 'index has a pages map');

// Read each page once; recompute its anchors independently of index.json.
const cache = {};
function pageFacts(file) {
  if (!(file in cache)) {
    const p = path.join(ROOT, file);
    ok(fs.existsSync(p), `referenced page exists on disk: ${file}`);
    const html = fs.readFileSync(p, 'utf8');
    cache[file] = {
      ids: new Set((html.match(/id="q-([0-9a-f]{8})"/g) || []).map(s => s.slice(6, 14))),
      beta: /<!--\s*beta\b/.test(html),
      primary: /<!--\s*primary\b/.test(html),
      verified: /<!--\s*verified:/.test(html),
    };
  }
  return cache[file];
}

// --- Every entry in BOTH maps resolves to a file that really has the anchor. ---
for (const [mapName, map] of [['questions', idx.questions], ['betaQuestions', idx.betaQuestions]]) {
  for (const [id, e] of Object.entries(map)) {
    ok(e.file, `${mapName}[${id}] names a file`);
    const f = pageFacts(e.file);
    ok(f.ids.has(id), `${mapName}[${id}] anchor #q-${id} really present in ${e.file}`);
    ok(typeof e.url === 'string' && e.url.indexOf(`#q-${id}`) !== -1,
      `${mapName}[${id}].url is anchored to the question`);
  }
}

// --- Rule 1: primary precedence. ---
for (const [id, file] of Object.entries(CLUSTER_IDS)) {
  const e = idx.questions[id];
  ok(e, `${id} is registered in the always-on questions map`);
  eq(e.file, file, `${id} resolves to the primary cluster page ${file}`);
  ok(pageFacts(file).primary, `${file} carries the <!-- primary --> marker`);
}
// A superseded page must not own ANY id — landing there instead of the
// model-first page is the exact regression this guards.
for (const dead of [COE_SLOW, NONLINEAR_SLOW]) {
  const owned = Object.entries(idx.questions).filter(([, e]) => e.file === dead).map(([id]) => id);
  eq(owned.length, 0, `superseded page ${dead} owns no question ids (found: ${owned.join(',')})`);
}

// --- Rule 2: beta quarantine invariant. ---
for (const [id, e] of Object.entries(idx.questions)) {
  eq(!!e.beta, false, `always-on questions[${id}] is not flagged beta`);
  eq(pageFacts(e.file).beta, false, `always-on page ${e.file} carries no <!-- beta --> marker`);
}
for (const [id, e] of Object.entries(idx.betaQuestions)) {
  eq(pageFacts(e.file).beta, true, `betaQuestions[${id}] page ${e.file} really carries the beta marker`);
}

// --- The two cluster pages record that their figures were card-verified. ---
ok(pageFacts(COE_GRAPHS).verified, `${COE_GRAPHS} records a <!-- verified: --> card check`);
ok(pageFacts(NONLINEAR_MODEL).verified, `${NONLINEAR_MODEL} records a <!-- verified: --> card check`);

console.log(`✓ explainer links: ${checks} checks (primary precedence honoured, beta quarantine intact)`);
