#!/usr/bin/env node
/**
 * scripts/restore_cosmos.js
 * Restores a snapshot JSON backup into Azure Cosmos DB with safety safeguards:
 * 1. Supports both Azure Function format ({ studentAnswers, feedback }) and CLI format ({ documents }).
 * 2. Strict validation: Fails with a hard error if 0 valid documents are present.
 * 3. Dry-run mode by default; requires explicit --apply flag for database writes.
 * 4. Automatic pre-restore snapshot: Captures live database state before modifying any document.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const crypto = require('crypto');

/**
 * Verifies SHA-256 integrity against sidecar file (.sha256) or metadata checksum.
 */
function verifyBackupIntegrity(backupPath, rawContent, parsed) {
  const fileBuffer = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(String(rawContent), 'utf8');
  const actualSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex').toLowerCase();

  let expectedSha256 = null;
  let source = null;

  const sidecarPath = `${backupPath}.sha256`;
  if (fs.existsSync(sidecarPath)) {
    const sidecarContent = fs.readFileSync(sidecarPath, 'utf8').trim();
    expectedSha256 = sidecarContent.split(/\s+/)[0].toLowerCase();
    source = `sidecar (${path.basename(sidecarPath)})`;
  } else if (parsed && parsed.backupMetadata && parsed.backupMetadata.sha256) {
    expectedSha256 = String(parsed.backupMetadata.sha256).toLowerCase();
    source = 'backupMetadata.sha256';
  }

  if (expectedSha256) {
    if (actualSha256 !== expectedSha256) {
      throw new Error(`❌ Hard Failure: Checksum verification failed for backup (${backupPath}). Expected ${expectedSha256} from ${source}, but computed ${actualSha256}. Backup is corrupted or tampered. Aborting restore.`);
    }
    return { verified: true, sha256: actualSha256, source: source };
  }

  return { verified: false, sha256: actualSha256, source: 'none' };
}

/**
 * Extracts and categorizes documents from various backup payload formats.
 *
 * Formats accepted:
 *   - v1.1 cloud (WI-04): { studentAnswers: [...], feedback: [...], questions: [...] }
 *   - v1.0 cloud:         { studentAnswers: [...], feedback: [...] }
 *   - local CLI:          { documents: [...] }
 *   - bare array / single document object
 *
 * `questions` is REPORTED but never restored: the Questions container has a different
 * partition key (/domain) and is a write-only mirror of data/questions_data.js. Restoring
 * it into UATStudentAnswers would corrupt the student container, so it is deliberately
 * excluded from studentDocs/feedbackDocs here.
 */
function extractBackupDocuments(parsed) {
  const empty = { studentDocs: [], feedbackDocs: [], questionDocs: [] };
  if (!parsed || typeof parsed !== 'object') {
    return empty;
  }
  if (Array.isArray(parsed)) {
    return { studentDocs: parsed, feedbackDocs: [], questionDocs: [] };
  }
  const questionDocs = Array.isArray(parsed.questions) ? parsed.questions : [];
  // Azure Function backup format: { studentAnswers: [...], feedback: [...], questions?: [...] }
  if (parsed.studentAnswers || parsed.feedback || parsed.questions) {
    return {
      studentDocs: Array.isArray(parsed.studentAnswers) ? parsed.studentAnswers : [],
      feedbackDocs: Array.isArray(parsed.feedback) ? parsed.feedback : [],
      questionDocs: questionDocs
    };
  }
  // CLI backup format: { documents: [...] }
  if (parsed.documents && Array.isArray(parsed.documents)) {
    return { studentDocs: parsed.documents, feedbackDocs: [], questionDocs: questionDocs };
  }
  // Single document object: { id: "...", ... }
  if (parsed.id) {
    return { studentDocs: [parsed], feedbackDocs: [], questionDocs: questionDocs };
  }
  return empty;
}

/**
 * Validates backup content and returns sanitized list of valid documents.
 * Throws a hard error if zero valid documents are found.
 */
