/**
 * tests/integrity/test_shard_routing.js — WI-11.5 server-logic pins.
 *
 * OFFLINE. No Cosmos, no network. `api/src/lib/shardsync.js` is the whole decision
 * surface of GET/POST /api/sync — what the composite is, which shards change, what the
 * master becomes — so pinning it here pins the API's behaviour without deploying it.
 *
 * The two things this file exists to prove, both of them owner acceptance criteria:
 *
 *   1. THE EXISTING APP KEEPS WORKING. A captured REAL v1 payload — the full-state push
 *      the untouched production client sends, reconstructed from the WI-02 immutable
 *      baseline copy of the live document — must produce, through the NEW server logic,
 *      exactly the state today's server produces through the OLD logic. Section 3 runs
 *      today's shipped merge sequence side by side with the new one and compares.
 *
 *   2. DELTAS ROUTE TO THEIR BUCKET. Section 2 pins that a single changed question
 *      rewrites exactly one shard and leaves the other fifteen untouched — which is the
 *      property that keeps a sync cheap, and the property a naive "rebuild everything"
 *      implementation would silently lose.
 *
 * The merge pins in tests/integrity/test_merge_pins.js are unchanged and still apply:
 * shardsync.js imports merge.js rather than reimplementing it, so those pins cover this
 * path too. That is checked explicitly in section 5.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dm = require('../../api/src/lib/datamodel.js');
const shardsync = require('../../api/src/lib/shardsync.js');
const merge = require('../../api/src/lib/merge.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'real_master_profile_2026-08-29.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const REAL_MASTER = fixture.documents.find(d => d.id === 'student_default_student');
const REAL_EXAM_DOCS = fixture.documents.filter(d => d.doc_type === 'exam_session');

let checks = 0;
function ok(msg) { checks++; console.log(`  ✓ ${msg}`); }

/**
 * The captured REAL v1 payload.
 *
 * A v1 client pushes its whole local state: the four maps plus identity fields
 * (js/engine/sync.js pushToCloud). Reconstructing it from the baseline copy of the live
 * document is how WI-11.5's brief requires it to be captured — read-only, from the
 * backup, never by POSTing as the live student.
 */
const V1_PAYLOAD = {
  student_name: 'compat_test_student',
  progress: REAL_MASTER.progress,
  srsState: REAL_MASTER.srsState,
  sessionsState: REAL_MASTER.sessionsState,
  examHistory: REAL_MASTER.examHistory,
  clientTimestamp: '2026-08-29T14:00:00.000Z'
  // Deliberately no `schemaVersion` and no `client_version`: a v1 client sends neither.
};

const NOW = 1788000000000; // fixed; nothing here reads the clock

console.log('WI-11.5 shard-routing and v1-compatibility pins (offline, real production payload)\n');

// =========================================================================
// 1. First-ever push from a v1 client onto an empty partition.
// =========================================================================
console.log('1. A v1 full-state push onto an empty partition');
let firstPlan;
{
  firstPlan = shardsync.planWrite({
    studentName: 'compat_test_student',
    body: V1_PAYLOAD,
    existingMaster: null,
    existingProgressShards: [],
    existingSrsShards: [],
    durableExamIds: [],
    now: NOW
  });

  assert.strictEqual(firstPlan.mode, 'dual_write',
    'an unmigrated document must stay in dual-write mode — sharding is additive');
  ok('mode is dual_write (no shardsVerifiedAt marker ⇒ nothing about the legacy layout changes)');

  assert.strictEqual(firstPlan.mergedProgressCount, 406);
  assert.strictEqual(firstPlan.mergedSrsCount, 392);
  assert.strictEqual(firstPlan.fallbacks, 0);
  ok('406 progress entries and 392 SRS cards planned, 0 codec fallbacks');

  // Dual-write: the master still carries the full maps, byte-for-byte.
  assert.strictEqual(dm.canonicalMapJson(firstPlan.masterDoc.progress), dm.canonicalMapJson(REAL_MASTER.progress),
    'in dual-write mode the master document keeps the full progress map, unchanged');
  assert.strictEqual(dm.canonicalMapJson(firstPlan.masterDoc.srsState), dm.canonicalMapJson(REAL_MASTER.srsState));
  ok('dual-write: the master document still holds the complete progress and srsState maps');

  const pDocs = firstPlan.shardDocs.filter(d => d.doc_type === 'progress_shard');
  const sDocs = firstPlan.shardDocs.filter(d => d.doc_type === 'srs_shard');
  assert.strictEqual(pDocs.length, 16, 'all 16 progress buckets are non-empty at 406 entries');
  assert.strictEqual(sDocs.length, 16);
  ok(`and 32 shard documents are written alongside it (${pDocs.length} progress + ${sDocs.length} srs)`);

  // Every shard is on the same partition key.
  firstPlan.shardDocs.forEach(d => {
    assert.strictEqual(d.student_name, 'compat_test_student',
      'every shard must carry the SAME /student_name partition key as the master');
  });
  ok('every shard carries the same /student_name partition key (a full read stays one in-partition query)');
}

