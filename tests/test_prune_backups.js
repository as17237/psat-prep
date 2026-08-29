/**
 * tests/test_prune_backups.js
 *
 * Unit tests for the retention selector in scripts/prune_backups.js.
 * Pure function, hand-written fixture blob listings, "now" injected as a parameter
 * (never read from the clock, never monkeypatched).
 *
 * Policy under test:
 *   - keep every backup <= 30 days old
 *   - older than 30 days: keep exactly one (the newest) per ISO week
 *   - HARD refusal: the newest 7 backups are never deleted, whatever the policy says
 *   - only cosmos_backup_<timestamp>.json archives are ever candidates; the
 *     cosmos_backup_latest.json pointer, failure markers and unrelated blobs are
 *     never touched. A deleted archive takes its .sha256 sidecar with it.
 */

const assert = require('assert');
const {
  isoWeekKey,
  selectBackupsForDeletion,
  RETENTION_DAYS,
  MIN_KEEP_NEWEST
} = require('../scripts/prune_backups.js');

console.log('Testing prune_backups.js retention selector...');

assert.strictEqual(RETENTION_DAYS, 30);
assert.strictEqual(MIN_KEEP_NEWEST, 7);

// ---------------------------------------------------------------------------
// 1. ISO week keys — hand-verified against the ISO-8601 calendar.
//    ISO week 1 of 2026 runs Mon 2025-12-29 .. Sun 2026-01-04.
//    ISO week 35 of 2026 runs Mon 2026-08-24 .. Sun 2026-08-30.
// ---------------------------------------------------------------------------
assert.strictEqual(isoWeekKey(new Date('2026-01-01T00:00:00.000Z')), '2026-W01');
assert.strictEqual(isoWeekKey(new Date('2025-12-29T00:00:00.000Z')), '2026-W01');
assert.strictEqual(isoWeekKey(new Date('2026-01-04T23:59:59.000Z')), '2026-W01');
assert.strictEqual(isoWeekKey(new Date('2026-01-05T00:00:00.000Z')), '2026-W02');
assert.strictEqual(isoWeekKey(new Date('2026-08-24T00:00:00.000Z')), '2026-W35');
assert.strictEqual(isoWeekKey(new Date('2026-08-29T12:00:00.000Z')), '2026-W35');
assert.strictEqual(isoWeekKey(new Date('2026-08-30T23:00:00.000Z')), '2026-W35');
assert.strictEqual(isoWeekKey(new Date('2026-08-31T00:00:00.000Z')), '2026-W36');
console.log('✓ ISO week keys match the hand-checked ISO-8601 calendar');

const NOW = Date.parse('2026-08-29T12:00:00.000Z');
const b = (iso) => ({ name: `cosmos_backup_${iso.replace(/[:.]/g, '-')}.json`, lastModified: iso });
const sidecar = (iso) => ({ name: `cosmos_backup_${iso.replace(/[:.]/g, '-')}.json.sha256`, lastModified: iso });

// ---------------------------------------------------------------------------
// 2. Nothing older than 30 days => nothing deleted.
// ---------------------------------------------------------------------------
const recentOnly = [
  b('2026-08-29T02:00:00.000Z'), b('2026-08-28T02:00:00.000Z'), b('2026-08-27T02:00:00.000Z'),
  b('2026-08-26T02:00:00.000Z'), b('2026-08-25T02:00:00.000Z'), b('2026-08-24T02:00:00.000Z'),
  b('2026-08-23T02:00:00.000Z'), b('2026-08-10T02:00:00.000Z'), b('2026-08-01T02:00:00.000Z')
];
const r2 = selectBackupsForDeletion(recentOnly, NOW);
assert.strictEqual(r2.toDelete.length, 0, 'No backup within 30 days may be deleted');
assert.strictEqual(r2.toKeep.length, 9);
console.log('✓ Backups within the 30-day window are all kept (0 deletions from 9)');

// ---------------------------------------------------------------------------
// 3. Old backups: one per ISO week survives, the rest are selected.
//    Fixture: 8 recent (so the newest-7 floor is already satisfied by recents)
//    plus, in 2026-W23 (Mon 2026-06-01 .. Sun 2026-06-07), four archives; and in
//    2026-W22 (Mon 2026-05-25 .. Sun 2026-05-31), two archives.
//    Expected survivors from the old set: 2026-06-06 (newest in W23) and
//    2026-05-30 (newest in W22). Expected deletions: the other 4.
// ---------------------------------------------------------------------------
const recents = [
  b('2026-08-29T02:00:00.000Z'), b('2026-08-28T02:00:00.000Z'), b('2026-08-27T02:00:00.000Z'),
  b('2026-08-26T02:00:00.000Z'), b('2026-08-25T02:00:00.000Z'), b('2026-08-24T02:00:00.000Z'),
  b('2026-08-23T02:00:00.000Z'), b('2026-08-22T02:00:00.000Z')
];
const olds = [
  b('2026-06-06T02:00:00.000Z'), b('2026-06-04T02:00:00.000Z'),
  b('2026-06-02T02:00:00.000Z'), b('2026-06-01T02:00:00.000Z'),
  b('2026-05-30T02:00:00.000Z'), b('2026-05-26T02:00:00.000Z')
];
const r3 = selectBackupsForDeletion([...recents, ...olds], NOW);
const deletedNames3 = r3.toDelete.map(x => x.name).sort();
assert.deepStrictEqual(deletedNames3, [
  'cosmos_backup_2026-05-26T02-00-00-000Z.json',
  'cosmos_backup_2026-06-01T02-00-00-000Z.json',
  'cosmos_backup_2026-06-02T02-00-00-000Z.json',
  'cosmos_backup_2026-06-04T02-00-00-000Z.json'
], 'Exactly the non-newest archive of each old ISO week must be selected');
assert.ok(r3.toKeep.some(x => x.name === 'cosmos_backup_2026-06-06T02-00-00-000Z.json'));
assert.ok(r3.toKeep.some(x => x.name === 'cosmos_backup_2026-05-30T02-00-00-000Z.json'));
console.log('✓ Weekly retention keeps exactly one archive per old ISO week (4 of 14 selected)');

