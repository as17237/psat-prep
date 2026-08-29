#!/usr/bin/env node
/**
 * scripts/prune_backups.js
 *
 * Retention pruning for the `cosmos-backups` blob container. DRY RUN BY DEFAULT.
 *
 * Policy
 *   - Keep every backup archive <= 30 days old.
 *   - Older than 30 days: keep exactly one archive per ISO week (the newest in that week).
 *   - HARD REFUSAL: the newest 7 archives are never deleted, whatever the policy says.
 *   - Only timestamped `cosmos_backup_<ts>.json` archives are ever candidates. The
 *     `cosmos_backup_latest.json` pointer, `backup_FAILED_*` markers and any other blob
 *     are never touched. A deleted archive takes its own `.sha256` sidecar with it.
 *
 * Safety (CLAUDE.md mode 7 — destructive action needs a guard)
 *   - `--apply` is REQUIRED for any deletion; without it nothing is written or deleted.
 *   - Credentials come from environment variables only (AZURE_STORAGE_ACCOUNT /
 *     AZURE_STORAGE_KEY). Secrets on argv are refused.
 *   - Refuses to run inside the Azure Functions host: this is an operator tool and must
 *     never be reachable from the nightly timer.
 *   - The container name is hardcoded; there is no flag to point it elsewhere.
 *
 * Usage
 *   AZURE_STORAGE_ACCOUNT=psatprep4915 AZURE_STORAGE_KEY=... node scripts/prune_backups.js
 *   AZURE_STORAGE_ACCOUNT=psatprep4915 AZURE_STORAGE_KEY=... node scripts/prune_backups.js --apply
 */

const RETENTION_DAYS = 30;
const MIN_KEEP_NEWEST = 7;
const BACKUP_CONTAINER = 'cosmos-backups';

const ARCHIVE_RE = /^cosmos_backup_.+\.json$/;
const LATEST_POINTER = 'cosmos_backup_latest.json';

/**
 * ISO-8601 week key ("YYYY-Www") for a date, computed in UTC.
 * ISO weeks start Monday; week 1 is the week containing the first Thursday of the year.
 */
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;           // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);   // move to the Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil((((d.getTime() - yearStart) / 86400000) + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Pure retention selector. `nowMs` is a parameter — the clock is never read here.
 *
 * @param {Array<{name: string, lastModified: (Date|string)}>} blobs full container listing
 * @param {number} nowMs epoch milliseconds
 * @returns {{
 *   toDelete: Array<object>, toKeep: Array<object>, sidecarsToDelete: string[],
 *   ignored: Array<object>, protectedByFloor: Array<object>, cutoffIso: string
 * }}
 */
