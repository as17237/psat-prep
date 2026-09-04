/**
 * tests/test_explainer_links.js — WI-21 explainer index integrity (beta lane).
 *
 * The explainer feature maps a question id to a step-by-step page. This test
 * proves the map is not lying: every file it names exists on disk and actually
 * contains the #q-<id> anchor it claims. Anchor presence is recomputed HERE by
 * reading the HTML directly (never by trusting index.json's own count), so a
 * stale or hand-edited index is caught — CLAUDE.md failure mode 4.
 *
 * It also pins the beta contract that keeps unverified content off the real
 * student's screen (CLAUDE.md failure mode 1):
 *   - the two new cluster pages register in `betaQuestions`, NOT `questions`,
 *     so they never clobber a verified per-question link even though they cover
 *     the same miss ids;
 *   - every betaQuestions file carries the `<!-- beta -->` marker;
 *   - the verified `questions` map still points those same miss ids at the
 *     original, card-verified pages.
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

// Expected values written BY HAND (not read from the helper), so a wrong index
// is actually caught. These are the anchors the two beta cluster pages carry.
const COE_GRAPHS = 'explanations/command-of-evidence-graphs.html';
const NONLINEAR_MODEL = 'explanations/nonlinear-functions-model.html';
// Both the worked misses (<section class="qsec">) and the practice/drill items
// (<div class="pq">) are real #q-<id> targets the page addresses.
const BETA_MISSES = {
  // command-of-evidence-graphs: 3 worked + 5 practice
  '858be80e': COE_GRAPHS, '6488f498': COE_GRAPHS, '1b9fa866': COE_GRAPHS,
  '7c1e22ca': COE_GRAPHS, '9f55dec4': COE_GRAPHS, 'a795332a': COE_GRAPHS,
  'cc4d3cac': COE_GRAPHS, 'ac8cfb10': COE_GRAPHS,
  // nonlinear-functions-model: 3 worked + 3 sibling drills
  '0664c858': NONLINEAR_MODEL, '25161d0e': NONLINEAR_MODEL, 'ce6b914c': NONLINEAR_MODEL,
  '987887cd': NONLINEAR_MODEL, '4aab1fa5': NONLINEAR_MODEL, '36e2afc3': NONLINEAR_MODEL,
};

ok(idx.questions && typeof idx.questions === 'object', 'index has a questions map');
ok(idx.betaQuestions && typeof idx.betaQuestions === 'object', 'index has a betaQuestions map');

// Read each page once; recompute its anchors independently of index.json.
const anchorCache = {};
function anchorsOf(file) {
  if (!(file in anchorCache)) {
    const p = path.join(ROOT, file);
    ok(fs.existsSync(p), `referenced page exists on disk: ${file}`);
    const html = fs.readFileSync(p, 'utf8');
    anchorCache[file] = {
      ids: new Set((html.match(/id="q-([0-9a-f]{8})"/g) || []).map(s => s.slice(6, 14))),
      beta: /<!--\s*beta\b/.test(html),
    };
  }
  return anchorCache[file];
}

// --- Every entry in BOTH maps resolves to a file that really has the anchor. ---
for (const [mapName, map] of [['questions', idx.questions], ['betaQuestions', idx.betaQuestions]]) {
  for (const [id, e] of Object.entries(map)) {
    ok(e.file, `${mapName}[${id}] names a file`);
    const a = anchorsOf(e.file);
    ok(a.ids.has(id), `${mapName}[${id}] anchor #q-${id} really present in ${e.file}`);
    ok(typeof e.url === 'string' && e.url.indexOf(`#q-${id}`) !== -1,
      `${mapName}[${id}].url is anchored to the question`);
  }
}

// --- Beta contract: the two cluster pages live in betaQuestions only. ---
for (const [id, file] of Object.entries(BETA_MISSES)) {
  ok(idx.betaQuestions[id], `beta miss ${id} is registered in betaQuestions`);
  eq(idx.betaQuestions[id].file, file, `beta miss ${id} maps to ${file}`);
  eq(idx.betaQuestions[id].beta, true, `beta miss ${id} is flagged beta:true`);
  ok(anchorsOf(file).beta, `beta page ${file} carries the <!-- beta --> marker`);
}

// --- No clobber: the same miss ids that a beta page covers must STILL resolve
//     to their original card-verified pages in the always-on questions map. ---
eq(idx.questions['1b9fa866'] && idx.questions['1b9fa866'].file,
  'explanations/command-of-evidence.html',
  'verified questions map still points 1b9fa866 at the original CoE page (not the beta one)');
eq(idx.questions['0664c858'] && idx.questions['0664c858'].file,
  'explanations/nonlinear-functions.html',
  'verified questions map still points 0664c858 at the original nonlinear page');
// And the beta pages never leaked into the verified map.
ok(!Object.values(idx.questions).some(e => e.file === COE_GRAPHS || e.file === NONLINEAR_MODEL),
  'no beta cluster page appears in the verified questions map');

console.log(`✓ explainer links: ${checks} checks (verified map intact, beta pages quarantined to betaQuestions)`);
