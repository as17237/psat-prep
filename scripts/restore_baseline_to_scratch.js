#!/usr/bin/env node
/**
 * scripts/restore_baseline_to_scratch.js — WI-03 restore verification (part 1 of 2)
 * ============================================================================
 * Restores the WI-02 immutable baseline snapshot (blob container `refactor-baseline`)
 * into a SCRATCH Cosmos database so that the backup can be *proven* restorable rather
 * than assumed restorable.
 *
 * What it does, in order:
 *   1. Downloads the three Cosmos container exports AND their `.sha256` sidecars from
 *      the baseline folder.
 *   2. Verifies each sha256 BEFORE the JSON is parsed. A mismatch is a hard failure —
 *      a corrupted backup must never be silently "restored" (CLAUDE.md failure mode 5).
 *   3. Creates database `psat-prep-db-drtest` with the three containers using the exact
 *      production partition keys.
 *   4. Inserts every exported document with Cosmos system fields stripped, using a
 *      bounded-concurrency pool with 429/503 retry+backoff (the account is serverless).
 *
 * ---------------------------------------------------------------------------
 * DATA SAFETY (asserts in code, not conventions — CLAUDE.md failure mode 7)
 * ---------------------------------------------------------------------------
 * The restore target is the hardcoded constant SCRATCH_DB. `assertScratchTarget()`
 * throws immediately if the target is anything other than that literal string — in
 * particular if it is ever the production database `psat-prep-db`. It is called before
 * the Cosmos client is even constructed, and again immediately before every
 * database-level and container-level write. Production is never written to by this
 * script under any code path.
 *
 * Credentials come from the environment only, never argv:
 *   COSMOS_KEY              Cosmos primary master key for psat-cosmos-15958
 *   AZURE_STORAGE_ACCOUNT   storage account holding `refactor-baseline` (psatprep4915)
 *   AZURE_STORAGE_KEY       its access key
 * Optional: BASELINE_FOLDER (defaults to the WI-02 accepted baseline below).
 *
 * Usage:
 *   COSMOS_KEY=... AZURE_STORAGE_ACCOUNT=... AZURE_STORAGE_KEY=... \
 *     node scripts/restore_baseline_to_scratch.js
 *   node scripts/restore_baseline_to_scratch.js --assert-test   # offline safety check
 *
 * This module is also `require`d by scripts/reconcile_restore.js, which reuses the
 * same constants, download/verify routine and system-field stripper so that the two
 * scripts cannot drift apart (CLAUDE.md failure mode 2).
 */

'use strict';

const crypto = require('crypto');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The ONLY database this tooling is ever allowed to write to. */
const SCRATCH_DB = 'psat-prep-db-drtest';

/** The production database. Named here solely so the guard can refuse it by name. */
const PROD_DB = 'psat-prep-db';

const COSMOS_ACCOUNT = 'psat-cosmos-15958';
const COSMOS_ENDPOINT = `https://${COSMOS_ACCOUNT}.documents.azure.com:443/`;

const BASELINE_CONTAINER = 'refactor-baseline';
const DEFAULT_BASELINE_FOLDER = 'baseline_2026-08-29T14-09-29Z';

/** Production container names + partition keys, reproduced exactly in the scratch DB. */
const CONTAINER_SPECS = [
  { name: 'Questions', partitionKey: '/domain', expectedCount: 3059 },
  { name: 'UATStudentAnswers', partitionKey: '/student_name', expectedCount: 10 },
  { name: 'UATFeedback', partitionKey: '/category', expectedCount: 0 }
];

/** Cosmos-managed fields that are regenerated on insert and must be ignored/stripped. */
const SYSTEM_FIELDS = ['_rid', '_self', '_etag', '_attachments', '_ts'];

const INSERT_CONCURRENCY = 20;
const MAX_RETRIES = 6;