function validateBackupPayload(parsed, backupPath) {
  const { studentDocs, feedbackDocs, questionDocs } = extractBackupDocuments(parsed);
  const validStudentDocs = studentDocs.filter(d => d && typeof d === 'object' && d.id);
  const validFeedbackDocs = feedbackDocs.filter(d => d && typeof d === 'object' && d.id);
  // Questions are counted for reporting only; they are NOT restorable by this script and
  // therefore never contribute to the zero-document hard-failure guard.
  const validQuestionDocs = questionDocs.filter(d => d && typeof d === 'object' && d.id);
  const totalValidDocs = validStudentDocs.length + validFeedbackDocs.length;

  if (totalValidDocs === 0) {
    throw new Error(`❌ Hard Failure: 0 valid documents found in backup (${backupPath || 'unknown'}). Aborting restore.`);
  }

  return {
    studentDocs: validStudentDocs,
    feedbackDocs: validFeedbackDocs,
    questionDocs: validQuestionDocs,
    questionsIgnoredCount: validQuestionDocs.length,
    totalCount: totalValidDocs
  };
}

/**
 * Captures an automated pre-restore safety snapshot of the live database.
 */
async function createPreRestoreSnapshot(client, dbName, snapshotDir) {
  console.log('\n--- Creating Automated Pre-Restore Safety Snapshot ---');
  const database = client.database(dbName);
  const answersContainer = database.container('UATStudentAnswers');
  
  let liveDocs = [];
  try {
    const { resources } = await answersContainer.items.query('SELECT * FROM c').fetchAll();
    liveDocs = resources || [];
  } catch (err) {
    throw new Error(`Failed to query live container for pre-restore snapshot: ${err.message}`);
  }

  const now = new Date();
  const timestampStr = now.toISOString().replace(/[:.]/g, '-');
  const targetDir = snapshotDir || path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const snapshotFile = path.join(targetDir, `pre_restore_snapshot_${timestampStr}.json`);
  const snapshotPayload = {
    snapshotMetadata: {
      generatedAt: now.toISOString(),
      reason: 'pre_restore_safety_backup',
      database: dbName,
      documentCount: liveDocs.length
    },
    documents: liveDocs
  };

  try {
    fs.writeFileSync(snapshotFile, JSON.stringify(snapshotPayload, null, 2), 'utf8');
    console.log(`✓ Pre-restore snapshot safely saved to: ${snapshotFile} (${liveDocs.length} live documents)`);
    return snapshotFile;
  } catch (writeErr) {
    throw new Error(`Failed to write pre-restore safety snapshot to disk: ${writeErr.message}. Aborting restore.`);
  }
}

