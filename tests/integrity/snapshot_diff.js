#!/usr/bin/env node
/**
 * tests/integrity/snapshot_diff.js — WI-07 backup-to-backup difference report
 *
 * Given two backup JSON files (older first, newer second) it prints, per student, what
 * changed between them: progress entries added / removed / changed, SRS cards added /
 * removed / changed, session days added / removed / changed, exams added / removed, and
 * immutable exam_session documents added / removed.
 *
 * The point of the tool is the `--expect-no-removals` flag: at a phase gate the ONLY
 * legitimate difference between two consecutive backups is growth. Anything present in
 * the older file and absent from the newer one is data loss, and with that flag the tool
 * exits nonzero and names exactly what disappeared (REFACTOR_PLAN.md WI-18).
 *
 * Read-only and offline: it opens two local files and prints. It never contacts Azure and
 * never writes anything.
 *
 * Payload formats: BOTH are accepted.
 *   - version 1.0 (scripts/backup_cosmos.js): { backupMetadata, studentAnswers, feedback }
 *   - version 1.1 (api/src/functions/backup.js): the above plus a `questions` array
 * A missing `questions` key is reported as "absent (v1.0 payload)", never as 0 documents
 * (CLAUDE.md mode 1: absent data is null, not zero).
 *
 * Usage:
 *   node tests/integrity/snapshot_diff.js <older.json> <newer.json>
 *   node tests/integrity/snapshot_diff.js <older.json> <newer.json> --expect-no-removals
 *   node tests/integrity/snapshot_diff.js <older.json> <newer.json> --max-detail=25
 */

const fs = require('fs');
const path = require('path');
const dm = require('../../api/src/lib/datamodel.js');

/** How many individual ids to name per category before summarising the rest. */
const DEFAULT_MAX_DETAIL = 10;

/**
 * Loads and shallowly validates a backup payload. Throws with a clear message rather
 * than returning a half-built object — a snapshot we cannot read must stop the run,
 * never quietly compare against `{}` (CLAUDE.md mode 5).
 */
function loadBackup(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read backup file '${filePath}': ${e.message}`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Backup file '${filePath}' is not valid JSON: ${e.message}`);
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.studentAnswers)) {
    throw new Error(`Backup file '${filePath}' has no 'studentAnswers' array — not a recognised backup payload.`);
  }
  const meta = payload.backupMetadata || {};
  return {
    filePath,
    bytes: Buffer.byteLength(raw, 'utf8'),
    version: meta.version || 'unknown',
    generatedAt: meta.generatedAt || null,
    triggerType: meta.triggerType || null,
    studentAnswers: payload.studentAnswers,
    feedback: Array.isArray(payload.feedback) ? payload.feedback : [],
    // v1.0 payloads have no questions key at all: absent, not zero.
    questionsCount: Array.isArray(payload.questions) ? payload.questions.length : null
  };
}

/** Cosmos system fields are noise for a content diff. */
const SYSTEM_FIELDS = ['_rid', '_self', '_etag', '_attachments', '_ts'];
function stripSystem(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const copy = Object.assign({}, obj);
  SYSTEM_FIELDS.forEach(k => delete copy[k]);
  return copy;
}

/** Stable stringify so key ordering never registers as a change. */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value).filter(k => !SYSTEM_FIELDS.includes(k)).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

/**
 * Reduces one backup's studentAnswers array into per-student buckets:
 * the master profile's four maps plus the immutable exam_session documents.
 */