const COSMOS_MODULE = path.join(__dirname, '..', 'api', 'node_modules', '@azure', 'cosmos');
const STORAGE_MODULE = path.join(__dirname, '..', 'api', 'node_modules', '@azure', 'storage-blob');

// ---------------------------------------------------------------------------
// Safety guard
// ---------------------------------------------------------------------------

/**
 * Hard guard on the write target. Throws unless `dbName` is exactly SCRATCH_DB.
 * Called before the Cosmos client is constructed and before every write. Exported so
 * it can be exercised offline (`--assert-test`) without touching Azure.
 *
 * @param {string} dbName database name a caller intends to write to
 * @param {string} [context] where the check is happening, for the error message
 * @returns {string} the validated database name
 */
function assertScratchTarget(dbName, context) {
  const where = context ? ` [${context}]` : '';
  if (dbName === PROD_DB) {
    throw new Error(
      `REFUSING TO PROCEED${where}: target database is the PRODUCTION database ` +
      `"${PROD_DB}". This tooling may only ever write to "${SCRATCH_DB}".`
    );
  }
  if (dbName !== SCRATCH_DB) {
    throw new Error(
      `REFUSING TO PROCEED${where}: target database "${dbName}" is not the scratch ` +
      `database "${SCRATCH_DB}". Only the scratch database may be written to.`
    );
  }
  return dbName;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. ` +
      'Credentials must come from the environment, never from argv.');
  }
  return value;
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase();
}

/** Removes the Cosmos-managed fields, returning a new object. */
function stripSystemFields(doc) {
  const out = {};
  for (const key of Object.keys(doc)) {
    if (!SYSTEM_FIELDS.includes(key)) out[key] = doc[key];
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSecs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Blob access
// ---------------------------------------------------------------------------

/**
 * Builds a BlobServiceClient from AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY.
 * @returns {{client: object, account: string}}
 */
function getBlobServiceClient() {
  const account = requireEnv('AZURE_STORAGE_ACCOUNT');
  const key = requireEnv('AZURE_STORAGE_KEY');
  const { BlobServiceClient, StorageSharedKeyCredential } = require(STORAGE_MODULE);
  const credential = new StorageSharedKeyCredential(account, key);
  const client = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential);
  return { client, account };
}

/** Downloads a blob fully into a Buffer. */
async function downloadBlobBuffer(blobServiceClient, containerName, blobName) {
  const blobClient = blobServiceClient.getContainerClient(containerName).getBlobClient(blobName);
  const buffer = await blobClient.downloadToBuffer();
  return buffer;
}

/**
 * Downloads one container export plus its `.sha256` sidecar, verifies the checksum
 * BEFORE parsing, and returns the parsed payload.
 *
 * Sidecar format written by WI-02: "<hex sha256>  <filename>\n" (two spaces).
 *
 * @throws if the sidecar is missing or the checksum does not match — never falls back
 *         to "restore it anyway".
 */
async function downloadAndVerifyExport(blobServiceClient, baselineFolder, containerName) {
  const blobName = `${baselineFolder}/cosmos/${containerName}.json`;
  const sidecarName = `${blobName}.sha256`;

  const [payloadBuf, sidecarBuf] = await Promise.all([
    downloadBlobBuffer(blobServiceClient, BASELINE_CONTAINER, blobName),
    downloadBlobBuffer(blobServiceClient, BASELINE_CONTAINER, sidecarName)
  ]);

  const sidecarText = sidecarBuf.toString('utf8').trim();
  const expectedSha = (sidecarText.split(/\s+/)[0] || '').toLowerCase();
  const sidecarFilename = sidecarText.split(/\s+/)[1] || '';
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
    throw new Error(`Sidecar ${sidecarName} does not contain a sha256: "${sidecarText}"`);
  }
  if (sidecarFilename && sidecarFilename !== `${containerName}.json`) {
    throw new Error(`Sidecar ${sidecarName} names a different file ("${sidecarFilename}").`);
  }

  const actualSha = sha256Hex(payloadBuf);
  if (actualSha !== expectedSha) {
    throw new Error(
      `CHECKSUM MISMATCH on ${blobName}: sidecar says ${expectedSha}, downloaded bytes ` +
      `hash to ${actualSha}. The baseline export is corrupt or truncated. Aborting — ` +
      'refusing to parse or restore unverified backup data.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(payloadBuf.toString('utf8'));
  } catch (err) {
    throw new Error(`${blobName} passed checksum but is not valid JSON: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.documents)) {
    throw new Error(`${blobName} has no "documents" array — unexpected export shape.`);
  }
  const meta = parsed.exportMetadata || {};
  if (typeof meta.exportedCount === 'number' && meta.exportedCount !== parsed.documents.length) {
    throw new Error(
      `${blobName}: exportMetadata.exportedCount=${meta.exportedCount} but the file holds ` +
      `${parsed.documents.length} documents.`
    );
  }

  return {
    blobName,
    bytes: payloadBuf.length,
    sha256: actualSha,
    documents: parsed.documents,
    exportMetadata: meta
  };
}