async function runRestore(specifiedFile, options = {}) {
  console.log('--- Starting Azure Cosmos DB Restore ---');

  const backupPath = specifiedFile || path.join(__dirname, '..', 'backups', 'cosmos_backup_latest.json');
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found at: ${backupPath}`);
  }

  console.log(`Reading backup file from: ${backupPath}...`);
  const raw = fs.readFileSync(backupPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Malformed JSON in backup file (${backupPath}): ${e.message}`);
  }

  // 1. SHA-256 Checksum Integrity Verification
  const integrity = verifyBackupIntegrity(backupPath, raw, parsed);
  if (integrity.verified) {
    console.log(`✓ Integrity Verified: SHA-256 checksum matched via ${integrity.source} (${integrity.sha256.substring(0, 16)}...)`);
  } else {
    console.log(`ℹ️  Note: No SHA-256 sidecar or manifest found for this backup file. Computed SHA-256: ${integrity.sha256.substring(0, 16)}...`);
  }

  // 2. Strict validation (Hard Failure if 0 valid documents)
  const validation = validateBackupPayload(parsed, backupPath);
  const { studentDocs, feedbackDocs, totalCount, questionsIgnoredCount } = validation;

  if (questionsIgnoredCount > 0) {
    console.log(`ℹ️  Backup also contains ${questionsIgnoredCount} Questions-container documents. They are NOT restored by this script (different container, partition key /domain) — reported only.`);
  }

  const isApply = options.apply || process.argv.includes('--apply');

  if (!isApply) {
    console.log(`\n[DRY RUN MODE] Verified backup snapshot containing ${totalCount} valid restorable documents:`);
    console.log(`  - Student Answers / Profiles: ${studentDocs.length}`);
    console.log(`  - Feedback Documents: ${feedbackDocs.length}`);
    console.log(`  - Questions (reported, not restored): ${questionsIgnoredCount}`);
    studentDocs.slice(0, 10).forEach(doc => {
      console.log(`    • [StudentAnswers] ID: ${doc.id} (type: ${doc.doc_type || 'unknown'}, partition: ${doc.student_name || 'n/a'})`);
    });
    if (studentDocs.length > 10) {
      console.log(`    • ... and ${studentDocs.length - 10} more student documents`);
    }
    feedbackDocs.forEach(doc => {
      console.log(`    • [Feedback] ID: ${doc.id}`);
    });
    console.log('\n✓ Dry-run validation PASSED. Zero database writes were executed.');
    console.log('⚠️  To perform the live restore with automated pre-restore safety snapshot, run:');
    console.log(`   node scripts/restore_cosmos.js ${specifiedFile ? specifiedFile + ' ' : ''}--apply\n`);
    return { dryRun: true, totalCount, studentDocs: studentDocs.length, feedbackDocs: feedbackDocs.length, questionsIgnored: questionsIgnoredCount };
  }

  // 2. Obtain Cosmos DB Credentials
  let key = process.env.COSMOS_KEY;
  if (!key) {
    try {
      key = execSync('az cosmosdb keys list --name psat-cosmos-15958 --resource-group rg-psat-prep --query primaryMasterKey -o tsv').toString().trim();
    } catch (e) {
      throw new Error(`Error fetching Cosmos DB key from Azure CLI: ${e.message}`);
    }
  }

  const endpoint = process.env.COSMOS_ENDPOINT || 'https://psat-cosmos-15958.documents.azure.com:443/';
  const dbName = process.env.COSMOS_DB_NAME || 'psat-prep-db';

  const { CosmosClient } = require(options.cosmosClientPath || '../api/node_modules/@azure/cosmos');
  const client = new CosmosClient({ endpoint, key });
  const database = client.database(dbName);

  // 3. Create Pre-Restore Snapshot before modifying any live state
  await createPreRestoreSnapshot(client, dbName);

  // 4. Live Upsert of Student Documents
  const answersContainer = database.container('UATStudentAnswers');
  console.log(`\nExecuting live restore of ${studentDocs.length} student documents into UATStudentAnswers...`);
  for (const doc of studentDocs) {
    await answersContainer.items.upsert(doc);
    console.log(`  ✓ Restored student doc ID: ${doc.id} (${doc.doc_type || 'profile'})`);
  }

  // 5. Live Upsert of Feedback Documents (if any)
  if (feedbackDocs.length > 0) {
    const feedbackContainer = database.container('UATFeedback');
    console.log(`\nExecuting live restore of ${feedbackDocs.length} feedback documents into UATFeedback...`);
    for (const doc of feedbackDocs) {
      await feedbackContainer.items.upsert(doc);
      console.log(`  ✓ Restored feedback doc ID: ${doc.id}`);
    }
  }

  console.log(`\n✓ Live restore complete! Total ${totalCount} documents safely restored.`);
  return { success: true, restoredCount: totalCount };
}

if (require.main === module) {
  const target = process.argv.slice(2).find(arg => arg !== '--apply');
  runRestore(target).catch(err => {
    console.error('\n' + err.message);
    process.exit(1);
  });
}

module.exports = {
  verifyBackupIntegrity,
  extractBackupDocuments,
  validateBackupPayload,
  createPreRestoreSnapshot,
  runRestore
};