// =========================================================================
// 2. Delta routing: one changed question touches exactly one shard.
// =========================================================================
console.log('\n2. Delta routing');
{
  const existingP = firstPlan.shardDocs.filter(d => d.doc_type === 'progress_shard');
  const existingS = firstPlan.shardDocs.filter(d => d.doc_type === 'srs_shard');

  // Hand-picked target: '52332846'. Its bucket is whatever bucketOf says, and the test
  // asserts the SHARD ID that follows from it, not the bucket number, so this stays a
  // statement about routing rather than a restatement of the hash.
  const qid = '52332846';
  const targetBucket = dm.bucketOf(qid);
  const targetShardId = dm.progressShardId('compat_test_student', targetBucket);

  const delta = {
    student_name: 'compat_test_student',
    progress: {
      [qid]: {
        answered: true, selectedAnswer: 'B', isCorrect: false, timeSpentMs: 41000,
        timingReliable: true, isFlagged: false,
        timestamp: 1787900000000,           // NEWER than the stored 1787771651633
        timesSeen: 2, timesCorrect: 1, timesIncorrect: 1, accuracyPercent: 50
      }
    },
    srsState: {},
    sessionsState: {},
    examHistory: []
  };

  const plan = shardsync.planWrite({
    studentName: 'compat_test_student',
    body: delta,
    existingMaster: Object.assign({}, firstPlan.masterDoc),
    existingProgressShards: existingP,
    existingSrsShards: existingS,
    durableExamIds: [],
    now: NOW + 1000
  });

  assert.strictEqual(plan.shardDocs.length, 1,
    'a one-question delta must rewrite exactly one shard document');
  assert.strictEqual(plan.shardDocs[0].id, targetShardId,
    `the rewritten shard must be ${targetShardId}`);
  assert.strictEqual(plan.unchangedShards, 31,
    'the other 31 shard documents must be recognised as unchanged and not written');
  ok(`one changed question rewrites exactly 1 shard (${targetShardId}) and leaves 31 untouched`);

  // The delta actually landed, and nothing else in that shard moved.
  const rebuilt = dm.reassembleProgress([plan.shardDocs[0]]);
  assert.strictEqual(rebuilt[qid].selectedAnswer, 'B');
  assert.strictEqual(rebuilt[qid].timesSeen, 2);
  assert.strictEqual(rebuilt[qid].accuracyPercent, 50);
  ok('the new attempt is present in the rewritten shard with timesSeen 2 / accuracy 50');

  const priorShard = existingP.find(d => d.id === targetShardId);
  Object.keys(priorShard.entries).forEach(k => {
    if (k === qid) return;
    assert.strictEqual(JSON.stringify(plan.shardDocs[0].entries[k]), JSON.stringify(priorShard.entries[k]),
      `entry ${k} in the same shard must be untouched`);
  });
  ok(`the other ${Object.keys(priorShard.entries).length - 1} entries in that shard are byte-identical`);

  // A STALE delta must not displace the newer stored attempt (merge.js's rule, via shards).
  const stale = {
    student_name: 'compat_test_student',
    progress: { [qid]: { answered: true, selectedAnswer: 'D', isCorrect: false, timestamp: 1, timesSeen: 1, timesCorrect: 0 } }
  };
  const stalePlan = shardsync.planWrite({
    studentName: 'compat_test_student',
    body: stale,
    existingMaster: Object.assign({}, firstPlan.masterDoc),
    existingProgressShards: existingP,
    existingSrsShards: existingS,
    now: NOW + 2000
  });
  assert.strictEqual(stalePlan.shardDocs.length, 0,
    'a stale delta must change nothing at all — not even one shard write');
  ok('a stale delta (timestamp 1) is rejected by the newer-wins rule and writes zero shards');
}

