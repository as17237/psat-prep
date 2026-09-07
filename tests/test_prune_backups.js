/**
 * tests/test_prune_backups.js
 *
 * Unit tests for the retention policy in api/src/lib/backupRetention.js — the ONE
 * implementation, shared by scripts/prune_backups.js (operator CLI) and
 * api/src/functions/backupPrune.js (scheduled timer).
 *
 * Pure function; hand-written fixture listings; "now" injected as a parameter (never
 * read from the clock, never monkeypatched). Every expected value below is written out
 * by hand — no expectation is produced by calling the selector under test.
 *
 * POLICY UNDER TEST (changed 2026-09-07, was: keep <= 30 days, then one per ISO week)
 *   - keep every archive whose age is <= 15 days
 *   - archives STRICTLY older than 15 days are deleted...
 *   - ...except the newest 7, which are never deleted at any age (hard floor)
 *   - cosmos_backup_latest.json and its sidecar are pointers and are never deleted
 *   - only strictly-named cosmos_backup_<ts>.json archives are ever candidates
 *   - a deleted archive takes its own .sha256 sidecar; a sidecar is never deleted alone
 *   - an unusable listing (missing, non-array, empty, or missing the latest pointer)
 *     produces ZERO deletions, never a "best effort" prune
 *
 * The previous ISO-week tier and its isoWeekKey() helper were removed with the policy
 * change: under a flat 15-day window they would have let arbitrarily old archives live
 * forever, which is the opposite of what a 15-day retention job means.
 */

const assert = require('assert');

// Required through BOTH entry points on purpose: proving the CLI re-exports the very
// same function object is how this test enforces "one implementation, not two".
const lib = require('../api/src/lib/backupRetention.js');
const cli = require('../scripts/prune_backups.js');

const {
  RETENTION_DAYS,
  MIN_KEEP_NEWEST,
  BACKUP_CONTAINER,
  REFUSAL,
  timestampFromArchiveName,
  selectBackupsForDeletion,
  buildDeletionPairs,
  executeRetentionPlan
} = lib;

console.log('Testing backup retention selector (15-day policy)...');

// ---------------------------------------------------------------------------
// 0. One implementation, two callers.
// ---------------------------------------------------------------------------
assert.strictEqual(cli.selectBackupsForDeletion, lib.selectBackupsForDeletion,
  'The CLI must use the shared selector object itself, not a copy');
assert.strictEqual(cli.executeRetentionPlan, lib.executeRetentionPlan,
  'The CLI must use the shared executor object itself, not a copy');
assert.strictEqual(cli.RETENTION_DAYS, lib.RETENTION_DAYS);
assert.strictEqual(cli.MIN_KEEP_NEWEST, lib.MIN_KEEP_NEWEST);
console.log('  ok  CLI and library expose the identical selector/executor (one implementation)');

// ---------------------------------------------------------------------------
// 1. Constants are the policy the user asked for.
// ---------------------------------------------------------------------------
assert.strictEqual(RETENTION_DAYS, 15, 'Retention window must be 15 days');
assert.strictEqual(MIN_KEEP_NEWEST, 7, 'The newest-7 floor must survive the policy change');
assert.strictEqual(BACKUP_CONTAINER, 'cosmos-backups');
console.log('  ok  RETENTION_DAYS=15, MIN_KEEP_NEWEST=7, container=cosmos-backups');

// ---------------------------------------------------------------------------
// 2. Filename timestamp parsing — hand-computed values.
// ---------------------------------------------------------------------------
assert.strictEqual(
  new Date(timestampFromArchiveName('cosmos_backup_2026-08-28T22-54-48-379Z.json')).toISOString(),
  '2026-08-28T22:54:48.379Z',
  'A real archive name must parse to its exact UTC instant');
assert.strictEqual(timestampFromArchiveName('cosmos_backup_latest.json'), null,
  'The latest pointer carries no timestamp');
assert.strictEqual(timestampFromArchiveName('cosmos_backup_2026-08-28T22-54-48-379Z.json.sha256'), null,
  'A sidecar is not an archive name');
assert.strictEqual(timestampFromArchiveName('cosmos_backup_notatimestamp.json'), null,
  'A loosely-named blob must not yield a guessed age');
assert.strictEqual(timestampFromArchiveName('backup_FAILED_2026-08-28T22-54-48-379Z.json'), null,
  'A failure marker is not an archive');
console.log('  ok  archive filename timestamps parse strictly; everything else yields null');

