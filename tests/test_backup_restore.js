const assert = require('assert');
const { extractBackupDocuments, validateBackupPayload } = require('../scripts/restore_cosmos.js');

console.log('Testing Cosmos DB Backup & Restore Safeguards...');

// 1. Azure Function payload format ({ studentAnswers, feedback })
const azureFuncPayload = {
  backupMetadata: { generatedAt: '2026-08-28T22:00:00.000Z', totalDocuments: 3 },
  studentAnswers: [
    { id: 'student_default_student', student_name: 'default_student', doc_type: 'student_master_profile' },
    { id: 'exam_default_student_123', student_name: 'default_student', doc_type: 'exam_session' }
  ],
  feedback: [
    { id: 'fb_1', student_name: 'default_student', rating: 5 }
  ]
};

const res1 = validateBackupPayload(azureFuncPayload, 'mock_azure_backup.json');
assert.strictEqual(res1.totalCount, 3);
assert.strictEqual(res1.studentDocs.length, 2);
assert.strictEqual(res1.feedbackDocs.length, 1);
assert.strictEqual(res1.studentDocs[0].id, 'student_default_student');
assert.strictEqual(res1.feedbackDocs[0].id, 'fb_1');
console.log('✓ Azure Function backup payload validation passed');

// 1b. WI-04 extended cloud payload format ({ studentAnswers, feedback, questions }).
//     The Questions container is exported for disaster recovery but MUST NOT be
//     restored into UATStudentAnswers by this script — it is a different container
//     with a different partition key. The restore path reports it and ignores it.
const extendedPayload = {
  backupMetadata: {
    generatedAt: '2026-08-29T15:30:00.000Z',
    triggerType: 'http_request',
    database: 'psat-prep-db',
    totalDocuments: 6,
    studentAnswersCount: 2,
    feedbackCount: 1,
    questionsCount: 3,
    version: '1.1'
  },
  studentAnswers: [
    { id: 'student_default_student', student_name: 'default_student', doc_type: 'student_master_profile' },
    { id: 'exam_default_student_123', student_name: 'default_student', doc_type: 'exam_session' }
  ],
  feedback: [
    { id: 'fb_1', category: 'bug', message: 'x' }
  ],
  questions: [
    { id: 'q_ela_001', domain: 'Information and Ideas' },
    { id: 'q_math_001', domain: 'Algebra' },
    { id: 'q_math_002', domain: 'Geometry and Trigonometry' }
  ]
};

const ext = extractBackupDocuments(extendedPayload);
assert.strictEqual(ext.studentDocs.length, 2, 'Extended payload must yield exactly the 2 student docs');
assert.strictEqual(ext.feedbackDocs.length, 1, 'Extended payload must yield exactly the 1 feedback doc');
assert.strictEqual(ext.questionDocs.length, 3, 'Extended payload must report the questions array separately');
assert.ok(
  !ext.studentDocs.some(d => String(d.id).startsWith('q_')),
  'Question documents must NEVER leak into the UATStudentAnswers restore set'
);
assert.ok(
  !ext.feedbackDocs.some(d => String(d.id).startsWith('q_')),
  'Question documents must NEVER leak into the UATFeedback restore set'
);

const extValidated = validateBackupPayload(extendedPayload, 'mock_extended_backup.json');
assert.strictEqual(extValidated.totalCount, 3, 'Restorable count must be student+feedback only (3), not 6');
assert.strictEqual(extValidated.questionDocs.length, 3);
assert.strictEqual(extValidated.questionsIgnoredCount, 3, 'Ignored question count must be reported, not silently dropped');
console.log('✓ WI-04 extended payload: questions reported and excluded from the restore set');

// 1c. Old-format payloads (no questions key) stay restorable and report 0 questions.
const oldFormatCheck = extractBackupDocuments(azureFuncPayload);
assert.strictEqual(oldFormatCheck.questionDocs.length, 0);
assert.strictEqual(validateBackupPayload(azureFuncPayload, 'old.json').questionsIgnoredCount, 0);
console.log('✓ Old-format (pre-WI-04) backups remain restorable with 0 questions reported');

