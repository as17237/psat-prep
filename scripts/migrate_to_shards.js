#!/usr/bin/env node
/**
 * scripts/migrate_to_shards.js — WI-11.5 additive migration to the sharded data model.
 * ============================================================================
 * Moves one student's `progress` and `srsState` out of the single `student_<name>`
 * master document and into bucketed `progress_shard` / `srs_shard` documents on the same
 * `/student_name` partition — WITHOUT deleting anything.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF OPERATIONS IS THE SAFETY PROPERTY
 * ---------------------------------------------------------------------------
 *   1. READ the master document.
 *   2. BUILD the shard documents in memory and REASSEMBLE them back.
 *   3. PROVE the reassembled state is byte-for-byte identical to what was read
 *      (dm.canonicalMapJson on both sides — every record's own key order preserved
 *      exactly, the map's insertion order sorted because sharding regroups it). A single
 *      differing byte aborts before ANY write happens.
 *   4. WRITE the shards (upsert; additive — the master is untouched at this point).
 *   5. RE-READ the shards back out of Cosmos and prove the round trip AGAIN, this time
 *      through the database rather than through memory.
 *   6. Only then, stamp `shardsVerifiedAt` on the master. That one field is what makes
 *      api/src/lib/shardsync.js treat the shards as authoritative and FREEZE the
 *      master's `progress` / `srsState` — carried forward verbatim on every subsequent
 *      write, never extended, never removed.
 *
 * The legacy master document is NEVER deleted and its legacy fields are NEVER cleared.
 * They stay as a complete, readable fallback at the state they held on migration day.
 * `--rollback` removes the marker and nothing else, which returns the document to
 * dual-write mode with no data movement at all.
 *
 * ---------------------------------------------------------------------------
 * DATA SAFETY (asserts in code, not conventions — CLAUDE.md failure mode 7)
 * ---------------------------------------------------------------------------
 *   - Dry run is the DEFAULT. `--apply` is required to write anything.
 *   - The target database must be the scratch DB `psat-prep-db-drtest`. Targeting the
 *     production database requires `--allow-prod-db`, which is refused outright for
 *     `default_student` unless the separate owner-approval flag is also present
 *     (REFACTOR_PLAN.md §3 lists `student_default_student` as a protected object).
 *   - `exam_*` documents are never read for mutation and never written.
 *   - Credentials come from the environment only, never argv (COSMOS_KEY).
 *
 * Usage:
 *   node scripts/migrate_to_shards.js --student e2e_test_student                # dry run, scratch DB
 *   COSMOS_KEY=... node scripts/migrate_to_shards.js --student e2e_test_student --apply
 *   node scripts/migrate_to_shards.js --student e2e_test_student --rollback --apply
 *   node scripts/migrate_to_shards.js --assert-test                             # offline guard check
 */

'use strict';

const path = require('path');

const dm = require(path.join(__dirname, '..', 'api', 'src', 'lib', 'datamodel.js'));

const SCRATCH_DB = 'psat-prep-db-drtest';
const PROD_DB = 'psat-prep-db';
const COSMOS_ACCOUNT = 'psat-cosmos-15958';
const COSMOS_ENDPOINT = `https://${COSMOS_ACCOUNT}.documents.azure.com:443/`;
const STUDENT_CONTAINER = 'UATStudentAnswers';
const COSMOS_MODULE = path.join(__dirname, '..', 'api', 'node_modules', '@azure', 'cosmos');

/** Students this tooling refuses to touch without a separate, explicit owner approval. */
const PROTECTED_STUDENTS = ['default_student'];

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Hard guard on the write target. Throws unless the database is the scratch DB, or the
 * caller has explicitly opted in to production AND the student is not a protected one.
 *
 * Exported so it can be exercised offline (`--assert-test`) without touching Azure.
 */
