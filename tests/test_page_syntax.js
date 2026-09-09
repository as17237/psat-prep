/**
 * tests/test_page_syntax.js — WI-30. Every page module must PARSE.
 *
 * Why this exists: a stray pair of braces in js/pages/student.js killed module
 * evaluation, so nothing registered — no service worker, no handlers. The browser
 * suite reported it as "the service worker never takes control", and I twice
 * diagnosed that as a behavioural interaction with the startup sync change and
 * reverted working code because of it. The real fault was a syntax error, and
 * `node --check` finds it in milliseconds.
 *
 * A parse failure is not a subtle defect. It should be caught by the cheapest
 * possible check, before any browser starts.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const targets = [];

['js/pages', 'js/shared', 'js/components', 'js/engine'].forEach((dir) => {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return;
  fs.readdirSync(abs).filter((f) => f.endsWith('.js')).forEach((f) => targets.push(path.join(dir, f)));
});
['srs.js', 'sw.js'].forEach((f) => targets.push(f));

assert.ok(targets.length >= 25, 'expected to find the page/engine modules, got ' + targets.length);

// ES modules (import/export) need --input-type=module; the engine parts and sw.js are
// classic scripts. Pick per file rather than guessing.
let checked = 0;
const failures = [];
targets.forEach((rel) => {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  const isModule = /^\s*(import|export)\s/m.test(src);
  try {
    execFileSync(process.execPath,
      isModule ? ['--input-type=module', '--check'] : ['--input-type=commonjs', '--check'],
      { input: src, stdio: ['pipe', 'pipe', 'pipe'] });
    checked++;
  } catch (e) {
    const msg = (e.stderr || '').toString().split('\n').slice(0, 3).join(' ').trim();
    failures.push(rel + ' -> ' + msg);
  }
});

if (failures.length) {
  console.error('\nFiles that do not parse:\n  ' + failures.join('\n  '));
}
assert.deepStrictEqual(failures, [],
  'every page/engine module must parse. A file that does not parse takes the whole ' +
  'app down at load, and the browser suite reports it as an unrelated behavioural failure.');

console.log('✓ all ' + checked + ' page/engine/shared modules parse');
