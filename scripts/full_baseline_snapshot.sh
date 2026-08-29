#!/usr/bin/env bash
# ==============================================================================
# scripts/full_baseline_snapshot.sh — WI-02 full-scope baseline snapshot
# ==============================================================================
#
# Produces one complete, immutable, checksummed snapshot of everything needed to
# recover this project from scratch:
#   - all three Cosmos containers (Questions, UATStudentAnswers, UATFeedback)
#   - all $web/data/images/* blobs (server-side copy, no round-trip through disk)
#   - the local data bundle + source JSON files
#   - a MANIFEST.json tying it all together with checksums and doc counts
#
# Uploaded to a NEW private blob container `refactor-baseline` in storage account
# `psatprep4915`. Rerunnable: every run writes under its own timestamped virtual
# folder `baseline_<ISO-timestamp>/` and NEVER deletes or overwrites anything from
# a previous run (--overwrite false on every upload; the container is created once
# and reused; a failed run simply leaves its partial folder in place).
#
# Strictly READ-ONLY against every source: Cosmos (SELECT-only queries), $web
# (list/show/copy-FROM only), local data/ (read only). Never writes to $web, never
# writes to Cosmos, never deletes anything in refactor-baseline or cosmos-backups.
#
# Usage: ./scripts/full_baseline_snapshot.sh
# Requires: az CLI logged in, node (with api/node_modules/@azure/cosmos installed).
# ==============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STORAGE_ACCOUNT="psatprep4915"
RESOURCE_GROUP="rg-psat-prep"
CONTAINER="refactor-baseline"
COSMOS_ACCOUNT="psat-cosmos-15958"
COSMOS_DB="psat-prep-db"

POLL_INTERVAL_SECS=15
POLL_MAX_SECS=1200   # 20 minutes

TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
BASELINE_FOLDER="baseline_${TS}"

echo "======================================================================"
echo "WI-02 Full Baseline Snapshot"
echo "  Container : ${CONTAINER}"
echo "  Folder    : ${BASELINE_FOLDER}"
echo "  Started   : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "======================================================================"

WORKDIR="$(mktemp -d -t wi02-baseline-XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT
mkdir -p "$WORKDIR/exports" "$WORKDIR/bundle"
echo "Local staging dir (removed on exit, blobs are the source of truth): $WORKDIR"

# ------------------------------------------------------------------
# 0. Preconditions: git SHA, clean-ish sanity, keys
# ------------------------------------------------------------------
GIT_SHA="$(git rev-parse HEAD)"
echo ""
echo "--- Git SHA: ${GIT_SHA} ---"

echo "--- Fetching storage account key ---"
AK="$(az storage account keys list --account-name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" --query "[0].value" -o tsv)"
if [ -z "$AK" ]; then
  echo "FATAL: could not obtain storage account key for ${STORAGE_ACCOUNT}" >&2
  exit 1
fi
# Credential hygiene (CLAUDE.md mode 7: "credentials come from env vars, never argv"):
# every `az storage ...` call below relies on these two env vars instead of passing
# --account-name/--account-key on the command line, where the key would be visible to
# any local user via `ps aux` for the lifetime of that subprocess. Source and
# destination are the same storage account for the image copy, so this also lets us
# omit --source-account-name/--source-account-key on the copy-batch call entirely
# (confirmed empirically: az storage blob copy start-batch falls back to the
# destination account/credentials when the source account is unspecified).
export AZURE_STORAGE_ACCOUNT="$STORAGE_ACCOUNT"
export AZURE_STORAGE_KEY="$AK"

echo "--- Fetching Cosmos key ---"
COSMOS_KEY="$(az cosmosdb keys list --name "$COSMOS_ACCOUNT" --resource-group "$RESOURCE_GROUP" --query primaryMasterKey -o tsv)"
if [ -z "$COSMOS_KEY" ]; then
  echo "FATAL: could not obtain Cosmos key for ${COSMOS_ACCOUNT}" >&2
  exit 1
fi
export COSMOS_KEY
export COSMOS_ENDPOINT="https://${COSMOS_ACCOUNT}.documents.azure.com:443/"
export COSMOS_DB_NAME="$COSMOS_DB"