// ---------------------------------------------------------------------------
// 4. HARD refusal: the newest 7 archives are never deleted, even when policy
//    would delete them. Fixture: 10 archives, ALL older than 30 days, 9 of them
//    in the same ISO week (2026-W23) so policy alone would delete 8 of the 9.
//    The newest-7 floor must rescue the top 7 by recency.
// ---------------------------------------------------------------------------
const allOldSameWeek = [
  b('2026-06-07T02:00:00.000Z'), b('2026-06-06T02:00:00.000Z'), b('2026-06-05T02:00:00.000Z'),
  b('2026-06-04T02:00:00.000Z'), b('2026-06-03T02:00:00.000Z'), b('2026-06-02T02:00:00.000Z'),
  b('2026-06-01T02:00:00.000Z'),
  b('2026-05-30T02:00:00.000Z'), b('2026-05-29T02:00:00.000Z'), b('2026-05-28T02:00:00.000Z')
];
const r4 = selectBackupsForDeletion(allOldSameWeek, NOW);
const kept4 = r4.toKeep.map(x => x.name).sort();
const del4 = r4.toDelete.map(x => x.name).sort();
// Newest 7 by lastModified: 06-07, 06-06, 06-05, 06-04, 06-03, 06-02, 06-01 -> all protected.
// Remaining 3 are in 2026-W22 (05-25..05-31); the newest of that week, 05-30, is kept by policy.
assert.deepStrictEqual(del4, [
  'cosmos_backup_2026-05-28T02-00-00-000Z.json',
  'cosmos_backup_2026-05-29T02-00-00-000Z.json'
], 'The newest 7 archives must be protected regardless of policy');
assert.strictEqual(kept4.length, 8);
assert.strictEqual(r4.protectedByFloor.length, 7);
console.log('✓ Newest-7 hard floor protects archives the weekly policy would otherwise delete');

// ---------------------------------------------------------------------------
// 5. Fewer than 7 archives total => absolutely nothing is deletable.
// ---------------------------------------------------------------------------
const few = [
  b('2026-01-01T02:00:00.000Z'), b('2026-01-02T02:00:00.000Z'), b('2026-01-03T02:00:00.000Z'),
  b('2026-01-04T02:00:00.000Z'), b('2026-01-05T02:00:00.000Z'), b('2026-01-06T02:00:00.000Z')
];
const r5 = selectBackupsForDeletion(few, NOW);
assert.strictEqual(r5.toDelete.length, 0, 'With only 6 archives, nothing may ever be deleted');
console.log('✓ With fewer than 7 archives the selector deletes nothing');

// ---------------------------------------------------------------------------
// 6. Non-archive blobs are never candidates; sidecars of deleted archives follow.
// ---------------------------------------------------------------------------
const mixed = [
  ...recents,
  ...olds,
  ...olds.map(o => sidecar(o.lastModified)),
  { name: 'cosmos_backup_latest.json', lastModified: '2026-08-29T02:00:00.000Z' },
  { name: 'cosmos_backup_latest.json.sha256', lastModified: '2026-08-29T02:00:00.000Z' },
  { name: 'backup_FAILED_2026-06-02T02-00-00-000Z.json', lastModified: '2026-06-02T02:00:00.000Z' },
  { name: 'some_unrelated_blob.txt', lastModified: '2026-01-01T00:00:00.000Z' }
];
const r6 = selectBackupsForDeletion(mixed, NOW);
assert.deepStrictEqual(r6.toDelete.map(x => x.name).sort(), deletedNames3,
  'Only timestamped cosmos_backup archives may be selected for deletion');
assert.deepStrictEqual(r6.sidecarsToDelete.sort(), [
  'cosmos_backup_2026-05-26T02-00-00-000Z.json.sha256',
  'cosmos_backup_2026-06-01T02-00-00-000Z.json.sha256',
  'cosmos_backup_2026-06-02T02-00-00-000Z.json.sha256',
  'cosmos_backup_2026-06-04T02-00-00-000Z.json.sha256'
], 'A deleted archive takes its own sidecar with it, and only its own');
assert.ok(!r6.toDelete.some(x => /latest/.test(x.name)), 'The latest pointer is never deletable');
assert.ok(!r6.toDelete.some(x => /FAILED/.test(x.name)), 'Failure markers are never deletable');
assert.ok(!r6.toDelete.some(x => /unrelated/.test(x.name)), 'Unrelated blobs are never deletable');
// Non-candidates in this listing: 6 sidecars + latest.json + latest.json.sha256
// + 1 FAILED marker + 1 unrelated blob = 10.
assert.strictEqual(r6.ignored.length, 10, 'Non-candidate blobs must be reported as ignored');
console.log('✓ Only timestamped archives are candidates; sidecars follow their archive; pointer/markers untouched');

console.log('✓ All prune_backups.js retention selector unit tests passed!\n');
