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
