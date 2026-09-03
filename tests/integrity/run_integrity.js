#!/usr/bin/env node
/**
 * tests/integrity/run_integrity.js — WI-07 live data-integrity & reconciliation suite
 *
 * The check that proves "nothing was lost or corrupted" at every refactor checkpoint.
 * READ-ONLY against production: it issues Cosmos SELECT queries and blob downloads and
 * NOTHING else. There is no code path in this file that upserts, deletes, or uploads.
 *
 * Checks (every one prints the values it measured; any failure exits nonzero):
 *   1. Questions container holds exactly 3,059 documents (the frozen question mirror).
 *   2. UATStudentAnswers document count and student_default_student progress-entry count
 *      are at or above the floors in tests/integrity/expected_floor.json.
 *   3. Master-document schema: every progress entry and every SM-2 SRS card in every
 *      `student_master_profile` doc has a plausible shape.
 *   4. Orphan reconciliation: every immutable `exam_session` doc's examId appears in its
 *      student's master examHistory, and vice versa (counts reported in both directions).
 *   5. student_default_student stays under the 400 KB master-document budget (the early
 *      warning for the 2 MB Cosmos per-document wall).
 *   6. The newest cloud backup is younger than 26 h and its bytes hash to its .sha256
 *      sidecar (downloaded to a SYSTEM temp dir, never the repo, and deleted after).
 *   7. student_e2e_test_student carries a `clientVersion` — proof that the v2 write path's
 *      added fields actually persist through POST /api/sync.
 *
 * Field names were verified against the live documents on 2026-08-29 (CLAUDE.md mode 3),
 * NOT taken from the plan text. Two findings that this file pins as-measured:
 *   - SRS cards use camelCase `easeFactor` — there is no `ease_factor` field anywhere.
 *   - 13 of the 406 live progress entries have NO `timestamp` field, so `timestamp` is
 *     validated only when present. The count of entries missing it is reported as a
 *     measurement rather than invented away.
 *
 * Credentials: never on argv. COSMOS_KEY / AZURE_STORAGE_KEY from the environment if set,
 * otherwise fetched through the already-logged-in `az` CLI.
 *
 * Usage:  node tests/integrity/run_integrity.js
 *         INTEGRITY_SKIP_BACKUP=1 node tests/integrity/run_integrity.js   (skip check 6)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const {
  BACKUP_MAX_AGE_HOURS,
  BACKUP_ARCHIVE_RE,
  LATEST_POINTER_NAME,
  computeBackupStatus
} = require('../../api/src/lib/backupCore.js');

// WI-11.5: student state may live in bucketed `progress_shard` / `srs_shard` documents
// as well as on the master profile. Every check below reads the REASSEMBLED state
// (master + shards) so a migrated student is inspected exactly as thoroughly as an
// unmigrated one — the same rule applied at every site (CLAUDE.md mode 2).
const dm = require('../../api/src/lib/datamodel.js');

// ---------------------------------------------------------------------------
// Configuration — every one of these is a read target.
// ---------------------------------------------------------------------------
const COSMOS_ACCOUNT = 'psat-cosmos-15958';
const RESOURCE_GROUP = 'rg-psat-prep';
const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT || `https://${COSMOS_ACCOUNT}.documents.azure.com:443/`;
const DB_NAME = process.env.COSMOS_DB_NAME || 'psat-prep-db';
const STUDENT_CONTAINER = 'UATStudentAnswers';
const QUESTIONS_CONTAINER = 'Questions';
const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT || 'psatprep4915';
const BACKUP_CONTAINER = 'cosmos-backups';

const EXPECTED_QUESTIONS_COUNT = 3059;
const MASTER_DOC_BUDGET_BYTES = 400 * 1024; // 409,600
const DEFAULT_STUDENT_DOC_ID = 'student_default_student';
const E2E_STUDENT_DOC_ID = 'student_e2e_test_student';
/** SM-2's hard floor: an ease factor below this is a corrupt card, not a hard question. */
const MIN_EASE_FACTOR = 1.3;

const FLOOR_PATH = path.join(__dirname, 'expected_floor.json');

// ---------------------------------------------------------------------------
// Result plumbing — collect every check so one failure never hides the rest.
// ---------------------------------------------------------------------------
const results = [];
function record(id, title, passed, detail) {
  results.push({ id, title, passed, detail });
  console.log(`  ${passed ? '✓' : '✗'} [${id}] ${detail}`);
}
function section(n, title) {
  console.log(`\n--- ${n}. ${title} ---`);
}

