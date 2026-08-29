#!/usr/bin/env node
/**
 * scripts/backup_cosmos.js
 * Local CLI backup utility for Azure Cosmos DB (psat-prep-db).
 * Exports UATStudentAnswers (master student profiles, SRS states, sessions, and all
 * longitudinal exam sessions) + UATFeedback documents to timestamped, checksummed JSON
 * files under backups/. Payload shape is format-identical to the cloud function's
 * performCosmosBackup() (api/src/functions/backup.js) so scripts/restore_cosmos.js
 * accepts either.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

/**
 * Fetches UATStudentAnswers and UATFeedback documents via the given Cosmos database
 * handle. `database` must expose `.container(name).items.query(sql).fetchAll()`,
 * matching the @azure/cosmos client shape (or a fake for testing).
 *
 * Mirrors api/src/functions/backup.js performCosmosBackup(): the feedback fetch is
 * wrapped in try/catch (container may not exist / may be empty) but a real failure is
 * logged, never swallowed silently. The student-answers fetch has no such guard: a
 * failure there must propagate and abort the backup.
 */
async function fetchBackupDocuments(database, { log = console.log, warn = console.error } = {}) {
  const answersContainer = database.container('UATStudentAnswers');
  const { resources: studentDocs } = await answersContainer.items.query('SELECT * FROM c').fetchAll();

  let feedbackDocs = [];
  try {
    const feedbackContainer = database.container('UATFeedback');
    const { resources: fb } = await feedbackContainer.items.query('SELECT * FROM c').fetchAll();
    feedbackDocs = fb || [];
  } catch (e) {
    warn(`⚠️  Could not fetch UATFeedback documents (continuing with 0): ${e.message}`);
  }

  return { studentDocs: studentDocs || [], feedbackDocs };
}

/**
 * Builds the backup payload object exactly as api/src/functions/backup.js
 * performCosmosBackup() does, so local and cloud backups are format-identical.
 */
function buildBackupPayload({ studentDocs, feedbackDocs, dbName, triggerType, now }) {
  return {
    backupMetadata: {
      generatedAt: now.toISOString(),
      triggerType,
      database: dbName,
      totalDocuments: studentDocs.length + feedbackDocs.length,
      studentAnswersCount: studentDocs.length,
      feedbackCount: feedbackDocs.length,
      version: '1.0'
    },
    studentAnswers: studentDocs,
    feedback: feedbackDocs
  };
}

/**
 * Applies the zero-document abort guard: refuses to proceed if UATStudentAnswers came
 * back empty, so a connection/permission problem can never silently overwrite the last
 * good backup with an empty one.
 */
function assertNonEmptyStudentDocs(studentDocs, containerName) {
  if (!Array.isArray(studentDocs) || studentDocs.length === 0) {
    throw new Error(`Backup aborted: Query returned 0 documents from ${containerName}. Refusing to overwrite latest backup.`);
  }
}

/**
 * Serializes the payload and computes its sha256 sidecar content, in the same
 * "<sha256>  <filename>\n" format (two spaces) used by the cloud function and accepted
 * by restore_cosmos.js's verifyBackupIntegrity.
 */
function serializeBackup(payload, backupFilename) {
  const payloadString = JSON.stringify(payload, null, 2);
  const payloadBuffer = Buffer.from(payloadString, 'utf8');
  const sha256 = crypto.createHash('sha256').update(payloadBuffer).digest('hex');
  const sidecarContent = `${sha256}  ${backupFilename}\n`;
  return { payloadString, payloadBuffer, sha256, sidecarContent };
}

/**
 * Fetches, validates, and writes a local backup. `database` is a Cosmos database handle
 * (real or fake, see tests/test_backup_cli.js). `deps` allows injecting fs/console for
 * tests; production defaults are the real fs module and console.
 */
async function runBackupWithDatabase(database, {
  dbName,
  triggerType = 'local_cli',
  backupDir,
  now = new Date(),
  fsImpl = fs,
  log = console.log,
  warn = console.error
} = {}) {
  log(`Connecting to ${dbName} ...`);
  const { studentDocs, feedbackDocs } = await fetchBackupDocuments(database, { log, warn });

  assertNonEmptyStudentDocs(studentDocs, 'UATStudentAnswers');
  log(`Successfully fetched ${studentDocs.length} student document(s) and ${feedbackDocs.length} feedback document(s).`);

  const payload = buildBackupPayload({ studentDocs, feedbackDocs, dbName, triggerType, now });

  const timestampStr = now.toISOString().replace(/[:.]/g, '-');
  const backupFilename = `cosmos_backup_${timestampStr}.json`;
  const backupPath = path.join(backupDir, backupFilename);
  const sidecarPath = path.join(backupDir, `${backupFilename}.sha256`);

  if (!fsImpl.existsSync(backupDir)) {
    fsImpl.mkdirSync(backupDir, { recursive: true });
  }

  const { payloadString, payloadBuffer, sha256, sidecarContent } = serializeBackup(payload, backupFilename);

  fsImpl.writeFileSync(backupPath, payloadString, 'utf8');
  fsImpl.writeFileSync(sidecarPath, sidecarContent, 'utf8');
  log(`✓ Backup successfully written to: ${backupPath} (${Math.round(payloadBuffer.length / 1024)} KB)`);
  log(`✓ SHA-256 sidecar written to: ${sidecarPath} (${sha256.substring(0, 16)}...)`);

  const latestPath = path.join(backupDir, 'cosmos_backup_latest.json');
  const latestSidecarPath = path.join(backupDir, 'cosmos_backup_latest.json.sha256');
  fsImpl.copyFileSync(backupPath, latestPath);
  fsImpl.copyFileSync(sidecarPath, latestSidecarPath);
  log(`✓ Updated pointers: ${latestPath} & ${latestSidecarPath}`);

  return {
    backupPath,
    sidecarPath,
    latestPath,
    latestSidecarPath,
    payload,
    sha256,
    studentDocsCount: studentDocs.length,
    feedbackDocsCount: feedbackDocs.length
  };
}

async function runBackup() {
  console.log('--- Starting Azure Cosmos DB Backup ---');

  let key = process.env.COSMOS_KEY;
  if (!key) {
    try {
      key = execSync('az cosmosdb keys list --name psat-cosmos-15958 --resource-group rg-psat-prep --query primaryMasterKey -o tsv').toString().trim();
    } catch (e) {
      console.error('Error fetching Cosmos DB key from Azure CLI:', e.message);
      process.exit(1);
    }
  }

  const endpoint = process.env.COSMOS_ENDPOINT || 'https://psat-cosmos-15958.documents.azure.com:443/';
  const dbName = process.env.COSMOS_DB_NAME || 'psat-prep-db';

  const { CosmosClient } = require('../api/node_modules/@azure/cosmos');
  const client = new CosmosClient({ endpoint, key });
  const database = client.database(dbName);

  const backupDir = path.join(__dirname, '..', 'backups');

  const result = await runBackupWithDatabase(database, { dbName, triggerType: 'local_cli', backupDir });
  return result.backupPath;
}

if (require.main === module) {
  runBackup().catch(err => {
    console.error('Backup failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  runBackup,
  runBackupWithDatabase,
  fetchBackupDocuments,
  buildBackupPayload,
  assertNonEmptyStudentDocs,
  serializeBackup
};