// ---------------------------------------------------------------------------
// Cosmos
// ---------------------------------------------------------------------------

function getCosmosClient() {
  const key = requireEnv('COSMOS_KEY');
  const { CosmosClient } = require(COSMOS_MODULE);
  return new CosmosClient({ endpoint: COSMOS_ENDPOINT, key });
}

function isRetryable(err) {
  const code = err && (err.code || err.statusCode);
  return code === 429 || code === 449 || code === 503 || code === 500 || code === 408;
}

/** Creates one document, retrying throttles/transients with exponential backoff. */
async function createWithRetry(container, doc) {
  let attempt = 0;
  for (;;) {
    try {
      await container.items.create(doc);
      return;
    } catch (err) {
      attempt += 1;
      if (attempt > MAX_RETRIES || !isRetryable(err)) {
        throw new Error(
          `Insert failed for doc id="${doc.id}" after ${attempt} attempt(s): ` +
          `${err.code || err.statusCode || '?'} ${err.message}`
        );
      }
      const retryAfter = Number(err.retryAfterInMs || err.retryAfterInMilliseconds || 0);
      const backoff = retryAfter > 0 ? retryAfter : Math.min(2000, 100 * 2 ** attempt);
      await sleep(backoff);
    }
  }
}

/** Runs `worker` over `items` with at most `limit` in flight. Rejects on first error. */
async function runBounded(items, limit, worker) {
  let cursor = 0;
  let firstError = null;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      if (firstError) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch (err) {
        if (!firstError) firstError = err;
        return;
      }
    }
  });
  await Promise.all(runners);
  if (firstError) throw firstError;
}

// ---------------------------------------------------------------------------
// Main restore
// ---------------------------------------------------------------------------