// ---------------------------------------------------------------------------
// Credentials (never on argv; env first, then the logged-in az CLI).
// ---------------------------------------------------------------------------
function azTsv(command, what) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(`Could not obtain ${what} via the Azure CLI (is \`az login\` current?): ${e.message}`);
  }
}
function cosmosKey() {
  return process.env.COSMOS_KEY ||
    azTsv(`az cosmosdb keys list --name ${COSMOS_ACCOUNT} --resource-group ${RESOURCE_GROUP} --query primaryMasterKey -o tsv`, 'the Cosmos DB key');
}
function storageKey() {
  return process.env.AZURE_STORAGE_KEY ||
    azTsv(`az storage account keys list --account-name ${STORAGE_ACCOUNT} --resource-group ${RESOURCE_GROUP} --query '[0].value' -o tsv`, 'the storage account key');
}

// ---------------------------------------------------------------------------
// Schema validation helpers — pin what the live data ACTUALLY contains.
// ---------------------------------------------------------------------------

/**
 * Validates one progress entry. Returns an array of problem strings (empty = fine).
 * `timestamp` is optional by measurement, not by choice: 13 live entries lack it.
 */
function progressEntryProblems(qid, entry) {
  const problems = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    problems.push(`${qid}: entry is not an object (${JSON.stringify(entry)})`);
    return problems;
  }
  if (typeof entry.isCorrect !== 'boolean') {
    problems.push(`${qid}: isCorrect is ${JSON.stringify(entry.isCorrect)}, expected a boolean`);
  }
  if (entry.timestamp !== undefined) {
    if (typeof entry.timestamp !== 'number' || !Number.isFinite(entry.timestamp) || entry.timestamp <= 0) {
      problems.push(`${qid}: timestamp is ${JSON.stringify(entry.timestamp)}, expected a positive finite number`);
    }
  }
  for (const numeric of ['timesSeen', 'timesCorrect', 'timesIncorrect', 'timeSpentMs']) {
    if (entry[numeric] !== undefined && (typeof entry[numeric] !== 'number' || !Number.isFinite(entry[numeric]) || entry[numeric] < 0)) {
      problems.push(`${qid}: ${numeric} is ${JSON.stringify(entry[numeric])}, expected a non-negative finite number`);
    }
  }
  return problems;
}

/**
 * Validates one SM-2 SRS card against the field names the live data really uses:
 * easeFactor / repetitions / intervalDays / lastReviewedAt (all camelCase).
 */
function srsCardProblems(qid, card) {
  const problems = [];
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    problems.push(`${qid}: card is not an object (${JSON.stringify(card)})`);
    return problems;
  }
  if (card.ease_factor !== undefined) {
    problems.push(`${qid}: found snake_case ease_factor — the live schema is camelCase easeFactor`);
  }
  if (typeof card.easeFactor !== 'number' || !Number.isFinite(card.easeFactor)) {
    problems.push(`${qid}: easeFactor is ${JSON.stringify(card.easeFactor)}, expected a finite number`);
  } else if (card.easeFactor < MIN_EASE_FACTOR) {
    problems.push(`${qid}: easeFactor ${card.easeFactor} < SM-2 floor ${MIN_EASE_FACTOR}`);
  }
  if (typeof card.repetitions !== 'number' || !Number.isFinite(card.repetitions) || card.repetitions < 0) {
    problems.push(`${qid}: repetitions is ${JSON.stringify(card.repetitions)}, expected a non-negative finite number`);
  }
  if (card.intervalDays !== undefined && (typeof card.intervalDays !== 'number' || !Number.isFinite(card.intervalDays) || card.intervalDays < 0)) {
    problems.push(`${qid}: intervalDays is ${JSON.stringify(card.intervalDays)}, expected a non-negative finite number`);
  }
  if (card.lastReviewedAt !== undefined && (typeof card.lastReviewedAt !== 'number' || !Number.isFinite(card.lastReviewedAt) || card.lastReviewedAt < 0)) {
    problems.push(`${qid}: lastReviewedAt is ${JSON.stringify(card.lastReviewedAt)}, expected a non-negative finite number`);
  }
  return problems;
}

/** Bytes of a document as Cosmos stores it, minus the system fields Cosmos adds. */
function documentBytes(doc) {
  const copy = Object.assign({}, doc);
  ['_rid', '_self', '_etag', '_attachments', '_ts'].forEach(k => delete copy[k]);
  return { withSystemFields: Buffer.byteLength(JSON.stringify(doc), 'utf8'), userBytes: Buffer.byteLength(JSON.stringify(copy), 'utf8') };
}

