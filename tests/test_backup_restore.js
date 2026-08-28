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

console.log('✓ All Cloud Backup & Restore Safeguard unit tests passed!\n');