# ------------------------------------------------------------------
# 1. Container: create-if-absent (additive only), then hard-verify it is private
# ------------------------------------------------------------------
echo ""
echo "--- Ensuring container '${CONTAINER}' exists and is private ---"
EXISTS="$(az storage container exists --name "$CONTAINER" --query exists -o tsv)"
if [ "$EXISTS" != "true" ]; then
  az storage container create --name "$CONTAINER" --public-access off -o none
  echo "Created container ${CONTAINER} (public-access off)."
else
  echo "Container ${CONTAINER} already exists; reusing it (additive only, nothing deleted)."
fi

ACL="$(az storage container show-permission --name "$CONTAINER" --query publicAccess -o tsv)"
echo "Container ACL check: publicAccess='${ACL}'"
# az storage container show-permission returns the literal string "off" (or "None"/"null"/empty,
# depending on CLI version) for a private container, and "blob" or "container" for a public one.
# Only those two public values are a failure here — everything else means private.
if [ "$ACL" = "blob" ] || [ "$ACL" = "container" ]; then
  echo "FATAL: container ${CONTAINER} is NOT private (publicAccess=${ACL}). Aborting — refusing to write to a public container." >&2
  exit 1
fi
CONTAINER_ACL_STATUS="private (publicAccess=${ACL:-null})"
echo "✓ Container is private."

# ------------------------------------------------------------------
# helper: sha256 a local file, write sidecar, upload file+sidecar (never overwrite),
# then download the just-uploaded blob and re-hash it to prove round-trip integrity.
# ------------------------------------------------------------------
upload_and_fully_verify() {
  local local_path="$1" remote_blob="$2"
  local fname sha_local sidecar_local tmp_download sha_remote

  # IMPORTANT: local_path may be a real source file under data/ (read-only per WI-02
  # safety rules: "local data/ files (read only)") — the sidecar must NEVER be written
  # next to it (that would create/modify a file inside the repo's tracked data/ dir on
  # every run). Always stage the sidecar in $WORKDIR instead.
  fname="$(basename "$remote_blob")"
  sha_local="$(sha256sum "$local_path" | awk '{print $1}')"
  sidecar_local="$WORKDIR/sidecar_$(echo "$remote_blob" | tr '/' '_').sha256"
  printf '%s  %s\n' "$sha_local" "$fname" > "$sidecar_local"

  az storage blob upload \
    --container-name "$CONTAINER" --file "$local_path" --name "$remote_blob" --overwrite false -o none
  az storage blob upload \
    --container-name "$CONTAINER" --file "$sidecar_local" --name "${remote_blob}.sha256" --overwrite false -o none

  tmp_download="$WORKDIR/verify_download_$(echo "$remote_blob" | tr '/' '_')"
  az storage blob download \
    --container-name "$CONTAINER" --name "$remote_blob" --file "$tmp_download" -o none
  sha_remote="$(sha256sum "$tmp_download" | awk '{print $1}')"
  rm -f "$tmp_download"

  if [ "$sha_remote" != "$sha_local" ]; then
    echo "FATAL: checksum mismatch after upload+download round-trip for ${remote_blob}" >&2
    echo "       local=${sha_local} remote=${sha_remote}" >&2
    exit 1
  fi

  echo "✓ Uploaded + fully re-verified: ${remote_blob} sha256=${sha_local}" >&2
  echo "$sha_local"
}

# ------------------------------------------------------------------
# 2. Cosmos exports
# ------------------------------------------------------------------
echo ""
echo "--- Exporting Cosmos container: Questions ---"
QUESTIONS_LOCAL="$WORKDIR/exports/Questions.json"
QUESTIONS_EXPORT_OUT="$(node "$REPO_ROOT/scripts/export_questions_container.js" "$QUESTIONS_LOCAL")"
echo "$QUESTIONS_EXPORT_OUT"
QUESTIONS_EXPORT_COUNT="$(echo "$QUESTIONS_EXPORT_OUT" | grep '^QUESTIONS_EXPORT_COUNT=' | cut -d= -f2)"
QUESTIONS_LIVE_COUNT="$(echo "$QUESTIONS_EXPORT_OUT" | grep '^QUESTIONS_LIVE_COUNT=' | cut -d= -f2)"

