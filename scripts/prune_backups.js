#!/usr/bin/env node
/**
 * scripts/prune_backups.js
 *
 * Operator CLI for retention pruning of the `cosmos-backups` blob container.
 * DRY RUN BY DEFAULT.
 *
 * This file contains NO policy. The policy — the 15-day window, the newest-7 floor, the
 * pointer/sidecar rules, the refusal conditions and the delete ordering — lives in exactly
 * one place, `api/src/lib/backupRetention.js`, and is shared with the scheduled timer in
 * `api/src/functions/backupPrune.js` (CLAUDE.md mode 2: one implementation, not two).
 * Everything below is argument handling, Azure IO and printing.
 *
 * Scope: BACKUP ARCHIVES in one hardcoded blob container. This script has no Cosmos
 * client and no container flag; it cannot reach student data, the Cosmos database, the
 * `function-releases` container, `$web`, or `refactor-baseline/`.
 *
 * Safety (CLAUDE.md mode 7 — destructive action needs a guard)
 *   - `--apply` is REQUIRED for any deletion; without it nothing is written or deleted.
 *   - Credentials come from environment variables only (AZURE_STORAGE_ACCOUNT /
 *     AZURE_STORAGE_KEY). Secrets on argv are refused.
 *   - Refuses to run inside the Azure Functions host: this is the operator path. The
 *     scheduled path is a separate function with its own guards.
 *   - If the container cannot be fully enumerated, the listing is DISCARDED and nothing
 *     is planned or deleted. A partial list plus a delete loop deletes what you could
 *     not see.
 *
 * Usage
 *   AZURE_STORAGE_ACCOUNT=psatprep4915 AZURE_STORAGE_KEY=... node scripts/prune_backups.js
 *   AZURE_STORAGE_ACCOUNT=psatprep4915 AZURE_STORAGE_KEY=... node scripts/prune_backups.js --apply
 */

const {
  RETENTION_DAYS,
  MIN_KEEP_NEWEST,
  BACKUP_CONTAINER,
  LATEST_POINTER,
  REFUSAL,
  timestampFromArchiveName,
  selectBackupsForDeletion,
  buildDeletionPairs,
  executeRetentionPlan
} = require('../api/src/lib/backupRetention');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function assertNotRunningInFunctionsHost() {
  const hostMarkers = ['AzureWebJobsScriptRoot', 'WEBSITE_INSTANCE_ID', 'FUNCTIONS_WORKER_RUNTIME'];
  const present = hostMarkers.filter(k => process.env[k]);
  if (present.length > 0) {
    throw new Error(
      `Refusing to run: this prune CLI must never execute inside the Azure Functions host ` +
      `(found ${present.join(', ')}). It is an operator-only script; the scheduled path is ` +
      `api/src/functions/backupPrune.js.`
    );
  }
}

function assertNoSecretsOnArgv(argv) {
  for (const arg of argv) {
    if (/^--(account|key|account-key|connection-string|sas)/i.test(arg) || arg.length > 60) {
      throw new Error(
        'Refusing to run: credentials must come from AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY ' +
        'environment variables, never from the command line.'
      );
    }
  }
}

/**
 * Enumerates the container COMPLETELY or not at all.
 *
 * The async iterator throws mid-iteration on a paging failure, which would otherwise
 * leave a half-filled array that looks exactly like a small container. On any error the
 * partial array is discarded and null is returned, which the selector treats as
 * LISTING_UNAVAILABLE.
 */
async function listContainerOrNull(containerClient, warn) {
  const blobs = [];
  try {
    for await (const blob of containerClient.listBlobsFlat()) {
      blobs.push({
        name: blob.name,
        lastModified: blob.properties && blob.properties.lastModified ? blob.properties.lastModified : null
      });
    }
    return blobs;
  } catch (err) {
    warn(
      `Could not fully enumerate ${BACKUP_CONTAINER}: ${err.message}. ` +
      `Discarding the ${blobs.length} blob(s) read so far; a prune is never planned from a partial listing.`
    );
    return null;
  }
}

