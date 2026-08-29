#!/usr/bin/env node
/**
 * scripts/reconcile_restore.js — WI-03 restore verification (part 2 of 2)
 * ============================================================================
 * Independently proves that what is actually sitting in the scratch database matches
 * the baseline snapshot, byte for byte and field for field. This script deliberately
 * re-downloads the exports itself rather than trusting anything the restore script
 * held in memory — a reconciler that reuses the restorer's own data would only be
 * comparing the implementation to itself (CLAUDE.md failure mode 4).
 *
 * Checks performed:
 *   1. Re-download the three Cosmos exports + `.sha256` sidecars; verify checksums
 *      BEFORE parsing (hard fail on mismatch).
 *   2. Read every document back out of `psat-prep-db-drtest`.
 *   3. Per container: doc-count equality, zero missing ids, zero extra ids, and
 *      order-independent deep JSON equality per document ignoring Cosmos system fields.
 *   4. 20 randomly sampled image blobs from the baseline `images/` folder are
 *      byte-compared against their live `$web/data/images/` originals.
 *
 * Exits 0 only if every check passes; nonzero (with a per-failure listing) otherwise.
 *
 * READ-ONLY everywhere: it never writes to Cosmos or to any blob. It reads the scratch
 * database only; the shared `assertScratchTarget` guard still refuses any name other
 * than `psat-prep-db-drtest`, so it cannot even be pointed at production.
 *
 * Credentials from the environment only (never argv):
 *   COSMOS_KEY, AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_KEY
 * Optional: BASELINE_FOLDER, IMAGE_SAMPLE_SIZE (default 20).
 *
 * Usage:
 *   node scripts/reconcile_restore.js
 *   node scripts/reconcile_restore.js --assert-test    # offline safety check
 */

'use strict';

const common = require('./restore_baseline_to_scratch.js');

const {
  SCRATCH_DB,
  PROD_DB,
  COSMOS_ACCOUNT,
  BASELINE_CONTAINER,
  DEFAULT_BASELINE_FOLDER,
  CONTAINER_SPECS,
  SYSTEM_FIELDS,
  assertScratchTarget,
  assertSelfTest,
  stripSystemFields,
  getBlobServiceClient,
  getCosmosClient,
  downloadBlobBuffer,
  downloadAndVerifyExport
} = common;

const WEB_CONTAINER = '$web';
const DEFAULT_IMAGE_SAMPLE_SIZE = 20;

/** Max individual differences printed per container before truncating the listing. */
const MAX_DIFF_DETAIL = 10;

// ---------------------------------------------------------------------------
// Deep comparison
// ---------------------------------------------------------------------------

/**
 * Order-independent deep equality. Returns a list of dotted paths that differ, so a
 * failure says *what* changed rather than just "not equal".
 *
 * Objects compare by key set + value; arrays compare positionally (document arrays such
 * as `options` are order-significant). Cosmos system fields are never reached because
 * both sides are stripped before comparison.
 */