echo ""
echo "--- Exporting Cosmos containers: UATStudentAnswers + UATFeedback (reusing WI-01 CLI) ---"
export BACKUP_CLI_PATH="$REPO_ROOT/scripts/backup_cosmos.js"
export COSMOS_MODULE_PATH="$REPO_ROOT/api/node_modules/@azure/cosmos"
export EXPORT_DIR="$WORKDIR/exports"

STUDENT_FEEDBACK_SCRIPT="$WORKDIR/export_student_feedback.js"
cat > "$STUDENT_FEEDBACK_SCRIPT" <<'NODE_EOF'
// Generated at run time by scripts/full_baseline_snapshot.sh — not committed.
// Reuses scripts/backup_cosmos.js's fetchBackupDocuments() (WI-01) so student/feedback
// fetch logic lives in exactly one place. Writes one JSON file per container (not the
// combined backup_cosmos.js payload shape) to match WI-02's "one file per container"
// snapshot layout, each with the same sha256 sidecar format.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function getLiveCount(container) {
  const { resources } = await container.items.query('SELECT VALUE COUNT(1) FROM c').fetchAll();
  return resources[0];
}

function writeExport(outputPath, containerName, dbName, documents, liveCount, now) {
  const payload = {
    exportMetadata: {
      generatedAt: now.toISOString(),
      database: dbName,
      container: containerName,
      exportedCount: documents.length,
      liveCountAtRunTime: liveCount
    },
    documents
  };
  const payloadString = JSON.stringify(payload, null, 2);
  const sha256 = crypto.createHash('sha256').update(Buffer.from(payloadString, 'utf8')).digest('hex');
  const filename = path.basename(outputPath);
  fs.writeFileSync(outputPath, payloadString, 'utf8');
  fs.writeFileSync(`${outputPath}.sha256`, `${sha256}  ${filename}\n`, 'utf8');
  return { sha256, count: documents.length };
}

(async () => {
  const backupCli = require(process.env.BACKUP_CLI_PATH);
  const { CosmosClient } = require(process.env.COSMOS_MODULE_PATH);
  const client = new CosmosClient({ endpoint: process.env.COSMOS_ENDPOINT, key: process.env.COSMOS_KEY });
  const database = client.database(process.env.COSMOS_DB_NAME);
  const now = new Date();

  const { studentDocs, feedbackDocs } = await backupCli.fetchBackupDocuments(database);

  const studentLiveCount = await getLiveCount(database.container('UATStudentAnswers'));
  const feedbackLiveCount = await getLiveCount(database.container('UATFeedback'));

  if (studentDocs.length !== studentLiveCount) {
    throw new Error(`UATStudentAnswers mismatch: exported ${studentDocs.length} vs live COUNT(1) ${studentLiveCount}`);
  }
  if (feedbackDocs.length !== feedbackLiveCount) {
    throw new Error(`UATFeedback mismatch: exported ${feedbackDocs.length} vs live COUNT(1) ${feedbackLiveCount}`);
  }

  const outDir = process.env.EXPORT_DIR;
  const s = writeExport(path.join(outDir, 'UATStudentAnswers.json'), 'UATStudentAnswers', process.env.COSMOS_DB_NAME, studentDocs, studentLiveCount, now);
  const f = writeExport(path.join(outDir, 'UATFeedback.json'), 'UATFeedback', process.env.COSMOS_DB_NAME, feedbackDocs, feedbackLiveCount, now);

  console.log(`STUDENT_EXPORT_COUNT=${s.count}`);
  console.log(`STUDENT_LIVE_COUNT=${studentLiveCount}`);
  console.log(`FEEDBACK_EXPORT_COUNT=${f.count}`);
  console.log(`FEEDBACK_LIVE_COUNT=${feedbackLiveCount}`);
})().catch(err => {
  console.error('Student/Feedback export failed:', err.message);
  process.exit(1);
});
NODE_EOF

