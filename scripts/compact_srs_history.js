#!/usr/bin/env node
/**
 * scripts/compact_srs_history.js — WI-11 one-time server-side SRS compaction.
 *
 * WHAT IT DOES
 *   Walks every `student_master_profile` document in Cosmos `UATStudentAnswers`
 *   and, per SRS card:
 *     - computes the durable summaries (totalReviews / totalLapses /
 *       firstReviewedAt / lastReviewedAt) with the SAME engine function the app
 *       uses, PSAT_ENGINE.summarizeSrsCard — not a re-implementation;
 *     - trims `history` to the newest PSAT_ENGINE.SRS_HISTORY_CAP (20) events.
 *   Nothing else on the card, and nothing else in the document, is touched. No
 *   document is ever deleted, and no field is ever removed.
 *
 * DRY RUN IS THE DEFAULT. With no flags it performs ZERO writes: it prints, per
 * changed card, the history length before and after and the summaries it would
 * write, then a per-document and overall total. Run it, read it, and only then
 * decide.
 *
 * APPLYING REQUIRES TWO THINGS, BOTH CHECKED HERE, NOT ASSUMED:
 *   --apply                 explicit opt-in, and
 *   --backup <blob-name>    the name of a backup blob in `cosmos-backups` that
 *                           this script VERIFIES exists and was last modified
 *                           TODAY (UTC). A stale or absent backup is a hard
 *                           failure; there is no override flag.
 * A card is only written back if it actually changes, and each write is a
 * targeted upsert of the whole (already-read) document with only srsState
 * modified — the same shape POST /api/sync writes.
 *
 * PROTECTED BY DESIGN (REFACTOR_PLAN.md §3): this script never touches an
 * `exam_session` document, never deletes a blob, and never writes anything at
 * all without --apply.
 *
 * Credentials: COSMOS_KEY / AZURE_STORAGE_KEY from the environment if set,
 * otherwise via the already-logged-in `az` CLI. Never on argv (CLAUDE.md mode 7).
 *
 * Usage:
 *   node scripts/compact_srs_history.js                                  # dry run (default)
 *   node scripts/compact_srs_history.js --student default_student        # dry run, one student
 *   node scripts/compact_srs_history.js --apply --backup <blob-name>     # writes; human-approved step
 */
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const PSAT_ENGINE = require(path.join(REPO, 'srs.js'));
const { CosmosClient } = require(path.join(REPO, 'api', 'node_modules', '@azure', 'cosmos'));

const COSMOS_ACCOUNT = 'psat-cosmos-15958';
const RESOURCE_GROUP = 'rg-psat-prep';
const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT || `https://${COSMOS_ACCOUNT}.documents.azure.com:443/`;
const DB_NAME = process.env.COSMOS_DB_NAME || 'psat-prep-db';
const STUDENT_CONTAINER = 'UATStudentAnswers';
const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT || 'psatprep4915';
const BACKUP_CONTAINER = 'cosmos-backups';

const CAP = PSAT_ENGINE.SRS_HISTORY_CAP;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : null;
}
const APPLY = argv.indexOf('--apply') !== -1;
const BACKUP_NAME = flagValue('--backup');
const ONLY_STUDENT = flagValue('--student');

function azTsv(command, what) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(`Could not obtain ${what} via the Azure CLI (is \`az login\` current?): ${e.message}`);
  }
}

/**
 * Proves the named backup blob exists AND was written today (UTC).
 * A compaction is only reversible if there is a same-day restore point; accepting
 * yesterday's backup would silently widen the recovery window by a day of writes.
 */
function verifySameDayBackup(blobName) {
  const key = process.env.AZURE_STORAGE_KEY ||
    azTsv(`az storage account keys list --account-name ${STORAGE_ACCOUNT} --resource-group ${RESOURCE_GROUP} --query '[0].value' -o tsv`, 'the storage key');
  let lastModified;
  try {
    lastModified = execSync(
      `az storage blob show --account-name ${STORAGE_ACCOUNT} --container-name ${BACKUP_CONTAINER} ` +
      `--name ${JSON.stringify(blobName)} --query properties.lastModified -o tsv`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { AZURE_STORAGE_KEY: key }) }
    ).trim();
  } catch (e) {
    throw new Error(`--backup blob "${blobName}" was not found in the ${BACKUP_CONTAINER} container. ` +
      'Take a preflight backup first (./scripts/preflight_backup.sh) and pass the filename it prints.');
  }
  const modifiedDay = new Date(lastModified).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  if (modifiedDay !== today) {
    throw new Error(`--backup blob "${blobName}" was last modified ${modifiedDay}, but today is ${today}. ` +
      'Compaction requires a backup taken the same day. Take a fresh one and re-run.');
  }
  return { blobName, lastModified };
}