// ---------------------------------------------------------------------------
// Fixture helpers. `at` is the archive instant; the blob name is derived from it the
// same way performCosmosBackup() derives it (: and . become -).
// ---------------------------------------------------------------------------
const NOW = Date.parse('2026-09-07T00:00:00.000Z');   // cutoff is therefore 2026-08-23T00:00:00.000Z
const nameFor = (iso) => `cosmos_backup_${iso.replace(/[:.]/g, '-')}.json`;
const arc = (iso, lastModifiedIso) => ({ name: nameFor(iso), lastModified: lastModifiedIso || iso });
const side = (iso) => ({ name: `${nameFor(iso)}.sha256`, lastModified: iso });
const POINTER = { name: 'cosmos_backup_latest.json', lastModified: '2026-09-07T00:00:00.000Z' };
const POINTER_SIDECAR = { name: 'cosmos_backup_latest.json.sha256', lastModified: '2026-09-07T00:00:00.000Z' };

// Seven genuinely recent archives, ages 0,1,2,3,4,5,6 days at NOW. Used to satisfy the
// newest-7 floor so that older fixtures exercise the DAY WINDOW rather than the floor.
const SEVEN_RECENT = [
  arc('2026-09-07T00:00:00.000Z'),  // 0d
  arc('2026-09-06T00:00:00.000Z'),  // 1d
  arc('2026-09-05T00:00:00.000Z'),  // 2d
  arc('2026-09-04T00:00:00.000Z'),  // 3d
  arc('2026-09-03T00:00:00.000Z'),  // 4d
  arc('2026-09-02T00:00:00.000Z'),  // 5d
  arc('2026-09-01T00:00:00.000Z')   // 6d
];

// ---------------------------------------------------------------------------
// 3. THE BOUNDARY. 14 days is kept, exactly 15 days is kept, 16 days is deleted.
//
//    Intent, stated explicitly: the requirement is "delete archives OLDER THAN 15 days".
//    An archive whose age is exactly 15.000 days is not older than 15 days, so it is
//    KEPT. The comparison is `age > 15d` for deletion, i.e. `ms >= cutoff` for keeping.
//    This is the conservative side of the boundary: at the exact tick, we retain.
//
//    The seven recent archives above absorb the newest-7 floor, so the three boundary
//    archives are judged purely by the day window.
// ---------------------------------------------------------------------------
const boundary = [
  ...SEVEN_RECENT,
  POINTER,
  arc('2026-08-24T00:00:00.000Z'),   // exactly 14 days before NOW -> KEEP
  arc('2026-08-23T00:00:00.000Z'),   // exactly 15 days before NOW -> KEEP (boundary tick)
  arc('2026-08-22T00:00:00.000Z')    // exactly 16 days before NOW -> DELETE
];
const rBoundary = selectBackupsForDeletion(boundary, NOW);
assert.strictEqual(rBoundary.ok, true);
assert.strictEqual(rBoundary.cutoffIso, '2026-08-23T00:00:00.000Z',
  'The 15-day cutoff from 2026-09-07T00:00:00Z is 2026-08-23T00:00:00Z');
assert.deepStrictEqual(rBoundary.toDelete.map(x => x.name), [
  'cosmos_backup_2026-08-22T00-00-00-000Z.json'
], 'Only the 16-day-old archive may be selected');
assert.ok(rBoundary.toKeep.some(x => x.name === 'cosmos_backup_2026-08-24T00-00-00-000Z.json'),
  '14 days old is inside the window and must be kept');
const exactly15 = rBoundary.toKeep.find(x => x.name === 'cosmos_backup_2026-08-23T00-00-00-000Z.json');
assert.ok(exactly15, 'Exactly 15 days old must be KEPT: "older than 15 days" excludes the tick itself');
assert.strictEqual(exactly15.keepReason, 'within 15d window',
  'The exactly-15-day archive is kept by the window, not rescued by the floor');
assert.strictEqual(exactly15.ageDays, 15, 'Its measured age is exactly 15.00 days');
assert.strictEqual(rBoundary.toKeep.length, 9);
assert.strictEqual(rBoundary.archiveCount, 10);
console.log('  ok  boundary: 14d kept, exactly 15d kept (tick is retained), 16d selected');