function diffPaths(expected, actual, prefix = '', out = []) {
  if (out.length > 200) return out; // bound the report; the first 200 are plenty

  const te = typeOf(expected);
  const ta = typeOf(actual);
  if (te !== ta) {
    out.push(`${prefix || '<root>'}: type ${te} -> ${ta}`);
    return out;
  }

  if (te === 'array') {
    if (expected.length !== actual.length) {
      out.push(`${prefix}: array length ${expected.length} -> ${actual.length}`);
      return out;
    }
    for (let i = 0; i < expected.length; i += 1) {
      diffPaths(expected[i], actual[i], `${prefix}[${i}]`, out);
    }
    return out;
  }

  if (te === 'object') {
    const keysE = Object.keys(expected).sort();
    const keysA = Object.keys(actual).sort();
    for (const k of keysE) {
      if (!Object.prototype.hasOwnProperty.call(actual, k)) {
        out.push(`${prefix ? `${prefix}.` : ''}${k}: missing in restored doc`);
      }
    }
    for (const k of keysA) {
      if (!Object.prototype.hasOwnProperty.call(expected, k)) {
        out.push(`${prefix ? `${prefix}.` : ''}${k}: unexpected extra field in restored doc`);
      }
    }
    for (const k of keysE) {
      if (Object.prototype.hasOwnProperty.call(actual, k)) {
        diffPaths(expected[k], actual[k], `${prefix ? `${prefix}.` : ''}${k}`, out);
      }
    }
    return out;
  }

  // primitives (string/number/boolean/null)
  if (expected !== actual) {
    out.push(`${prefix || '<root>'}: ${short(expected)} -> ${short(actual)}`);
  }
  return out;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function short(v) {
  const s = typeof v === 'string' ? JSON.stringify(v) : String(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

// ---------------------------------------------------------------------------
// Cosmos read-back
// ---------------------------------------------------------------------------

async function readAllDocs(container) {
  const docs = [];
  const iterator = container.items.readAll({ maxItemCount: 200 }).getAsyncIterator();
  for await (const page of iterator) {
    for (const doc of page.resources) docs.push(doc);
  }
  return docs;
}

// ---------------------------------------------------------------------------
// Image byte verification
// ---------------------------------------------------------------------------

async function listBaselineImageBlobs(blobServiceClient, baselineFolder) {
  const prefix = `${baselineFolder}/images/data/images/`;
  const containerClient = blobServiceClient.getContainerClient(BASELINE_CONTAINER);
  const names = [];
  for await (const blob of containerClient.listBlobsFlat({ prefix })) {
    names.push(blob.name);
  }
  return { prefix, names };
}

function pickRandom(arr, n) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

async function verifyImageSamples(blobServiceClient, baselineFolder, sampleSize) {
  const { prefix, names } = await listBaselineImageBlobs(blobServiceClient, baselineFolder);
  console.log(`  baseline image blobs under ${prefix}: ${names.length}`);
  if (names.length === 0) {
    throw new Error(`No image blobs found under ${BASELINE_CONTAINER}/${prefix}.`);
  }

  const sample = pickRandom(names, sampleSize);
  let matched = 0;
  const failures = [];

  for (const baselineName of sample) {
    const relative = baselineName.slice(`${baselineFolder}/images/`.length); // data/images/<file>.png
    const [baselineBuf, webBuf] = await Promise.all([
      downloadBlobBuffer(blobServiceClient, BASELINE_CONTAINER, baselineName),
      downloadBlobBuffer(blobServiceClient, WEB_CONTAINER, relative)
    ]);
    if (baselineBuf.length === webBuf.length && baselineBuf.equals(webBuf)) {
      matched += 1;
      console.log(`    ✓ ${relative}  ${baselineBuf.length} bytes identical`);
    } else {
      failures.push(
        `${relative}: baseline ${baselineBuf.length} bytes vs $web ${webBuf.length} bytes — BYTES DIFFER`
      );
      console.log(`    ✗ ${relative}  baseline ${baselineBuf.length}B vs $web ${webBuf.length}B MISMATCH`);
    }
  }

  return { total: names.length, sampled: sample.length, matched, failures };
}

// ---------------------------------------------------------------------------
// Main reconcile
// ---------------------------------------------------------------------------

async function reconcile() {
  const baselineFolder = process.env.BASELINE_FOLDER || DEFAULT_BASELINE_FOLDER;
  const sampleSize = Number(process.env.IMAGE_SAMPLE_SIZE || DEFAULT_IMAGE_SAMPLE_SIZE);

  // Guard: this script only ever reads the scratch DB; refuse anything else by name.
  assertScratchTarget(SCRATCH_DB, 'reconcile startup');

  console.log('======================================================================');
  console.log('WI-03 Reconcile: scratch restore  vs  baseline snapshot');
  console.log(`  Cosmos account : ${COSMOS_ACCOUNT}`);
  console.log(`  Database read  : ${SCRATCH_DB}   (production "${PROD_DB}" untouched)`);
  console.log(`  Baseline folder: ${BASELINE_CONTAINER}/${baselineFolder}`);
  console.log(`  Started        : ${new Date().toISOString()}`);
  console.log('======================================================================');

  const started = Date.now();
  const problems = [];
  const { client: blobServiceClient } = getBlobServiceClient();
  const cosmos = getCosmosClient();
  const database = cosmos.database(SCRATCH_DB);

  // --- Cosmos containers ------------------------------------------------------
  console.log('\n--- Container reconciliation ---');
  const perContainer = [];

  for (const spec of CONTAINER_SPECS) {
    console.log(`\n[${spec.name}]  pk=${spec.partitionKey}`);

    // (a) independently re-download + verify the export
    const exported = await downloadAndVerifyExport(blobServiceClient, baselineFolder, spec.name);
    console.log(`  export: ${exported.documents.length} docs, sha256 verified ${exported.sha256.slice(0, 16)}…`);

    // (b) confirm the container exists with the right partition key
    const container = database.container(spec.name);
    let pkPaths = [];
    try {
      const { resource } = await container.read();
      pkPaths = (resource.partitionKey && resource.partitionKey.paths) || [];
    } catch (err) {
      problems.push(`${spec.name}: container missing from ${SCRATCH_DB} (${err.code || err.statusCode})`);
      console.log(`  ✗ container not found in ${SCRATCH_DB}`);
      perContainer.push({ name: spec.name, expected: exported.documents.length, actual: 0, missing: exported.documents.length, extra: 0, mismatched: 0 });
      continue;
    }
    const pkOk = pkPaths.length === 1 && pkPaths[0] === spec.partitionKey;
    console.log(`  partition key in scratch: ${JSON.stringify(pkPaths)} ${pkOk ? '✓' : '✗ EXPECTED ' + spec.partitionKey}`);
    if (!pkOk) problems.push(`${spec.name}: partition key ${JSON.stringify(pkPaths)} != ${spec.partitionKey}`);

    // (c) read every restored doc back
    const restored = await readAllDocs(container);
    console.log(`  counts: baseline ${exported.documents.length} / restored ${restored.length}`);
    if (restored.length !== exported.documents.length) {
      problems.push(
        `${spec.name}: doc count ${restored.length} != baseline ${exported.documents.length}`
      );
    }

    // (d) index both sides by id and deep-compare
    const expectedById = new Map();
    for (const doc of exported.documents) {
      if (expectedById.has(doc.id)) {
        problems.push(`${spec.name}: baseline export contains duplicate id "${doc.id}"`);
      }
      expectedById.set(doc.id, stripSystemFields(doc));
    }
    const restoredById = new Map();
    for (const doc of restored) {
      if (restoredById.has(doc.id)) {
        problems.push(`${spec.name}: scratch DB contains duplicate id "${doc.id}"`);
      }
      restoredById.set(doc.id, stripSystemFields(doc));
    }

    const missing = [];
    const extra = [];
    const mismatched = [];

    for (const [id, expectedDoc] of expectedById) {
      const actualDoc = restoredById.get(id);
      if (!actualDoc) {
        missing.push(id);
        continue;
      }
      const diffs = diffPaths(expectedDoc, actualDoc);
      if (diffs.length > 0) mismatched.push({ id, diffs });
    }
    for (const id of restoredById.keys()) {
      if (!expectedById.has(id)) extra.push(id);
    }

    console.log(`  missing (in baseline, absent from scratch): ${missing.length}`);
    console.log(`  extra   (in scratch, absent from baseline): ${extra.length}`);
    console.log(`  deep-equal failures: ${mismatched.length}`);

    for (const id of missing.slice(0, MAX_DIFF_DETAIL)) console.log(`    - MISSING id=${id}`);
    for (const id of extra.slice(0, MAX_DIFF_DETAIL)) console.log(`    - EXTRA   id=${id}`);
    for (const m of mismatched.slice(0, MAX_DIFF_DETAIL)) {
      console.log(`    - MISMATCH id=${m.id}`);
      for (const d of m.diffs.slice(0, 5)) console.log(`        ${d}`);
      if (m.diffs.length > 5) console.log(`        …and ${m.diffs.length - 5} more field diff(s)`);
    }
    if (missing.length + extra.length + mismatched.length > MAX_DIFF_DETAIL) {
      console.log('    (listing truncated)');
    }

    if (missing.length) problems.push(`${spec.name}: ${missing.length} missing document(s)`);
    if (extra.length) problems.push(`${spec.name}: ${extra.length} extra document(s)`);
    if (mismatched.length) problems.push(`${spec.name}: ${mismatched.length} document(s) failed deep equality`);

    perContainer.push({
      name: spec.name,
      expected: exported.documents.length,
      actual: restored.length,
      missing: missing.length,
      extra: extra.length,
      mismatched: mismatched.length
    });
  }

  // --- Images -----------------------------------------------------------------
  console.log(`\n--- Image byte verification (${sampleSize} random samples: baseline vs $web) ---`);
  const images = await verifyImageSamples(blobServiceClient, baselineFolder, sampleSize);
  for (const f of images.failures) problems.push(`image: ${f}`);
  if (images.sampled < sampleSize) {
    problems.push(`image: only ${images.sampled} blobs available to sample, wanted ${sampleSize}`);
  }

  // --- Summary ----------------------------------------------------------------
  const totalMismatch = perContainer.reduce((s, c) => s + c.mismatched, 0);
  const totalMissing = perContainer.reduce((s, c) => s + c.missing, 0);
  const totalExtra = perContainer.reduce((s, c) => s + c.extra, 0);

  console.log('\n======================================================================');
  console.log('RECONCILE SUMMARY');
  console.log(`  containers checked : ${perContainer.length}/${CONTAINER_SPECS.length}`);
  for (const c of perContainer) {
    console.log(
      `  ${c.name.padEnd(18)} docs ${c.actual}/${c.expected}  missing ${c.missing}  ` +
      `extra ${c.extra}  deep-equal failures ${c.mismatched}`
    );
  }
  console.log(`  deep-equal failures (all containers): ${totalMismatch}`);
  console.log(`  missing: ${totalMissing}   extra: ${totalExtra}`);
  console.log(`  images  : ${images.matched}/${images.sampled} byte-identical (of ${images.total} baseline blobs)`);
  console.log(`  elapsed : ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (problems.length === 0) {
    console.log('  RESULT  : PASS — restored scratch DB matches the baseline exactly.');
    console.log('======================================================================');
    return 0;
  }

  console.log(`  RESULT  : FAIL — ${problems.length} problem(s):`);
  for (const p of problems) console.log(`     • ${p}`);
  console.log('======================================================================');
  return 1;
}

// ---------------------------------------------------------------------------

if (require.main === module) {
  if (process.argv.includes('--assert-test')) {
    // Reuses the same guard the restore script uses — one implementation, one test.
    process.exit(assertSelfTest() === 0 ? 0 : 1);
  }
  reconcile().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`\nFATAL: ${err.message}`);
      process.exit(1);
    }
  );
}

module.exports = { diffPaths, reconcile, SYSTEM_FIELDS };
