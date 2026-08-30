/**
 * api/src/lib/shardsync.js — WI-11.5 pure planning layer for the sharded sync path.
 *
 * `api/src/functions/sync.js` is the only file that talks to Cosmos. Everything it has
 * to DECIDE — what the reassembled composite is, which shard documents changed, what
 * the master document should look like — is computed here, with no client, no context,
 * no clock and no mutation of any argument, so that the whole decision surface is
 * unit-pinnable offline against the real production document
 * (tests/integrity/test_shard_routing.js).
 *
 * The merge rules themselves are NOT reimplemented here. They are imported from
 * ./merge.js, which is what makes the shard path and the legacy path provably the same
 * rules (CLAUDE.md mode 2 — "two functions doing the same job is the bug"). The pins in
 * tests/integrity/test_merge_pins.js therefore still cover the shard path.
 *
 * THE TWO MODES
 * -------------
 * dual-write (default, and what every existing document is on)
 *   The master document keeps `progress` and `srsState` exactly as it always has, AND
 *   the same state is written to shards. Nothing about GET's answer changes, nothing is
 *   removed, and rollback is "ignore the shards". This is the additive half of the
 *   owner's "no data loss" constraint.
 *
 * shard-authoritative (only when the master carries `shardsVerifiedAt`)
 *   Set exclusively by scripts/migrate_to_shards.js AFTER it has proven, for that exact
 *   document, that reassembling the shards reproduces the pre-migration state byte for
 *   byte. From then on the master's `progress` / `srsState` are FROZEN: carried forward
 *   verbatim on every write, never extended, never deleted. They remain a complete,
 *   readable fallback at the state they held on migration day.
 *
 * GET is identical in both modes: it merges the frozen/legacy master fields with the
 * reassembled shards using merge.js's newer-wins rules, so it returns the same composite
 * shape a v1 client has always received regardless of which side is fresher.
 */

'use strict';

const {
  EXAM_HISTORY_CAP,
  mergeProgress,
  mergeSrsState,
  mergeSessions,
  mergeExamHistory
} = require('./merge.js');

const dm = require('./datamodel.js');

/** True when this master document has been migrated and verified by the migration tool. */
function isShardAuthoritative(masterDoc) {
  return !!(masterDoc && typeof masterDoc.shardsVerifiedAt === 'number' && masterDoc.shardsVerifiedAt > 0);
}

/**
 * Splits the raw result of `SELECT * FROM c WHERE c.student_name = @s` into the four
 * kinds of document this student owns.
 */
function classifyDocs(docs, studentName) {
  const out = { master: null, exams: [], progressShards: [], srsShards: [], other: [] };
  (docs || []).forEach(function (d) {
    if (!d) return;
    if (d.id === 'student_' + studentName) out.master = d;
    else if (d.doc_type === 'exam_session') out.exams.push(d);
    else if (d.doc_type === dm.PROGRESS_SHARD_TYPE) out.progressShards.push(d);
    else if (d.doc_type === dm.SRS_SHARD_TYPE) out.srsShards.push(d);
    else out.other.push(d);
  });
  return out;
}

/**
 * The composite GET /api/sync returns. Byte-identical in shape to what the v1 API has
 * always returned — same keys, same order, same types — which is constraint 2 of the
 * owner's decision ("the existing app keeps working") made checkable.
 *
 * @param {Object[]} docs every document in this student's partition
 * @param {string} studentName
 * @param {number} nowMs used only for the `updatedAt` fallback on a document that has none
 */
function reassembleComposite(docs, studentName, nowMs) {
  const c = classifyDocs(docs, studentName);
  if (!c.master && c.exams.length === 0 && c.progressShards.length === 0 && c.srsShards.length === 0) {
    return null;
  }

  const shardedProgress = dm.reassembleProgress(c.progressShards);
  const shardedSrs = dm.reassembleSrs(c.srsShards);

  return {
    id: 'student_' + studentName,
    student_name: studentName,
    // Legacy/frozen master fields first, shards second: merge.js's rules let the newer
    // record win per key, so it does not matter which side happens to be fresher.
    progress: mergeProgress(c.master && c.master.progress, shardedProgress),
    srsState: mergeSrsState(c.master && c.master.srsState, shardedSrs),
    sessionsState: (c.master && c.master.sessionsState) || {},
    // Uncapped on purpose, exactly as before: the immutable exam_session documents
    // restore any report the master's capped array no longer lists, and they win the
    // dedupe, which is also what makes the master's exam-history INDEX lossless.
    examHistory: mergeExamHistory(c.master && c.master.examHistory, c.exams),
    updatedAt: (c.master && c.master.updatedAt) || nowMs,
    schemaVersion: Number(c.master && c.master.schemaVersion) || 1,
    createdAt: (c.master && c.master.createdAt) || null
  };
}

