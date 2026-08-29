const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

const { computeBackupStatus } = require('../lib/backupCore');

const storageConnectionString = process.env.AzureWebJobsStorage;
const backupContainerName = 'cosmos-backups';

/**
 * Lists the cosmos-backups container. Read-only: this endpoint never creates, writes,
 * or deletes a blob.
 *
 * @param {object} containerClient an @azure/storage-blob ContainerClient (or a fake)
 * @returns {Promise<Array<{name: string, lastModified: Date}>>}
 */
async function listBackupBlobs(containerClient) {
  const blobs = [];
  for await (const blob of containerClient.listBlobsFlat()) {
    blobs.push({
      name: blob.name,
      lastModified: blob.properties && blob.properties.lastModified ? blob.properties.lastModified : null
    });
  }
  return blobs;
}

/**
 * GET /api/backup-status
 *
 * Returns a real measurement of cloud-backup freshness:
 *   { lastSuccessAt, lastAttemptAt, lastFailureAt, ageHours, healthy, reason, ... }
 *
 * healthy === true means: the newest cosmos_backup_*.json archive is < 26 h old AND no
 * backup_FAILED_* marker is newer than it. Every value is derived from blob metadata --
 * nothing is defaulted or invented; absent data is null (CLAUDE.md mode 1).
 */
app.http('backupStatus', {
  route: 'backup-status',
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') {
      return { status: 204 };
    }

    if (!storageConnectionString) {
      context.error('backup-status: AzureWebJobsStorage is not configured');
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          success: false,
          error: 'AzureWebJobsStorage environment variable is not configured',
          healthy: false
        }
      };
    }

    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
      const containerClient = blobServiceClient.getContainerClient(backupContainerName);
      const blobs = await listBackupBlobs(containerClient);
      const status = computeBackupStatus(blobs, Date.now());

      context.log(
        `backup-status: healthy=${status.healthy} ageHours=${status.ageHours} ` +
        `archives=${status.successBackupCount} failureMarkers=${status.failureMarkerCount}`
      );

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        jsonBody: Object.assign({ success: true, container: backupContainerName }, status)
      };
    } catch (err) {
      // mode 5: report, never return a fabricated "healthy" on an error path.
      context.error('backup-status endpoint error:', err.message);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: { success: false, error: err.message, healthy: false }
      };
    }
  }
});

module.exports = { listBackupBlobs };