STUDENT_FEEDBACK_OUT="$(node "$STUDENT_FEEDBACK_SCRIPT")"
echo "$STUDENT_FEEDBACK_OUT"
STUDENT_EXPORT_COUNT="$(echo "$STUDENT_FEEDBACK_OUT" | grep '^STUDENT_EXPORT_COUNT=' | cut -d= -f2)"
STUDENT_LIVE_COUNT="$(echo "$STUDENT_FEEDBACK_OUT" | grep '^STUDENT_LIVE_COUNT=' | cut -d= -f2)"
FEEDBACK_EXPORT_COUNT="$(echo "$STUDENT_FEEDBACK_OUT" | grep '^FEEDBACK_EXPORT_COUNT=' | cut -d= -f2)"
FEEDBACK_LIVE_COUNT="$(echo "$STUDENT_FEEDBACK_OUT" | grep '^FEEDBACK_LIVE_COUNT=' | cut -d= -f2)"

echo ""
echo "--- Uploading Cosmos exports (with full download+re-hash verification) ---"
# NOTE: upload_and_fully_verify uploads BOTH the artifact and its <name>.sha256 sidecar
# in one call (it (re)writes the sidecar from the artifact's own bytes just before
# uploading) — do not call it a second time on the sidecar file itself, that would
# upload a spurious "<name>.sha256.sha256" blob.
QUESTIONS_SHA="$(upload_and_fully_verify "$WORKDIR/exports/Questions.json" "${BASELINE_FOLDER}/cosmos/Questions.json")"
STUDENT_SHA="$(upload_and_fully_verify "$WORKDIR/exports/UATStudentAnswers.json" "${BASELINE_FOLDER}/cosmos/UATStudentAnswers.json")"
FEEDBACK_SHA="$(upload_and_fully_verify "$WORKDIR/exports/UATFeedback.json" "${BASELINE_FOLDER}/cosmos/UATFeedback.json")"

QUESTIONS_BYTES="$(stat -c%s "$WORKDIR/exports/Questions.json")"
STUDENT_BYTES="$(stat -c%s "$WORKDIR/exports/UATStudentAnswers.json")"
FEEDBACK_BYTES="$(stat -c%s "$WORKDIR/exports/UATFeedback.json")"

# ------------------------------------------------------------------
# 3. Bundle + source JSON: verify local == deployed BEFORE snapshotting, then upload
# ------------------------------------------------------------------
echo ""
echo "--- Verifying local bundle matches deployed \$web bundle (byte size) ---"
LOCAL_BUNDLE="$REPO_ROOT/data/questions_data.js"
LOCAL_BUNDLE_BYTES="$(stat -c%s "$LOCAL_BUNDLE")"
DEPLOYED_BUNDLE_BYTES="$(az storage blob show --container-name '$web' --name 'data/questions_data.js' --query properties.contentLength -o tsv)"
echo "  local=${LOCAL_BUNDLE_BYTES} deployed=${DEPLOYED_BUNDLE_BYTES}"
if [ "$LOCAL_BUNDLE_BYTES" != "$DEPLOYED_BUNDLE_BYTES" ]; then
  echo "FATAL: local data/questions_data.js (${LOCAL_BUNDLE_BYTES} bytes) differs from the deployed \$web copy (${DEPLOYED_BUNDLE_BYTES} bytes)." >&2
  echo "       Refusing to snapshot a bundle that has drifted from what is live. Run rebuild_bundle.py / redeploy, then rerun this script." >&2
  exit 1
fi
echo "✓ Local bundle matches deployed bundle byte-for-byte (size)."

echo ""
echo "--- Uploading bundle + source JSON (with full download+re-hash verification) ---"
BUNDLE_SHA="$(upload_and_fully_verify "$LOCAL_BUNDLE" "${BASELINE_FOLDER}/bundle/questions_data.js")"
ELA_LOCAL="$REPO_ROOT/data/ela_questions.json"
MATH_LOCAL="$REPO_ROOT/data/math_questions.json"
ELA_SHA="$(upload_and_fully_verify "$ELA_LOCAL" "${BASELINE_FOLDER}/bundle/ela_questions.json")"
MATH_SHA="$(upload_and_fully_verify "$MATH_LOCAL" "${BASELINE_FOLDER}/bundle/math_questions.json")"

UPLOADED_BUNDLE_BYTES="$(az storage blob show --container-name "$CONTAINER" --name "${BASELINE_FOLDER}/bundle/questions_data.js" --query properties.contentLength -o tsv)"
ELA_BYTES="$(stat -c%s "$ELA_LOCAL")"
MATH_BYTES="$(stat -c%s "$MATH_LOCAL")"

