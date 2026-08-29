/**
 * tests/test_backup_cli.js
 *
 * Tests scripts/backup_cosmos.js against an injected fake Cosmos client (no network,
 * no real Cosmos account touched). Verifies:
 *  1. The payload shape matches the version 1.0 backup format, against a hand-written
 *     expected object (never produced by calling the function under test). Note: since
 *     WI-04 the cloud function emits version 1.1 with an extra `questions` array; the
 *     shared fields asserted here are unchanged and restore_cosmos.js accepts both.
 *  2. The sha256 sidecar format ("<hex>  <filename>\n") and value, where the expected
 *     hash is computed independently in this test from a hand-built payload string.
 *  3. The zero-document abort guard on UATStudentAnswers: refuses (throws) and writes
 *     no files.
 *
 * Fixture: 2 student docs, 1 feedback doc, fixed timestamp.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  runBackupWithDatabase,
  buildBackupPayload,
  assertNonEmptyStudentDocs
} = require('../scripts/backup_cosmos.js');

console.log('Testing backup_cosmos.js CLI payload construction...');

// ---------------------------------------------------------------------------
// Fixture: hand-written, not derived from any code under test.
// ---------------------------------------------------------------------------
const FIXED_NOW = new Date('2026-08-29T12:00:00.000Z');
const DB_NAME = 'psat-prep-db';
const TRIGGER_TYPE = 'local_cli';

const studentDocs = [
  { id: 'student_default_student', student_name: 'default_student', doc_type: 'student_master_profile', progress: { q1: { isCorrect: true } } },
  { id: 'exam_default_student_20260101T000000000Z', student_name: 'default_student', doc_type: 'exam_session', examId: 'exam_1' }
];
const feedbackDocs = [
  { id: 'fb_1', student_name: 'default_student', rating: 5, comment: 'great app' }
];

// Hand-built expected payload structure -- the version 1.0 format. This is NOT produced by calling
// buildBackupPayload(); it is typed out independently so the test can catch a
// regression in that function.
const expectedPayload = {
  backupMetadata: {
    generatedAt: '2026-08-29T12:00:00.000Z',
    triggerType: 'local_cli',
    database: 'psat-prep-db',
    totalDocuments: 3,
    studentAnswersCount: 2,
    feedbackCount: 1,
    version: '1.0'
  },
  studentAnswers: studentDocs,
  feedback: feedbackDocs
};

// Expected serialized string + sha256, computed independently here with node crypto
// over the hand-built object above -- never by calling the code under test.
const expectedPayloadString = JSON.stringify(expectedPayload, null, 2);
const expectedSha256 = crypto.createHash('sha256').update(Buffer.from(expectedPayloadString, 'utf8')).digest('hex');
const expectedBackupFilename = 'cosmos_backup_2026-08-29T12-00-00-000Z.json';
const expectedSidecarContent = `${expectedSha256}  ${expectedBackupFilename}\n`;

// ---------------------------------------------------------------------------
// Fake Cosmos client: injected dependency, not a monkeypatch of module internals.
// ---------------------------------------------------------------------------
function makeFakeDatabase({ students, feedback, feedbackThrows = false }) {
  return {
    container(name) {
      if (name === 'UATStudentAnswers') {
        return { items: { query: () => ({ fetchAll: async () => ({ resources: students }) }) } };
      }
      if (name === 'UATFeedback') {
        if (feedbackThrows) {
          return { items: { query: () => ({ fetchAll: async () => { throw new Error('simulated connection error'); } }) } };
        }
        return { items: { query: () => ({ fetchAll: async () => ({ resources: feedback }) }) } };
      }
      throw new Error(`Unexpected container requested: ${name}`);
    }
  };
}

const tmpDir = path.join(__dirname, 'tmp_test_backup_cli');
function freshTmpDir() {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

async function testPayloadShapeAndChecksum() {
  const backupDir = freshTmpDir();
  const fakeDb = makeFakeDatabase({ students: studentDocs, feedback: feedbackDocs });

  const result = await runBackupWithDatabase(fakeDb, {
    dbName: DB_NAME,
    triggerType: TRIGGER_TYPE,
    backupDir,
    now: FIXED_NOW,
    log: () => {},
    warn: () => {}
  });

  // Structural equality against the hand-written expectation.
  assert.deepStrictEqual(result.payload, expectedPayload, 'payload must match hand-written expected structure');

  // Counts (redundant with deepStrictEqual above, but explicit per the spec).
  assert.strictEqual(result.payload.backupMetadata.studentAnswersCount, 2);
  assert.strictEqual(result.payload.backupMetadata.feedbackCount, 1);
  assert.strictEqual(result.payload.backupMetadata.totalDocuments, 3);
  assert.strictEqual(result.payload.backupMetadata.triggerType, 'local_cli');
  assert.strictEqual(result.payload.backupMetadata.version, '1.0');

  // sha256 must match the independently-computed expectation.
  assert.strictEqual(result.sha256, expectedSha256, 'sha256 must match independently computed hash of hand-built payload');

  // Files actually on disk: main file, sidecar, and latest pointers.
  const writtenFile = path.join(backupDir, expectedBackupFilename);
  assert.ok(fs.existsSync(writtenFile), `expected backup file ${writtenFile} to exist`);
  const writtenString = fs.readFileSync(writtenFile, 'utf8');
  assert.strictEqual(writtenString, expectedPayloadString, 'written file bytes must match hand-built expected string');

  const sidecarFile = `${writtenFile}.sha256`;
  assert.ok(fs.existsSync(sidecarFile), `expected sidecar ${sidecarFile} to exist`);
  const sidecarContent = fs.readFileSync(sidecarFile, 'utf8');
  assert.strictEqual(sidecarContent, expectedSidecarContent, 'sidecar must be "<sha256>  <filename>\\n" with two spaces');

  const latestFile = path.join(backupDir, 'cosmos_backup_latest.json');
  const latestSidecar = path.join(backupDir, 'cosmos_backup_latest.json.sha256');
  assert.ok(fs.existsSync(latestFile), 'latest pointer file must exist');
  assert.ok(fs.existsSync(latestSidecar), 'latest sidecar pointer must exist');
  assert.strictEqual(fs.readFileSync(latestFile, 'utf8'), expectedPayloadString, 'latest pointer must be byte-identical to timestamped backup');
  assert.strictEqual(fs.readFileSync(latestSidecar, 'utf8'), expectedSidecarContent, 'latest sidecar pointer must match');

  console.log('✓ Payload shape, sha256, and sidecar format match hand-written expectations');
}

async function testUATFeedbackFetchedAndToleratesFailure() {
  const backupDir = freshTmpDir();

  // 1. Normal path: UATFeedback is actually queried (this is the fetch the CLI
  //    previously lacked) -- prove it by returning a non-empty feedback array and
  //    checking it lands in the payload.
  const fakeDbWithFeedback = makeFakeDatabase({ students: studentDocs, feedback: feedbackDocs });
  const result = await runBackupWithDatabase(fakeDbWithFeedback, {
    dbName: DB_NAME, triggerType: TRIGGER_TYPE, backupDir, now: FIXED_NOW, log: () => {}, warn: () => {}
  });
  assert.strictEqual(result.feedbackDocsCount, 1, 'UATFeedback container must actually be queried');

  // 2. Failure path: UATFeedback container throws (simulated connection error). The
  //    backup must not crash (feedback is optional / may be empty), but the failure
  //    must be reported, not silently swallowed.
  const backupDir2 = freshTmpDir();
  const fakeDbFeedbackFails = makeFakeDatabase({ students: studentDocs, feedback: [], feedbackThrows: true });
  let warnedMessage = null;
  const result2 = await runBackupWithDatabase(fakeDbFeedbackFails, {
    dbName: DB_NAME, triggerType: TRIGGER_TYPE, backupDir: backupDir2, now: FIXED_NOW,
    log: () => {}, warn: (msg) => { warnedMessage = msg; }
  });
  assert.strictEqual(result2.feedbackDocsCount, 0, 'feedback count must be 0 when the container errors');
  assert.ok(warnedMessage && /simulated connection error/.test(warnedMessage), 'a real UATFeedback connection error must be reported via warn(), not swallowed silently');

  console.log('✓ UATFeedback is fetched, and a real fetch failure is reported rather than swallowed');
}

async function testZeroDocumentGuardRefusesAndWritesNoFiles() {
  const backupDir = freshTmpDir();
  const fakeDbEmpty = makeFakeDatabase({ students: [], feedback: [] });

  let threw = false;
  try {
    await runBackupWithDatabase(fakeDbEmpty, {
      dbName: DB_NAME, triggerType: TRIGGER_TYPE, backupDir, now: FIXED_NOW, log: () => {}, warn: () => {}
    });
  } catch (e) {
    threw = true;
    assert.match(e.message, /0 documents/, 'error message must explain the zero-document refusal');
  }
  assert.strictEqual(threw, true, 'zero student documents must cause a thrown error (nonzero exit at the CLI)');

  // No files should have been written for this abort.
  const entries = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
  assert.strictEqual(entries.length, 0, 'zero-document guard must write no files at all');

  // Direct unit check on the guard helper itself, per the CLAUDE.md pattern reused
  // from api/src/functions/backup.js.
  assert.throws(() => assertNonEmptyStudentDocs([], 'UATStudentAnswers'), /0 documents from UATStudentAnswers/);
  assert.doesNotThrow(() => assertNonEmptyStudentDocs([{ id: 'x' }], 'UATStudentAnswers'));

  console.log('✓ Zero-document abort guard refuses and writes no files');
}

async function main() {
  await testPayloadShapeAndChecksum();
  await testUATFeedbackFetchedAndToleratesFailure();
  await testZeroDocumentGuardRefusesAndWritesNoFiles();

  // Cleanup.
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('✓ All backup_cosmos.js CLI tests passed!\n');
}

main().catch(err => {
  console.error('FAILED:', err);
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
