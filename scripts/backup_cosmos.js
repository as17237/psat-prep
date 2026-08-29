#!/usr/bin/env node
/**
 * scripts/backup_cosmos.js
 * Automated backup utility for Azure Cosmos DB (psat-prep-db).
 * Exports master student profiles, SRS states, sessions, and all longitudinal exam sessions to timestamped JSON files.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { CosmosClient } = require('../api/node_modules/@azure/cosmos');

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
  const containerName = process.env.COSMOS_CONTAINER_NAME || 'UATStudentAnswers';

  const client = new CosmosClient({ endpoint, key });
  const container = client.database(dbName).container(containerName);

  console.log(`Connecting to ${endpoint} (${dbName} / ${containerName})...`);
  const { resources: allDocs } = await container.items.query('SELECT * FROM c').fetchAll();
  
  if (!Array.isArray(allDocs) || allDocs.length === 0) {
    console.error(`❌ Backup aborted: Query returned 0 documents from ${containerName}. Refusing to overwrite latest backup.`);
    process.exit(1);
  }
  console.log(`Successfully fetched ${allDocs.length} total documents.`);

  const now = new Date();
  const timestampStr = now.toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const crypto = require('crypto');
  const backupFilename = `cosmos_backup_${timestampStr}.json`;
  const backupPath = path.join(backupDir, backupFilename);
  const sidecarPath = path.join(backupDir, `${backupFilename}.sha256`);

  const payloadString = JSON.stringify(backupPayload, null, 2);
  const payloadBuffer = Buffer.from(payloadString, 'utf8');
  const sha256 = crypto.createHash('sha256').update(payloadBuffer).digest('hex');

  fs.writeFileSync(backupPath, payloadString, 'utf8');
  fs.writeFileSync(sidecarPath, `${sha256}  ${backupFilename}\n`, 'utf8');
  console.log(`✓ Backup successfully written to: ${backupPath} (${Math.round(payloadBuffer.length / 1024)} KB)`);
  console.log(`✓ SHA-256 sidecar written to: ${sidecarPath} (${sha256.substring(0, 16)}...)`);

  // Also maintain a 'latest.json' pointer and sidecar
  const latestPath = path.join(backupDir, 'cosmos_backup_latest.json');
  const latestSidecarPath = path.join(backupDir, 'cosmos_backup_latest.json.sha256');
  fs.copyFileSync(backupPath, latestPath);
  fs.copyFileSync(sidecarPath, latestSidecarPath);
  console.log(`✓ Updated pointers: ${latestPath} & ${latestSidecarPath}`);

  return backupPath;
}

if (require.main === module) {
  runBackup().catch(err => {
    console.error('Backup failed:', err);
    process.exit(1);
  });
}

module.exports = { runBackup };