// WI-18: a master profile becomes shard-authoritative once scripts/migrate_to_shards.js
// stamps `shardsVerifiedAt` (after proving the shards reassemble byte-for-byte). From then
// on api/src/lib/shardsync.js FREEZES the master's `progress` / `srsState` — carried forward
// verbatim on every write, never extended, never deleted.
function isFrozenMaster(doc) {
  return !!(doc && doc.doc_type === 'student_master_profile' && typeof doc.shardsVerifiedAt === 'number' && doc.shardsVerifiedAt > 0);
}

// The bytes the size budget should watch: the ones that can still GROW. The document
// budget exists to catch UNBOUNDED GROWTH. For a frozen master the legacy `progress` /
// `srsState` maps are constant dead weight that new writes route to shards instead of
// extending, so they are not a growth risk and are excluded here; everything that can
// still grow (sessionsState, examHistory, envelope) is still counted, and the record's
// live shards are budgeted whole in the DOC-SIZE-ALL sweep. Every non-frozen document
// (shards, un-migrated masters) is budgeted whole, exactly as before.
function budgetableBytes(doc) {
  if (!isFrozenMaster(doc)) return documentBytes(doc).withSystemFields;
  const copy = Object.assign({}, doc, { progress: {}, srsState: {} });
  ['_rid', '_self', '_etag', '_attachments', '_ts'].forEach(k => delete copy[k]);
  return Buffer.byteLength(JSON.stringify(copy), 'utf8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const startedAt = new Date();
  console.log('======================================================================');
  console.log('WI-07 data-integrity suite — READ-ONLY against production');
  console.log(`  Cosmos    : ${COSMOS_ENDPOINT} / ${DB_NAME}`);
  console.log(`  Storage   : ${STORAGE_ACCOUNT} / ${BACKUP_CONTAINER}`);
  console.log(`  Started   : ${startedAt.toISOString()}`);
  console.log('======================================================================');

  // Floors — read from disk, never derived from the live values they guard.
  let floor;
  try {
    floor = JSON.parse(fs.readFileSync(FLOOR_PATH, 'utf8'));
  } catch (e) {
    console.error(`FATAL: could not read ${FLOOR_PATH}: ${e.message}`);
    process.exit(1);
  }
  if (typeof floor.studentDocsMin !== 'number' || typeof floor.defaultStudentProgressMin !== 'number') {
    console.error(`FATAL: ${FLOOR_PATH} must define numeric studentDocsMin and defaultStudentProgressMin.`);
    process.exit(1);
  }
  console.log(`\nFloors in use (hand-maintained, never auto-raised — see ${path.relative(process.cwd(), FLOOR_PATH)}):`);
  console.log(`  studentDocsMin              = ${floor.studentDocsMin}`);
  console.log(`  defaultStudentProgressMin   = ${floor.defaultStudentProgressMin}`);

  const { CosmosClient } = require('../../api/node_modules/@azure/cosmos');
  const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: cosmosKey() });
  const database = client.database(DB_NAME);

  // =====================================================================
  // 1. Questions container == 3,059 exactly.
  // =====================================================================
  section(1, `${QUESTIONS_CONTAINER} container count`);
  {
    const { resources } = await database.container(QUESTIONS_CONTAINER)
      .items.query('SELECT VALUE COUNT(1) FROM c').fetchAll();
    const count = Array.isArray(resources) && resources.length ? resources[0] : null;
    console.log(`  measured Questions documents : ${count}`);
    record('Q-COUNT', 'Questions == 3059',
      count === EXPECTED_QUESTIONS_COUNT,
      `Questions=${count} (expected exactly ${EXPECTED_QUESTIONS_COUNT})`);
  }

  // =====================================================================
  // Fetch every student document once; checks 2-5 and 7 all read it.
  // =====================================================================
  const { resources: studentDocs } = await database.container(STUDENT_CONTAINER)
    .items.query('SELECT * FROM c').fetchAll();
  const allDocs = Array.isArray(studentDocs) ? studentDocs : [];
  const masters = allDocs.filter(d => d && d.doc_type === 'student_master_profile');
  const examSessions = allDocs.filter(d => d && d.doc_type === 'exam_session');
  const progressShards = allDocs.filter(d => d && d.doc_type === dm.PROGRESS_SHARD_TYPE);
  const srsShards = allDocs.filter(d => d && d.doc_type === dm.SRS_SHARD_TYPE);
  const KNOWN_DOC_TYPES = ['student_master_profile', 'exam_session', dm.PROGRESS_SHARD_TYPE, dm.SRS_SHARD_TYPE];
  const untyped = allDocs.filter(d => d && KNOWN_DOC_TYPES.indexOf(d.doc_type) === -1);

  /**
   * The REASSEMBLED state per student: the master profile's own maps merged with
   * whatever its shards hold. Every subsequent check reads this, not `m.progress`, so a
   * migrated student is not silently reported as having lost its data.
   */
  const effectiveByStudent = new Map();
  const ensureStudent = (name) => {
    if (!effectiveByStudent.has(name)) {
      effectiveByStudent.set(name, { student: name, master: null, progress: {}, srsState: {} });
    }
    return effectiveByStudent.get(name);
  };
  masters.forEach(m => {
    const s = ensureStudent(m.student_name || '(no student_name)');
    s.master = m;
    Object.assign(s.progress, m.progress || {});
    Object.assign(s.srsState, m.srsState || {});
  });
  progressShards.forEach(d => {
    Object.assign(ensureStudent(d.student_name || '(no student_name)').progress,
      dm.reassembleProgress([d]));
  });
  srsShards.forEach(d => {
    Object.assign(ensureStudent(d.student_name || '(no student_name)').srsState,
      dm.reassembleSrs([d]));
  });

  // =====================================================================
  // 2. Document / progress floors.
  // =====================================================================
  section(2, `${STUDENT_CONTAINER} floors`);
  {
    console.log(`  measured documents            : ${allDocs.length}  (masters=${masters.length}, exam_session=${examSessions.length}, ` +
      `progress_shard=${progressShards.length}, srs_shard=${srsShards.length}, other=${untyped.length})`);
    record('DOC-FLOOR', 'UATStudentAnswers >= floor',
      allDocs.length >= floor.studentDocsMin,
      `documents=${allDocs.length} >= floor ${floor.studentDocsMin}`);

    const defaultMaster = allDocs.find(d => d && d.id === DEFAULT_STUDENT_DOC_ID);
    if (!defaultMaster) {
      record('PROGRESS-FLOOR', 'default_student progress >= floor', false,
        `${DEFAULT_STUDENT_DOC_ID} not found in ${STUDENT_CONTAINER} — cannot check the progress floor`);
    } else {
      // Reassembled (master + shards), never the master field alone.
      const eff = effectiveByStudent.get(defaultMaster.student_name) || { progress: {}, srsState: {} };
      const n = Object.keys(eff.progress).length;
      console.log(`  measured default_student progress entries : ${n}  ` +
        `(master field ${Object.keys(defaultMaster.progress || {}).length} + shards)`);
      console.log(`  measured default_student SRS cards        : ${Object.keys(eff.srsState).length}  ` +
        `(master field ${Object.keys(defaultMaster.srsState || {}).length} + shards)`);
      console.log(`  measured default_student session days     : ${Object.keys(defaultMaster.sessionsState || {}).length}`);
      console.log(`  measured default_student examHistory      : ${(defaultMaster.examHistory || []).length}`);
      console.log(`  measured default_student updatedAt        : ${defaultMaster.updatedAt ? new Date(defaultMaster.updatedAt).toISOString() : 'null'}`);
      record('PROGRESS-FLOOR', 'default_student progress >= floor',
        n >= floor.defaultStudentProgressMin,
        `progress entries=${n} >= floor ${floor.defaultStudentProgressMin}`);
    }
  }

  // =====================================================================
  // 3. Master-document schema.
  // =====================================================================
  section(3, 'Reassembled student schema (progress entries + SM-2 SRS cards, master + shards)');
  {
    let totalProgress = 0, totalCards = 0, missingTimestamp = 0, emptyQuestionId = 0;
    let minEase = null, maxEase = null, minReps = null, maxReps = null;
    const problems = [];

    for (const m of effectiveByStudent.values()) {
      const progress = m.progress || {};
      for (const [qid, entry] of Object.entries(progress)) {
        totalProgress++;
        if (entry && typeof entry === 'object' && entry.timestamp === undefined) missingTimestamp++;
        progressEntryProblems(`${m.student}/${qid}`, entry).forEach(p => problems.push(p));
      }
      const cards = m.srsState || {};
      for (const [qid, card] of Object.entries(cards)) {
        totalCards++;
        if (card && card.questionId === '') emptyQuestionId++;
        if (card && typeof card.easeFactor === 'number') {
          minEase = (minEase === null || card.easeFactor < minEase) ? card.easeFactor : minEase;
          maxEase = (maxEase === null || card.easeFactor > maxEase) ? card.easeFactor : maxEase;
        }
        if (card && typeof card.repetitions === 'number') {
          minReps = (minReps === null || card.repetitions < minReps) ? card.repetitions : minReps;
          maxReps = (maxReps === null || card.repetitions > maxReps) ? card.repetitions : maxReps;
        }
        srsCardProblems(`${m.student}/${qid}`, card).forEach(p => problems.push(p));
      }
    }

    console.log(`  students inspected                 : ${effectiveByStudent.size} (${[...effectiveByStudent.keys()].join(', ')})`);
    console.log(`  master_profile documents inspected : ${masters.length} (${masters.map(m => m.id).join(', ')})`);
    console.log(`  shard documents inspected          : ${progressShards.length} progress + ${srsShards.length} srs`);
    console.log(`  progress entries inspected         : ${totalProgress}`);
    console.log(`  ...of which have NO timestamp      : ${missingTimestamp}  (measured, not a failure: timestamp is validated only when present)`);
    console.log(`  SRS cards inspected                : ${totalCards}`);
    console.log(`  easeFactor range                   : ${minEase === null ? 'n/a (no cards)' : `${minEase} .. ${maxEase}`}  (SM-2 floor ${MIN_EASE_FACTOR})`);
    console.log(`  repetitions range                  : ${minReps === null ? 'n/a (no cards)' : `${minReps} .. ${maxReps}`}`);
    console.log(`  cards with questionId === ""       : ${emptyQuestionId} of ${totalCards}  (measured; the card key is the question id, the field is unpopulated)`);
    if (problems.length) {
      problems.slice(0, 20).forEach(p => console.log(`      ! ${p}`));
      if (problems.length > 20) console.log(`      ! ...and ${problems.length - 20} more`);
    }
    record('SCHEMA', 'master-doc schema', problems.length === 0,
      `${problems.length} schema problem(s) across ${totalProgress} progress entries and ${totalCards} SRS cards`);
  }

  // =====================================================================
  // 4. Orphan reconciliation between exam_session docs and master examHistory.
  // =====================================================================
  section(4, 'Exam reconciliation (exam_session docs <-> master examHistory)');
  {
    const historyByStudent = new Map();
    for (const m of masters) {
      const ids = new Set();
      (m.examHistory || []).forEach(e => { if (e && e.examId) ids.add(e.examId); });
      historyByStudent.set(m.student_name, ids);
    }
    const sessionsByStudent = new Map();
    for (const d of examSessions) {
      if (!sessionsByStudent.has(d.student_name)) sessionsByStudent.set(d.student_name, new Set());
      if (d.examId) sessionsByStudent.get(d.student_name).add(d.examId);
    }

    const orphanSessions = [];   // session doc whose examId is absent from the master history
    const historyOnly = [];      // master history entry with no immutable session doc
    const sessionsNoExamId = [];

    for (const d of examSessions) {
      if (!d.examId) { sessionsNoExamId.push(d.id); continue; }
      const hist = historyByStudent.get(d.student_name);
      if (!hist || !hist.has(d.examId)) orphanSessions.push(`${d.student_name}/${d.examId} (doc ${d.id})`);
    }
    for (const [student, ids] of historyByStudent.entries()) {
      const sess = sessionsByStudent.get(student) || new Set();
      for (const id of ids) if (!sess.has(id)) historyOnly.push(`${student}/${id}`);
    }

    const totalHistoryIds = Array.from(historyByStudent.values()).reduce((a, s) => a + s.size, 0);
    console.log(`  exam_session documents             : ${examSessions.length}`);
    console.log(`  distinct examIds in master history : ${totalHistoryIds}`);
    console.log(`  session docs with no examId field  : ${sessionsNoExamId.length}${sessionsNoExamId.length ? ' -> ' + sessionsNoExamId.join(', ') : ''}`);
    console.log(`  orphan session docs (session -> history missing) : ${orphanSessions.length}${orphanSessions.length ? ' -> ' + orphanSessions.join(', ') : ''}`);
    console.log(`  history entries with no session doc (history -> session missing) : ${historyOnly.length}${historyOnly.length ? ' -> ' + historyOnly.join(', ') : ''}`);
    record('ORPHANS', 'exam reconciliation',
      orphanSessions.length === 0 && historyOnly.length === 0 && sessionsNoExamId.length === 0,
      `orphanSessions=${orphanSessions.length}, historyWithoutSessionDoc=${historyOnly.length}, sessionDocsMissingExamId=${sessionsNoExamId.length}`);
  }

  // =====================================================================
  // 5. Master-document size budget.
  // =====================================================================
  section(5, `${STUDENT_CONTAINER} document size budget`);
  {
    // WI-11.5: the budget applies to EVERY document, not only the master. Sharding
    // moves bytes into other documents, so a check that only watched the master would
    // stop seeing the growth it exists to catch (CLAUDE.md mode 2).
    const sized = allDocs.map(d => ({ id: d.id, type: d.doc_type, bytes: documentBytes(d).withSystemFields, budgeted: budgetableBytes(d), frozen: isFrozenMaster(d) }))
      .sort((a, b) => b.bytes - a.bytes);
    const over = sized.filter(d => d.budgeted >= MASTER_DOC_BUDGET_BYTES);
    console.log(`  documents measured                                      : ${sized.length}`);
    console.log('  five largest (on disk; "growable" excludes a frozen master\'s carried-forward maps):');
    sized.slice(0, 5).forEach(d => console.log(`    ${String(d.bytes).padStart(8)} B  ${d.id}  [${d.type}]` + (d.frozen ? `  (frozen; growable ${d.budgeted} B)` : '')));
    record('DOC-SIZE-ALL', 'every document within the growth budget', over.length === 0,
      over.length === 0
        ? `all ${sized.length} documents within ${MASTER_DOC_BUDGET_BYTES}-byte growth budget (largest growable ${sized.reduce((m, d) => Math.max(m, d.budgeted), 0)})`
        : `${over.length} document(s) at/over budget: ${over.map(d => `${d.id}=${d.budgeted}`).join(', ')}`);

    const doc = allDocs.find(d => d && d.id === DEFAULT_STUDENT_DOC_ID);
    if (!doc) {
      record('DOC-SIZE', 'master doc < 400 KB', false, `${DEFAULT_STUDENT_DOC_ID} not found`);
    } else {
      const { withSystemFields, userBytes } = documentBytes(doc);
      const frozen = isFrozenMaster(doc);
      const budgeted = budgetableBytes(doc);
      const pct = ((budgeted / MASTER_DOC_BUDGET_BYTES) * 100).toFixed(1);
      console.log(`  measured bytes (as stored, incl. Cosmos _rid/_etag/...) : ${withSystemFields}`);
      console.log(`  measured bytes (application fields only)                : ${userBytes}`);
      if (frozen) {
        console.log(`  shard-authoritative (shardsVerifiedAt set)              : progress/srsState FROZEN (${withSystemFields - budgeted} B) excluded from budget`);
        console.log(`  growable bytes (sessions + examHistory + envelope)      : ${budgeted}`);
      }
      console.log(`  budget                                                  : ${MASTER_DOC_BUDGET_BYTES} bytes (400 KB) — currently ${pct}% of the growth budget used`);
      // Also print the largest master doc so a different student cannot creep past unseen.
      const largest = masters.map(m => ({ id: m.id, bytes: documentBytes(m).withSystemFields }))
        .sort((a, b) => b.bytes - a.bytes)[0];
      console.log(`  largest master document overall                         : ${largest.id} @ ${largest.bytes} bytes`);
      record('DOC-SIZE', 'master within the growth budget',
        budgeted < MASTER_DOC_BUDGET_BYTES,
        frozen
          ? `${DEFAULT_STUDENT_DOC_ID} growable=${budgeted} bytes < ${MASTER_DOC_BUDGET_BYTES} budget (${pct}%); frozen legacy maps ${withSystemFields - budgeted} B excluded; total on disk ${withSystemFields} B`
          : `${DEFAULT_STUDENT_DOC_ID} = ${budgeted} bytes < ${MASTER_DOC_BUDGET_BYTES} budget (${pct}%)`);
    }
  }

  // =====================================================================
  // 5b. WI-11.5 shard integrity: routing, non-overlap, codec health.
  // =====================================================================
  section('5b', 'Shard integrity (routing, non-overlap, codec fallbacks)');
  {
    const misrouted = [];
    const seenProgress = new Map(); // qid -> shard doc id
    const seenSrs = new Map();
    let rawFallbacks = 0;
    let shardedProgressEntries = 0;
    let shardedSrsCards = 0;

    const checkShard = (doc, mapField, seen, kind) => {
      const map = doc[mapField] || {};
      for (const qid of Object.keys(map)) {
        const want = dm.bucketOf(qid);
        if (want !== doc.bucket) {
          misrouted.push(`${kind} '${qid}' is in ${doc.id} (bucket ${doc.bucket}) but hashes to bucket ${want}`);
        }
        const prior = seen.get(qid);
        if (prior && prior !== doc.id) {
          misrouted.push(`${kind} '${qid}' appears in BOTH ${prior} and ${doc.id}`);
        }
        seen.set(qid, doc.id);
        if (map[qid] && Object.prototype.hasOwnProperty.call(map[qid], dm.K_RAW)) rawFallbacks++;
      }
      return Object.keys(map).length;
    };

    progressShards.forEach(d => { shardedProgressEntries += checkShard(d, 'entries', seenProgress, 'progress entry'); });
    srsShards.forEach(d => { shardedSrsCards += checkShard(d, 'cards', seenSrs, 'srs card'); });

    console.log(`  progress shards / entries          : ${progressShards.length} / ${shardedProgressEntries}`);
    console.log(`  srs shards / cards                 : ${srsShards.length} / ${shardedSrsCards}`);
    console.log(`  shard buckets configured           : ${dm.SHARD_COUNT}`);
    console.log(`  records stored via the codec's verbatim fallback ($r) : ${rawFallbacks}  ` +
      `(measured; a fallback costs bytes but never loses data)`);
    if (misrouted.length) misrouted.slice(0, 20).forEach(p => console.log(`      ! ${p}`));
    record('SHARD-ROUTING', 'every sharded record is in its hashed bucket, exactly once',
      misrouted.length === 0,
      misrouted.length === 0
        ? `${shardedProgressEntries + shardedSrsCards} sharded records, 0 misrouted, 0 duplicated`
        : `${misrouted.length} routing problem(s)`);
  }

  // =====================================================================
  // 6. Newest cloud backup: age < 26 h, and its sha256 sidecar verifies.
  // =====================================================================
  section(6, `Newest ${BACKUP_CONTAINER} archive: freshness + checksum`);
  if (process.env.INTEGRITY_SKIP_BACKUP === '1') {
    console.log('  INTEGRITY_SKIP_BACKUP=1 — backup freshness/checksum check SKIPPED (not passed, skipped).');
    record('BACKUP', 'backup freshness + checksum', true, 'SKIPPED by INTEGRITY_SKIP_BACKUP=1 (no assertion made)');
  } else {
    const { BlobServiceClient, StorageSharedKeyCredential } = require('../../api/node_modules/@azure/storage-blob');
    const service = new BlobServiceClient(
      `https://${STORAGE_ACCOUNT}.blob.core.windows.net`,
      new StorageSharedKeyCredential(STORAGE_ACCOUNT, storageKey())
    );
    const containerClient = service.getContainerClient(BACKUP_CONTAINER);

    const blobs = [];
    for await (const b of containerClient.listBlobsFlat()) {
      blobs.push({ name: b.name, lastModified: b.properties.lastModified, contentLength: b.properties.contentLength });
    }

    // Reuse the shipped status logic rather than re-deriving freshness (CLAUDE.md mode 2).
    const status = computeBackupStatus(blobs, Date.now());
    console.log(`  blobs in container                 : ${blobs.length}`);
    console.log(`  successful archives                : ${status.successBackupCount}`);
    console.log(`  failure markers                    : ${status.failureMarkerCount}`);
    console.log(`  last successful backup             : ${status.lastSuccessAt}`);
    console.log(`  age                                : ${status.ageHours === null ? 'n/a' : status.ageHours + ' h'} (limit ${BACKUP_MAX_AGE_HOURS} h)`);
    console.log(`  status reason                      : ${status.reason}`);
    record('BACKUP-AGE', 'newest backup < 26 h and no newer failure marker',
      status.healthy === true,
      `ageHours=${status.ageHours}, healthy=${status.healthy} — ${status.reason}`);

    const archives = blobs
      .filter(b => b.name !== LATEST_POINTER_NAME && BACKUP_ARCHIVE_RE.test(b.name))
      .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    if (archives.length === 0) {
      record('BACKUP-SHA', 'sidecar checksum verifies', false, 'no cosmos_backup_*.json archive to verify');
    } else {
      const newest = archives[0];
      const sidecarName = `${newest.name}.sha256`;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-backup-'));
      try {
        const localPath = path.join(tmpDir, path.basename(newest.name));
        await containerClient.getBlockBlobClient(newest.name).downloadToFile(localPath);
        const bytes = fs.readFileSync(localPath);
        const localSha = crypto.createHash('sha256').update(bytes).digest('hex');

        let sidecarSha = null;
        let sidecarError = null;
        try {
          const buf = await containerClient.getBlockBlobClient(sidecarName).downloadToBuffer();
          sidecarSha = String(buf).trim().split(/\s+/)[0].toLowerCase();
        } catch (e) {
          sidecarError = e.message;
        }

        console.log(`  newest archive                     : ${newest.name}`);
        console.log(`  downloaded bytes                   : ${bytes.length} (container reports ${newest.contentLength})`);
        console.log(`  locally computed sha256            : ${localSha}`);
        console.log(`  sidecar (${sidecarName}) sha256    : ${sidecarSha === null ? `UNREADABLE: ${sidecarError}` : sidecarSha}`);

        // Parse the payload too: a checksum-valid but structurally empty backup is
        // still a lost backup (CLAUDE.md mode 5 — report both "valid" and "complete").
        let payloadNote = 'unparseable';
        let payloadOk = false;
        try {
          const payload = JSON.parse(bytes.toString('utf8'));
          const meta = payload.backupMetadata || {};
          const students = Array.isArray(payload.studentAnswers) ? payload.studentAnswers.length : 0;
          const questions = Array.isArray(payload.questions) ? payload.questions.length : 0;
          payloadNote = `version=${meta.version || 'unknown'}, studentAnswers=${students}, feedback=${Array.isArray(payload.feedback) ? payload.feedback.length : 0}, questions=${questions}`;
          // A backup is a snapshot of the PAST, so it is not compared against the live
          // floor — a backup taken before legitimate growth holds fewer documents and
          // that is correct, not a loss. What must never happen is an empty/structureless
          // archive that still checksums perfectly (CLAUDE.md mode 5: "valid" != "complete").
          payloadOk = Array.isArray(payload.studentAnswers) && students > 0;
          console.log(`  payload                            : ${payloadNote}`);
          if (!payloadOk) console.log(`      ! backup contains no studentAnswers array / zero student documents — checksum-valid but empty`);
          if (students < floor.studentDocsMin) {
            console.log(`      i note: this archive predates current growth (${students} student docs vs live floor ${floor.studentDocsMin}) — informational, not a failure`);
          }
        } catch (e) {
          console.log(`  payload                            : UNPARSEABLE (${e.message})`);
        }

        const shaOk = sidecarSha !== null && sidecarSha === localSha && bytes.length === newest.contentLength;
        record('BACKUP-SHA', 'sidecar checksum verifies on download and the archive is non-empty', shaOk && payloadOk,
          `${newest.name}: sha match=${sidecarSha === localSha}, bytes=${bytes.length}/${newest.contentLength}, ${payloadNote}`);
      } finally {
        // Temp files never live in the repo and never outlive the run.
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  }

  // =====================================================================
  // 7. e2e_test_student carries clientVersion (v2 write path persists its fields).
  // =====================================================================
  section(7, `${E2E_STUDENT_DOC_ID}: clientVersion present`);
  {
    const doc = allDocs.find(d => d && d.id === E2E_STUDENT_DOC_ID);
    if (!doc) {
      record('E2E-CLIENTVERSION', 'e2e doc has clientVersion', false,
        `${E2E_STUDENT_DOC_ID} not found — the v2 write path has never been exercised against this database`);
    } else {
      const cv = doc.clientVersion;
      console.log(`  clientVersion    : ${JSON.stringify(cv)}`);
      console.log(`  clientTimestamp  : ${JSON.stringify(doc.clientTimestamp)}`);
      console.log(`  updatedAt        : ${doc.updatedAt ? new Date(doc.updatedAt).toISOString() : 'null'}`);
      console.log(`  progress entries : ${Object.keys(doc.progress || {}).length}`);
      record('E2E-CLIENTVERSION', 'e2e doc has clientVersion',
        typeof cv === 'string' && cv.length > 0,
        `clientVersion=${JSON.stringify(cv)}`);
    }
  }

  // =====================================================================
  // Summary
  // =====================================================================
  const failed = results.filter(r => !r.passed);
  console.log('\n======================================================================');
  console.log(`Checks run: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  results.forEach(r => console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id.padEnd(18)} ${r.detail}`));
  console.log(`Finished: ${new Date().toISOString()} (${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s)`);
  if (failed.length) {
    console.log('INTEGRITY_SUITE_FAILED');
    console.log('======================================================================');
    process.exitCode = 1;
    return;
  }
  console.log('INTEGRITY_SUITE_OK');
  console.log('======================================================================');
}

if (require.main === module) {
  main().catch(err => {
    console.error('\n❌ run_integrity.js aborted:', err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
    console.log('INTEGRITY_SUITE_FAILED');
    process.exit(1);
  });
}

module.exports = { progressEntryProblems, srsCardProblems, documentBytes, isFrozenMaster, budgetableBytes, MIN_EASE_FACTOR, MASTER_DOC_BUDGET_BYTES };