function assertWriteTarget(dbName, studentName, opts) {
  const o = opts || {};
  if (dbName !== SCRATCH_DB) {
    if (!o.allowProdDb) {
      throw new Error(
        `REFUSING TO PROCEED: target database "${dbName}" is not the scratch database ` +
        `"${SCRATCH_DB}". Pass --allow-prod-db only for a migration run that has been ` +
        'explicitly approved.'
      );
    }
    if (dbName !== PROD_DB) {
      throw new Error(`REFUSING TO PROCEED: unknown database "${dbName}".`);
    }
  }
  if (PROTECTED_STUDENTS.indexOf(studentName) !== -1 && dbName === PROD_DB && !o.ownerApprovedDefaultStudent) {
    throw new Error(
      `REFUSING TO PROCEED: "${studentName}" is a protected production document ` +
      '(REFACTOR_PLAN.md §3). Its migration is a separate, explicitly owner-approved run; ' +
      'pass --i-have-owner-approval-for-default-student only when that approval exists.'
    );
  }
  if (/^exam_/.test(studentName)) {
    throw new Error('REFUSING TO PROCEED: exam_* documents are immutable and are never written.');
  }
  return dbName;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. ` +
      'Credentials must come from the environment, never from argv.');
  }
  return value;
}

function argValue(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return (i === -1 || i === process.argv.length - 1) ? dflt : process.argv[i + 1];
}
function hasFlag(name) { return process.argv.indexOf('--' + name) !== -1; }

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

/**
 * Builds the shard documents for a master profile and PROVES the round trip.
 * Pure — no Cosmos, no writes. Returns the proof so a dry run can print exactly what an
 * apply run would do.
 *
 * @param {Object} master the master profile document as stored
 * @returns {{ok:boolean, progressShards:Object[], srsShards:Object[], report:Object}}
 */
function planAndProve(master) {
  const studentName = master.student_name;
  const originalProgress = master.progress || {};
  const originalSrs = master.srsState || {};

  const p = dm.buildProgressShards(studentName, originalProgress);
  const s = dm.buildSrsShards(studentName, originalSrs);

  const backProgress = dm.reassembleProgress(p.docs);
  const backSrs = dm.reassembleSrs(s.docs);

  const progressEqual = dm.canonicalMapJson(backProgress) === dm.canonicalMapJson(originalProgress);
  const srsEqual = dm.canonicalMapJson(backSrs) === dm.canonicalMapJson(originalSrs);

  const beforeP = dm.bytesOf(originalProgress);
  const beforeS = dm.bytesOf(originalSrs);
  const afterP = p.docs.reduce((a, d) => a + dm.bytesOf(d), 0);
  const afterS = s.docs.reduce((a, d) => a + dm.bytesOf(d), 0);

  return {
    ok: progressEqual && srsEqual,
    progressShards: p.docs,
    srsShards: s.docs,
    report: {
      student: studentName,
      progressEntries: Object.keys(originalProgress).length,
      srsCards: Object.keys(originalSrs).length,
      progressEqual: progressEqual,
      srsEqual: srsEqual,
      codecFallbacks: p.fallbacks + s.fallbacks,
      progressBuckets: p.buckets.sort((a, b) => a - b),
      srsBuckets: s.buckets.sort((a, b) => a - b),
      masterBytes: dm.bytesOf(master),
      progressBytesBefore: beforeP,
      progressBytesAfter: afterP,
      srsBytesBefore: beforeS,
      srsBytesAfter: afterS,
      largestShardBytes: [].concat(p.docs, s.docs).reduce((a, d) => Math.max(a, dm.bytesOf(d)), 0)
    }
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  if (hasFlag('assert-test')) {
    // Offline guard check: every refusal path must actually refuse.
    const cases = [
      ['prod db without opt-in', () => assertWriteTarget(PROD_DB, 'e2e_test_student', {})],
      ['unknown db', () => assertWriteTarget('some-other-db', 'x', { allowProdDb: true })],
      ['default_student in prod without approval', () => assertWriteTarget(PROD_DB, 'default_student', { allowProdDb: true })],
      ['exam doc as student', () => assertWriteTarget(SCRATCH_DB, 'exam_default_student_x', {})]
    ];
    let bad = 0;
    cases.forEach(([label, fn]) => {
      try { fn(); console.log(`  ✗ ${label}: NOT refused`); bad++; }
      catch (e) { console.log(`  ✓ ${label}: refused — ${e.message.slice(0, 70)}...`); }
    });
    try { assertWriteTarget(SCRATCH_DB, 'e2e_test_student', {}); console.log('  ✓ scratch db + normal student: allowed'); }
    catch (e) { console.log(`  ✗ scratch db + normal student: wrongly refused — ${e.message}`); bad++; }
    process.exit(bad ? 1 : 0);
  }

  const student = argValue('student', null);
  if (!student) {
    console.error('Missing --student <name>. Run with --assert-test for the offline guard check.');
    process.exit(2);
  }
  const dbNameArg = argValue('db', SCRATCH_DB);
  const apply = hasFlag('apply');
  const rollback = hasFlag('rollback');
  const opts = {
    allowProdDb: hasFlag('allow-prod-db'),
    ownerApprovedDefaultStudent: hasFlag('i-have-owner-approval-for-default-student')
  };

  assertWriteTarget(dbNameArg, student, opts);

  const { CosmosClient } = require(COSMOS_MODULE);
  const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: requireEnv('COSMOS_KEY') });
  const c = client.database(dbNameArg).container(STUDENT_CONTAINER);

  console.log('WI-11.5 shard migration');
  console.log('=======================');
  console.log(`  database : ${dbNameArg}`);
  console.log(`  student  : ${student}`);
  console.log(`  mode     : ${rollback ? 'ROLLBACK' : 'MIGRATE'} ${apply ? '(APPLY — will write)' : '(dry run — writes nothing)'}`);
  console.log('');

  const masterId = `student_${student}`;
  let master;
  try {
    const { resource } = await c.item(masterId, student).read();
    master = resource;
  } catch (err) {
    console.error(`Cannot read ${masterId}: ${err.message}`);
    process.exit(1);
  }
  if (!master) {
    console.error(`${masterId} does not exist in ${dbNameArg}.`);
    process.exit(1);
  }

  if (rollback) {
    console.log(`  shardsVerifiedAt currently: ${master.shardsVerifiedAt || '(unset)'}`);
    if (!master.shardsVerifiedAt) {
      console.log('  Nothing to roll back — this document is already in dual-write mode.');
      process.exit(0);
    }
    if (!apply) {
      console.log('  DRY RUN: would remove `shardsVerifiedAt` from the master document.');
      console.log('  No shard document would be deleted; the legacy master fields are already intact.');
      process.exit(0);
    }
    const rolled = Object.assign({}, master);
    delete rolled.shardsVerifiedAt;
    await c.items.upsert(rolled);
    console.log('  ✓ marker removed. The document is back in dual-write mode; the shards remain in place');
    console.log('    and are still merged on read, so no state changed.');
    process.exit(0);
  }

  // --- steps 2 + 3: build and prove, in memory, before touching anything ----
  const plan = planAndProve(master);
  const r = plan.report;
  console.log('  Pre-migration document');
  console.log(`    master bytes ................ ${r.masterBytes}`);
  console.log(`    progress entries ............ ${r.progressEntries}  (${r.progressBytesBefore} bytes)`);
  console.log(`    srs cards ................... ${r.srsCards}  (${r.srsBytesBefore} bytes)`);
  console.log('  Planned shards');
  console.log(`    progress shards ............. ${plan.progressShards.length} (buckets ${r.progressBuckets.join(',')}) -> ${r.progressBytesAfter} bytes`);
  console.log(`    srs shards .................. ${plan.srsShards.length} (buckets ${r.srsBuckets.join(',')}) -> ${r.srsBytesAfter} bytes`);
  console.log(`    largest shard ............... ${r.largestShardBytes} bytes`);
  console.log(`    codec verbatim fallbacks .... ${r.codecFallbacks}`);
  console.log('  In-memory round-trip proof');
  console.log(`    progress byte-equal ......... ${r.progressEqual}`);
  console.log(`    srsState byte-equal ......... ${r.srsEqual}`);

  if (!plan.ok) {
    console.error('\n✗ ABORT: the reassembled state is NOT byte-identical to the stored state. ' +
      'Nothing has been written.');
    process.exit(1);
  }

  if (!apply) {
    console.log('\n  DRY RUN — nothing written. Re-run with --apply to write the shards and stamp the marker.');
    process.exit(0);
  }

  // --- step 4: write the shards (additive; the master is untouched) ---------
  const shards = [].concat(plan.progressShards, plan.srsShards);
  for (const d of shards) {
    await c.items.upsert(Object.assign({}, d, { migratedAt: Date.now() }));
  }
  console.log(`\n  ✓ ${shards.length} shard document(s) written. The master document is still unchanged.`);

  // --- step 5: prove the round trip again, THROUGH the database ------------
  const { resources } = await c.items.query({
    query: 'SELECT * FROM c WHERE c.student_name = @s',
    parameters: [{ name: '@s', value: student }]
  }).fetchAll();
  const backProgress = dm.reassembleProgress(resources);
  const backSrs = dm.reassembleSrs(resources);
  const dbProgressEqual = dm.canonicalMapJson(backProgress) === dm.canonicalMapJson(master.progress || {});
  const dbSrsEqual = dm.canonicalMapJson(backSrs) === dm.canonicalMapJson(master.srsState || {});
  console.log('  Round-trip proof THROUGH Cosmos (re-read, not the in-memory copy)');
  console.log(`    progress byte-equal ......... ${dbProgressEqual}`);
  console.log(`    srsState byte-equal ......... ${dbSrsEqual}`);
  if (!dbProgressEqual || !dbSrsEqual) {
    console.error('\n✗ ABORT: the shards read back out of Cosmos do NOT reassemble to the stored state. ' +
      'The marker has NOT been set, so the master document remains authoritative and nothing is lost. ' +
      'Investigate before retrying.');
    process.exit(1);
  }

  // --- step 6: stamp the marker --------------------------------------------
  const stamped = Object.assign({}, master, { shardsVerifiedAt: Date.now() });
  await c.items.upsert(stamped);
  console.log(`\n  ✓ shardsVerifiedAt = ${stamped.shardsVerifiedAt} stamped on ${masterId}.`);
  console.log('    The master\'s legacy `progress` / `srsState` are now FROZEN — carried forward verbatim');
  console.log('    on every write, never extended, never deleted. Rollback: --rollback --apply.');
}

module.exports = { assertWriteTarget, planAndProve, SCRATCH_DB, PROD_DB, PROTECTED_STUDENTS };

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  });
}
