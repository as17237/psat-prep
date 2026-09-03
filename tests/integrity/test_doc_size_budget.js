/**
 * tests/integrity/test_doc_size_budget.js — WI-18.
 *
 * Offline guard for the reframed DOC-SIZE budget in run_integrity.js. After a student
 * is migrated to the sharded model, the master's `progress` / `srsState` are FROZEN
 * (carried forward verbatim, never extended). The budget exists to catch *growth*, so
 * it must:
 *   - EXCLUDE those frozen maps for a shard-authoritative master (huge-but-frozen is OK),
 *   - still CATCH growth that CAN happen (examHistory on a frozen master, an un-migrated
 *     master, or a shard), so a real regression can never hide behind the exemption.
 *
 * Pure/offline; expected values hand-reasoned, not derived from the code under test.
 */
const assert = require('assert');
const { isFrozenMaster, budgetableBytes, MASTER_DOC_BUDGET_BYTES } = require('./run_integrity.js');

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

const BUDGET = MASTER_DOC_BUDGET_BYTES; // 409600
// A map whose JSON is ~`n` bytes, built from padded entries.
function bigMap(nBytes) {
  const map = {};
  let i = 0;
  while (Buffer.byteLength(JSON.stringify(map), 'utf8') < nBytes) {
    map['q' + String(i).padStart(6, '0')] = 'x'.repeat(80);
    i++;
  }
  return map;
}

const bigProgress = bigMap(300 * 1024); // 300 KB of frozen progress
const bigSrs = bigMap(200 * 1024); // 200 KB of frozen srs
const smallExam = [{ examId: 'e1', totalCorrect: 5 }];
const bigExam = Array.from({ length: 1 }, () => ({ blob: 'y'.repeat(450 * 1024) })); // 450 KB examHistory

// --- 1. isFrozenMaster only true for a master with a positive shardsVerifiedAt ---
ok(isFrozenMaster({ doc_type: 'student_master_profile', shardsVerifiedAt: 1 }) === true, 'frozen master detected');
ok(isFrozenMaster({ doc_type: 'student_master_profile' }) === false, 'un-migrated master is not frozen');
ok(isFrozenMaster({ doc_type: 'student_master_profile', shardsVerifiedAt: 0 }) === false, 'shardsVerifiedAt=0 is not frozen');
ok(isFrozenMaster({ doc_type: 'progress_shard', shardsVerifiedAt: 1 }) === false, 'a shard is never a "frozen master"');

// --- 2. A frozen master ~500 KB but small growable content is UNDER budget -------
const frozenOk = { id: 'student_x', doc_type: 'student_master_profile', shardsVerifiedAt: 123, progress: bigProgress, srsState: bigSrs, sessionsState: {}, examHistory: smallExam };
ok(budgetableBytes(frozenOk) < BUDGET, 'frozen master with tiny growable content is within budget');
ok(Buffer.byteLength(JSON.stringify(frozenOk), 'utf8') > BUDGET, 'sanity: that same doc is >400KB on disk (so the old check would have failed it)');

// --- 3. Growth is STILL caught, three ways -------------------------------------
// (a) frozen master whose GROWABLE examHistory blew past budget
const frozenGrew = { id: 'student_y', doc_type: 'student_master_profile', shardsVerifiedAt: 123, progress: bigProgress, srsState: bigSrs, sessionsState: {}, examHistory: bigExam };
ok(budgetableBytes(frozenGrew) >= BUDGET, 'frozen master with a huge examHistory is STILL over budget');
// (b) an UN-migrated master of the same size is budgeted whole -> over
const unmigrated = { id: 'student_z', doc_type: 'student_master_profile', progress: bigProgress, srsState: bigSrs, sessionsState: {}, examHistory: smallExam };
ok(budgetableBytes(unmigrated) >= BUDGET, 'un-migrated master is budgeted whole and flagged over budget');
// (c) a shard is budgeted whole
const bigShard = { id: 'p_shard_0', doc_type: 'progress_shard', bucket: 0, progress: bigMap(420 * 1024) };
ok(budgetableBytes(bigShard) >= BUDGET, 'an over-size shard is caught');

console.log(`✓ doc-size budget reframe: ${checks} checks (frozen legacy maps exempt; all growth still caught)`);