// ---------------------------------------------------------------------------
// 4. The newest-7 floor survives even when EVERY archive is older than 15 days.
//    Fixture: 12 archives dated 2026-08-01 .. 2026-08-12, ages 26..37 days at NOW.
//    Newest 7 by date: 08-12, 08-11, 08-10, 08-09, 08-08, 08-07, 08-06 -> all kept.
//    Remaining 5: 08-05, 08-04, 08-03, 08-02, 08-01 -> all selected.
// ---------------------------------------------------------------------------
const ALL_OLD = [
  arc('2026-08-01T00:00:00.000Z'), arc('2026-08-02T00:00:00.000Z'), arc('2026-08-03T00:00:00.000Z'),
  arc('2026-08-04T00:00:00.000Z'), arc('2026-08-05T00:00:00.000Z'), arc('2026-08-06T00:00:00.000Z'),
  arc('2026-08-07T00:00:00.000Z'), arc('2026-08-08T00:00:00.000Z'), arc('2026-08-09T00:00:00.000Z'),
  arc('2026-08-10T00:00:00.000Z'), arc('2026-08-11T00:00:00.000Z'), arc('2026-08-12T00:00:00.000Z')
];
const rFloor = selectBackupsForDeletion([...ALL_OLD, POINTER], NOW);
assert.strictEqual(rFloor.ok, true);
assert.deepStrictEqual(rFloor.toDelete.map(x => x.name).sort(), [
  'cosmos_backup_2026-08-01T00-00-00-000Z.json',
  'cosmos_backup_2026-08-02T00-00-00-000Z.json',
  'cosmos_backup_2026-08-03T00-00-00-000Z.json',
  'cosmos_backup_2026-08-04T00-00-00-000Z.json',
  'cosmos_backup_2026-08-05T00-00-00-000Z.json'
], 'With all 12 archives past the window, exactly the 5 oldest may go');
assert.strictEqual(rFloor.toKeep.length, 7, 'Exactly the newest 7 survive');
assert.strictEqual(rFloor.protectedByFloor.length, 7);
assert.deepStrictEqual(rFloor.protectedByFloor.map(x => x.name), [
  'cosmos_backup_2026-08-12T00-00-00-000Z.json',
  'cosmos_backup_2026-08-11T00-00-00-000Z.json',
  'cosmos_backup_2026-08-10T00-00-00-000Z.json',
  'cosmos_backup_2026-08-09T00-00-00-000Z.json',
  'cosmos_backup_2026-08-08T00-00-00-000Z.json',
  'cosmos_backup_2026-08-07T00-00-00-000Z.json',
  'cosmos_backup_2026-08-06T00-00-00-000Z.json'
], 'The floor is the newest 7 by date, newest first');
for (const kept of rFloor.toKeep) {
  assert.strictEqual(kept.keepReason, 'newest-7 floor',
    'Every survivor here is rescued by the floor, not by the window');
}
console.log('  ok  newest-7 floor keeps 7 of 12 when every archive is past the window');

// ---------------------------------------------------------------------------
// 5. The latest pointer is never selected, at ANY age.
//    Given a pointer whose lastModified is over 6 years old.
// ---------------------------------------------------------------------------
const ancientPointer = { name: 'cosmos_backup_latest.json', lastModified: '2020-01-01T00:00:00.000Z' };
const ancientPointerSidecar = { name: 'cosmos_backup_latest.json.sha256', lastModified: '2020-01-01T00:00:00.000Z' };
const rPointer = selectBackupsForDeletion([...ALL_OLD, ancientPointer, ancientPointerSidecar], NOW);
assert.strictEqual(rPointer.ok, true);
assert.ok(!rPointer.toDelete.some(x => x.name.includes('latest')),
  'cosmos_backup_latest.json must never be selected, however old it looks');
assert.ok(!rPointer.sidecarsToDelete.some(n => n.includes('latest')),
  'The latest pointer sidecar must never be selected');
assert.deepStrictEqual(rPointer.toDelete.map(x => x.name).sort(), [
  'cosmos_backup_2026-08-01T00-00-00-000Z.json',
  'cosmos_backup_2026-08-02T00-00-00-000Z.json',
  'cosmos_backup_2026-08-03T00-00-00-000Z.json',
  'cosmos_backup_2026-08-04T00-00-00-000Z.json',
  'cosmos_backup_2026-08-05T00-00-00-000Z.json'
], 'A 2020-dated pointer changes nothing about which archives are selected');
console.log('  ok  cosmos_backup_latest.json (+ sidecar) never selected, even dated 2020');

// ---------------------------------------------------------------------------
// 6. Sidecars: every selected archive brings its own, and no sidecar goes alone.
//    Sidecars present for 08-01 and 08-03 (both selected) and for 08-09 (kept by floor).
//    Expected sidecarsToDelete: exactly the two whose archives are selected.
// ---------------------------------------------------------------------------
const withSidecars = [
  ...ALL_OLD,
  POINTER,
  POINTER_SIDECAR,
  side('2026-08-01T00:00:00.000Z'),
  side('2026-08-03T00:00:00.000Z'),
  side('2026-08-09T00:00:00.000Z')
];
const rSide = selectBackupsForDeletion(withSidecars, NOW);
assert.deepStrictEqual(rSide.sidecarsToDelete.slice().sort(), [
  'cosmos_backup_2026-08-01T00-00-00-000Z.json.sha256',
  'cosmos_backup_2026-08-03T00-00-00-000Z.json.sha256'
], 'Only sidecars whose own archive is selected may be selected');
const deletedSet = new Set(rSide.toDelete.map(x => x.name));
for (const s of rSide.sidecarsToDelete) {
  assert.ok(deletedSet.has(s.replace(/\.sha256$/, '')),
    `Sidecar ${s} was selected without its archive`);
}
// The 08-09 sidecar belongs to a floor-protected archive and must survive.
assert.ok(!rSide.sidecarsToDelete.includes('cosmos_backup_2026-08-09T00-00-00-000Z.json.sha256'),
  'A kept archive keeps its sidecar');
