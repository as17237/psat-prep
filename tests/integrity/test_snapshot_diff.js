/**
 * tests/integrity/test_snapshot_diff.js — offline tests for the WI-07 snapshot diff tool.
 *
 * Runs entirely against the hand-written fixtures in tests/integrity/fixtures/ — no Azure
 * credentials, no network — so it belongs in CI alongside test_merge_pins.js.
 *
 * Every expected value below is written out by hand from the fixture files, never
 * computed with the code under test (CLAUDE.md mode 4).
 *
 * Fixtures:
 *   backup_base.json              v1.1, fixture_student: progress {q_alpha, q_beta},
 *                                 1 SRS card, 1 session day, 1 exam + 1 exam_session doc
 *   backup_plus_one_attempt.json  base + EXACTLY one new progress entry (q_gamma)
 *   backup_with_removal.json      base MINUS q_beta (a lost attempt)
 *   backup_v10_base.json          the same student content in a v1.0 payload (no `questions`)
 */

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  loadBackup,
  buildDiff,
  collectRemovals,
  diffMaps,
  stable
} = require('./snapshot_diff.js');

const FIX = path.join(__dirname, 'fixtures');
const TOOL = path.join(__dirname, 'snapshot_diff.js');
const BASE = path.join(FIX, 'backup_base.json');
const PLUS = path.join(FIX, 'backup_plus_one_attempt.json');
const REMOVED = path.join(FIX, 'backup_with_removal.json');
const V10 = path.join(FIX, 'backup_v10_base.json');

let checks = 0;
function ok(msg) { checks++; console.log(`  ✓ ${msg}`); }

console.log('WI-07 snapshot_diff offline tests\n');

// -------------------------------------------------------------------------
// 1. Payload loading: both 1.0 and 1.1, and `questions` absent != zero.
// -------------------------------------------------------------------------
console.log('1. Payload format handling');
{
  const v11 = loadBackup(BASE);
  assert.strictEqual(v11.version, '1.1');
  assert.strictEqual(v11.questionsCount, 2, 'a v1.1 payload reports its questions array length');
  assert.strictEqual(v11.studentAnswers.length, 2);
  ok('v1.1 payload loads with questionsCount = 2');

  const v10 = loadBackup(V10);
  assert.strictEqual(v10.version, '1.0');
  assert.strictEqual(v10.questionsCount, null, 'a v1.0 payload has NO questions key -> null, never 0');
  assert.strictEqual(v10.studentAnswers.length, 2);
  ok('v1.0 payload loads with questionsCount = null (absent, not zero)');

  assert.throws(() => loadBackup(path.join(FIX, 'does_not_exist.json')), /Cannot read backup file/);
  ok('a missing file throws rather than comparing against an empty snapshot');
}

// -------------------------------------------------------------------------
// 2. diffMaps — hand-checked adds/removes/changes.
// -------------------------------------------------------------------------
console.log('\n2. diffMaps');
{
  const d = diffMaps({ a: 1, b: 2, c: 3 }, { b: 2, c: 99, d: 4 });
  assert.deepStrictEqual(d.added, ['d']);
  assert.deepStrictEqual(d.removed, ['a']);
  assert.deepStrictEqual(d.changed, ['c']);
  assert.strictEqual(d.oldCount, 3);
  assert.strictEqual(d.newCount, 3);
  ok('added/removed/changed computed correctly on a hand-written map pair');

  // Key ORDER inside a value must not register as a change.
  const reordered = diffMaps({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } });
  assert.deepStrictEqual(reordered.changed, [], 'reordered keys are not a change');
  ok('key reordering is not reported as a change');

  // Cosmos system fields must not register as changes either.
  const sysOnly = diffMaps({ a: { v: 1, _etag: '"1"', _ts: 1 } }, { a: { v: 1, _etag: '"2"', _ts: 2 } });
  assert.deepStrictEqual(sysOnly.changed, [], '_etag/_ts churn is not a content change');
  ok('Cosmos _etag/_ts churn is not reported as a change');

  assert.strictEqual(stable({ b: 1, a: 2 }), stable({ a: 2, b: 1 }));
  ok('stable() is order-independent');
}

// -------------------------------------------------------------------------
// 3. base -> plus-one-attempt: exactly ONE progress entry added, nothing else.
// -------------------------------------------------------------------------
console.log('\n3. base -> plus one attempt');
{
  const diff = buildDiff(loadBackup(BASE), loadBackup(PLUS));
  assert.strictEqual(diff.students.length, 1);
  const s = diff.students[0];
  assert.strictEqual(s.student, 'fixture_student');

  assert.deepStrictEqual(s.progress.added, ['q_gamma'], 'the one added attempt must be named exactly');
  assert.deepStrictEqual(s.progress.removed, []);
  assert.deepStrictEqual(s.progress.changed, []);
  assert.strictEqual(s.progress.oldCount, 2);
  assert.strictEqual(s.progress.newCount, 3);
  ok('reports exactly one added progress entry (q_gamma), 2 -> 3');

  assert.deepStrictEqual([s.srs.added, s.srs.removed, s.srs.changed], [[], [], []]);
  assert.deepStrictEqual([s.sessions.added, s.sessions.removed, s.sessions.changed], [[], [], []]);
  assert.deepStrictEqual([s.exams.added, s.exams.removed], [[], []]);
  assert.deepStrictEqual([s.examDocs.added, s.examDocs.removed], [[], []]);
  ok('no SRS, session, exam or exam_session doc differences are invented');

  assert.strictEqual(diff.totals.progressAdded, 1);
  assert.strictEqual(diff.totals.progressRemoved, 0);
  assert.deepStrictEqual(diff.totals.studentsAdded, []);
  assert.deepStrictEqual(diff.totals.studentsRemoved, []);
  ok('summary totals: +1 progress, everything else zero');

  assert.deepStrictEqual(collectRemovals(diff), [], 'growth-only diff has no removals');
  ok('collectRemovals() is empty for a growth-only diff');
}

