#!/usr/bin/env node
/**
 * scripts/export_questions_container.js
 *
 * Read-only export of the Cosmos `Questions` container (database psat-prep-db,
 * partition key /domain, expected 3,059 docs) to a single checksummed JSON file.
 *
 * Written for WI-02 (full-scope baseline snapshot): scripts/full_baseline_snapshot.sh
 * shells out to this file to produce the Questions export, exactly the way it reuses
 * scripts/backup_cosmos.js for the UATStudentAnswers/UATFeedback exports. Never writes
 * to Cosmos — SELECT-only queries.
 *
 * Self-verification: this script fetches a live `SELECT VALUE COUNT(1)` from the same
 * container immediately before/after paging through `SELECT * FROM c`, and refuses to
 * write an export whose document count does not match that live count (CLAUDE.md mode
 * 5 — no swallowed errors; a pagination bug must fail loudly, not silently produce a
 * short export labeled as complete).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

/** Live count via SELECT VALUE COUNT(1) FROM c — independent of the paged fetch below. */
async function getLiveCount(container) {
  const { resources } = await container.items.query('SELECT VALUE COUNT(1) FROM c').fetchAll();
  return resources[0];
}

/** Fetches every document in the container via SELECT * FROM c (auto-paginated by the SDK). */
async function fetchAllDocuments(container) {
  const { resources } = await container.items.query('SELECT * FROM c').fetchAll();
  return resources || [];
}

/** Builds the export payload: metadata + the raw document array. */
function buildExportPayload({ containerName, dbName, documents, liveCount, now }) {
  return {
    exportMetadata: {
      generatedAt: now.toISOString(),
      database: dbName,
      container: containerName,
      exportedCount: documents.length,
      liveCountAtRunTime: liveCount
    },
    documents
  };
}

/**
 * Serializes the payload and computes its sha256 sidecar content, in the same
 * "<sha256>  <filename>\n" format (two spaces) used by scripts/backup_cosmos.js.
 */
function serializeExport(payload, filename) {
  const payloadString = JSON.stringify(payload, null, 2);
  const payloadBuffer = Buffer.from(payloadString, 'utf8');
  const sha256 = crypto.createHash('sha256').update(payloadBuffer).digest('hex');
  const sidecarContent = `${sha256}  ${filename}\n`;
  return { payloadString, payloadBuffer, sha256, sidecarContent };
}

/**
 * Fetches, validates, and writes a checksummed export of `containerName`.
 * `database` is a Cosmos database handle (real or fake — matches the shape used by
 * scripts/backup_cosmos.js's tests). Throws (never swallows) on a live-count mismatch
 * or a zero-document result, since both would mean the export cannot be trusted.
 */
async function runExport(database, {
  dbName,
  containerName = 'Questions',
  outputPath,
  now = new Date(),
  fsImpl = fs,
  log = console.log
} = {}) {
  const container = database.container(containerName);

  log(`Querying live COUNT(1) for ${containerName} ...`);
  const liveCount = await getLiveCount(container);

  log(`Fetching all documents from ${containerName} ...`);
  const documents = await fetchAllDocuments(container);

  if (documents.length !== liveCount) {
    throw new Error(
      `Export aborted: ${containerName} exported ${documents.length} document(s) but live ` +
      `SELECT VALUE COUNT(1) reports ${liveCount}. Refusing to write a mismatched export.`
    );
  }
  if (documents.length === 0) {
    throw new Error(`Export aborted: ${containerName} returned 0 documents. Refusing to write an empty export as if it were real.`);
  }

  const payload = buildExportPayload({ containerName, dbName, documents, liveCount, now });
  const filename = path.basename(outputPath);
  const { payloadString, sha256, sidecarContent } = serializeExport(payload, filename);

  const dir = path.dirname(outputPath);
  if (!fsImpl.existsSync(dir)) {
    fsImpl.mkdirSync(dir, { recursive: true });
  }
  fsImpl.writeFileSync(outputPath, payloadString, 'utf8');
  const sidecarPath = `${outputPath}.sha256`;
  fsImpl.writeFileSync(sidecarPath, sidecarContent, 'utf8');

  log(`✓ Exported ${documents.length} ${containerName} document(s) to ${outputPath}`);
  log(`✓ SHA-256 sidecar written to: ${sidecarPath} (${sha256.substring(0, 16)}...)`);

  return { outputPath, sidecarPath, sha256, count: documents.length, liveCount };
}

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) {
    console.error('Usage: node export_questions_container.js <outputPath>');
    process.exit(1);
  }

  let key = process.env.COSMOS_KEY;
  if (!key) {
    try {
      key = execSync(
        'az cosmosdb keys list --name psat-cosmos-15958 --resource-group rg-psat-prep --query primaryMasterKey -o tsv'
      ).toString().trim();
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

  const result = await runExport(database, { dbName, containerName: 'Questions', outputPath });

  // Machine-parseable lines for scripts/full_baseline_snapshot.sh to grep.
  console.log(`QUESTIONS_EXPORT_COUNT=${result.count}`);
  console.log(`QUESTIONS_LIVE_COUNT=${result.liveCount}`);
  console.log(`QUESTIONS_SHA256=${result.sha256}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Questions export failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  getLiveCount,
  fetchAllDocuments,
  buildExportPayload,
  serializeExport,
  runExport
};