// ---------------------------------------------------------------------------
// The per-card plan. PURE — it decides, it does not write.
// ---------------------------------------------------------------------------
function planCard(card) {
  const history = Array.isArray(card && card.history) ? card.history : [];
  const summary = PSAT_ENGINE.summarizeSrsCard(card);
  const before = history.length;
  const after = Math.min(before, CAP);

  const summariesChange =
    card.totalReviews !== summary.totalReviews ||
    card.totalLapses !== summary.totalLapses ||
    card.firstReviewedAt !== summary.firstReviewedAt ||
    card.lastReviewedAt !== summary.lastReviewedAt;

  if (before === after && !summariesChange) return null;

  return {
    historyBefore: before,
    historyAfter: after,
    trimmed: before - after,
    summary: summary,
    card: Object.assign({}, card, {
      history: before > CAP ? history.slice(-CAP) : history,
      totalReviews: summary.totalReviews,
      totalLapses: summary.totalLapses,
      firstReviewedAt: summary.firstReviewedAt,
      lastReviewedAt: summary.lastReviewedAt
    })
  };
}

// ---------------------------------------------------------------------------
(async function main() {
  console.log('WI-11 SRS history compaction');
  console.log('============================');
  console.log(`Mode ............... ${APPLY ? 'APPLY (writes enabled)' : 'DRY RUN (default; no writes)'}`);
  console.log(`History cap ........ ${CAP} events/card (PSAT_ENGINE.SRS_HISTORY_CAP)`);
  console.log(`Container .......... ${DB_NAME}/${STUDENT_CONTAINER}`);
  if (ONLY_STUDENT) console.log(`Student filter ..... ${ONLY_STUDENT}`);

  if (APPLY) {
    if (!BACKUP_NAME) {
      console.error('\n✗ --apply requires --backup <blob-name> naming a backup taken TODAY. Refusing to write.');
      process.exit(2);
    }
    const verified = verifySameDayBackup(BACKUP_NAME);
    console.log(`Backup verified .... ${verified.blobName} (lastModified ${verified.lastModified})`);
  } else if (BACKUP_NAME) {
    console.log(`Backup named ....... ${BACKUP_NAME} (not verified: dry run performs no writes)`);
  }
  console.log('');

  const key = process.env.COSMOS_KEY ||
    azTsv(`az cosmosdb keys list --name ${COSMOS_ACCOUNT} --resource-group ${RESOURCE_GROUP} --query primaryMasterKey -o tsv`, 'the Cosmos key');
  const container = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key }).database(DB_NAME).container(STUDENT_CONTAINER);

  const { resources } = await container.items
    .query("SELECT * FROM c WHERE c.doc_type = 'student_master_profile'")
    .fetchAll();

  let totalCards = 0;
  let totalChanged = 0;
  let totalTrimmed = 0;
  let docsChanged = 0;

  for (const doc of resources) {
    if (ONLY_STUDENT && doc.student_name !== ONLY_STUDENT) continue;
    const srs = doc.srsState || {};
    const qids = Object.keys(srs);
    const bytesBefore = Buffer.byteLength(JSON.stringify(doc), 'utf8');

    console.log(`--- ${doc.id} (student_name=${doc.student_name}) ---`);
    console.log(`  document bytes ....... ${bytesBefore}`);
    console.log(`  SRS cards ............ ${qids.length}`);

    const plans = {};
    let docTrimmed = 0;
    qids.forEach((qid) => {
      totalCards++;
      const plan = planCard(srs[qid] || {});
      if (!plan) return;
      plans[qid] = plan;
      totalChanged++;
      docTrimmed += plan.trimmed;
      totalTrimmed += plan.trimmed;
      console.log(
        `    ${qid}: history ${plan.historyBefore} -> ${plan.historyAfter}` +
        ` (trim ${plan.trimmed}); totalReviews=${plan.summary.totalReviews}` +
        ` totalLapses=${plan.summary.totalLapses}` +
        ` firstReviewedAt=${plan.summary.firstReviewedAt}` +
        ` lastReviewedAt=${plan.summary.lastReviewedAt}`
      );
    });

    const changedQids = Object.keys(plans);
    if (changedQids.length === 0) {
      console.log('  no card needs compaction in this document.');
      console.log('');
      continue;
    }
    docsChanged++;

    const newSrs = Object.assign({}, srs);
    changedQids.forEach((qid) => { newSrs[qid] = plans[qid].card; });
    const newDoc = Object.assign({}, doc, { srsState: newSrs });
    const bytesAfter = Buffer.byteLength(JSON.stringify(newDoc), 'utf8');
    console.log(`  cards to change ...... ${changedQids.length}`);
    console.log(`  history events trimmed ${docTrimmed}`);
    console.log(`  document bytes ....... ${bytesBefore} -> ${bytesAfter} (${bytesAfter - bytesBefore})`);

    if (APPLY) {
      await container.items.upsert(newDoc);
      console.log('  WRITTEN.');
    } else {
      console.log('  (dry run: nothing written)');
    }
    console.log('');
  }

  console.log('=== totals ===');
  console.log(`  master documents inspected ... ${resources.length}`);
  console.log(`  documents needing change ..... ${docsChanged}`);
  console.log(`  SRS cards inspected .......... ${totalCards}`);
  console.log(`  SRS cards needing change ..... ${totalChanged}`);
  console.log(`  history events to trim ....... ${totalTrimmed}`);
  console.log(APPLY ? '\nAPPLIED.' : '\nDRY RUN COMPLETE — no document was modified.');
})().catch((err) => {
  console.error('\n✗ compaction failed:', err.message);
  process.exit(1);
});