// Pairing and ORDER: archive first, then its own sidecar.
const pairs = buildDeletionPairs(rSide);
assert.strictEqual(pairs.length, 5, 'One pair per selected archive');
const pair01 = pairs.find(p => p.archive === 'cosmos_backup_2026-08-01T00-00-00-000Z.json');
assert.strictEqual(pair01.sidecar, 'cosmos_backup_2026-08-01T00-00-00-000Z.json.sha256');
const pair02 = pairs.find(p => p.archive === 'cosmos_backup_2026-08-02T00-00-00-000Z.json');
assert.strictEqual(pair02.sidecar, null, 'An archive with no sidecar pairs with null, not a guess');
// Archives that never had a sidecar are reported, not silently deleted-with-a-phantom.
assert.deepStrictEqual(rSide.archivesWithoutSidecar.slice().sort(), [
  'cosmos_backup_2026-08-02T00-00-00-000Z.json',
  'cosmos_backup_2026-08-04T00-00-00-000Z.json',
  'cosmos_backup_2026-08-05T00-00-00-000Z.json',
  'cosmos_backup_2026-08-06T00-00-00-000Z.json',
  'cosmos_backup_2026-08-07T00-00-00-000Z.json',
  'cosmos_backup_2026-08-08T00-00-00-000Z.json',
  'cosmos_backup_2026-08-10T00-00-00-000Z.json',
  'cosmos_backup_2026-08-11T00-00-00-000Z.json',
  'cosmos_backup_2026-08-12T00-00-00-000Z.json'
], 'Unchecksummed archives are reported so an operator can see them');
console.log('  ok  sidecars follow their archive, never travel alone, pair archive-first');

// ---------------------------------------------------------------------------
// 7. Unusable listings => ZERO deletions. Never a partial prune.
// ---------------------------------------------------------------------------
for (const [label, input, code] of [
  ['listing error (null)', null, REFUSAL.LISTING_UNAVAILABLE],
  ['listing error (undefined)', undefined, REFUSAL.LISTING_UNAVAILABLE],
  ['listing error (not an array)', { name: 'oops' }, REFUSAL.LISTING_UNAVAILABLE],
  ['empty container', [], REFUSAL.EMPTY_LISTING]
]) {
  const r = selectBackupsForDeletion(input, NOW);
  assert.strictEqual(r.ok, false, `${label}: plan must be refused`);
  assert.strictEqual(r.refusalCode, code, `${label}: wrong refusal code`);
  assert.strictEqual(r.toDelete.length, 0, `${label}: must select ZERO archives`);
  assert.strictEqual(r.sidecarsToDelete.length, 0, `${label}: must select ZERO sidecars`);
  assert.deepStrictEqual(buildDeletionPairs(r), [], `${label}: must yield no delete pairs`);
}
// A listing missing the latest pointer is treated as "not the container I think it is".
const rNoPointer = selectBackupsForDeletion(ALL_OLD, NOW);
assert.strictEqual(rNoPointer.ok, false);
assert.strictEqual(rNoPointer.refusalCode, REFUSAL.POINTER_MISSING);
assert.strictEqual(rNoPointer.toDelete.length, 0,
  'Without the latest pointer the listing is not trusted, so nothing is selected');
// A single-archive container: one archive, however old, plus the pointer.
const rSingle = selectBackupsForDeletion([arc('2025-01-01T00:00:00.000Z'), POINTER], NOW);
assert.strictEqual(rSingle.ok, true);
assert.strictEqual(rSingle.archiveCount, 1);
assert.strictEqual(rSingle.toDelete.length, 0,
  'A container with one 615-day-old archive still deletes nothing: the floor holds it');
assert.strictEqual(rSingle.toKeep[0].keepReason, 'newest-7 floor');
console.log('  ok  listing error, empty container, missing pointer and single archive all delete NOTHING');

// ---------------------------------------------------------------------------
// 8. Nothing outside the cosmos-backups archive namespace can ever be selected.
//    The selector takes no container argument at all, and foreign blob names — even
//    ones planted inside this listing — are ignored.
// ---------------------------------------------------------------------------
assert.strictEqual(selectBackupsForDeletion.length, 2,
  'The selector takes (blobs, nowMs) only — there is no container parameter to redirect');