# ------------------------------------------------------------------
# 4. Images: server-side copy, then poll until every destination blob is success
# ------------------------------------------------------------------
echo ""
echo "--- Counting source images (\$web/data/images/) ---"
SOURCE_IMAGE_COUNT="$(az storage blob list --container-name '$web' --prefix 'data/images/' --num-results '*' --query 'length(@)' -o tsv)"
echo "Source image count: ${SOURCE_IMAGE_COUNT}"

echo ""
echo "--- Starting server-side blob copy (async): \$web/data/images/* -> ${CONTAINER}/${BASELINE_FOLDER}/images/ ---"
az storage blob copy start-batch \
  --destination-container "$CONTAINER" \
  --destination-path "${BASELINE_FOLDER}/images" \
  --source-container '$web' \
  --pattern 'data/images/*' -o none

# az storage blob copy start-batch with --destination-path prepends that path to each
# source blob's full name, so destinations land at <folder>/images/data/images/<file>.
IMAGE_PREFIX="${BASELINE_FOLDER}/images/data/images/"

echo "--- Polling copy status under '${IMAGE_PREFIX}' (every ${POLL_INTERVAL_SECS}s, up to ${POLL_MAX_SECS}s) ---"
ELAPSED=0
IMAGE_SUCCESS_COUNT=0
while true; do
  # NOTE: az storage blob list omits copy properties entirely (they come back null)
  # unless --include c is passed — confirmed empirically: az storage blob show returns
  # real copy.status for a blob, but az storage blob list does not without this flag.
  # Without it this loop silently sees "seen=0" forever and eventually times out even
  # though the copies already succeeded (caught in a real run against live Azure).
  STATUSES="$(az storage blob list \
    --container-name "$CONTAINER" --prefix "$IMAGE_PREFIX" --include c --num-results '*' \
    --query '[].properties.copy.status' -o tsv || true)"
  IMAGE_SUCCESS_COUNT="$(printf '%s\n' "$STATUSES" | grep -c '^success$' || true)"
  IMAGE_FAILED_COUNT="$(printf '%s\n' "$STATUSES" | grep -Ec '^(failed|aborted)$' || true)"
  IMAGE_SEEN_COUNT="$(printf '%s\n' "$STATUSES" | grep -c . || true)"
  echo "  [$(date -u +%H:%M:%S)] elapsed=${ELAPSED}s seen=${IMAGE_SEEN_COUNT} success=${IMAGE_SUCCESS_COUNT} failed=${IMAGE_FAILED_COUNT} target=${SOURCE_IMAGE_COUNT}"

  if [ "$IMAGE_FAILED_COUNT" -gt 0 ]; then
    echo "FATAL: ${IMAGE_FAILED_COUNT} image copy operation(s) failed or aborted." >&2
    exit 1
  fi
  if [ "$IMAGE_SUCCESS_COUNT" -ge "$SOURCE_IMAGE_COUNT" ] && [ "$IMAGE_SEEN_COUNT" -ge "$SOURCE_IMAGE_COUNT" ]; then
    echo "✓ All ${IMAGE_SUCCESS_COUNT} image copies succeeded."
    break
  fi
  if [ "$ELAPSED" -ge "$POLL_MAX_SECS" ]; then
    echo "FATAL: timed out after ${POLL_MAX_SECS}s waiting for image copies (success=${IMAGE_SUCCESS_COUNT}/${SOURCE_IMAGE_COUNT})." >&2
    exit 1
  fi
  sleep "$POLL_INTERVAL_SECS"
  ELAPSED=$((ELAPSED + POLL_INTERVAL_SECS))
done

DEST_IMAGE_COUNT="$IMAGE_SUCCESS_COUNT"

