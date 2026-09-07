const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

const { writeFailureMarker } = require('../lib/backupCore');
const {
  RETENTION_DAYS,
  MIN_KEEP_NEWEST,
  BACKUP_CONTAINER,
  REFUSAL,
  selectBackupsForDeletion,
  buildDeletionPairs,
  executeRetentionPlan
} = require('../lib/backupRetention');

const storageConnectionString = process.env.AzureWebJobsStorage;

/**
 * ARMING SWITCH. The timer always runs and always logs the plan; it only DELETES when
 * this app setting is exactly the string 'true'.
 *
 * It ships disarmed on purpose. A deploy that silently begins deleting recovery points
 * the first night is not something anyone should discover from the logs afterwards — the
 * maintainer arms it with one setting, after reading a night or two of dry-run plans:
 *
 *   az functionapp config appsettings set --name psat-api-4915 \
 *     --resource-group rg-psat-prep --settings BACKUP_PRUNE_APPLY=true
 *
 * Setting it to anything else, or removing it, disarms the job again without a redeploy.
 */
const PRUNE_APPLY_ENABLED = process.env.BACKUP_PRUNE_APPLY === 'true';

/**
 * SCHEDULE: 04:30:00 UTC daily (NCRONTAB is {sec} {min} {hour} {day} {month} {dow};
 * the Function App sets no WEBSITE_TIME_ZONE, so this is UTC).
 *
 * Why it cannot race dailyCosmosBackup at '0 0 2 * * *':
 *   1. 2h30m of clearance. The 02:00 backup writes four blobs totalling ~9.5 MB and its
 *      observed archives land at 02:00:01 — under two seconds. Two and a half hours is
 *      four orders of magnitude more headroom than the job has ever needed, and it still
 *      leaves 21.5 hours before the next backup, so the prune can never drift into the
 *      following night's run either.
 *   2. Even a direct collision would be harmless by construction. An in-flight or
 *      just-written archive has an age near zero, so it is inside the 15-day window AND
 *      inside the newest-7 floor — doubly ineligible. The prune only ever touches blobs
 *      that were already 15 days old before the backup started.
 *   3. The prune never writes to the paths the backup writes: it never touches
 *      cosmos_backup_latest.json or its sidecar, which are the only blobs the 02:00 run
 *      overwrites rather than creates.
 *   Off-the-hour (:30) also keeps it clear of hourly platform maintenance windows.
 */
const PRUNE_SCHEDULE = '0 30 4 * * *';

/**
 * Enumerates the backup container COMPLETELY, or returns null.
 *
 * CLAUDE.md mode 7: a partial listing plus a delete loop deletes everything you could not
 * see. The async iterator throws mid-paging on a transient storage error, which would
 * otherwise leave a half-filled array indistinguishable from a small container. On ANY
 * error the partial array is discarded and null is returned; the selector then refuses.
 *
 * @returns {Promise<{blobs: (Array|null), error: (string|null), partialCount: number}>}
 */
async function listContainerOrNull(containerClient, { warn = console.warn } = {}) {
  const blobs = [];
  try {
    for await (const blob of containerClient.listBlobsFlat()) {
      blobs.push({
        name: blob.name,
        lastModified: blob.properties && blob.properties.lastModified ? blob.properties.lastModified : null
      });
    }
    return { blobs, error: null, partialCount: blobs.length };
  } catch (err) {
    warn(
      `Could not fully enumerate ${BACKUP_CONTAINER}: ${err.message}. ` +
      `Discarding the ${blobs.length} blob(s) read so far — a prune is never planned from a partial listing.`
    );
    return { blobs: null, error: err.message, partialCount: blobs.length };
  }
}

/**
 * Writes a loud, durable marker so a broken prune is visible via GET /api/backup-status
 * rather than dying in the logs. Same mechanism and same blob shape as
 * recordBackupFailure() in backup.js, so the existing status endpoint already reports it
 * (a backup_FAILED_* marker newer than the last archive turns `healthy` false).
 *
 * Never throws: a marker write that fails must not replace the original prune error.
 */
