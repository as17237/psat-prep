#!/usr/bin/env node
/**
 * scripts/restore_cosmos.js
 * Restores a snapshot JSON backup into Azure Cosmos DB.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { CosmosClient } = require('../api/node_modules/@azure/cosmos');

async function runRestore(specifiedFile) {
  console.log('--- Starting Azure Cosmos DB Restore ---');
  
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

  const backupPath = specifiedFile || path.join(__dirname, '..', 'backups', 'cosmos_backup_latest.json');
  if (!fs.existsSync(backupPath)) {
    console.error(`Backup file not found at: ${backupPath}`);
    process.exit(1);
  }

  console.log(`Reading backup file from: ${backupPath}...`);
  const raw = fs.readFileSync(backupPath, 'utf8');
  const parsed = JSON.parse(raw);
  const docs = parsed.documents || (Array.isArray(parsed) ? parsed : [parsed]);

  console.log(`Restoring ${docs.length} documents into Cosmos DB container (${containerName})...`);
  for (const doc of docs) {
    if (doc && doc.id) {
      await container.items.upsert(doc);
      console.log(`  ✓ Restored document ID: ${doc.id} (type: ${doc.doc_type || 'unknown'})`);
    }
  }

  console.log(`✓ Restore complete! ${docs.length} documents safely upserted.`);
}

if (require.main === module) {
  const target = process.argv[2];
  runRestore(target).catch(err => {
    console.error('Restore failed:', err);
    process.exit(1);
  });
}

module.exports = { runRestore };