// -------------------------------------------------------------------------
// 4. base -> removal fixture: the lost attempt is named.
// -------------------------------------------------------------------------
console.log('\n4. base -> removal fixture');
{
  const diff = buildDiff(loadBackup(BASE), loadBackup(REMOVED));
  const s = diff.students[0];
  assert.deepStrictEqual(s.progress.removed, ['q_beta'], 'the lost attempt must be named exactly');
  assert.deepStrictEqual(s.progress.added, []);
  assert.strictEqual(diff.totals.progressRemoved, 1);
  ok('reports exactly one removed progress entry (q_beta), 2 -> 1');

  const removals = collectRemovals(diff);
  assert.strictEqual(removals.length, 1);
  assert.strictEqual(removals[0], "fixture_student: progress entry 'q_beta' removed");
  ok('collectRemovals() names the removal in full');
}

// -------------------------------------------------------------------------
// 5. Synthetic losses of every other kind are caught too.
// -------------------------------------------------------------------------
console.log('\n5. Every removal category');
{
  const older = loadBackup(BASE);
  const newerRaw = JSON.parse(JSON.stringify(loadBackup(BASE)));
  const master = newerRaw.studentAnswers[0];
  delete master.srsState.q_alpha;               // SRS card lost
  delete master.sessionsState['2026-08-27'];    // session day lost
  master.examHistory = [];                      // exam lost from history
  newerRaw.studentAnswers.splice(1, 1);         // immutable exam_session doc lost

  const removals = collectRemovals(buildDiff(older, newerRaw)).sort();
  assert.deepStrictEqual(removals, [
    "fixture_student: SRS card 'q_alpha' removed",
    "fixture_student: exam 'exam_fixture_1' removed from examHistory",
    "fixture_student: immutable exam_session doc 'exam_fixture_student_exam_fixture_1' removed",
    "fixture_student: session day '2026-08-27' removed"
  ]);
  ok('lost SRS card, session day, exam and exam_session doc are each reported');
}

{
  // A session counter that goes BACKWARDS is a loss even though the day still exists.
  const older = loadBackup(BASE);
  const newerRaw = JSON.parse(JSON.stringify(loadBackup(BASE)));
  newerRaw.studentAnswers[0].sessionsState['2026-08-27'].questionsAnswered = 1; // was 2
  const diff = buildDiff(older, newerRaw);
  assert.deepStrictEqual(diff.students[0].sessionRegressions, ['2026-08-27: questionsAnswered 2->1']);
  const removals = collectRemovals(diff);
  assert.ok(removals.some(r => r.includes('went BACKWARDS')), 'a shrinking session counter is a removal');
  ok('a session counter going backwards is reported as a loss');
}

{
  // A whole student vanishing.
  const older = loadBackup(BASE);
  const newerRaw = JSON.parse(JSON.stringify(loadBackup(BASE)));
  newerRaw.studentAnswers = [];
  const diff = buildDiff(older, newerRaw);
  assert.deepStrictEqual(diff.totals.studentsRemoved, ['fixture_student']);
  assert.ok(collectRemovals(diff).some(r => r.includes('absent from the newer backup entirely')));
  ok('a student missing from the newer backup entirely is reported');
}

// -------------------------------------------------------------------------
// 6. CLI exit codes — the gate WI-18 actually relies on.
// -------------------------------------------------------------------------
console.log('\n6. CLI exit codes');
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [TOOL].concat(args), { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: (e.stdout || '') + (e.stderr || '') };
  }
}
{
  const growth = runCli([BASE, PLUS, '--expect-no-removals']);
  assert.strictEqual(growth.code, 0, '--expect-no-removals must exit 0 on a growth-only diff');
  assert.ok(growth.stdout.includes('SNAPSHOT_DIFF_NO_REMOVALS_OK'));
  assert.ok(growth.stdout.includes('q_gamma'));
  ok('growth-only + --expect-no-removals -> exit 0, prints SNAPSHOT_DIFF_NO_REMOVALS_OK');

  const loss = runCli([BASE, REMOVED, '--expect-no-removals']);
  assert.strictEqual(loss.code, 1, '--expect-no-removals must exit 1 when something disappeared');
  assert.ok(loss.stdout.includes('SNAPSHOT_DIFF_REMOVALS_DETECTED'));
  assert.ok(loss.stdout.includes("progress entry 'q_beta' removed"), 'the removal must be named in the CLI output');
  ok('removal + --expect-no-removals -> exit 1, names q_beta');

  const lossNoFlag = runCli([BASE, REMOVED]);
  assert.strictEqual(lossNoFlag.code, 0, 'without the flag a removal is a warning, not a failure');
  assert.ok(lossNoFlag.stdout.includes('removal(s) detected'));
  ok('removal without the flag -> exit 0 but a visible warning');

  const mixed = runCli([V10, PLUS]);
  assert.strictEqual(mixed.code, 0);
  assert.ok(mixed.stdout.includes('absent (v1.0 payload)'), 'a v1.0 payload must be labelled, not shown as 0 questions');
  ok('v1.0 vs v1.1 comparison runs and labels the absent questions array');

  const badArgs = runCli([BASE]);
  assert.strictEqual(badArgs.code, 2, 'wrong argument count exits 2');
  ok('missing second file -> exit 2 with usage');
}

console.log(`\n✓ All ${checks} snapshot_diff offline checks passed.\n`);