function printPlan(plan, blobCount, account, apply) {
  console.log(`--- Backup retention prune (${apply ? 'APPLY' : 'DRY RUN'}) ---`);
  console.log(`Container: ${BACKUP_CONTAINER} on ${account}`);
  console.log(
    `Policy: keep every archive <= ${RETENTION_DAYS} days old; ` +
    `the newest ${MIN_KEEP_NEWEST} archives are never deleted at any age.`
  );
  console.log(`Blobs listed: ${blobCount === null ? 'LISTING FAILED' : blobCount}`);

  if (plan.ok !== true) {
    console.log(`\nREFUSED (${plan.refusalCode}): ${plan.refusalReason}`);
    console.log('Deletions selected: 0');
    return;
  }

  console.log(`Archives: ${plan.archiveCount} (ignored non-archive blobs: ${plan.ignored.length})`);
  console.log(`Retention cutoff: ${plan.cutoffIso}`);

  if (plan.skewWarnings.length > 0) {
    console.log(`\nAGE SKEW (${plan.skewWarnings.length}) — filename time vs lastModified disagree; the younger reading was used:`);
    for (const w of plan.skewWarnings) {
      console.log(`  ${w.name}  filename=${w.filenameIso}  lastModified=${w.lastModifiedIso}  (${w.skewMs} ms)`);
    }
  }
  if (plan.archivesWithoutSidecar.length > 0) {
    console.log(`\nARCHIVES WITH NO .sha256 SIDECAR (${plan.archivesWithoutSidecar.length}) — unverifiable, pre-date the sidecar era:`);
    for (const n of plan.archivesWithoutSidecar) console.log(`  ${n}`);
  }

  console.log(`\nKEEP (${plan.toKeep.length}):`);
  for (const c of plan.toKeep) {
    console.log(`  keep   ${c.name}  (${c.ageDays.toFixed(2)}d, ${c.keepReason})`);
  }

  console.log(`\nDELETE (${plan.toDelete.length} archives + ${plan.sidecarsToDelete.length} sidecars):`);
  if (plan.toDelete.length === 0) {
    console.log('  (nothing)');
  }
  for (const pair of buildDeletionPairs(plan)) {
    const c = plan.toDelete.find(x => x.name === pair.archive);
    console.log(`  delete ${pair.archive}  (${c.ageDays.toFixed(2)}d, older than ${RETENTION_DAYS}d)`);
    if (pair.sidecar) console.log(`  delete ${pair.sidecar}  (sidecar of the archive above)`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  assertNotRunningInFunctionsHost();
  assertNoSecretsOnArgv(argv);

  const apply = argv.includes('--apply');
  const account = process.env.AZURE_STORAGE_ACCOUNT;
  const key = process.env.AZURE_STORAGE_KEY;

  if (!account || !key) {
    throw new Error('AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY environment variables are required.');
  }

  const { BlobServiceClient, StorageSharedKeyCredential } = require('../api/node_modules/@azure/storage-blob');
  const credential = new StorageSharedKeyCredential(account, key);
  const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential);
  const container = service.getContainerClient(BACKUP_CONTAINER);

  const blobs = await listContainerOrNull(container, m => console.error(`WARNING: ${m}`));
  const nowMs = Date.now();
  const plan = selectBackupsForDeletion(blobs, nowMs);

  printPlan(plan, blobs === null ? null : blobs.length, account, apply);

  if (plan.ok !== true) {
    if (plan.refusalCode === REFUSAL.LISTING_UNAVAILABLE || plan.refusalCode === REFUSAL.POINTER_MISSING) {
      throw new Error(`Prune refused: ${plan.refusalReason}`);
    }
    console.log('\nNothing selected. Exiting without any write.');
    return { dryRun: !apply, plan };
  }

  if (!apply) {
    console.log('\n[DRY RUN] Nothing was deleted. Re-run with --apply to execute this plan.');
    return { dryRun: true, plan };
  }

  if (plan.toDelete.length === 0) {
    console.log('\nNothing to delete. Exiting without any write.');
    return { applied: true, deleted: 0, plan };
  }

  const outcome = await executeRetentionPlan(container, plan, {
    apply: true,
    log: m => console.log(m),
    warn: m => console.error(m)
  });

  console.log(`\nDeleted ${outcome.deleted.length} blob(s). Failures: ${outcome.failures.length}. Sidecars kept back: ${outcome.skipped.length}`);
  if (outcome.failures.length > 0) {
    throw new Error(`Prune completed with ${outcome.failures.length} failure(s):\n  ${outcome.failures.join('\n  ')}`);
  }
  return { applied: true, deleted: outcome.deleted.length, plan };
}

if (require.main === module) {
  main().catch(err => {
    console.error('\nprune_backups failed: ' + err.message);
    process.exit(1);
  });
}

module.exports = {
  // Re-exported from api/src/lib/backupRetention.js so this module stays the CLI entry
  // point without owning a second copy of the policy.
  RETENTION_DAYS,
  MIN_KEEP_NEWEST,
  BACKUP_CONTAINER,
  LATEST_POINTER,
  REFUSAL,
  timestampFromArchiveName,
  selectBackupsForDeletion,
  buildDeletionPairs,
  executeRetentionPlan,
  // CLI-only guards
  assertNotRunningInFunctionsHost,
  assertNoSecretsOnArgv,
  listContainerOrNull
};