function indexByStudent(backup) {
  const byStudent = new Map();
  const ensure = (name) => {
    if (!byStudent.has(name)) {
      byStudent.set(name, {
        student: name,
        hasMaster: false,
        masterBytes: null,
        progress: {},
        srsState: {},
        sessionsState: {},
        examHistory: {},     // examId -> entry
        examSessionDocs: {}  // doc id -> doc
      });
    }
    return byStudent.get(name);
  };

  for (const doc of backup.studentAnswers) {
    if (!doc || typeof doc !== 'object') continue;
    const name = doc.student_name || '(no student_name)';
    const bucket = ensure(name);
    if (doc.doc_type === 'exam_session' || /^exam_/.test(doc.id || '')) {
      bucket.examSessionDocs[doc.id] = stripSystem(doc);
      continue;
    }
    // WI-11.5: bucketed shard documents hold the same progress / SRS records the master
    // profile used to hold, in slim form. Expanding them here means a snapshot taken
    // before a shard migration and one taken after diff as "no change" rather than as
    // "406 progress entries removed" — the diff compares STATE, not storage layout.
    if (doc.doc_type === dm.PROGRESS_SHARD_TYPE) {
      Object.assign(bucket.progress, dm.reassembleProgress([doc]));
      continue;
    }
    if (doc.doc_type === dm.SRS_SHARD_TYPE) {
      Object.assign(bucket.srsState, dm.reassembleSrs([doc]));
      continue;
    }
    // Anything else carrying the master maps is treated as the master profile.
    bucket.hasMaster = true;
    bucket.masterBytes = Buffer.byteLength(JSON.stringify(stripSystem(doc)), 'utf8');
    Object.assign(bucket.progress, doc.progress || {});
    Object.assign(bucket.srsState, doc.srsState || {});
    Object.assign(bucket.sessionsState, doc.sessionsState || {});
    (doc.examHistory || []).forEach(e => { if (e && e.examId) bucket.examHistory[e.examId] = e; });
  }
  return byStudent;
}

/**
 * Compares two keyed maps. Returns { added, removed, changed } as arrays of keys,
 * plus counts. Pure — used for progress, SRS, sessions, exams and exam docs alike.
 */
function diffMaps(oldMap, newMap) {
  const oldKeys = Object.keys(oldMap || {});
  const newKeys = Object.keys(newMap || {});
  const oldSet = new Set(oldKeys);
  const newSet = new Set(newKeys);
  const added = newKeys.filter(k => !oldSet.has(k));
  const removed = oldKeys.filter(k => !newSet.has(k));
  const changed = oldKeys.filter(k => newSet.has(k) && stable(oldMap[k]) !== stable(newMap[k]));
  return { added, removed, changed, oldCount: oldKeys.length, newCount: newKeys.length };
}

/**
 * Builds the whole diff between two loaded backups. Pure: no printing, no IO.
 * @returns {{students: Array, totals: Object, older: Object, newer: Object}}
 */
function buildDiff(older, newer) {
  const oldIdx = indexByStudent(older);
  const newIdx = indexByStudent(newer);
  const names = Array.from(new Set([...oldIdx.keys(), ...newIdx.keys()])).sort();

  const empty = { hasMaster: false, masterBytes: null, progress: {}, srsState: {}, sessionsState: {}, examHistory: {}, examSessionDocs: {} };
  const students = names.map(name => {
    const o = oldIdx.get(name) || Object.assign({ student: name }, empty);
    const n = newIdx.get(name) || Object.assign({ student: name }, empty);
    return {
      student: name,
      presentInOlder: oldIdx.has(name),
      presentInNewer: newIdx.has(name),
      masterBytesOld: o.masterBytes,
      masterBytesNew: n.masterBytes,
      progress: diffMaps(o.progress, n.progress),
      srs: diffMaps(o.srsState, n.srsState),
      sessions: diffMaps(o.sessionsState, n.sessionsState),
      exams: diffMaps(o.examHistory, n.examHistory),
      examDocs: diffMaps(o.examSessionDocs, n.examSessionDocs),
      // Session values are cumulative daily counters — a DECREASE is a loss even
      // though the key still exists, so it is surfaced separately from "changed".
      sessionRegressions: Object.keys(o.sessionsState)
        .filter(d => n.sessionsState[d])
        .map(d => {
          const a = o.sessionsState[d] || {};
          const b = n.sessionsState[d] || {};
          const fields = ['questionsAnswered', 'correct', 'totalTimeMs']
            .filter(f => typeof a[f] === 'number' && typeof b[f] === 'number' && b[f] < a[f])
            .map(f => `${f} ${a[f]}->${b[f]}`);
          return fields.length ? `${d}: ${fields.join(', ')}` : null;
        })
        .filter(Boolean)
    };
  });

  const totals = {
    studentsAdded: students.filter(s => !s.presentInOlder && s.presentInNewer).map(s => s.student),
    studentsRemoved: students.filter(s => s.presentInOlder && !s.presentInNewer).map(s => s.student),
    progressAdded: 0, progressRemoved: 0, progressChanged: 0,
    srsAdded: 0, srsRemoved: 0, srsChanged: 0,
    sessionsAdded: 0, sessionsRemoved: 0, sessionsChanged: 0, sessionRegressions: 0,
    examsAdded: 0, examsRemoved: 0,
    examDocsAdded: 0, examDocsRemoved: 0
  };
  for (const s of students) {
    totals.progressAdded += s.progress.added.length;
    totals.progressRemoved += s.progress.removed.length;
    totals.progressChanged += s.progress.changed.length;
    totals.srsAdded += s.srs.added.length;
    totals.srsRemoved += s.srs.removed.length;
    totals.srsChanged += s.srs.changed.length;
    totals.sessionsAdded += s.sessions.added.length;
    totals.sessionsRemoved += s.sessions.removed.length;
    totals.sessionsChanged += s.sessions.changed.length;
    totals.sessionRegressions += s.sessionRegressions.length;
    totals.examsAdded += s.exams.added.length;
    totals.examsRemoved += s.exams.removed.length;
    totals.examDocsAdded += s.examDocs.added.length;
    totals.examDocsRemoved += s.examDocs.removed.length;
  }

  return { students, totals, older, newer };
}