// 1d. A questions-only payload has nothing restorable and must still hard-fail,
//     rather than "succeeding" with 3,059 questions written into the wrong container.
assert.throws(() => {
  validateBackupPayload({ questions: [{ id: 'q_math_001', domain: 'Algebra' }] }, 'questions_only.json');
}, /Hard Failure: 0 valid documents found/, 'A questions-only payload must hard-fail, never restore into UATStudentAnswers');
console.log('✓ Questions-only payload hard-fails instead of restoring into the wrong container');

// 2. CLI payload format ({ documents })
const cliPayload = {
  backupMetadata: { generatedAt: '2026-08-28T22:00:00.000Z', documentCount: 2 },
  documents: [
    { id: 'student_default_student', student_name: 'default_student' },
    { id: 'exam_default_student_456', student_name: 'default_student' }
  ]
};

const res2 = validateBackupPayload(cliPayload, 'mock_cli_backup.json');
assert.strictEqual(res2.totalCount, 2);
assert.strictEqual(res2.studentDocs.length, 2);
assert.strictEqual(res2.feedbackDocs.length, 0);
console.log('✓ CLI backup payload validation passed');

// 3. Array of documents format
const arrayPayload = [
  { id: 'student_default_student', student_name: 'default_student' }
];
const res3 = validateBackupPayload(arrayPayload, 'mock_array.json');
assert.strictEqual(res3.totalCount, 1);
assert.strictEqual(res3.studentDocs[0].id, 'student_default_student');
console.log('✓ Direct array payload validation passed');

// 4. Hard failure on 0 valid documents
assert.throws(() => {
  validateBackupPayload({}, 'empty.json');
}, /Hard Failure: 0 valid documents found/, 'Empty object must cause hard failure');

assert.throws(() => {
  validateBackupPayload({ studentAnswers: [] }, 'empty_answers.json');
}, /Hard Failure: 0 valid documents found/, 'Empty answers array must cause hard failure');

assert.throws(() => {
  validateBackupPayload({ documents: [{ invalid_no_id: true }] }, 'invalid_docs.json');
}, /Hard Failure: 0 valid documents found/, 'Documents without ID must cause hard failure');
console.log('✓ Zero-document hard failure safety guard verified');

// 5. Pre-restore snapshot validation guard
assert.throws(() => {
  validateBackupPayload(null, 'null.json');
}, /Hard Failure: 0 valid documents found/, 'Null payload must cause hard failure');

// 6. SHA-256 Checksum Integrity Tests
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verifyBackupIntegrity } = require('../scripts/restore_cosmos.js');

const tmpDir = path.join(__dirname, 'tmp_test_backup');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const testPayload = JSON.stringify(azureFuncPayload, null, 2);
const testFile = path.join(tmpDir, 'test_backup.json');
const testSidecar = path.join(tmpDir, 'test_backup.json.sha256');

fs.writeFileSync(testFile, testPayload, 'utf8');
const expectedSha = crypto.createHash('sha256').update(Buffer.from(testPayload, 'utf8')).digest('hex');
fs.writeFileSync(testSidecar, `${expectedSha}  test_backup.json\n`, 'utf8');

// 6A. Valid checksum passes
const validCheck = verifyBackupIntegrity(testFile, testPayload, azureFuncPayload);
assert.strictEqual(validCheck.verified, true);
assert.strictEqual(validCheck.sha256, expectedSha);
console.log('✓ Valid SHA-256 sidecar checksum verified');

// 6B. Corrupted / Tampered content causes hard failure
const tamperedPayload = testPayload + '\n/* tampered */';
assert.throws(() => {
  verifyBackupIntegrity(testFile, tamperedPayload, azureFuncPayload);
}, /Checksum verification failed/, 'Tampered backup must throw hard failure error');
console.log('✓ Tampered backup checksum mismatch hard failure verified');

// Clean up tmp test files
fs.unlinkSync(testFile);
fs.unlinkSync(testSidecar);
fs.rmdirSync(tmpDir);

console.log('✓ All Cloud Backup & Restore Safeguard and Checksum Integrity unit tests passed!\n');