async function restore() {
  const baselineFolder = process.env.BASELINE_FOLDER || DEFAULT_BASELINE_FOLDER;

  // Guard #1 — before any client is constructed.
  assertScratchTarget(SCRATCH_DB, 'startup');

  console.log('======================================================================');
  console.log('WI-03 Restore baseline -> SCRATCH Cosmos database');
  console.log(`  Cosmos account : ${COSMOS_ACCOUNT}`);
  console.log(`  Target database: ${SCRATCH_DB}   (production "${PROD_DB}" is never written)`);
  console.log(`  Baseline folder: ${BASELINE_CONTAINER}/${baselineFolder}`);
  console.log(`  Started        : ${new Date().toISOString()}`);
  console.log('======================================================================');

  const overallStart = Date.now();

  // --- 1. Download + verify all three exports before touching Cosmos ----------
  const { client: blobServiceClient, account } = getBlobServiceClient();
  console.log(`\n--- Downloading + checksum-verifying exports from ${account} ---`);
  const exports = {};
  for (const spec of CONTAINER_SPECS) {
    const t0 = Date.now();
    const result = await downloadAndVerifyExport(blobServiceClient, baselineFolder, spec.name);
    exports[spec.name] = result;
    console.log(
      `  ✓ ${spec.name.padEnd(18)} ${String(result.documents.length).padStart(5)} docs  ` +
      `${String(result.bytes).padStart(8)} bytes  sha256 OK (${result.sha256.slice(0, 12)}…)  ` +
      `${formatSecs(Date.now() - t0)}`
    );
    if (result.documents.length !== spec.expectedCount) {
      throw new Error(
        `${spec.name}: expected ${spec.expectedCount} documents in the baseline export, ` +
        `got ${result.documents.length}. Refusing to restore an unexpected baseline.`
      );
    }
  }

  // --- 2. (Re)create the scratch database ------------------------------------
  const cosmos = getCosmosClient();
  assertScratchTarget(SCRATCH_DB, 'database create');

  const existing = cosmos.database(SCRATCH_DB);
  let alreadyThere = false;
  try {
    await existing.read();
    alreadyThere = true;
  } catch (err) {
    if ((err.code || err.statusCode) !== 404) throw err;
  }
  if (alreadyThere) {
    assertScratchTarget(SCRATCH_DB, 'database delete (pre-existing scratch)');
    console.log(`\n--- Scratch database ${SCRATCH_DB} already exists; deleting it for a clean restore ---`);
    await cosmos.database(SCRATCH_DB).delete();
    console.log('  ✓ deleted');
  }

  console.log(`\n--- Creating database ${SCRATCH_DB} ---`);
  const dbStart = Date.now();
  const { database } = await cosmos.databases.create({ id: SCRATCH_DB });
  if (database.id !== SCRATCH_DB) {
    throw new Error(`Created database id "${database.id}" != "${SCRATCH_DB}" — aborting.`);
  }
  console.log(`  ✓ created in ${formatSecs(Date.now() - dbStart)}`);

  // --- 3. Containers ----------------------------------------------------------
  console.log('\n--- Creating containers ---');
  const containers = {};
  for (const spec of CONTAINER_SPECS) {
    assertScratchTarget(database.id, `container create ${spec.name}`);
    const t0 = Date.now();
    const { container } = await database.containers.create({
      id: spec.name,
      partitionKey: { paths: [spec.partitionKey] }
    });
    containers[spec.name] = container;
    console.log(`  ✓ ${spec.name.padEnd(18)} pk=${spec.partitionKey.padEnd(15)} ${formatSecs(Date.now() - t0)}`);
  }

  // --- 4. Insert --------------------------------------------------------------
  console.log(`\n--- Inserting documents (concurrency ${INSERT_CONCURRENCY}, 429 retry/backoff) ---`);
  const summary = [];
  for (const spec of CONTAINER_SPECS) {
    assertScratchTarget(database.id, `insert into ${spec.name}`);
    const docs = exports[spec.name].documents.map(stripSystemFields);
    const t0 = Date.now();
    let done = 0;
    await runBounded(docs, INSERT_CONCURRENCY, async (doc) => {
      await createWithRetry(containers[spec.name], doc);
      done += 1;
      if (done % 500 === 0) {
        console.log(`      … ${done}/${docs.length} ${spec.name} (${formatSecs(Date.now() - t0)})`);
      }
    });
    const elapsed = Date.now() - t0;
    summary.push({ container: spec.name, inserted: done, expected: spec.expectedCount, ms: elapsed });
    console.log(
      `  ✓ ${spec.name.padEnd(18)} inserted ${String(done).padStart(5)}/${spec.expectedCount} ` +
      `in ${formatSecs(elapsed)}` +
      (done > 0 ? ` (${(done / (elapsed / 1000)).toFixed(1)} docs/s)` : '')
    );
    if (done !== spec.expectedCount) {
      throw new Error(`${spec.name}: inserted ${done} but expected ${spec.expectedCount}.`);
    }
  }

  // --- 5. Immediate post-insert count check -----------------------------------
  console.log('\n--- Post-insert COUNT(1) verification against the scratch DB ---');
  for (const spec of CONTAINER_SPECS) {
    const { resources } = await containers[spec.name].items
      .query('SELECT VALUE COUNT(1) FROM c').fetchAll();
    const live = resources[0];
    console.log(`  ${spec.name.padEnd(18)} ${live} docs in ${SCRATCH_DB} (expected ${spec.expectedCount})`);
    if (live !== spec.expectedCount) {
      throw new Error(`${spec.name}: scratch DB holds ${live} docs, expected ${spec.expectedCount}.`);
    }
  }

  console.log('\n======================================================================');
  console.log(`RESTORE COMPLETE in ${formatSecs(Date.now() - overallStart)}`);
  for (const row of summary) {
    console.log(`  ${row.container.padEnd(18)} ${row.inserted}/${row.expected} docs  ${formatSecs(row.ms)}`);
  }
  console.log(`Next: node scripts/reconcile_restore.js`);
  console.log('======================================================================');
  return summary;
}

