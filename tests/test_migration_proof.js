/**
 * tests/test_migration_proof.js — WI-18(d).
 *
 * Guards the reconciliation logic of scripts/migration_proof.js: it must count
 * every category correctly AND actually DETECT a dropped record (a silent
 * disappearance is exactly the failure the migration proof exists to catch —
 * CLAUDE.md failure mode 5). Expected values are hand-written, not derived.
 */
const assert = require('assert');
const { synthesizeV1, reconcile } = require('../scripts/migration_proof.js');
const PSAT_ENGINE = require('../srs.js');

let checks = 0;
const eq = (a, b, m) => { assert.strictEqual(a, b, m); checks++; };

// --- 1. Happy path: a real migration preserves every record ------------------
const src = synthesizeV1(406, 392, 9);
const map = new Map();
const store = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
};
store.setItem('psat_progress', JSON.stringify(src.progress));
store.setItem('psat_srs', JSON.stringify(src.srs));
store.setItem('psat_sessions', JSON.stringify(src.sessions));
store.setItem('psat_exam_history', JSON.stringify(src.exams));

const report = PSAT_ENGINE.migrateLocalStateToV2(store);
eq(report.success, true, 'migration reports success');
eq(PSAT_ENGINE.readSchemaMeta(store).schemaVersion, 2, 'schema is v2 after migration');

const outProgress = JSON.parse(store.getItem('psat_progress'));
const outSrs = JSON.parse(store.getItem('psat_srs'));
const outExams = JSON.parse(store.getItem('psat_exam_history'));

const rp = reconcile('progress', src.progress, outProgress);
eq(rp.before, 406, 'progress before count'); eq(rp.after, 406, 'progress after count'); eq(rp.missing.length, 0, 'progress 0 missing');
const rs = reconcile('srs', src.srs, outSrs);
eq(rs.before, 392, 'srs before count'); eq(rs.after, 392, 'srs after count'); eq(rs.missing.length, 0, 'srs 0 missing');
const re = reconcile('exams', src.exams, outExams, 'examId');
eq(re.before, 9, 'exams before count'); eq(re.after, 9, 'exams after count'); eq(re.missing.length, 0, 'exams 0 missing');

// --- 2. The reconciler DETECTS a dropped record (the whole point) -------------
const dropped = { ...outProgress };
const victim = Object.keys(dropped)[0];
delete dropped[victim];
const rdrop = reconcile('progress', src.progress, dropped);
eq(rdrop.after, 405, 'dropped-case after count is one fewer');
eq(rdrop.missing.length, 1, 'exactly one record reported missing');
eq(rdrop.missing[0], victim, 'the missing record is the one that was dropped');

// --- 3. Array reconcile detects a dropped exam by examId ----------------------
const examsDrop = outExams.slice(1); // drop the first exam
const rex = reconcile('exams', src.exams, examsDrop, 'examId');
eq(rex.missing.length, 1, 'one exam reported missing');
eq(rex.missing[0], 'exam_0', 'the dropped exam is identified by examId');

console.log(`✓ migration_proof reconciliation: ${checks} checks (preserves all records; detects drops)`);