function selectBackupsForDeletion(blobs, nowMs) {
  const list = Array.isArray(blobs) ? blobs : [];
  const candidates = [];
  const ignored = [];
  const sidecarNames = new Set();

  for (const blob of list) {
    if (!blob || !blob.name) continue;
    const ms = toMillis(blob.lastModified);
    if (blob.name.endsWith('.sha256')) sidecarNames.add(blob.name);
    if (blob.name !== LATEST_POINTER && ARCHIVE_RE.test(blob.name) && ms !== null) {
      candidates.push({ name: blob.name, lastModified: blob.lastModified, ms });
    } else {
      ignored.push(blob);
    }
  }

  // Newest first.
  candidates.sort((a, b) => b.ms - a.ms);

  const cutoffMs = nowMs - (RETENTION_DAYS * 86400000);
  const protectedByFloor = candidates.slice(0, MIN_KEEP_NEWEST);
  const floorNames = new Set(protectedByFloor.map(c => c.name));

  // Among archives older than the cutoff, the newest of each ISO week survives.
  const weekWinner = new Map();
  for (const c of candidates) {
    if (c.ms > cutoffMs) continue;
    const key = isoWeekKey(new Date(c.ms));
    // candidates are sorted newest-first, so the first seen in a week is its winner.
    if (!weekWinner.has(key)) weekWinner.set(key, c.name);
  }

  const toDelete = [];
  const toKeep = [];
  for (const c of candidates) {
    const withinRetention = c.ms > cutoffMs;
    const isWeekWinner = weekWinner.get(isoWeekKey(new Date(c.ms))) === c.name;
    const isFloorProtected = floorNames.has(c.name);
    if (withinRetention || isWeekWinner || isFloorProtected) {
      toKeep.push(c);
    } else {
      toDelete.push(c);
    }
  }

  const sidecarsToDelete = toDelete
    .map(c => `${c.name}.sha256`)
    .filter(name => sidecarNames.has(name));

  return {
    toDelete,
    toKeep,
    sidecarsToDelete,
    ignored,
    protectedByFloor,
    cutoffIso: new Date(cutoffMs).toISOString()
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function assertNotRunningInFunctionsHost() {
  const hostMarkers = ['AzureWebJobsScriptRoot', 'WEBSITE_INSTANCE_ID', 'FUNCTIONS_WORKER_RUNTIME'];
  const present = hostMarkers.filter(k => process.env[k]);
  if (present.length > 0) {
    throw new Error(
      `Refusing to run: this prune tool must never execute inside the Azure Functions host ` +
      `(found ${present.join(', ')}). It is an operator-only script.`
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

function formatAge(ms, nowMs) {
  return `${((nowMs - ms) / 86400000).toFixed(1)}d`;
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

  const blobs = [];
  for await (const blob of container.listBlobsFlat()) {
    blobs.push({ name: blob.name, lastModified: blob.properties.lastModified });
  }

  const nowMs = Date.now();
  const plan = selectBackupsForDeletion(blobs, nowMs);

  console.log(`--- Backup retention prune (${apply ? 'APPLY' : 'DRY RUN'}) ---`);
  console.log(`Container: ${BACKUP_CONTAINER} on ${account}`);
  console.log(`Policy: keep all <= ${RETENTION_DAYS} days, then one per ISO week; newest ${MIN_KEEP_NEWEST} archives never deleted.`);
  console.log(`Blobs listed: ${blobs.length} (archives: ${plan.toDelete.length + plan.toKeep.length}, ignored: ${plan.ignored.length})`);
  console.log(`Retention cutoff: ${plan.cutoffIso}`);
  console.log(`\nKEEP (${plan.toKeep.length}):`);
  for (const c of plan.toKeep) {
    const why = plan.protectedByFloor.some(p => p.name === c.name) ? 'newest-7 floor' :
      (c.ms > nowMs - RETENTION_DAYS * 86400000 ? '<=30d' : `weekly ${isoWeekKey(new Date(c.ms))}`);
    console.log(`  keep   ${c.name}  (${formatAge(c.ms, nowMs)}, ${why})`);
  }
  console.log(`\nDELETE (${plan.toDelete.length} archives + ${plan.sidecarsToDelete.length} sidecars):`);
  for (const c of plan.toDelete) {
    console.log(`  delete ${c.name}  (${formatAge(c.ms, nowMs)}, superseded in ${isoWeekKey(new Date(c.ms))})`);
  }
  for (const s of plan.sidecarsToDelete) {
    console.log(`  delete ${s}  (sidecar of a deleted archive)`);
  }

  if (!apply) {
    console.log('\n[DRY RUN] Nothing was deleted. Re-run with --apply to execute this plan.');
    return { dryRun: true, plan };
  }

  if (plan.toDelete.length === 0) {
    console.log('\nNothing to delete. Exiting without any write.');
    return { applied: true, deleted: 0 };
  }

  let deleted = 0;
  const failures = [];
  for (const name of [...plan.toDelete.map(c => c.name), ...plan.sidecarsToDelete]) {
    try {
      const res = await container.getBlockBlobClient(name).deleteIfExists();
      if (res.succeeded) {
        deleted += 1;
        console.log(`  ✓ deleted ${name}`);
      } else {
        failures.push(`${name}: blob not found`);
        console.error(`  ⚠️  not deleted (missing): ${name}`);
      }
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
      console.error(`  ❌ delete failed: ${name} — ${err.message}`);
    }
  }

  console.log(`\nDeleted ${deleted} blob(s). Failures: ${failures.length}`);
  if (failures.length > 0) {
    throw new Error(`Prune completed with ${failures.length} failure(s):\n  ${failures.join('\n  ')}`);
  }
  return { applied: true, deleted };
}

if (require.main === module) {
  main().catch(err => {
    console.error('\n❌ prune_backups failed: ' + err.message);
    process.exit(1);
  });
}

module.exports = {
  RETENTION_DAYS,
  MIN_KEEP_NEWEST,
  BACKUP_CONTAINER,
  isoWeekKey,
  selectBackupsForDeletion,
  assertNotRunningInFunctionsHost,
  assertNoSecretsOnArgv
};