// ---------------------------------------------------------------------------
// Offline safety-assert self test (no network, no credentials)
// ---------------------------------------------------------------------------

function assertSelfTest() {
  console.log('--- Safety-assert self test (offline: no Cosmos/Storage connection) ---');
  let failures = 0;

  const mustThrow = (value, label) => {
    try {
      assertScratchTarget(value, 'self-test');
      console.log(`  ✗ FAIL ${label}: assertScratchTarget(${JSON.stringify(value)}) did NOT throw`);
      failures += 1;
    } catch (err) {
      console.log(`  ✓ PASS ${label}: threw — ${err.message.split('\n')[0]}`);
    }
  };

  mustThrow(PROD_DB, 'production database name');
  mustThrow('psat-prep-db ', 'production name with trailing space');
  mustThrow('PSAT-PREP-DB-DRTEST', 'wrong case');
  mustThrow('', 'empty string');
  mustThrow(undefined, 'undefined');
  mustThrow('psat-prep-db-drtest2', 'near-miss name');

  try {
    const ok = assertScratchTarget(SCRATCH_DB, 'self-test');
    if (ok === SCRATCH_DB) {
      console.log(`  ✓ PASS scratch name accepted: ${SCRATCH_DB}`);
    } else {
      console.log('  ✗ FAIL scratch name returned wrong value');
      failures += 1;
    }
  } catch (err) {
    console.log(`  ✗ FAIL scratch name was rejected: ${err.message}`);
    failures += 1;
  }

  console.log(failures === 0 ? '--- Safety-assert self test: ALL PASS ---'
    : `--- Safety-assert self test: ${failures} FAILURE(S) ---`);
  return failures;
}

// ---------------------------------------------------------------------------

if (require.main === module) {
  if (process.argv.includes('--assert-test')) {
    process.exit(assertSelfTest() === 0 ? 0 : 1);
  }
  restore().then(
    () => process.exit(0),
    (err) => {
      console.error(`\nFATAL: ${err.message}`);
      process.exit(1);
    }
  );
}

module.exports = {
  SCRATCH_DB,
  PROD_DB,
  COSMOS_ACCOUNT,
  COSMOS_ENDPOINT,
  BASELINE_CONTAINER,
  DEFAULT_BASELINE_FOLDER,
  CONTAINER_SPECS,
  SYSTEM_FIELDS,
  COSMOS_MODULE,
  STORAGE_MODULE,
  assertScratchTarget,
  assertSelfTest,
  requireEnv,
  sha256Hex,
  stripSystemFields,
  getBlobServiceClient,
  getCosmosClient,
  downloadBlobBuffer,
  downloadAndVerifyExport,
  runBounded,
  restore
};