const foreign = [
  ...ALL_OLD,
  POINTER,
  { name: '20260828185431-6e37ac86-b5e7-4db2-bd46-3654ccbd36e2.zip', lastModified: '2026-08-28T18:54:31.000Z' },
  { name: 'refactor-baseline/baseline_2026-08-29T14-09-29Z/UATStudentAnswers.json', lastModified: '2026-08-29T14:09:29.000Z' },
  { name: 'refactor-baseline/baseline_2026-08-29T14-09-29Z/cosmos_backup_2026-08-01T00-00-00-000Z.json', lastModified: '2026-08-01T00:00:00.000Z' },
  { name: 'index.html', lastModified: '2026-08-01T00:00:00.000Z' },
  { name: 'data/questions_data.js', lastModified: '2026-08-01T00:00:00.000Z' },
  { name: 'UATStudentAnswers', lastModified: '2026-08-01T00:00:00.000Z' },
  { name: 'backup_FAILED_2026-08-02T00-00-00-000Z.json', lastModified: '2026-08-02T00:00:00.000Z' },
  { name: 'cosmos_backup_notatimestamp.json', lastModified: '2026-08-01T00:00:00.000Z' },
  { name: 'cosmos_backup_2026-08-01T00-00-00-000Z.json', lastModified: null }   // no usable age
];
const rForeign = selectBackupsForDeletion(foreign, NOW);
assert.deepStrictEqual(rForeign.toDelete.map(x => x.name).sort(), [
  'cosmos_backup_2026-08-01T00-00-00-000Z.json',
  'cosmos_backup_2026-08-02T00-00-00-000Z.json',
  'cosmos_backup_2026-08-03T00-00-00-000Z.json',
  'cosmos_backup_2026-08-04T00-00-00-000Z.json',
  'cosmos_backup_2026-08-05T00-00-00-000Z.json'
], 'Only bare cosmos_backup_<ts>.json archives may be selected; every foreign blob is ignored');
for (const bad of ['.zip', 'refactor-baseline/', 'index.html', 'questions_data', 'UATStudentAnswers', 'FAILED', 'notatimestamp']) {
  assert.ok(!rForeign.toDelete.some(x => x.name.includes(bad)),
    `A blob matching "${bad}" must never be selected for deletion`);
  assert.ok(!rForeign.sidecarsToDelete.some(n => n.includes(bad)),
    `A sidecar matching "${bad}" must never be selected for deletion`);
}
assert.strictEqual(rForeign.container, 'cosmos-backups',
  'The plan names the one container it applies to');
console.log('  ok  release zips, refactor-baseline/, $web files, markers and unaged blobs are all ignored');

