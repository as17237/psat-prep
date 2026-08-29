const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');

const {
  assertQuestionsIntegrity,
  buildCloudBackupPayload,
  writeFailureMarker
} = require('../lib/backupCore');

const connectionString = process.env.COSMOS_CONNECTION_STRING;
const storageConnectionString = process.env.AzureWebJobsStorage;
const dbName = process.env.COSMOS_DB_NAME || 'psat-prep-db';
const backupContainerName = 'cosmos-backups';

/**
 * Records a loud, durable marker of a failed backup attempt in the cosmos-backups
 * container so a silent nightly failure becomes observable (GET /api/backup-status
 * reads these markers).
 *
 * Never throws: the marker write is best-effort and must not mask the original error.
 * Returns the checked success flag from writeFailureMarker so callers can log it.
 */
async function recordBackupFailure(error, triggerType, { warn = console.warn, now = new Date() } = {}) {
  if (!storageConnectionString) {
    warn(
      '⚠️  Cannot write backup failure marker: AzureWebJobsStorage is not configured. ' +
      `Original backup failure: ${error && error.message ? error.message : error}`
    );
    return { written: false, filename: null, error: 'AzureWebJobsStorage not configured' };
  }
  let containerClient;
  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
    containerClient = blobServiceClient.getContainerClient(backupContainerName);
  } catch (clientErr) {
    warn(
      `⚠️  Could not build a blob client for the failure marker: ${clientErr.message}. ` +
      `Original backup failure: ${error && error.message ? error.message : error}`
    );
    return { written: false, filename: null, error: clientErr.message };
  }
  return writeFailureMarker(containerClient, { error, triggerType, now, warn });
}

async function performCosmosBackup(triggerType = 'timer', { log = console.log, warn = console.warn } = {}) {
  if (!connectionString) {
    throw new Error('COSMOS_CONNECTION_STRING environment variable is not configured');
  }
  if (!storageConnectionString) {
    throw new Error('AzureWebJobsStorage environment variable is not configured');
  }

  const cosmosClient = new CosmosClient(connectionString);
  const database = cosmosClient.database(dbName);

  // 1. Fetch documents from student answers & feedback
  const answersContainer = database.container('UATStudentAnswers');
  const { resources: studentDocs } = await answersContainer.items.query('SELECT * FROM c').fetchAll();

  let feedbackDocs = [];
  try {
    const feedbackContainer = database.container('UATFeedback');
    const { resources: fb } = await feedbackContainer.items.query('SELECT * FROM c').fetchAll();
    feedbackDocs = fb || [];
  } catch (e) {
    // Feedback container may be empty or optional -- report, never swallow silently.
    warn(`⚠️  Could not fetch UATFeedback documents (continuing with 0): ${e.message}`);
  }

  if (!Array.isArray(studentDocs) || studentDocs.length === 0) {
    throw new Error('Safety guard: 0 documents retrieved from UATStudentAnswers container. Aborting backup.');
  }

  // 1b. Fetch the Questions container (question mirror, ~3,059 docs). A failure here is
  // reported and treated as "container missing" (0 docs) by the guard below; a PARTIAL
  // read (1..2999) aborts the backup rather than writing a silently incomplete snapshot.
  let questionDocs = [];
  try {
    const questionsContainer = database.container('Questions');
    const { resources: qs } = await questionsContainer.items.query('SELECT * FROM c').fetchAll();
    questionDocs = qs || [];
  } catch (e) {
    warn(`⚠️  Could not fetch Questions documents: ${e.message}`);
    questionDocs = [];
  }
  const questionsGuard = assertQuestionsIntegrity(questionDocs, { warn });

  const now = new Date();
  const timestampStr = now.toISOString().replace(/[:.]/g, '-');
  const crypto = require('crypto');
  const backupFilename = `cosmos_backup_${timestampStr}.json`;
  const sidecarFilename = `cosmos_backup_${timestampStr}.json.sha256`;

  const backupPayload = buildCloudBackupPayload({
    studentDocs,
    feedbackDocs,
    questionDocs,
    dbName,
    triggerType,
    now
  });

  const payloadString = JSON.stringify(backupPayload, null, 2);
  const payloadBuffer = Buffer.from(payloadString, 'utf8');
  const sha256Checksum = crypto.createHash('sha256').update(payloadBuffer).digest('hex');
  const sidecarContent = `${sha256Checksum}  ${backupFilename}\n`;
  const sidecarBuffer = Buffer.from(sidecarContent, 'utf8');

  // 2. Upload to Azure Blob Storage (cosmos-backups container)
  const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
  const containerClient = blobServiceClient.getContainerClient(backupContainerName);
  await containerClient.createIfNotExists();

  // Timestamped archive blob
  const blockBlobClient = containerClient.getBlockBlobClient(backupFilename);
  await blockBlobClient.upload(payloadBuffer, payloadBuffer.length, {
    blobHTTPHeaders: { blobContentType: 'application/json' }
  });

  // Timestamped SHA-256 sidecar blob
  const sidecarBlobClient = containerClient.getBlockBlobClient(sidecarFilename);
  await sidecarBlobClient.upload(sidecarBuffer, sidecarBuffer.length, {
    blobHTTPHeaders: { blobContentType: 'text/plain' }
  });

  // Latest snapshot pointer
  const latestBlobClient = containerClient.getBlockBlobClient('cosmos_backup_latest.json');
  await latestBlobClient.upload(payloadBuffer, payloadBuffer.length, {
    blobHTTPHeaders: { blobContentType: 'application/json' }
  });

  // Latest SHA-256 sidecar pointer
  const latestSidecarClient = containerClient.getBlockBlobClient('cosmos_backup_latest.json.sha256');
  await latestSidecarClient.upload(sidecarBuffer, sidecarBuffer.length, {
    blobHTTPHeaders: { blobContentType: 'text/plain' }
  });

  const summary = {
    success: true,
    timestamp: now.toISOString(),
    filename: backupFilename,
    sidecarFilename: sidecarFilename,
    sha256: sha256Checksum,
    blobContainer: backupContainerName,
    sizeBytes: payloadBuffer.length,
    sizeKB: Math.round(payloadBuffer.length / 1024),
    studentDocumentsBackedUp: studentDocs.length,
    feedbackDocumentsBackedUp: feedbackDocs.length,
    questionsCount: questionsGuard.count,
    questionsContainerMissing: questionsGuard.warned,
    payloadVersion: backupPayload.backupMetadata.version,
    latestPointerUpdated: true
  };

  log(`Backup payload built: ${summary.studentDocumentsBackedUp} student, ${summary.feedbackDocumentsBackedUp} feedback, ${summary.questionsCount} question documents.`);

  return summary;
}

