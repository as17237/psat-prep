#!/usr/bin/env node
/**
 * scripts/migration_proof.js — WI-18(d) v1->v2 migration reconciliation proof.
 *
 * Proves the WI-11 local schema migration (PSAT_ENGINE.migrateLocalStateToV2)
 * preserves EVERY record: nothing is dropped, no category shrinks, and every
 * question / card / exam present before the migration is present after. It prints
 * per-category counts (before/after) and a mismatch count that MUST be 0.
 *
 * It is pure and offline: it loads a state snapshot into an in-memory store,
 * runs the real migration against that store, and reconciles. It NEVER touches
 * the network, localStorage, or any file except the one you point it at to read.
 *
 * Usage:
 *   node scripts/migration_proof.js --self-test
 *       Synthesises a realistic v1 snapshot (406 progress / 392 SRS / 9 exams),
 *       migrates + reconciles. Use this to prove the reconciliation logic itself,
 *       with no live data. Runs in CI-friendly isolation.
 *
 *   node scripts/migration_proof.js <cloud_dump.json>
 *       Reconciles a REAL default_student snapshot. Produce the dump by pulling
 *       the cloud doc read-only (see WI-18b, ?readonly=1) and saving its
 *       { progress, srsState, sessionsState, examHistory } to a JSON file. This
 *       script only READS that file; it writes nothing back anywhere.
 *
 * Exit 0 iff migration succeeded AND every category reconciles with 0 mismatches.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const PSAT_ENGINE = require(path.join(__dirname, '..', 'srs.js'));

// --- in-memory localStorage shim (production lane: no prefix) ----------------
function makeStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _dump: () => Object.fromEntries(map),
  };
}

// Accept several key spellings so a raw cloud doc or a hand-made dump both work.
function pick(obj, names, fallback) {
  for (const n of names) if (obj && obj[n] !== undefined && obj[n] !== null) return obj[n];
  return fallback;
}

function loadSource(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const doc = raw.document || raw.doc || raw; // tolerate a wrapped cloud response
  return {
    progress: pick(doc, ['progress', 'psat_progress'], {}),
    srs: pick(doc, ['srsState', 'srs', 'psat_srs'], {}),
    sessions: pick(doc, ['sessionsState', 'sessions', 'psat_sessions'], {}),
    exams: pick(doc, ['examHistory', 'exam_history', 'psat_exam_history'], []),
  };
}

function synthesizeV1(nProgress, nSrs, nExams) {
  const progress = {};
  for (let i = 0; i < nProgress; i++) {
    const id = 'q' + String(i).padStart(5, '0');
    progress[id] = { answered: true, isCorrect: i % 3 !== 0, selectedAnswer: 'A', timeSpentMs: 30000, timestamp: 1700000000000 + i };
  }
  // v1-shaped SRS cards (pre-envelope): the migration upgrades their shape but
  // must keep every id.
  const srs = {};
  for (let i = 0; i < nSrs; i++) {
    const id = 'q' + String(i).padStart(5, '0');
    srs[id] = { questionId: id, repetitions: (i % 4), intervalDays: 1 + (i % 7), easeFactor: 2.5, dueAt: 1700000000000 + i * 86400000, history: [{ at: 1700000000000, grade: 4 }] };
  }
  const exams = [];
  for (let i = 0; i < nExams; i++) {
    exams.push({ examId: 'exam_' + i, type: i % 2 ? 'mini_psat89' : 'standard_psat89', completedAt: 1700000000000 + i, totalQuestions: 8, totalCorrect: 5 });
  }
  return { progress, srs, sessions: {}, exams };
}

function idsOf(objOrArr, idKey) {
  if (Array.isArray(objOrArr)) return objOrArr.map((e, i) => (e && e[idKey] != null ? String(e[idKey]) : 'idx_' + i));
  return Object.keys(objOrArr || {});
}

// Reconcile one category: every "before" id must still be present "after".
function reconcile(label, before, after, idKey) {
  const b = idsOf(before, idKey);
  const a = new Set(idsOf(after, idKey));
  const missing = b.filter((id) => !a.has(id));
  return { label, before: b.length, after: a.size, missing };
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: node scripts/migration_proof.js (--self-test | <cloud_dump.json>)');
    process.exit(2);
  }

  const src = arg === '--self-test' ? synthesizeV1(406, 392, 9) : loadSource(arg);
  const mode = arg === '--self-test' ? 'self-test (synthetic v1)' : `file ${arg}`;

  const store = makeStore();
  store.setItem('psat_progress', JSON.stringify(src.progress));
  store.setItem('psat_srs', JSON.stringify(src.srs));
  store.setItem('psat_sessions', JSON.stringify(src.sessions));
  store.setItem('psat_exam_history', JSON.stringify(src.exams));

  const before = PSAT_ENGINE.readSchemaMeta(store);
  const report = PSAT_ENGINE.migrateLocalStateToV2(store);
  const after = PSAT_ENGINE.readSchemaMeta(store);

  const outProgress = JSON.parse(store.getItem('psat_progress') || '{}');
  const outSrs = JSON.parse(store.getItem('psat_srs') || '{}');
  const outExams = JSON.parse(store.getItem('psat_exam_history') || '[]');

  const cats = [
    reconcile('progress', src.progress, outProgress),
    reconcile('srs     ', src.srs, outSrs),
    reconcile('exams   ', src.exams, outExams, 'examId'),
  ];

  console.log(`\nWI-18 migration proof — source: ${mode}`);
  console.log(`schemaVersion: ${before.schemaVersion} -> ${after.schemaVersion}  (migrated=${report.migrated}, alreadyV2=${report.alreadyV2}, cardsUpgraded=${report.cardsUpgraded}, eventsTrimmed=${report.eventsTrimmed})`);
  let totalMismatch = 0;
  cats.forEach((c) => {
    totalMismatch += c.missing.length;
    console.log(`  ${c.label}  ${String(c.before).padStart(5)} / ${String(c.after).padStart(5)}   mismatches ${c.missing.length}` + (c.missing.length ? `  MISSING: ${c.missing.slice(0, 10).join(',')}${c.missing.length > 10 ? '…' : ''}` : ''));
  });

  const ok = report.success && !report.error && after.schemaVersion === 2 && totalMismatch === 0;
  if (ok) {
    console.log('MIGRATION_PROOF_OK — 0 mismatches, schemaVersion 2, all records preserved.\n');
    process.exit(0);
  }
  console.error(`MIGRATION_PROOF_FAILED — mismatches=${totalMismatch}, error=${report.error || 'none'}, schemaVersion=${after.schemaVersion}\n`);
  process.exit(1);
}

if (require.main === module) main();

// Exported for tests/test_migration_proof.js (the reconciliation logic is the
// safety-critical part and must be red-demonstrable on a clean clone).
module.exports = { makeStore, synthesizeV1, idsOf, reconcile, loadSource };