/**
 * Everything that disappeared between the two snapshots, as human-readable strings.
 * This — not a count — is what `--expect-no-removals` reports and fails on.
 */
function collectRemovals(diff) {
  const removals = [];
  for (const s of diff.students) {
    if (s.presentInOlder && !s.presentInNewer) removals.push(`student '${s.student}' is absent from the newer backup entirely`);
    s.progress.removed.forEach(k => removals.push(`${s.student}: progress entry '${k}' removed`));
    s.srs.removed.forEach(k => removals.push(`${s.student}: SRS card '${k}' removed`));
    s.sessions.removed.forEach(k => removals.push(`${s.student}: session day '${k}' removed`));
    s.exams.removed.forEach(k => removals.push(`${s.student}: exam '${k}' removed from examHistory`));
    s.examDocs.removed.forEach(k => removals.push(`${s.student}: immutable exam_session doc '${k}' removed`));
    s.sessionRegressions.forEach(r => removals.push(`${s.student}: session counter went BACKWARDS — ${r}`));
  }
  return removals;
}

function fmtList(keys, maxDetail) {
  if (keys.length === 0) return '';
  const shown = keys.slice(0, maxDetail);
  const more = keys.length - shown.length;
  return `      ${shown.join(', ')}${more > 0 ? `, …and ${more} more` : ''}`;
}

function printDiff(diff, { maxDetail = DEFAULT_MAX_DETAIL, out = console.log } = {}) {
  const { older, newer, students, totals } = diff;
  out('======================================================================');
  out('WI-07 snapshot_diff — backup-to-backup difference report');
  out(`  older : ${older.filePath}`);
  out(`          version=${older.version} generatedAt=${older.generatedAt} bytes=${older.bytes} questions=${older.questionsCount === null ? 'absent (v1.0 payload)' : older.questionsCount}`);
  out(`  newer : ${newer.filePath}`);
  out(`          version=${newer.version} generatedAt=${newer.generatedAt} bytes=${newer.bytes} questions=${newer.questionsCount === null ? 'absent (v1.0 payload)' : newer.questionsCount}`);
  out(`  documents: studentAnswers ${older.studentAnswers.length} -> ${newer.studentAnswers.length}, feedback ${older.feedback.length} -> ${newer.feedback.length}`);
  out('======================================================================');

  for (const s of students) {
    const tag = !s.presentInOlder ? ' [NEW STUDENT]' : (!s.presentInNewer ? ' [MISSING FROM NEWER]' : '');
    out(`\nStudent: ${s.student}${tag}`);
    out(`  master doc bytes : ${s.masterBytesOld === null ? 'absent' : s.masterBytesOld} -> ${s.masterBytesNew === null ? 'absent' : s.masterBytesNew}`);

    const rows = [
      ['progress entries', s.progress],
      ['SRS cards', s.srs],
      ['session days', s.sessions],
      ['examHistory', s.exams],
      ['exam_session docs', s.examDocs]
    ];
    for (const [label, d] of rows) {
      out(`  ${label.padEnd(18)}: ${d.oldCount} -> ${d.newCount}   +${d.added.length} added, -${d.removed.length} removed, ~${d.changed.length} changed`);
      if (d.added.length) { out(`    added:`); out(fmtList(d.added, maxDetail)); }
      if (d.removed.length) { out(`    REMOVED:`); out(fmtList(d.removed, maxDetail)); }
      if (d.changed.length) { out(`    changed:`); out(fmtList(d.changed, maxDetail)); }
    }
    if (s.sessionRegressions.length) {
      out('    SESSION COUNTERS WENT BACKWARDS:');
      s.sessionRegressions.forEach(r => out(`      ${r}`));
    }
  }

  out('\n----------------------------------------------------------------------');
  out('Summary');
  out(`  students          : ${students.length} seen  (added: ${totals.studentsAdded.length ? totals.studentsAdded.join(', ') : 'none'}; removed: ${totals.studentsRemoved.length ? totals.studentsRemoved.join(', ') : 'none'})`);
  out(`  progress entries  : +${totals.progressAdded} / -${totals.progressRemoved} / ~${totals.progressChanged}`);
  out(`  SRS cards         : +${totals.srsAdded} / -${totals.srsRemoved} / ~${totals.srsChanged}`);
  out(`  session days      : +${totals.sessionsAdded} / -${totals.sessionsRemoved} / ~${totals.sessionsChanged}  (counter regressions: ${totals.sessionRegressions})`);
  out(`  examHistory       : +${totals.examsAdded} / -${totals.examsRemoved}`);
  out(`  exam_session docs : +${totals.examDocsAdded} / -${totals.examDocsRemoved}`);
  out('----------------------------------------------------------------------');
}