echo ""
echo "--- Spot-checking 20 random image content-MD5 values (source vs destination) ---"
mapfile -t SAMPLE_NAMES < <(az storage blob list --container-name '$web' --prefix 'data/images/' --num-results '*' --query '[].name' -o tsv | shuf -n 20)
IMAGE_SAMPLES_JSON="$WORKDIR/image_md5_samples.json"
echo "[" > "$IMAGE_SAMPLES_JSON"
IMG_MISMATCHES=0
FIRST=1
for name in "${SAMPLE_NAMES[@]}"; do
  if [ -z "$name" ]; then continue; fi
  dest_name="${BASELINE_FOLDER}/images/${name}"
  src_md5="$(az storage blob show --container-name '$web' --name "$name" --query 'properties.contentSettings.contentMd5' -o tsv)"
  dst_md5="$(az storage blob show --container-name "$CONTAINER" --name "$dest_name" --query 'properties.contentSettings.contentMd5' -o tsv)"
  match="true"
  if [ "$src_md5" != "$dst_md5" ] || [ -z "$src_md5" ]; then match="false"; IMG_MISMATCHES=$((IMG_MISMATCHES + 1)); fi
  if [ "$FIRST" -eq 0 ]; then echo "," >> "$IMAGE_SAMPLES_JSON"; fi
  FIRST=0
  printf '  {"blob": "%s", "sourceContentMd5": "%s", "destContentMd5": "%s", "match": %s}' "$name" "$src_md5" "$dst_md5" "$match" >> "$IMAGE_SAMPLES_JSON"
  echo "  ${name}: source=${src_md5} dest=${dst_md5} match=${match}"
done
echo "" >> "$IMAGE_SAMPLES_JSON"
echo "]" >> "$IMAGE_SAMPLES_JSON"
if [ "$IMG_MISMATCHES" -gt 0 ]; then
  echo "FATAL: ${IMG_MISMATCHES} of 20 sampled images had a content-MD5 mismatch (or missing MD5) between source and destination." >&2
  exit 1
fi
echo "✓ 20/20 sampled images match by content-MD5."

# ------------------------------------------------------------------
# 5. MANIFEST.json — uploaded LAST
# ------------------------------------------------------------------
echo ""
echo "--- Building MANIFEST.json ---"
MANIFEST_LOCAL="$WORKDIR/MANIFEST.json"
python3 - "$MANIFEST_LOCAL" <<PYEOF
import json, sys

manifest = {
    "gitSha": "${GIT_SHA}",
    "generatedAtUtc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "baselineFolder": "${BASELINE_FOLDER}",
    "container": "${CONTAINER}",
    "storageAccount": "${STORAGE_ACCOUNT}",
    "containerAclStatus": "${CONTAINER_ACL_STATUS}",
    "cosmos": {
        "account": "${COSMOS_ACCOUNT}",
        "database": "${COSMOS_DB}",
        "containers": {
            "Questions": {
                "blobPath": "${BASELINE_FOLDER}/cosmos/Questions.json",
                "bytes": ${QUESTIONS_BYTES},
                "sha256": "${QUESTIONS_SHA}",
                "exportedCount": ${QUESTIONS_EXPORT_COUNT},
                "liveCountAtRunTime": ${QUESTIONS_LIVE_COUNT}
            },
            "UATStudentAnswers": {
                "blobPath": "${BASELINE_FOLDER}/cosmos/UATStudentAnswers.json",
                "bytes": ${STUDENT_BYTES},
                "sha256": "${STUDENT_SHA}",
                "exportedCount": ${STUDENT_EXPORT_COUNT},
                "liveCountAtRunTime": ${STUDENT_LIVE_COUNT}
            },
            "UATFeedback": {
                "blobPath": "${BASELINE_FOLDER}/cosmos/UATFeedback.json",
                "bytes": ${FEEDBACK_BYTES},
                "sha256": "${FEEDBACK_SHA}",
                "exportedCount": ${FEEDBACK_EXPORT_COUNT},
                "liveCountAtRunTime": ${FEEDBACK_LIVE_COUNT}
            }
        }
    },
    "images": {
        "sourcePrefix": "\$web/data/images/",
        "destinationPrefix": "${BASELINE_FOLDER}/images/data/images/",
        "sourceCount": ${SOURCE_IMAGE_COUNT},
        "destinationCopySuccessCount": ${DEST_IMAGE_COUNT},
        "md5SpotCheckSampleSize": 20,
        "md5SpotCheckMismatches": ${IMG_MISMATCHES},
        "md5Samples": json.load(open("${IMAGE_SAMPLES_JSON}"))
    },
    "bundleAndSources": {
        "questions_data.js": {
            "blobPath": "${BASELINE_FOLDER}/bundle/questions_data.js",
            "localBytes": ${LOCAL_BUNDLE_BYTES},
            "deployedWebBytes": ${DEPLOYED_BUNDLE_BYTES},
            "uploadedBytes": ${UPLOADED_BUNDLE_BYTES},
            "sha256": "${BUNDLE_SHA}"
        },
        "ela_questions.json": {
            "blobPath": "${BASELINE_FOLDER}/bundle/ela_questions.json",
            "bytes": ${ELA_BYTES},
            "sha256": "${ELA_SHA}"
        },
        "math_questions.json": {
            "blobPath": "${BASELINE_FOLDER}/bundle/math_questions.json",
            "bytes": ${MATH_BYTES},
            "sha256": "${MATH_SHA}"
        }
    }
}

