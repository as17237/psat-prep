#!/usr/bin/env node
/**
 * scripts/verify_shard_migration_scratch.js — WI-11.5 live end-to-end migration proof.
 * ============================================================================
 * Runs the WHOLE sharded read/write path against a real Cosmos database holding a real
 * copy of the production student document, and proves the four things the owner's
 * decision requires. It is the live counterpart to the offline pins in
 * tests/integrity/test_datamodel.js and tests/integrity/test_shard_routing.js: those
 * prove the pure logic, this proves the logic plus Cosmos.
 *
 *   1. GET equivalence — the composite reassembled from the migrated documents is
 *      byte-identical to the composite the pre-migration document produced.
 *   2. v1 write compatibility — a v1-shaped full-state POST, run through the real
 *      planWrite + upsert path, lands correctly and is visible on the next read.
 *   3. The legacy master fields are frozen — byte-identical before and after that write,
 *      neither extended nor deleted.
 *   4. Every document stays under the 400 KB budget.
 *
 * ---------------------------------------------------------------------------
 * DATA SAFETY
 * ---------------------------------------------------------------------------
 * The write target is guarded by `assertScratchTarget` imported from
 * scripts/restore_baseline_to_scratch.js — the SAME guard WI-03 uses, which hard-fails
 * if the database is anything but `psat-prep-db-drtest`, and by name if it is the
 * production database. It is called before the client is constructed and again before
 * every write. Production is never written by any code path here.
 *
 * The student it writes as is `shardproof_student`, never `default_student`: the real
 * document restored into scratch is READ for the comparison and never modified by this
 * script.
 *
 * Credentials from the environment only (COSMOS_KEY).
 *
 * Usage (after scripts/restore_baseline_to_scratch.js and scripts/migrate_to_shards.js):
 *   COSMOS_KEY=... node scripts/verify_shard_migration_scratch.js
 */

'use strict';

const path = require('path');

const dm = require(path.join(__dirname, '..', 'api', 'src', 'lib', 'datamodel.js'));
const shardsync = require(path.join(__dirname, '..', 'api', 'src', 'lib', 'shardsync.js'));
const merge = require(path.join(__dirname, '..', 'api', 'src', 'lib', 'merge.js'));
const { assertScratchTarget, SCRATCH_DB } = require(path.join(__dirname, 'restore_baseline_to_scratch.js'));

const COSMOS_ENDPOINT = 'https://psat-cosmos-15958.documents.azure.com:443/';
const CONTAINER = 'UATStudentAnswers';
const SOURCE_STUDENT = 'default_student';   // READ ONLY
const PROOF_STUDENT = 'shardproof_student'; // the only thing written
const DOC_BUDGET_BYTES = 400 * 1024;

