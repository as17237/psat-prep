/**
 * tests/test_deploy_scripts.js — WI-06 guard tests for the three lane-scoped
 * deploy scripts.
 *
 * These are deliberately NEGATIVE tests: they prove each script REFUSES to write
 * outside its own blob-name prefix, and that promote_to_prod.sh aborts before any
 * Azure call unless the operator types PROMOTE.
 *
 * Nothing here calls Azure. Every invocation uses --check-name (assert only) or
 * --dry-run (plan only, guaranteed no az call).
 *
 * Expected values below are hand-written, not derived from the scripts.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const REFUSED = 3;

console.log('Testing lane-scoped deploy scripts (WI-06)...');

function run(script, args, opts) {
  return spawnSync('bash', [path.join(REPO, script), ...args], {
    cwd: REPO,
    encoding: 'utf8',
    input: (opts && opts.input) || '',
    env: Object.assign({}, process.env, (opts && opts.env) || {})
  });
}

function checkName(script, name) {
  return run(script, ['--check-name', name]);
}

// ---------------------------------------------------------------------------
// 0. The scripts exist, are executable, and parse.
// ---------------------------------------------------------------------------
['scripts/deploy_v2.sh', 'scripts/deploy_beta.sh', 'scripts/promote_to_prod.sh',
 'scripts/lib/deploy_common.sh'].forEach(s => {
  const p = path.join(REPO, s);
  assert.ok(fs.existsSync(p), `${s} must exist`);
  const syn = spawnSync('bash', ['-n', p], { encoding: 'utf8' });
  assert.strictEqual(syn.status, 0, `${s} must parse: ${syn.stderr}`);
});

// ---------------------------------------------------------------------------
// 1. deploy_v2.sh accepts only v2/ names.
// ---------------------------------------------------------------------------
const v2Accepted = ['v2/index.html', 'v2/styles/buttons.css', 'v2/data/questions_data.js'];
v2Accepted.forEach(n => {
  const r = checkName('scripts/deploy_v2.sh', n);
  assert.strictEqual(r.status, 0, `deploy_v2.sh must accept '${n}' (stderr: ${r.stderr})`);
  assert.ok(r.stdout.includes(`OK: ${n}`), `deploy_v2.sh must report OK for '${n}'`);
});

const v2Refused = [
  'index.html',                 // production root
  'styles/buttons.css',         // production root
  'beta/index.html',            // the other soak lane
  'v2index.html',               // prefix look-alike, no segment boundary
  'v2xx/index.html',            // prefix look-alike
  'v2/../index.html',           // traversal out of the lane
  '/v2/index.html',             // absolute
  'data/questions_data.js',     // the live bundle at the root
  ''                            // empty
];
v2Refused.forEach(n => {
  const r = checkName('scripts/deploy_v2.sh', n);
  assert.strictEqual(r.status, REFUSED,
    `deploy_v2.sh must REFUSE '${n}' with exit ${REFUSED}, got ${r.status} (${r.stdout}${r.stderr})`);
  assert.ok(/REFUSED/.test(r.stderr), `deploy_v2.sh must say REFUSED for '${n}'`);
});

// ---------------------------------------------------------------------------
// 2. deploy_beta.sh accepts only beta/ names.
// ---------------------------------------------------------------------------
['beta/index.html', 'beta/srs.js'].forEach(n => {
  const r = checkName('scripts/deploy_beta.sh', n);
  assert.strictEqual(r.status, 0, `deploy_beta.sh must accept '${n}'`);
});
['index.html', 'v2/index.html', 'betax/index.html', 'beta/../index.html', ''].forEach(n => {
  const r = checkName('scripts/deploy_beta.sh', n);
  assert.strictEqual(r.status, REFUSED,
    `deploy_beta.sh must REFUSE '${n}' with exit ${REFUSED}, got ${r.status}`);
});

// ---------------------------------------------------------------------------
// 3. promote_to_prod.sh accepts only root names, and refuses soak lanes.
// ---------------------------------------------------------------------------
['index.html', 'parent.html', 'styles/buttons.css'].forEach(n => {
  const r = checkName('scripts/promote_to_prod.sh', n);
  assert.strictEqual(r.status, 0, `promote_to_prod.sh must accept root name '${n}'`);
});
['v2/index.html', 'beta/index.html', '../index.html', '/index.html', ''].forEach(n => {
  const r = checkName('scripts/promote_to_prod.sh', n);
  assert.strictEqual(r.status, REFUSED,
    `promote_to_prod.sh must REFUSE '${n}' with exit ${REFUSED}, got ${r.status}`);
});

// ---------------------------------------------------------------------------
// 4. promote_to_prod.sh typed-confirmation gate.
//    Wrong input must abort with a non-zero exit and never reach an upload.
// ---------------------------------------------------------------------------
const wrongInputs = ['promote\n', 'PROMOTE ME\n', 'yes\n', '\n'];
wrongInputs.forEach(inp => {
  const r = run('scripts/promote_to_prod.sh', ['--dry-run'], { input: inp });
  assert.strictEqual(r.status, 1,
    `promote_to_prod.sh must abort (exit 1) on input ${JSON.stringify(inp)}, got ${r.status}`);
  assert.ok(/Promotion cancelled/.test(r.stdout),
    'aborted promotion must say so plainly');
  assert.ok(!/would upload/.test(r.stdout),
    'a cancelled promotion must not print an upload plan');
  assert.ok(!/PROMOTE_TO_PROD_(DRY_RUN_)?OK/.test(r.stdout),
    'a cancelled promotion must not print a success token');
});

// Exact typed 'PROMOTE' proceeds (dry-run: still no az call, no upload).
const okRun = run('scripts/promote_to_prod.sh', ['--dry-run'], { input: 'PROMOTE\n' });
assert.strictEqual(okRun.status, 0, `typed PROMOTE must proceed in dry-run: ${okRun.stderr}`);
assert.ok(/PROMOTE_TO_PROD_DRY_RUN_OK/.test(okRun.stdout), 'dry-run must print its OK token');
assert.ok(/would upload/.test(okRun.stdout), 'dry-run must print the upload plan');

// The confirmation must be reached BEFORE any Azure call: a dry run makes none.
[okRun, run('scripts/promote_to_prod.sh', ['--dry-run'], { input: 'nope\n' })].forEach(r => {
  assert.ok(!/drift check/.test(r.stdout),
    'the drift check (first az call) must not run in dry-run mode');
});

// ---------------------------------------------------------------------------
// 5. Dry runs of the two soak lanes plan only in-lane destinations.
// ---------------------------------------------------------------------------
const v2Dry = run('scripts/deploy_v2.sh', ['--dry-run'], {});
assert.strictEqual(v2Dry.status, 0, `deploy_v2.sh --dry-run must succeed: ${v2Dry.stderr}`);
assert.ok(/DEPLOY_V2_DRY_RUN_OK v2-/.test(v2Dry.stdout), 'v2 dry-run must print its version token');
const v2Planned = [...v2Dry.stdout.matchAll(/would upload .* -> \$web\/(\S+)/g)].map(m => m[1]);
assert.strictEqual(v2Planned.length, 7, `v2 must plan 7 blobs, planned ${v2Planned.length}`);
v2Planned.forEach(n => assert.ok(n.startsWith('v2/'), `planned blob '${n}' must be in the v2 lane`));
assert.ok(v2Planned.includes('v2/data/questions_data.js'),
  'v2 must carry its own question bundle (the pages load it by relative src)');

const betaDry = run('scripts/deploy_beta.sh', ['--dry-run'], {});
assert.strictEqual(betaDry.status, 0, `deploy_beta.sh --dry-run must succeed: ${betaDry.stderr}`);
const betaPlanned = [...betaDry.stdout.matchAll(/would upload .* -> \$web\/(\S+)/g)].map(m => m[1]);
assert.strictEqual(betaPlanned.length, 6, `beta must plan 6 blobs, planned ${betaPlanned.length}`);
betaPlanned.forEach(n => assert.ok(n.startsWith('beta/'), `planned blob '${n}' must be in the beta lane`));

// No lane script may ever plan a bare root blob.
[...v2Planned, ...betaPlanned].forEach(n => {
  assert.ok(n.includes('/'), `soak-lane blob '${n}' must never be a bare root name`);
});

// ---------------------------------------------------------------------------
// 6. deploy_v2.sh staging transformations (the reason /v2/ can share root images).
// ---------------------------------------------------------------------------
assert.ok(/7 image references absolutised, 4 pages versioned/.test(v2Dry.stdout),
  'v2 staging must absolutise all 7 question-image references and version all 4 pages');

// ---------------------------------------------------------------------------
// 7. promote_beta.sh is a hard-failing deprecation stub (it used to write both
//    the production root and beta/ in one run).
// ---------------------------------------------------------------------------
const stub = run('promote_beta.sh', [], {});
assert.strictEqual(stub.status, 1, 'promote_beta.sh must exit 1');
assert.ok(/deploy_v2\.sh/.test(stub.stderr) && /promote_to_prod\.sh/.test(stub.stderr),
  'the stub must point at the replacement scripts');
const stubSrc = fs.readFileSync(path.join(REPO, 'promote_beta.sh'), 'utf8');
assert.ok(!/az storage blob upload/.test(stubSrc),
  'the stub must contain no upload command at all');

// ---------------------------------------------------------------------------
// 8. No deploy script may pass a secret on argv.
// ---------------------------------------------------------------------------
['scripts/deploy_v2.sh', 'scripts/deploy_beta.sh', 'scripts/promote_to_prod.sh',
 'scripts/lib/deploy_common.sh'].forEach(s => {
  const src = fs.readFileSync(path.join(REPO, s), 'utf8');
  const offending = src.split('\n').filter(l =>
    /--account-key/.test(l) && !/^\s*#/.test(l));
  assert.strictEqual(offending.length, 0,
    `${s} must not pass --account-key on argv: ${offending.join(' | ')}`);
});

console.log('✓ All WI-06 deploy-script lane, confirmation-gate and credential tests passed!');