with open(sys.argv[1], "w") as f:
    json.dump(manifest, f, indent=2)
print("Manifest written:", sys.argv[1])
PYEOF

MANIFEST_SHA="$(upload_and_fully_verify "$MANIFEST_LOCAL" "${BASELINE_FOLDER}/MANIFEST.json")"

# ------------------------------------------------------------------
# 6. VERIFY block — final self-verification summary
# ------------------------------------------------------------------
echo ""
echo "======================================================================"
echo "VERIFY"
echo "======================================================================"
echo "Git SHA                         : ${GIT_SHA}"
echo "Baseline folder                 : ${BASELINE_FOLDER}"
echo "Container ACL                   : ${CONTAINER_ACL_STATUS}"
echo ""
echo "-- Cosmos export vs live count --"
echo "Questions           : exported=${QUESTIONS_EXPORT_COUNT} live=${QUESTIONS_LIVE_COUNT} $( [ "$QUESTIONS_EXPORT_COUNT" = "$QUESTIONS_LIVE_COUNT" ] && echo MATCH || echo MISMATCH )"
echo "UATStudentAnswers   : exported=${STUDENT_EXPORT_COUNT} live=${STUDENT_LIVE_COUNT} $( [ "$STUDENT_EXPORT_COUNT" = "$STUDENT_LIVE_COUNT" ] && echo MATCH || echo MISMATCH )"
echo "UATFeedback         : exported=${FEEDBACK_EXPORT_COUNT} live=${FEEDBACK_LIVE_COUNT} $( [ "$FEEDBACK_EXPORT_COUNT" = "$FEEDBACK_LIVE_COUNT" ] && echo MATCH || echo MISMATCH )"
echo ""
echo "-- Images --"
echo "Source count (\$web/data/images/)      : ${SOURCE_IMAGE_COUNT}"
echo "Destination copy-success count        : ${DEST_IMAGE_COUNT}"
echo "Match                                  : $( [ "$SOURCE_IMAGE_COUNT" = "$DEST_IMAGE_COUNT" ] && echo MATCH || echo MISMATCH )"
echo "MD5 spot-check (20 samples)            : $((20 - IMG_MISMATCHES))/20 match"
echo ""
echo "-- Bundle byte size --"
echo "local=${LOCAL_BUNDLE_BYTES} deployed=${DEPLOYED_BUNDLE_BYTES} uploaded=${UPLOADED_BUNDLE_BYTES} $( [ "$LOCAL_BUNDLE_BYTES" = "$DEPLOYED_BUNDLE_BYTES" ] && [ "$LOCAL_BUNDLE_BYTES" = "$UPLOADED_BUNDLE_BYTES" ] && echo MATCH || echo MISMATCH )"
echo ""
echo "-- Checksums (fully re-verified via upload+download+re-hash) --"
echo "Questions.json              sha256=${QUESTIONS_SHA}"
echo "UATStudentAnswers.json      sha256=${STUDENT_SHA}"
echo "UATFeedback.json            sha256=${FEEDBACK_SHA}"
echo "questions_data.js           sha256=${BUNDLE_SHA}"
echo "ela_questions.json          sha256=${ELA_SHA}"
echo "math_questions.json         sha256=${MATH_SHA}"
echo "MANIFEST.json               sha256=${MANIFEST_SHA}"
echo ""
echo "MANIFEST blob path: ${CONTAINER}/${BASELINE_FOLDER}/MANIFEST.json"
echo "======================================================================"
echo "WI-02 baseline snapshot complete: ${BASELINE_FOLDER}"
echo "======================================================================"
