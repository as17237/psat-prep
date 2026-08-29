#!/usr/bin/env node
/**
 * scripts/corrupt_one_doc.js — WI-05 red-demonstration helper for weekly_restore_check.sh
 * ============================================================================
 * The DR runbook (§5.7) and REFACTOR_PLAN.md WI-03/WI-05 both require that every restore
 * verification include a "red demonstration": a reconciler that has never been observed
 * to fail is not evidence (CLAUDE.md failure mode 4). Doing that by hand each week
 * ("manually flip a field in the Data Explorer") is exactly the kind of step that quietly
 * stops happening, so this script makes it a single, reviewable, committed command that
 * `scripts/weekly_restore_check.sh` runs automatically.
 *
 * What it does:
 *   1. Connects to the SCRATCH Cosmos database ONLY — reuses `assertScratchTarget()`
 *      from restore_baseline_to_scratch.js, the exact same guard `reconcile_restore.js`
 *      trusts, so this script cannot drift from that guard (CLAUDE.md failure mode 2).
 *      The guard is called before the Cosmos client is constructed and again
 *      immediately before the write.
 *   2. Picks one random document from the `Questions` container in the scratch DB.
 *   3. Overwrites its `difficulty` field with a `CORRUPTED-BY-WEEKLY-CHECK-<timestamp>`
 *      marker value and replaces the document (read-modify-replace, not a partial patch,
 *      so the rest of the document round-trips byte-for-byte).
 *   4. Prints exactly which document and field it changed, and the old/new values, so a
 *      human (or `weekly_restore_check.sh`) can confirm the subsequent reconcile failure
 *      is localised to precisely that one document.
 *
 * This script NEVER touches production. It has no `--db`/`--container` override flag —
 * unlike restore_baseline_to_scratch.js and reconcile_restore.js it does not need one,
 * because corrupting anything other than the scratch DB is never a legitimate use of
 * this tool. `--assert-test` runs the shared offline guard self-test (no network) to
 * prove that same guard still rejects the production database name.
 *
 * Credentials from the environment only, never argv: COSMOS_KEY.
 *
 * Usage:
 *   COSMOS_KEY=... node scripts/corrupt_one_doc.js
 *   node scripts/corrupt_one_doc.js --assert-test   # offline safety check
 */

'use strict';

const common = require('./restore_baseline_to_scratch.js');

const {
  SCRATCH_DB,
  PROD_DB,
  COSMOS_ACCOUNT,
  assertScratchTarget,
  assertSelfTest,
  getCosmosClient
} = common;

const TARGET_CONTAINER = 'Questions';
const TARGET_FIELD = 'difficulty';

async function corruptOneDoc() {
  // Guard #1 — before any client is constructed. Hardcoded target, no argv override.
  assertScratchTarget(SCRATCH_DB, 'corrupt_one_doc startup');

  console.log('======================================================================');
  console.log('WI-05 corrupt_one_doc — red-demonstration helper (SCRATCH DB ONLY)');
  console.log(`  Cosmos account : ${COSMOS_ACCOUNT}`);
  console.log(`  Target database: ${SCRATCH_DB}   (production "${PROD_DB}" is never touched)`);
  console.log(`  Container      : ${TARGET_CONTAINER}`);
  console.log(`  Started        : ${new Date().toISOString()}`);
  console.log('======================================================================');

  const cosmos = getCosmosClient();
  const database = cosmos.database(SCRATCH_DB);
  const container = database.container(TARGET_CONTAINER);

  const { resources: countRes } = await container.items
    .query('SELECT VALUE COUNT(1) FROM c')
    .fetchAll();
  const total = countRes[0];
  if (!total || total < 1) {
    throw new Error(
      `${TARGET_CONTAINER} in ${SCRATCH_DB} has ${total || 0} documents — nothing to corrupt. ` +
      'Run scripts/restore_baseline_to_scratch.js first.'
    );
  }

  const offset = Math.floor(Math.random() * total);
  const { resources: picked } = await container.items
    .query(`SELECT * FROM c OFFSET ${offset} LIMIT 1`)
    .fetchAll();
  if (picked.length !== 1) {
    throw new Error(`Expected exactly 1 document at offset ${offset}, got ${picked.length}.`);
  }
  const doc = picked[0];
  const partitionKeyValue = doc.domain;
  if (!doc.id || partitionKeyValue === undefined) {
    throw new Error(`Picked document is missing id or partition key (domain): ${JSON.stringify(doc.id)}`);
  }

  const oldValue = doc[TARGET_FIELD];
  const newValue = `CORRUPTED-BY-WEEKLY-CHECK-${new Date().toISOString()}`;
  doc[TARGET_FIELD] = newValue;

  // Guard #2 — immediately before the write.
  assertScratchTarget(SCRATCH_DB, 'corrupt_one_doc write');
  await container.item(doc.id, partitionKeyValue).replace(doc);

  console.log(`\n  ✓ corrupted 1 document in ${SCRATCH_DB}/${TARGET_CONTAINER}`);
  console.log(`      id     : ${doc.id}`);
  console.log(`      field  : ${TARGET_FIELD}`);
  console.log(`      old    : ${JSON.stringify(oldValue)}`);
  console.log(`      new    : ${JSON.stringify(newValue)}`);
  console.log('======================================================================');
  console.log(`CORRUPT_ONE_DOC_OK id=${doc.id} field=${TARGET_FIELD}`);

  return { id: doc.id, container: TARGET_CONTAINER, field: TARGET_FIELD, oldValue, newValue };
}

if (require.main === module) {
  if (process.argv.includes('--assert-test')) {
    // Same guard reconcile_restore.js and restore_baseline_to_scratch.js trust — one
    // implementation, one test (CLAUDE.md failure mode 2).
    process.exit(assertSelfTest() === 0 ? 0 : 1);
  }
  corruptOneDoc().then(
    () => process.exit(0),
    (err) => {
      console.error(`\nFATAL: ${err.message}`);
      process.exit(1);
    }
  );
}

module.exports = { corruptOneDoc, TARGET_CONTAINER, TARGET_FIELD };