async function recordPruneFailure(error, { warn = console.warn, now = new Date() } = {}) {
  if (!storageConnectionString) {
    warn(
      'Cannot write prune failure marker: AzureWebJobsStorage is not configured. ' +
      `Original prune failure: ${error && error.message ? error.message : error}`
    );
    return { written: false, filename: null, error: 'AzureWebJobsStorage not configured' };
  }
  let containerClient;
  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
    containerClient = blobServiceClient.getContainerClient(BACKUP_CONTAINER);
  } catch (clientErr) {
    warn(
      `Could not build a blob client for the prune failure marker: ${clientErr.message}. ` +
      `Original prune failure: ${error && error.message ? error.message : error}`
    );
    return { written: false, filename: null, error: clientErr.message };
  }
  return writeFailureMarker(containerClient, { error, triggerType: 'scheduled_prune', now, warn });
}

/**
 * The whole job, separated from the trigger so it is callable from a test with a fake
 * container client and an injected clock.
 *
 * SCOPE: this function opens exactly one blob container, `cosmos-backups`, hardcoded in
 * the shared policy module. It constructs no Cosmos client, reads no database, and names
 * no other container. It cannot reach student data, `function-releases`, `$web`, or
 * `refactor-baseline/`.
 *
 * @returns {Promise<object>} a report of what was deleted and what was kept
 */
async function performBackupPrune({
  containerClient,
  nowMs = Date.now(),
  apply = PRUNE_APPLY_ENABLED,
  log = console.log,
  warn = console.warn
} = {}) {
  const listing = await listContainerOrNull(containerClient, { warn });
  const plan = selectBackupsForDeletion(listing.blobs, nowMs);

  const report = {
    checkedAt: new Date(nowMs).toISOString(),
    container: BACKUP_CONTAINER,
    retentionDays: RETENTION_DAYS,
    minKeepNewest: MIN_KEEP_NEWEST,
    armed: apply === true,
    blobsListed: listing.blobs === null ? null : listing.blobs.length,
    archiveCount: plan.archiveCount,
    refused: plan.ok !== true,
    refusalCode: plan.refusalCode,
    refusalReason: plan.refusalReason,
    selectedArchives: plan.toDelete.map(c => c.name),
    selectedSidecars: plan.sidecarsToDelete.slice(),
    keptArchives: plan.toKeep.map(c => ({ name: c.name, ageDays: c.ageDays, reason: c.keepReason })),
    deleted: [],
    failures: [],
    sidecarsHeldBack: []
  };

  // --- Refusal paths: do nothing, and say so loudly. ------------------------
  if (plan.ok !== true) {
    if (plan.refusalCode === REFUSAL.EMPTY_LISTING) {
      // Not a prune failure: an empty container is already reported as unhealthy by
      // GET /api/backup-status ("No successful cosmos_backup_*.json archive found").
      // Writing our own marker here would just add noise to an already-red signal.
      warn(`Prune did nothing: ${plan.refusalReason}`);
      return report;
    }
    const err = new Error(plan.refusalReason);
    warn(`PRUNE REFUSED (${plan.refusalCode}): ${plan.refusalReason}`);
    const marker = await recordPruneFailure(err, { warn, now: new Date(nowMs) });
    report.failureMarkerWritten = marker.written;
    report.failureMarkerFilename = marker.written ? marker.filename : null;
    if (marker.written) {
      warn(`Prune failure marker written to ${BACKUP_CONTAINER}/${marker.filename} (visible via GET /api/backup-status)`);
    } else {
      warn(`Prune failure marker could NOT be written (${marker.error}). This refusal is only in these logs.`);
    }
    return report;
  }

  // --- Log exactly what was kept and why, every run. ------------------------
  log(
    `Prune plan: ${plan.archiveCount} archives in ${BACKUP_CONTAINER}; cutoff ${plan.cutoffIso}; ` +
    `keep ${plan.toKeep.length}, select ${plan.toDelete.length} archives + ${plan.sidecarsToDelete.length} sidecars.`
  );
  for (const kept of plan.toKeep) {
    log(`  KEEP   ${kept.name} (${kept.ageDays.toFixed(2)}d, ${kept.keepReason})`);
  }
  for (const pair of buildDeletionPairs(plan)) {
    log(`  SELECT ${pair.archive}${pair.sidecar ? ` + ${pair.sidecar}` : ' (no sidecar present)'}`);
  }
  for (const w of plan.skewWarnings) {
    warn(`  AGE SKEW ${w.name}: filename=${w.filenameIso} lastModified=${w.lastModifiedIso}; used the younger reading.`);
  }

  if (plan.toDelete.length === 0) {
    log('Nothing is older than the retention window. No deletions.');
    return report;
  }

  if (apply !== true) {
    log(
      `[DRY RUN] BACKUP_PRUNE_APPLY is not 'true', so nothing was deleted. ` +
      `${plan.toDelete.length} archive(s) + ${plan.sidecarsToDelete.length} sidecar(s) would be removed.`
    );
    return report;
  }

  // --- Armed: execute through the shared executor. --------------------------
  const outcome = await executeRetentionPlan(containerClient, plan, {
    apply: true,
    log,
    warn
  });
  report.deleted = outcome.deleted;
  report.failures = outcome.failures;
  report.sidecarsHeldBack = outcome.skipped;

  log(`Prune complete: deleted ${outcome.deleted.length} blob(s), ${outcome.failures.length} failure(s).`);
  if (outcome.failures.length > 0) {
    const err = new Error(
      `Prune completed with ${outcome.failures.length} failure(s): ${outcome.failures.join('; ')}`
    );
    const marker = await recordPruneFailure(err, { warn, now: new Date(nowMs) });
    report.failureMarkerWritten = marker.written;
    report.failureMarkerFilename = marker.written ? marker.filename : null;
    warn(
      marker.written
        ? `Prune failure marker written to ${BACKUP_CONTAINER}/${marker.filename}`
        : `Prune failure marker could NOT be written (${marker.error}).`
    );
  }
  return report;
}