// Scheduled Daily Backup at 02:00 UTC (every night)
app.timer('dailyCosmosBackup', {
  schedule: '0 0 2 * * *',
  handler: async (myTimer, context) => {
    context.log('--- Executing Scheduled Daily Cosmos DB Cloud Backup ---');
    try {
      const result = await performCosmosBackup('scheduled_cron', {
        log: (m) => context.log(m),
        warn: (m) => context.warn ? context.warn(m) : context.log(m)
      });
      context.log(`✓ Daily backup completed successfully: ${result.filename} (${result.sizeKB} KB, ${result.studentDocumentsBackedUp} student docs, ${result.questionsCount} question docs)`);
      if (result.questionsContainerMissing) {
        context.error('⚠️  Daily backup completed WITHOUT the Questions container (0 documents retrieved). Investigate the Questions container.');
      }
    } catch (err) {
      context.error('❌ Daily Cosmos DB backup failed:', err.message);
      const marker = await recordBackupFailure(err, 'scheduled_cron', {
        warn: (m) => context.error(m)
      });
      if (marker.written) {
        context.error(`↳ Failure marker written to ${backupContainerName}/${marker.filename} (visible via GET /api/backup-status)`);
      } else {
        context.error(`↳ Failure marker could NOT be written (${marker.error}). Backup failure is only in these logs.`);
      }
    }
  }
});

// On-Demand HTTP Trigger Endpoint (/api/backup)
app.http('backup', {
  methods: ['GET', 'POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') {
      return { status: 204 };
    }

    try {
      context.log('--- Triggering On-Demand Cosmos DB Cloud Backup ---');
      const result = await performCosmosBackup('http_request', {
        log: (m) => context.log(m),
        warn: (m) => context.warn ? context.warn(m) : context.log(m)
      });
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: result
      };
    } catch (err) {
      context.error('Backup endpoint error:', err.message);
      const marker = await recordBackupFailure(err, 'http_request', {
        warn: (m) => context.error(m)
      });
      if (marker.written) {
        context.error(`↳ Failure marker written to ${backupContainerName}/${marker.filename}`);
      } else {
        context.error(`↳ Failure marker could NOT be written (${marker.error}).`);
      }
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          success: false,
          error: err.message,
          failureMarkerWritten: marker.written,
          failureMarkerFilename: marker.written ? marker.filename : null
        }
      };
    }
  }
});

module.exports = { performCosmosBackup, recordBackupFailure };