function parseArgs(argv) {
  const files = [];
  let expectNoRemovals = false;
  let maxDetail = DEFAULT_MAX_DETAIL;
  for (const a of argv) {
    if (a === '--expect-no-removals') expectNoRemovals = true;
    else if (a.startsWith('--max-detail=')) maxDetail = Math.max(1, parseInt(a.split('=')[1], 10) || DEFAULT_MAX_DETAIL);
    else if (a.startsWith('--')) throw new Error(`Unknown flag '${a}'`);
    else files.push(a);
  }
  if (files.length !== 2) {
    throw new Error('Usage: node tests/integrity/snapshot_diff.js <older.json> <newer.json> [--expect-no-removals] [--max-detail=N]');
  }
  return { olderPath: files[0], newerPath: files[1], expectNoRemovals, maxDetail };
}

function main(argv) {
  const { olderPath, newerPath, expectNoRemovals, maxDetail } = parseArgs(argv);
  const older = loadBackup(olderPath);
  const newer = loadBackup(newerPath);

  if (older.generatedAt && newer.generatedAt && new Date(older.generatedAt) > new Date(newer.generatedAt)) {
    console.log(`⚠️  NOTE: the first file (${path.basename(olderPath)}, ${older.generatedAt}) was generated AFTER the second ` +
      `(${path.basename(newerPath)}, ${newer.generatedAt}). Arguments are <older> <newer>; the report below treats them in the order given.`);
  }

  const diff = buildDiff(older, newer);
  printDiff(diff, { maxDetail });

  const removals = collectRemovals(diff);
  if (expectNoRemovals) {
    if (removals.length === 0) {
      console.log(`\n✓ --expect-no-removals: nothing present in the older snapshot is missing from the newer one (growth only).`);
      console.log('SNAPSHOT_DIFF_NO_REMOVALS_OK');
      return 0;
    }
    console.log(`\n✗ --expect-no-removals FAILED: ${removals.length} removal(s) detected.`);
    removals.forEach(r => console.log(`    - ${r}`));
    console.log('SNAPSHOT_DIFF_REMOVALS_DETECTED');
    return 1;
  }
  if (removals.length) {
    console.log(`\n⚠️  ${removals.length} removal(s) detected (run with --expect-no-removals to make this a hard failure).`);
    removals.slice(0, maxDetail).forEach(r => console.log(`    - ${r}`));
    if (removals.length > maxDetail) console.log(`    …and ${removals.length - maxDetail} more`);
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`❌ snapshot_diff.js: ${err.message}`);
    process.exit(2);
  }
}

module.exports = { loadBackup, indexByStudent, diffMaps, buildDiff, collectRemovals, printDiff, stable, main };