// =========================================================================
// 3. THE COMPATIBILITY PROOF: new server logic == today's server logic.
// =========================================================================
console.log('\n3. v1-payload compatibility: new logic reproduces today\'s stored state exactly');
{
  /**
   * Today's shipped POST handler, transcribed. This is the code that runs in production
   * right now (api/src/functions/sync.js before WI-11.5): four merges onto the existing
   * master, straight into one document. Written out here BY HAND rather than imported,
   * so the comparison is against the old behaviour and not against the new code's idea
   * of the old behaviour (CLAUDE.md mode 4).
   */
  function todaysServerPost(existingMaster, body, now, student) {
    return {
      id: `student_${student}`,
      student_name: student,
      doc_type: 'student_master_profile',
      progress: merge.mergeProgress(existingMaster && existingMaster.progress, body.progress),
      srsState: merge.mergeSrsState(existingMaster && existingMaster.srsState, body.srsState),
      sessionsState: merge.mergeSessions(existingMaster && existingMaster.sessionsState, body.sessionsState),
      examHistory: merge.mergeExamHistory(existingMaster && existingMaster.examHistory, body.examHistory, merge.EXAM_HISTORY_CAP),
      updatedAt: now,
      clientTimestamp: body.clientTimestamp || new Date(now).toISOString(),
      clientVersion: body.client_version || (existingMaster && existingMaster.clientVersion) || null,
      schemaVersion: Math.max(Number(body.schemaVersion) || 0, Number(existingMaster && existingMaster.schemaVersion) || 1),
      createdAt: (existingMaster && existingMaster.createdAt) || now
    };
  }

  /** Today's shipped GET handler, transcribed the same way. */
  function todaysServerGet(masterDoc, examDocs, student, now) {
    return {
      id: `student_${student}`,
      student_name: student,
      progress: (masterDoc && masterDoc.progress) || {},
      srsState: (masterDoc && masterDoc.srsState) || {},
      sessionsState: (masterDoc && masterDoc.sessionsState) || {},
      examHistory: merge.mergeExamHistory(masterDoc && masterDoc.examHistory, examDocs),
      updatedAt: (masterDoc && masterDoc.updatedAt) || now,
      schemaVersion: Number(masterDoc && masterDoc.schemaVersion) || 1,
      createdAt: (masterDoc && masterDoc.createdAt) || null
    };
  }

  const STUDENT = 'compat_test_student';
  const examDocsForStudent = REAL_EXAM_DOCS.map(d => Object.assign({}, d, { student_name: STUDENT }));

  // --- Case A: an empty partition receives the real v1 payload -------------
  const oldDoc = todaysServerPost(null, V1_PAYLOAD, NOW, STUDENT);
  const oldComposite = todaysServerGet(oldDoc, examDocsForStudent, STUDENT, NOW);

  const newPlan = shardsync.planWrite({
    studentName: STUDENT, body: V1_PAYLOAD, existingMaster: null,
    existingProgressShards: [], existingSrsShards: [], durableExamIds: [], now: NOW
  });
  const newPartition = [newPlan.masterDoc].concat(newPlan.shardDocs, examDocsForStudent);
  const newComposite = shardsync.reassembleComposite(newPartition, STUDENT, NOW);

  assert.strictEqual(dm.canonicalMapJson(newComposite.progress), dm.canonicalMapJson(oldComposite.progress),
    'progress returned by the new GET must equal what today\'s GET returns');
  assert.strictEqual(dm.canonicalMapJson(newComposite.srsState), dm.canonicalMapJson(oldComposite.srsState));
  assert.strictEqual(JSON.stringify(newComposite.sessionsState), JSON.stringify(oldComposite.sessionsState));
  assert.strictEqual(JSON.stringify(newComposite.examHistory), JSON.stringify(oldComposite.examHistory));
  assert.deepStrictEqual(Object.keys(newComposite), Object.keys(oldComposite),
    'the composite must have the SAME keys in the SAME order — the v1 client parses this shape');
  ['id', 'student_name', 'updatedAt', 'schemaVersion', 'createdAt'].forEach(k => {
    assert.strictEqual(JSON.stringify(newComposite[k]), JSON.stringify(oldComposite[k]), `${k} differs`);
  });
  ok(`case A — empty partition + real v1 payload (406 entries, 392 cards, 9 exams): ` +
    'new composite === today\'s composite, key for key');

  // --- Case B: the same payload replayed onto a MIGRATED document ----------
  // The master is frozen at the migrated state, the shards carry the truth, and the
  // untouched v1 client pushes its full state again exactly as it always has.
  const migratedMaster = Object.assign({}, newPlan.masterDoc, {
    shardsVerifiedAt: NOW,
    // The frozen legacy copy, as the migration leaves it.
    progress: REAL_MASTER.progress,
    srsState: REAL_MASTER.srsState
  });
  const replay = shardsync.planWrite({
    studentName: STUDENT, body: V1_PAYLOAD, existingMaster: migratedMaster,
    existingProgressShards: newPlan.shardDocs.filter(d => d.doc_type === 'progress_shard'),
    existingSrsShards: newPlan.shardDocs.filter(d => d.doc_type === 'srs_shard'),
    durableExamIds: examDocsForStudent.map(d => d.examId),
    now: NOW + 5000
  });

  assert.strictEqual(replay.mode, 'shard_authoritative');
  assert.strictEqual(replay.shardDocs.length, 0,
    'replaying the identical payload must rewrite no shard at all');
  ok('case B — the same v1 payload replayed onto a migrated document: mode shard_authoritative, 0 shard writes');

  const replayPartition = [replay.masterDoc]
    .concat(newPlan.shardDocs, examDocsForStudent);
  const replayComposite = shardsync.reassembleComposite(replayPartition, STUDENT, NOW);
  assert.strictEqual(dm.canonicalMapJson(replayComposite.progress), dm.canonicalMapJson(oldComposite.progress),
    'a migrated document must still return exactly the state today\'s server returns');
  assert.strictEqual(dm.canonicalMapJson(replayComposite.srsState), dm.canonicalMapJson(oldComposite.srsState));
  assert.strictEqual(JSON.stringify(replayComposite.examHistory), JSON.stringify(oldComposite.examHistory),
    'the exam-history index must reassemble to the FULL reports via the immutable session docs');
  ok('case B — the migrated composite is identical to today\'s composite, exam reports included');

  // The exam-history index really did strip moduleReports from the master...
  const indexed = replay.masterDoc.examHistory.filter(e => e && e.moduleReportsInSessionDoc);
  assert.ok(indexed.length > 0, 'at least one exam must have been indexed');
  indexed.forEach(e => assert.strictEqual(e.moduleReports, undefined));
  // ...and the composite still hands the client the full reports.
  const full = replayComposite.examHistory.filter(e => Array.isArray(e.moduleReports));
  assert.strictEqual(full.length, examDocsForStudent.filter(d => Array.isArray(d.moduleReports)).length,
    'every exam whose session doc has moduleReports must come back with them');
  console.log(`     master examHistory: ${dm.bytesOf(newPlan.masterDoc.examHistory)} bytes -> ` +
    `${dm.bytesOf(replay.masterDoc.examHistory)} bytes as an index; the composite still returns ` +
    `${full.length} full reports from the immutable session docs`);
  ok('exam-history indexing shrinks the master without removing a single report from the composite');

  // --- Case C: an exam with NO immutable session doc keeps its full report --
  const orphanExam = {
    examId: 'exam_never_persisted', title: 'Drill', type: 'drill',
    completedAt: NOW, totalQuestions: 5, totalCorrect: 3,
    moduleReports: [{ id: 'm1', questions: [{ questionId: 'x', isCorrect: true }] }]
  };
  const orphanPlan = shardsync.planWrite({
    studentName: STUDENT,
    body: { student_name: STUDENT, examHistory: [orphanExam] },
    existingMaster: migratedMaster,
    existingProgressShards: newPlan.shardDocs.filter(d => d.doc_type === 'progress_shard'),
    existingSrsShards: newPlan.shardDocs.filter(d => d.doc_type === 'srs_shard'),
    durableExamIds: examDocsForStudent.map(d => d.examId), // note: NOT the orphan
    now: NOW + 6000
  });
  const kept = orphanPlan.masterDoc.examHistory.find(e => e.examId === 'exam_never_persisted');
  assert.ok(kept, 'the unconfirmed exam must still be in the master history');
  assert.ok(Array.isArray(kept.moduleReports),
    'an exam with no confirmed immutable session doc must KEEP its full report on the master');
  ok('case C — an exam whose session doc was not confirmed keeps its full report (never indexed away)');
}

