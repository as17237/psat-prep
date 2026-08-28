const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env.COSMOS_CONNECTION_STRING;
const storageConnectionString = process.env.AzureWebJobsStorage;
const dbName = process.env.COSMOS_DB_NAME || 'psat-prep-db';
const backupContainerName = 'cosmos-backups';

async function performCosmosBackup(triggerType = 'timer') {
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
    // Feedback container may be empty or optional
  }

  if (!Array.isArray(studentDocs) || studentDocs.length === 0) {
    throw new Error('Safety guard: 0 documents retrieved from UATStudentAnswers container. Aborting backup.');
  }

  const now = new Date();
  const timestampStr = now.toISOString().replace(/[:.]/g, '-');
  const backupFilename = `cosmos_backup_${timestampStr}.json`;

  const backupPayload = {
    backupMetadata: {
      generatedAt: now.toISOString(),
      triggerType: triggerType,
      database: dbName,
      totalDocuments: studentDocs.length + feedbackDocs.length,
      studentAnswersCount: studentDocs.length,
      feedbackCount: feedbackDocs.length,
      version: '1.0'
    },
    studentAnswers: studentDocs,
    feedback: feedbackDocs
  };

  const payloadString = JSON.stringify(backupPayload, null, 2);
  const payloadBuffer = Buffer.from(payloadString, 'utf8');

  // 2. Upload to Azure Blob Storage (cosmos-backups container)
  const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
  const containerClient = blobServiceClient.getContainerClient(backupContainerName);
  await containerClient.createIfNotExists();

  // Timestamped archive blob
  const blockBlobClient = containerClient.getBlockBlobClient(backupFilename);
  await blockBlobClient.upload(payloadBuffer, payloadBuffer.length, {
    blobHTTPHeaders: { blobContentType: 'application/json' }
  });

  // Latest snapshot pointer
  const latestBlobClient = containerClient.getBlockBlobClient('cosmos_backup_latest.json');
  await latestBlobClient.upload(payloadBuffer, payloadBuffer.length, {
    blobHTTPHeaders: { blobContentType: 'application/json' }
  });

  const summary = {
    success: true,
    timestamp: now.toISOString(),
    filename: backupFilename,
    blobContainer: backupContainerName,
    sizeBytes: payloadBuffer.length,
    sizeKB: Math.round(payloadBuffer.length / 1024),
    studentDocumentsBackedUp: studentDocs.length,
    feedbackDocumentsBackedUp: feedbackDocs.length,
    latestPointerUpdated: true
  };

  return summary;
}

// Scheduled Daily Backup at 02:00 UTC (every night)
app.timer('dailyCosmosBackup', {
  schedule: '0 0 2 * * *',
  handler: async (myTimer, context) => {
    context.log('--- Executing Scheduled Daily Cosmos DB Cloud Backup ---');
    try {
      const result = await performCosmosBackup('scheduled_cron');
      context.log(`✓ Daily backup completed successfully: ${result.filename} (${result.sizeKB} KB, ${result.studentDocumentsBackedUp} docs)`);
    } catch (err) {
      context.error('❌ Daily Cosmos DB backup failed:', err.message);
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
      const result = await performCosmosBackup('http_request');
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: result
      };
    } catch (err) {
      context.error('Backup endpoint error:', err.message);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: { success: false, error: err.message }
      };
    }
  }
});

module.exports = { performCosmosBackup };