// Scheduled daily retention prune at 04:30 UTC — 2h30m after the 02:00 backup.
app.timer('dailyBackupPrune', {
  schedule: PRUNE_SCHEDULE,
  handler: async (myTimer, context) => {
    context.log(
      `--- Scheduled backup retention prune (${RETENTION_DAYS}-day window, newest-${MIN_KEEP_NEWEST} floor, ` +
      `${PRUNE_APPLY_ENABLED ? 'ARMED' : 'DRY RUN — BACKUP_PRUNE_APPLY is not true'}) ---`
    );

    if (!storageConnectionString) {
      // Cannot even reach storage: do nothing, and report. There is nowhere to write a
      // marker either, so this is logged as loudly as possible and the run ends.
      context.error(
        'Prune aborted: AzureWebJobsStorage is not configured. No blob was listed and none was deleted.'
      );
      return;
    }

    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
      const containerClient = blobServiceClient.getContainerClient(BACKUP_CONTAINER);

      // Deliberately NOT createIfNotExists(): if the container is missing, that is a
      // condition to report, not to paper over on a deletion path.
      const report = await performBackupPrune({
        containerClient,
        nowMs: Date.now(),
        apply: PRUNE_APPLY_ENABLED,
        log: (m) => context.log(m),
        warn: (m) => context.error(m)
      });

      context.log(
        `Prune summary: listed=${report.blobsListed} archives=${report.archiveCount} ` +
        `kept=${report.keptArchives.length} selected=${report.selectedArchives.length} ` +
        `deleted=${report.deleted.length} refused=${report.refused} armed=${report.armed}`
      );
    } catch (err) {
      context.error('Scheduled backup prune failed:', err.message);
      const marker = await recordPruneFailure(err, { warn: (m) => context.error(m) });
      if (marker.written) {
        context.error(`Prune failure marker written to ${BACKUP_CONTAINER}/${marker.filename} (visible via GET /api/backup-status)`);
      } else {
        context.error(`Prune failure marker could NOT be written (${marker.error}). This failure is only in these logs.`);
      }
    }
  }
});

module.exports = {
  PRUNE_SCHEDULE,
  PRUNE_APPLY_ENABLED,
  performBackupPrune,
  listContainerOrNull,
  recordPruneFailure
};