let failures = 0;
function check(label, passed, detail) {
  console.log(`  ${passed ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!passed) failures++;
}

async function readPartition(c, student) {
  const { resources } = await c.items.query({
    query: 'SELECT * FROM c WHERE c.student_name = @s',
    parameters: [{ name: '@s', value: student }]
  }).fetchAll();
  return resources || [];
}

const SYSTEM_FIELDS = ['_rid', '_self', '_etag', '_attachments', '_ts'];
function strip(d) {
  const o = {};
  Object.keys(d).forEach(k => { if (SYSTEM_FIELDS.indexOf(k) === -1) o[k] = d[k]; });
  return o;
}

async function main() {
  const key = process.env.COSMOS_KEY;
  if (!key) throw new Error('Missing COSMOS_KEY. Credentials come from the environment, never argv.');

  assertScratchTarget(SCRATCH_DB, 'startup');
  const { CosmosClient } = require(path.join(__dirname, '..', 'api', 'node_modules', '@azure', 'cosmos'));
  const c = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key }).database(SCRATCH_DB).container(CONTAINER);

  console.log('WI-11.5 live migration proof');
  console.log('============================');
  console.log(`  database      : ${SCRATCH_DB}  (production is never written)`);
  console.log(`  read student  : ${SOURCE_STUDENT}  (READ ONLY — the restored real document)`);
  console.log(`  write student : ${PROOF_STUDENT}`);
  console.log('');

  // -----------------------------------------------------------------------
  // 1. The migrated real document reassembles to the pre-migration state.
  // -----------------------------------------------------------------------
  console.log('1. GET equivalence on the migrated real document');
  const srcDocs = (await readPartition(c, SOURCE_STUDENT)).map(strip);
  const srcMaster = srcDocs.find(d => d.id === `student_${SOURCE_STUDENT}`);
  const srcExams = srcDocs.filter(d => d.doc_type === 'exam_session');
  const srcPShards = srcDocs.filter(d => d.doc_type === dm.PROGRESS_SHARD_TYPE);
  const srcSShards = srcDocs.filter(d => d.doc_type === dm.SRS_SHARD_TYPE);

  console.log(`   documents in partition : ${srcDocs.length} ` +
    `(1 master + ${srcExams.length} exam_session + ${srcPShards.length} progress_shard + ${srcSShards.length} srs_shard)`);
  console.log(`   shardsVerifiedAt       : ${srcMaster.shardsVerifiedAt || '(unset)'}`);

  // What today's server would return from this document's LEGACY fields alone.
  const preMigrationComposite = {
    progress: srcMaster.progress || {},
    srsState: srcMaster.srsState || {},
    sessionsState: srcMaster.sessionsState || {},
    examHistory: merge.mergeExamHistory(srcMaster.examHistory, srcExams)
  };
  // What the NEW server returns from the migrated document set.
  const composite = shardsync.reassembleComposite(srcDocs, SOURCE_STUDENT, Date.now());

  check('progress reassembles byte-equal to the pre-migration document',
    dm.canonicalMapJson(composite.progress) === dm.canonicalMapJson(preMigrationComposite.progress),
    `${Object.keys(composite.progress).length} entries`);
  check('srsState reassembles byte-equal to the pre-migration document',
    dm.canonicalMapJson(composite.srsState) === dm.canonicalMapJson(preMigrationComposite.srsState),
    `${Object.keys(composite.srsState).length} cards`);
  check('sessionsState unchanged',
    JSON.stringify(composite.sessionsState) === JSON.stringify(preMigrationComposite.sessionsState),
    `${Object.keys(composite.sessionsState).length} days`);
  check('examHistory unchanged',
    JSON.stringify(composite.examHistory) === JSON.stringify(preMigrationComposite.examHistory),
    `${composite.examHistory.length} exams`);

  // Reassembly must come from the SHARDS, not from the still-present legacy fields.
  const shardsOnly = shardsync.reassembleComposite(
    srcDocs.filter(d => d.doc_type !== 'student_master_profile'), SOURCE_STUDENT, Date.now());
  check('the shards alone (master field ignored) already reproduce the full state',
    dm.canonicalMapJson(shardsOnly.progress) === dm.canonicalMapJson(preMigrationComposite.progress) &&
    dm.canonicalMapJson(shardsOnly.srsState) === dm.canonicalMapJson(preMigrationComposite.srsState),
    'so the migration is real, not a read-through to the legacy copy');

  // -----------------------------------------------------------------------
  // 2. A v1 write against a migrated document.
  // -----------------------------------------------------------------------
  console.log('\n2. A v1-shaped POST against a migrated document (written as ' + PROOF_STUDENT + ')');
  assertScratchTarget(SCRATCH_DB, 'proof-student seed');

  // Seed: the same real state, migrated, under the proof student's name.
  const seedPlan = shardsync.planWrite({
    studentName: PROOF_STUDENT,
    body: {
      student_name: PROOF_STUDENT,
      progress: preMigrationComposite.progress,
      srsState: preMigrationComposite.srsState,
      sessionsState: preMigrationComposite.sessionsState,
      examHistory: []
    },
    existingMaster: null, existingProgressShards: [], existingSrsShards: [], now: Date.now()
  });
  for (const d of seedPlan.shardDocs) await c.items.upsert(d);
  await c.items.upsert(Object.assign({}, seedPlan.masterDoc, { shardsVerifiedAt: Date.now() }));
  console.log(`   seeded ${seedPlan.shardDocs.length} shards + master, then marked verified`);

  const beforeDocs = (await readPartition(c, PROOF_STUDENT)).map(strip);
  const beforeMaster = beforeDocs.find(d => d.id === `student_${PROOF_STUDENT}`);
  const frozenProgressBefore = JSON.stringify(beforeMaster.progress);
  const frozenSrsBefore = JSON.stringify(beforeMaster.srsState);

  // A brand-new question the student has never answered, plus a newer attempt on an
  // existing one — exactly what a v1 client's full-state push looks like after a session.
  const existingQid = Object.keys(preMigrationComposite.progress)[0];
  const newQid = 'zz9plural';
  const v1Push = {
    student_name: PROOF_STUDENT,
    progress: Object.assign({}, preMigrationComposite.progress, {
      [newQid]: {
        answered: true, selectedAnswer: 'D', isCorrect: true, timeSpentMs: 31000,
        timingReliable: true, isFlagged: false, timestamp: 1788100000000,
        timesSeen: 1, timesCorrect: 1, timesIncorrect: 0, accuracyPercent: 100
      },
      [existingQid]: Object.assign({}, preMigrationComposite.progress[existingQid], {
        timestamp: 1788100000001, timesSeen: 2, timesCorrect: 2, timesIncorrect: 0, accuracyPercent: 100
      })
    }),
    srsState: preMigrationComposite.srsState,
    sessionsState: preMigrationComposite.sessionsState,
    examHistory: [],
    clientTimestamp: '2026-08-30T10:00:00.000Z'
  };

  const before2 = shardsync.classifyDocs(beforeDocs, PROOF_STUDENT);
  const plan = shardsync.planWrite({
    studentName: PROOF_STUDENT, body: v1Push,
    existingMaster: before2.master,
    existingProgressShards: before2.progressShards,
    existingSrsShards: before2.srsShards,
    durableExamIds: [], now: Date.now()
  });
  assertScratchTarget(SCRATCH_DB, 'proof-student write');
  for (const d of plan.shardDocs) await c.items.upsert(d);
  await c.items.upsert(plan.masterDoc);

  console.log(`   mode=${plan.mode}  shards rewritten=${plan.shardDocs.length}  unchanged=${plan.unchangedShards}  ` +
    `codec fallbacks=${plan.fallbacks}`);
  check('a v1 push touching 2 questions rewrote at most 2 shards',
    plan.shardDocs.length <= 2, `${plan.shardDocs.length} rewritten of 32`);

  const afterDocs = (await readPartition(c, PROOF_STUDENT)).map(strip);
  const after = shardsync.reassembleComposite(afterDocs, PROOF_STUDENT, Date.now());
  check('the brand-new question is readable after the write',
    !!after.progress[newQid] && after.progress[newQid].selectedAnswer === 'D',
    `${newQid} -> ${JSON.stringify(after.progress[newQid] && after.progress[newQid].selectedAnswer)}`);
  check('the updated existing question shows the newer attempt',
    after.progress[existingQid] && after.progress[existingQid].timesSeen === 2,
    `${existingQid}.timesSeen = ${after.progress[existingQid] && after.progress[existingQid].timesSeen}`);
  check('every pre-existing question is still readable',
    Object.keys(preMigrationComposite.progress).every(q => !!after.progress[q]),
    `${Object.keys(after.progress).length} entries (was ${Object.keys(preMigrationComposite.progress).length} + 1 new)`);

  // -----------------------------------------------------------------------
  // 3. The frozen legacy fields.
  // -----------------------------------------------------------------------
  console.log('\n3. The legacy master fields after a shard-authoritative write');
  const afterMaster = afterDocs.find(d => d.id === `student_${PROOF_STUDENT}`);
  check('master.progress is byte-identical to before the write (frozen, not extended)',
    JSON.stringify(afterMaster.progress) === frozenProgressBefore,
    `${Object.keys(afterMaster.progress).length} entries, unchanged`);
  check('master.srsState is byte-identical to before the write',
    JSON.stringify(afterMaster.srsState) === frozenSrsBefore);
  check('the new question is NOT in the frozen master map',
    afterMaster.progress[newQid] === undefined,
    'it lives only in its shard');
  check('nothing was deleted from the frozen map',
    Object.keys(preMigrationComposite.progress).every(q => afterMaster.progress[q] !== undefined));

  // -----------------------------------------------------------------------
  // 4. Document sizes.
  // -----------------------------------------------------------------------
  console.log('\n4. Document sizes in the scratch database');
  const all = (await c.items.query('SELECT * FROM c').fetchAll()).resources
    .map(d => ({ id: d.id, type: d.doc_type, bytes: Buffer.byteLength(JSON.stringify(d), 'utf8') }))
    .sort((a, b) => b.bytes - a.bytes);
  all.slice(0, 6).forEach(d => console.log(`   ${String(d.bytes).padStart(8)} B  ${d.id}  [${d.type}]`));
  const over = all.filter(d => d.bytes >= DOC_BUDGET_BYTES);
  check('every document in the scratch database is under the 400 KB budget',
    over.length === 0,
    `${all.length} documents, largest ${all[0].bytes} B` + (over.length ? ` — OVER: ${over.map(d => d.id).join(', ')}` : ''));

  const proofShards = afterDocs.filter(d => d.doc_type === dm.PROGRESS_SHARD_TYPE || d.doc_type === dm.SRS_SHARD_TYPE);
  const shardBytes = proofShards.reduce((a, d) => a + Buffer.byteLength(JSON.stringify(d), 'utf8'), 0);
  console.log(`   ${PROOF_STUDENT}: master ${Buffer.byteLength(JSON.stringify(afterMaster), 'utf8')} B ` +
    `(of which ${Buffer.byteLength(frozenProgressBefore) + Buffer.byteLength(frozenSrsBefore)} B is the frozen legacy copy) ` +
    `+ ${proofShards.length} shards totalling ${shardBytes} B`);

  console.log('');
  console.log('======================================================================');
  console.log(failures === 0 ? 'SHARD_MIGRATION_PROOF_OK' : `SHARD_MIGRATION_PROOF_FAILED (${failures} check(s))`);
  console.log('======================================================================');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(`\n✗ ${err.message}`); process.exit(1); });