// ---------------------------------------------------------------------------
// 9. Age skew: when the filename time and lastModified disagree, the YOUNGER reading
//    wins, so disagreement can only ever keep a backup longer. Both directions.
//    skewA: name says 2026-08-01 (37d), blob says 2026-08-28 (10d) -> treated as 10d.
//    skewB: name says 2026-08-28 (10d), blob says 2026-08-01 (37d) -> treated as 10d.
//    control: a plain 20-day-old archive -> selected.
// ---------------------------------------------------------------------------
const skewA = arc('2026-08-01T00:00:00.000Z', '2026-08-28T00:00:00.000Z');
const skewB = arc('2026-08-28T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
const control = arc('2026-08-18T00:00:00.000Z');   // 20 days old, no skew
const rSkew = selectBackupsForDeletion([...SEVEN_RECENT, POINTER, skewA, skewB, control], NOW);
assert.strictEqual(rSkew.ok, true);
assert.deepStrictEqual(rSkew.toDelete.map(x => x.name), [
  'cosmos_backup_2026-08-18T00-00-00-000Z.json'
], 'Only the unambiguous 20-day-old archive may be selected');
const keptA = rSkew.toKeep.find(x => x.name === 'cosmos_backup_2026-08-01T00-00-00-000Z.json');
const keptB = rSkew.toKeep.find(x => x.name === 'cosmos_backup_2026-08-28T00-00-00-000Z.json');
assert.ok(keptA && keptA.keepReason === 'within 15d window',
  'A 37-day-old NAME with a 10-day-old lastModified is kept by the window');
assert.ok(keptB && keptB.keepReason === 'within 15d window',
  'A 10-day-old NAME with a 37-day-old lastModified is kept by the window');
assert.strictEqual(keptA.ageDays, 10);
assert.strictEqual(keptB.ageDays, 10);
assert.strictEqual(rSkew.skewWarnings.length, 2, 'Both disagreements are reported to the operator');
console.log('  ok  filename/lastModified disagreement always keeps, never deletes; both cases reported');

// ---------------------------------------------------------------------------
// 10. The executor honours the plan flag, the apply flag, and the pairing order.
//     A fake container client: no network, no Azure, no deletion of anything real.
// ---------------------------------------------------------------------------
function fakeContainer(failOn) {
  const calls = [];
  return {
    calls,
    getBlockBlobClient(name) {
      return {
        async deleteIfExists() {
          calls.push(name);
          if (failOn && failOn === name) throw new Error('simulated storage failure');
          return { succeeded: true };
        }
      };
    }
  };
}
const silent = { log: () => {}, warn: () => {} };

// 10a. apply omitted => nothing is touched at all.
(async () => {
  const c1 = fakeContainer();
  const out1 = await executeRetentionPlan(c1, rSide, Object.assign({}, silent));
  assert.strictEqual(out1.applied, false, 'Without apply:true the executor must not run');
  assert.strictEqual(c1.calls.length, 0, 'Without apply:true not a single delete call may be made');
  assert.strictEqual(out1.deleted.length, 0);

  // 10b. A REFUSED plan cannot be executed even with apply:true.
  const c2 = fakeContainer();
  const refused = selectBackupsForDeletion(null, NOW);
  const out2 = await executeRetentionPlan(c2, refused, Object.assign({ apply: true }, silent));
  assert.strictEqual(out2.applied, false, 'A refused plan must never execute');
  assert.strictEqual(c2.calls.length, 0, 'A refused plan must make zero delete calls');

  // 10c. Happy path: archive immediately followed by its own sidecar.
  const c3 = fakeContainer();
  const out3 = await executeRetentionPlan(c3, rSide, Object.assign({ apply: true }, silent));
  assert.strictEqual(out3.applied, true);
  assert.deepStrictEqual(c3.calls, [
    'cosmos_backup_2026-08-05T00-00-00-000Z.json',
    'cosmos_backup_2026-08-04T00-00-00-000Z.json',
    'cosmos_backup_2026-08-03T00-00-00-000Z.json',
    'cosmos_backup_2026-08-03T00-00-00-000Z.json.sha256',
    'cosmos_backup_2026-08-02T00-00-00-000Z.json',
    'cosmos_backup_2026-08-01T00-00-00-000Z.json',
    'cosmos_backup_2026-08-01T00-00-00-000Z.json.sha256'
  ], 'Deletes run newest-first, each archive immediately followed by its own sidecar');
  assert.strictEqual(out3.failures.length, 0);

  // 10d. If an archive delete fails, its sidecar is NOT deleted: never leave an
  //      archive without its checksum.
  const c4 = fakeContainer('cosmos_backup_2026-08-01T00-00-00-000Z.json');
  const out4 = await executeRetentionPlan(c4, rSide, Object.assign({ apply: true }, silent));
  assert.ok(!c4.calls.includes('cosmos_backup_2026-08-01T00-00-00-000Z.json.sha256'),
    'A sidecar must not be deleted when its archive delete failed');
  assert.deepStrictEqual(out4.skipped, ['cosmos_backup_2026-08-01T00-00-00-000Z.json.sha256']);
  assert.strictEqual(out4.failures.length, 1);
  assert.ok(/simulated storage failure/.test(out4.failures[0]));
  console.log('  ok  executor: refuses without apply, refuses a refused plan, pairs archive->sidecar, keeps sidecar on archive failure');

  // -------------------------------------------------------------------------
  // 11. The SCHEDULED job (api/src/functions/backupPrune.js) end to end, driven
  //     with a fake container client and an injected clock. No network, no Azure,
  //     nothing real is ever deleted by this test.
  // -------------------------------------------------------------------------
  const prune = require('../api/src/functions/backupPrune.js');

  // Schedule: 04:30:00 UTC, well clear of the 02:00:00 UTC backup.
  assert.strictEqual(prune.PRUNE_SCHEDULE, '0 30 4 * * *',
    'The prune must be scheduled at 04:30 UTC');
  const backupSchedule = '0 0 2 * * *';
  const [, pruneMin, pruneHour] = prune.PRUNE_SCHEDULE.split(' ');
  const [, backupMin, backupHour] = backupSchedule.split(' ');
  const pruneMinutes = Number(pruneHour) * 60 + Number(pruneMin);
  const backupMinutes = Number(backupHour) * 60 + Number(backupMin);
  assert.strictEqual(backupMinutes, 120, 'The backup runs at 02:00 UTC = minute 120');
  assert.strictEqual(pruneMinutes, 270, 'The prune runs at 04:30 UTC = minute 270');
  assert.strictEqual(pruneMinutes - backupMinutes, 150,
    'The prune must start 150 minutes (2h30m) after the backup, never alongside it');
  console.log('  ok  scheduled at 04:30 UTC — 150 minutes after the 02:00 UTC backup');

  // A listing-capable fake container. `throwAfter` simulates a paging failure partway
  // through enumeration, which is exactly the partial-listing hazard.
  function fakeListingContainer(blobs, opts) {
    const o = opts || {};
    const deleteCalls = [];
    return {
      deleteCalls,
      listBlobsFlat() {
        return (async function* () {
          let i = 0;
          for (const b of blobs) {
            if (o.throwAfter !== undefined && i === o.throwAfter) {
              throw new Error('simulated paging failure');
            }
            i += 1;
            yield { name: b.name, properties: { lastModified: new Date(b.lastModified) } };
          }
        })();
      },
      getBlockBlobClient(name) {
        return {
          async deleteIfExists() {
            deleteCalls.push(name);
            return { succeeded: true };
          }
        };
      }
    };
  }

  // The pointer is listed FIRST on purpose. If it came last, a truncated listing would
  // be caught by the POINTER_MISSING guard instead, and this fixture would not actually
  // exercise the "discard the partial listing" rule it is meant to test.
  const prunable = [POINTER, ...ALL_OLD, side('2026-08-01T00:00:00.000Z')];

  // 11a. A listing that fails partway must delete NOTHING. The truncation point is chosen
  //      so the partial view is individually plausible — pointer + the 10 oldest archives
  //      — and would yield 3 deletions if it were trusted. It must yield none.
  const cFail = fakeListingContainer(prunable, { throwAfter: 11 });
  const repFail = await prune.performBackupPrune({
    containerClient: cFail, nowMs: NOW, apply: true, log: () => {}, warn: () => {}
  });
  assert.strictEqual(repFail.refused, true, 'A partial listing must refuse');
  assert.strictEqual(repFail.refusalCode, REFUSAL.LISTING_UNAVAILABLE);
  assert.strictEqual(repFail.blobsListed, null, 'The partial listing is discarded, not counted');
  assert.strictEqual(repFail.deleted.length, 0);
  assert.strictEqual(cFail.deleteCalls.length, 0,
    'A prune that could not enumerate the container must make ZERO delete calls');
  console.log('  ok  scheduled job: enumeration failure => 0 delete calls, refused, reported');

  // 11b. Disarmed (BACKUP_PRUNE_APPLY not 'true'): plans, logs, deletes nothing.
  const cDry = fakeListingContainer(prunable);
  const repDry = await prune.performBackupPrune({
    containerClient: cDry, nowMs: NOW, apply: false, log: () => {}, warn: () => {}
  });
  assert.strictEqual(repDry.refused, false);
  assert.strictEqual(repDry.armed, false);
  assert.strictEqual(repDry.blobsListed, 14, '12 archives + pointer + 1 sidecar were listed');
  assert.deepStrictEqual(repDry.selectedArchives.slice().sort(), [
    'cosmos_backup_2026-08-01T00-00-00-000Z.json',
    'cosmos_backup_2026-08-02T00-00-00-000Z.json',
    'cosmos_backup_2026-08-03T00-00-00-000Z.json',
    'cosmos_backup_2026-08-04T00-00-00-000Z.json',
    'cosmos_backup_2026-08-05T00-00-00-000Z.json'
  ], 'The disarmed run still reports exactly what it WOULD delete');
  assert.strictEqual(cDry.deleteCalls.length, 0,
    'A disarmed run must make ZERO delete calls');
  assert.strictEqual(repDry.keptArchives.length, 7);
  console.log('  ok  scheduled job: disarmed run plans and reports but makes 0 delete calls');

  // 11c. Armed: deletes exactly the plan, archive before sidecar, pointer untouched.
  const cArmed = fakeListingContainer(prunable);
  const repArmed = await prune.performBackupPrune({
    containerClient: cArmed, nowMs: NOW, apply: true, log: () => {}, warn: () => {}
  });
  assert.deepStrictEqual(cArmed.deleteCalls, [
    'cosmos_backup_2026-08-05T00-00-00-000Z.json',
    'cosmos_backup_2026-08-04T00-00-00-000Z.json',
    'cosmos_backup_2026-08-03T00-00-00-000Z.json',
    'cosmos_backup_2026-08-02T00-00-00-000Z.json',
    'cosmos_backup_2026-08-01T00-00-00-000Z.json',
    'cosmos_backup_2026-08-01T00-00-00-000Z.json.sha256'
  ], 'An armed run deletes exactly the planned blobs, archive before its sidecar');
  assert.ok(!cArmed.deleteCalls.some(n => n.includes('latest')),
    'An armed run must never touch the latest pointer');
  assert.strictEqual(repArmed.failures.length, 0);
  assert.strictEqual(repArmed.deleted.length, 6);
  console.log('  ok  scheduled job: armed run deletes exactly the plan and never the pointer');

  // 11d. An empty container deletes nothing and is not treated as a prune failure.
  const cEmpty = fakeListingContainer([]);
  const repEmpty = await prune.performBackupPrune({
    containerClient: cEmpty, nowMs: NOW, apply: true, log: () => {}, warn: () => {}
  });
  assert.strictEqual(repEmpty.refusalCode, REFUSAL.EMPTY_LISTING);
  assert.strictEqual(cEmpty.deleteCalls.length, 0, 'An empty container must delete nothing');
  console.log('  ok  scheduled job: empty container => 0 delete calls');

  // -------------------------------------------------------------------------
  // REGRESSION: the floor must rank by the IMMUTABLE filename timestamp.
  //
  // Found by external review after the first implementation shipped. `ms` is
  // max(filenameMs, lastModifiedMs), which is correct for the WINDOW (looking
  // younger only keeps an archive longer) but was catastrophic for the FLOOR,
  // where looking younger DISPLACES a genuinely newer archive out of protection.
  // lastModified is mutable: a re-copy, tier change or metadata write bumps it.
  //
  // Original reproduction: seven January archives whose metadata had been bumped
  // to August occupied all seven floor slots, and every one of the seven
  // genuinely newer July archives was selected for deletion.
  // -------------------------------------------------------------------------
  {
    const nm = (d) => 'cosmos_backup_' + d + '.json';
    const blobs = [{ name: 'cosmos_backup_latest.json', lastModified: new Date(NOW) }];
    // genuinely OLDEST, but metadata bumped to look recent
    for (let i = 0; i < 7; i++) {
      blobs.push({ name: nm('2026-01-0' + (i + 1) + 'T02-00-00-000Z'),
                   lastModified: new Date(Date.UTC(2026, 7, 20 + (i % 5))) });
    }
    // genuinely NEWEST, untouched metadata
    for (let i = 0; i < 7; i++) {
      blobs.push({ name: nm('2026-07-0' + (i + 1) + 'T02-00-00-000Z'),
                   lastModified: new Date(Date.UTC(2026, 6, 1 + i)) });
    }
    const r = selectBackupsForDeletion(blobs, NOW);
    const deleted = r.toDelete.map(x => x.name);

    assert.strictEqual(deleted.filter(n => n.includes('2026-07')).length, 0,
      'REGRESSION: the seven genuinely NEWEST (July) archives must never be deleted. ' +
      'A bumped lastModified on older archives must not displace them from the floor.');
    assert.deepStrictEqual(
      r.protectedByFloor.map(x => x.name.slice(14, 21)),
      ['2026-07', '2026-07', '2026-07', '2026-07', '2026-07', '2026-07', '2026-07'],
      'The floor must hold the seven newest by FILENAME timestamp, not by lastModified');
    // The January archives look ~14-18 days old through their bumped metadata, so the
    // window legitimately spares some of them. That direction is safe: max() only ever
    // keeps an archive longer. What must never happen is a NEWER archive being deleted.
    assert.ok(deleted.length > 0 && deleted.every(n => n.includes('2026-01')),
      'Only the genuinely oldest archives may be selected');
  }
  console.log('  ok  floor ranks by immutable filename time — a bumped lastModified cannot displace a newer backup');

  // -------------------------------------------------------------------------
  // REGRESSION: Date.UTC() rolls impossible dates over instead of rejecting.
  //   Date.UTC(2026, 1, 31) -> 2026-03-03      (February 31st)
  //   Date.UTC(2026, 1, 29) -> 2026-03-01      (2026 is not a leap year)
  // A rolled-over date is a FABRICATED age, and a fabricated age on a deletion
  // path decides whether a real backup lives or dies. An archive whose age cannot
  // be determined must never be a deletion candidate.
  // -------------------------------------------------------------------------
  {
    const nm = (d) => 'cosmos_backup_' + d + '.json';
    const base = [{ name: 'cosmos_backup_latest.json', lastModified: new Date(NOW) }];
    for (let i = 0; i < 8; i++) {
      base.push({ name: nm('2026-09-0' + (i + 1) + 'T02-00-00-000Z'),
                  lastModified: new Date(Date.UTC(2026, 8, 1 + i)) });
    }

    const impossible = base.concat([
      { name: nm('2026-02-31T02-00-00-000Z'), lastModified: new Date(Date.UTC(2026, 1, 28)) },
      { name: nm('2026-02-29T02-00-00-000Z'), lastModified: new Date(Date.UTC(2026, 1, 28)) },
      { name: nm('2026-13-01T02-00-00-000Z'), lastModified: new Date(Date.UTC(2026, 1, 28)) }
    ]);
    const rBad = selectBackupsForDeletion(impossible, NOW);
    ['02-31', '02-29', '13-01'].forEach((frag) => {
      assert.ok(!rBad.toDelete.some(x => x.name.includes(frag)),
        'An archive dated ' + frag + ' has no determinable age and must never be selected');
    });

    // ...and the fix must not over-protect: a REAL leap day is a real date.
    const leap = base.concat([
      { name: nm('2024-02-29T02-00-00-000Z'), lastModified: new Date(Date.UTC(2024, 1, 29)) }
    ]);
    const rLeap = selectBackupsForDeletion(leap, NOW);
    assert.ok(rLeap.toDelete.some(x => x.name.includes('2024-02-29')),
      '2024-02-29 IS a valid leap day; rejecting it would silently keep archives forever');
  }
  console.log('  ok  impossible calendar dates are never deletable; a real leap day still is');

  console.log('\nAll backup retention tests passed.\n');
})().catch(err => {
  console.error('\nTEST FAILURE: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