// =========================================================================
// 4. The frozen legacy fields.
// =========================================================================
console.log('\n4. The legacy master fields are frozen, never extended, never deleted');
{
  const frozenMaster = {
    id: 'student_frozen_student', student_name: 'frozen_student',
    doc_type: 'student_master_profile',
    progress: { qA: { answered: true, isCorrect: true, timestamp: 100, timesSeen: 1, timesCorrect: 1 } },
    srsState: { qA: { questionId: '', repetitions: 1, intervalDays: 1, easeFactor: 2.5, lastReviewedAt: 100, dueAt: 100 + 86400000, lastGrade: 4, history: [] } },
    sessionsState: {}, examHistory: [],
    schemaVersion: 2, createdAt: 1, shardsVerifiedAt: 50
  };
  const plan = shardsync.planWrite({
    studentName: 'frozen_student',
    body: {
      student_name: 'frozen_student',
      progress: { qB: { answered: true, isCorrect: false, timestamp: 200, timesSeen: 1, timesCorrect: 0 } },
      srsState: {}, sessionsState: {}, examHistory: []
    },
    existingMaster: frozenMaster,
    existingProgressShards: [],
    existingSrsShards: [],
    now: NOW
  });

  assert.deepStrictEqual(Object.keys(plan.masterDoc.progress), ['qA'],
    'the new question must NOT be appended to the frozen legacy map');
  assert.strictEqual(JSON.stringify(plan.masterDoc.progress), JSON.stringify(frozenMaster.progress),
    'the frozen legacy progress must be carried forward byte-for-byte');
  assert.strictEqual(JSON.stringify(plan.masterDoc.srsState), JSON.stringify(frozenMaster.srsState));
  ok('a new question does not grow the frozen legacy map — it goes only to its shard');

  assert.ok(plan.masterDoc.progress.qA, 'the legacy entry is still there — nothing was deleted');
  assert.strictEqual(plan.masterDoc.shardsVerifiedAt, 50, 'the marker is preserved across writes');
  ok('the pre-migration legacy data is still present and readable; the marker survives');

  // And the composite still shows BOTH.
  const composite = shardsync.reassembleComposite(
    [plan.masterDoc].concat(plan.shardDocs), 'frozen_student', NOW);
  assert.deepStrictEqual(Object.keys(composite.progress).sort(), ['qA', 'qB'],
    'the composite must merge the frozen legacy entry with the new sharded one');
  ok('the composite merges frozen legacy state with sharded state: qA (frozen) + qB (shard)');

  // Rollback: drop the marker and the document is back in dual-write mode.
  const rolledBack = Object.assign({}, frozenMaster);
  delete rolledBack.shardsVerifiedAt;
  const rbPlan = shardsync.planWrite({
    studentName: 'frozen_student',
    body: { student_name: 'frozen_student', progress: { qB: { answered: true, isCorrect: false, timestamp: 200, timesSeen: 1, timesCorrect: 0 } } },
    existingMaster: rolledBack, existingProgressShards: plan.shardDocs.filter(d => d.doc_type === 'progress_shard'),
    existingSrsShards: [], now: NOW
  });
  assert.strictEqual(rbPlan.mode, 'dual_write');
  assert.deepStrictEqual(Object.keys(rbPlan.masterDoc.progress).sort(), ['qA', 'qB'],
    'after rollback the master document carries the full map again');
  ok('rollback (remove the marker) restores dual-write and re-populates the master map — no data movement needed');
}

// =========================================================================
// 5. shardsync does not reimplement the merge rules.
// =========================================================================
console.log('\n5. One implementation of the merge rules, not two');
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'src', 'lib', 'shardsync.js'), 'utf8');
  assert.ok(/require\(['"]\.\/merge\.js['"]\)/.test(src),
    'shardsync.js must import the merge rules from merge.js');
  ['mergeProgress', 'mergeSrsState', 'mergeSessions', 'mergeExamHistory'].forEach(fn => {
    assert.ok(!new RegExp(`function\\s+${fn}\\s*\\(`).test(src),
      `shardsync.js must not define its own ${fn} — the merge pins would stop covering the shard path`);
  });
  ok('shardsync.js imports merge.js and defines none of the four merge functions itself');

  const syncSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'src', 'functions', 'sync.js'), 'utf8');
  ['mergeProgress(', 'mergeSrsState(', 'mergeSessions('].forEach(call => {
    assert.ok(syncSrc.indexOf(call) === -1,
      `sync.js must not call ${call} directly any more — the plan comes from shardsync.planWrite`);
  });
  ok('sync.js delegates every merge decision to shardsync.planWrite (one decision surface)');
}

console.log(`\n${checks} checks passed.`);