/**
 * Plans everything a POST must write. Pure: returns documents, writes nothing.
 *
 * @param {Object} opts
 * @param {string} opts.studentName
 * @param {Object} opts.body                   the client payload (v1 full state or v2 delta)
 * @param {Object|null} opts.existingMaster
 * @param {Object[]} opts.existingProgressShards
 * @param {Object[]} opts.existingSrsShards
 * @param {number} opts.now
 * @param {string[]} [opts.durableExamIds]     examIds confirmed to exist as exam_session docs
 * @returns {{masterDoc:Object, shardDocs:Object[], unchangedShards:number,
 *            mode:string, fallbacks:number, mergedProgressCount:number,
 *            mergedSrsCount:number}}
 */
function planWrite(opts) {
  const studentName = opts.studentName;
  const body = opts.body || {};
  const existingMaster = opts.existingMaster || null;
  const now = opts.now;
  const shardMode = isShardAuthoritative(existingMaster);

  // What the server currently holds, from BOTH sides, merged by the same rules GET uses.
  const heldProgress = mergeProgress(
    existingMaster && existingMaster.progress,
    dm.reassembleProgress(opts.existingProgressShards)
  );
  const heldSrs = mergeSrsState(
    existingMaster && existingMaster.srsState,
    dm.reassembleSrs(opts.existingSrsShards)
  );

  const mergedProgress = mergeProgress(heldProgress, body.progress);
  const mergedSrs = mergeSrsState(heldSrs, body.srsState);
  const mergedSessions = mergeSessions(existingMaster && existingMaster.sessionsState, body.sessionsState);
  let mergedExams = mergeExamHistory(existingMaster && existingMaster.examHistory, body.examHistory, EXAM_HISTORY_CAP);

  // --- shard documents -----------------------------------------------------
  const pShards = dm.buildProgressShards(studentName, mergedProgress, { updatedAt: now });
  const sShards = dm.buildSrsShards(studentName, mergedSrs, { updatedAt: now });

  // Only upsert a shard whose payload actually changed. `updatedAt` is excluded from the
  // comparison so an unchanged bucket costs no RU and no write.
  const existingByIdP = {};
  (opts.existingProgressShards || []).forEach(function (d) { existingByIdP[d.id] = d; });
  const existingByIdS = {};
  (opts.existingSrsShards || []).forEach(function (d) { existingByIdS[d.id] = d; });

  const shardDocs = [];
  let unchanged = 0;
  pShards.docs.forEach(function (d) {
    const prior = existingByIdP[d.id];
    if (prior && JSON.stringify(prior.entries) === JSON.stringify(d.entries)) { unchanged++; return; }
    shardDocs.push(d);
  });
  sShards.docs.forEach(function (d) {
    const prior = existingByIdS[d.id];
    if (prior && JSON.stringify(prior.cards) === JSON.stringify(d.cards)) { unchanged++; return; }
    shardDocs.push(d);
  });

  // --- exam-history index --------------------------------------------------
  // Only once shards are authoritative, and only for exams whose immutable session
  // document is confirmed present. Anything unconfirmed keeps its full report here.
  if (shardMode && Array.isArray(opts.durableExamIds) && opts.durableExamIds.length) {
    const durable = {};
    opts.durableExamIds.forEach(function (id) { durable[id] = true; });
    mergedExams = mergedExams.map(function (e) {
      return (e && durable[e.examId]) ? dm.examIndexEntry(e) : e;
    });
  }

  // --- master document -----------------------------------------------------
  const masterDoc = {
    id: 'student_' + studentName,
    student_name: studentName,
    doc_type: 'student_master_profile',
    // FROZEN in shard-authoritative mode: carried forward byte-for-byte, never extended
    // and never removed, so the pre-migration state stays readable forever. In
    // dual-write mode this is the merged state, exactly as it has always been.
    progress: shardMode ? ((existingMaster && existingMaster.progress) || {}) : mergedProgress,
    srsState: shardMode ? ((existingMaster && existingMaster.srsState) || {}) : mergedSrs,
    sessionsState: mergedSessions,
    examHistory: mergedExams,
    updatedAt: now,
    clientTimestamp: body.clientTimestamp || new Date(now).toISOString(),
    clientVersion: body.client_version || (existingMaster && existingMaster.clientVersion) || null,
    schemaVersion: Math.max(
      Number(body.schemaVersion) || 0,
      Number(existingMaster && existingMaster.schemaVersion) || 1
    ),
    createdAt: (existingMaster && existingMaster.createdAt) || now
  };
  // Preserve the migration marker; only the migration tool ever sets or clears it.
  if (existingMaster && existingMaster.shardsVerifiedAt) {
    masterDoc.shardsVerifiedAt = existingMaster.shardsVerifiedAt;
  }

  return {
    masterDoc: masterDoc,
    shardDocs: shardDocs,
    unchangedShards: unchanged,
    mode: shardMode ? 'shard_authoritative' : 'dual_write',
    fallbacks: pShards.fallbacks + sShards.fallbacks,
    mergedProgressCount: Object.keys(mergedProgress).length,
    mergedSrsCount: Object.keys(mergedSrs).length
  };
}

module.exports = {
  isShardAuthoritative,
  classifyDocs,
  reassembleComposite,
  planWrite
};
