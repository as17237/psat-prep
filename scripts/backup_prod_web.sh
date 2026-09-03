#!/usr/bin/env bash
# ==============================================================================
# scripts/backup_prod_web.sh — snapshot the LIVE production $web app files
# ==============================================================================
# WI-19 pre-cutover backup. Before scripts/promote_to_prod.sh overwrites the
# production root, this captures a byte-for-byte, in-place backup of every file
# the promotion will touch, using Azure blob SNAPSHOTS (point-in-time copies that
# preserve the exact bytes AND headers — content-type, content-encoding, cache).
#
# It also records, per file, whether the blob EXISTED before the promotion:
#   - "snapshot": the file existed; its snapshot id is recorded for restore.
#   - "absent"  : the file did NOT exist (a NEW file the promotion adds); on
#                 rollback it must be DELETED to return to the pre-cutover state.
#
# The manifest is written under refactor-baseline/pre_cutover_<ts>/manifest.json
# and is what scripts/rollback_prod.sh consumes. Commit it so the backup is
# versioned. Snapshots live inside $web but are never served at the base path
# (static hosting serves only the base blob), so they cost storage, not exposure.
#
# Read/creates snapshots only — it never overwrites or deletes a base blob.
#
# Usage:  ./scripts/backup_prod_web.sh
# Credentials: AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY from the environment
#              (resolve_storage_credentials fetches the key via az if unset).
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/deploy_common.sh
source "$SCRIPT_DIR/lib/deploy_common.sh"
cd "$REPO_ROOT"

resolve_storage_credentials

TS=$(date -u +"%Y%m%dT%H%M%SZ")
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
OUT_DIR="refactor-baseline/pre_cutover_${TS}"
mkdir -p "$OUT_DIR"
MANIFEST="$OUT_DIR/manifest.json"

# Everything the promotion writes: the app files plus the out-of-band bundle.
FILES=("${APP_FILES[@]}" "data/questions_data.js")

echo "======================================================================"
echo "🗄  Pre-cutover backup of production \$web (snapshots)"
echo "  • account : ${AZURE_STORAGE_ACCOUNT}"
echo "  • files   : ${#FILES[@]}"
echo "  • manifest: ${MANIFEST}"
echo "======================================================================"

snap_count=0
absent_count=0
{
  echo "{"
  echo "  \"timestamp\": \"${TS}\","
  echo "  \"gitSha\": \"${GIT_SHA}\","
  echo "  \"container\": \"${WEB_CONTAINER}\","
  echo "  \"account\": \"${AZURE_STORAGE_ACCOUNT}\","
  echo "  \"files\": ["
} > "$MANIFEST"

first=1
for f in "${FILES[@]}"; do
  exists=$(az storage blob exists --container-name "$WEB_CONTAINER" --name "$f" --query exists -o tsv)
  if [[ "$exists" == "true" ]]; then
    snap=$(az storage blob snapshot --container-name "$WEB_CONTAINER" --name "$f" --query snapshot -o tsv)
    entry="{\"name\": \"${f}\", \"status\": \"snapshot\", \"snapshot\": \"${snap}\"}"
    snap_count=$((snap_count + 1))
    echo "  ✓ snapshot  ${f}  @ ${snap}"
  else
    entry="{\"name\": \"${f}\", \"status\": \"absent\"}"
    absent_count=$((absent_count + 1))
    echo "  • absent    ${f}  (new file; rollback will delete it)"
  fi
  if [[ $first -eq 1 ]]; then first=0; else echo "," >> "$MANIFEST"; fi
  printf '    %s' "$entry" >> "$MANIFEST"
done

{
  echo ""
  echo "  ]"
  echo "}"
} >> "$MANIFEST"

echo "----------------------------------------------------------------------"
echo "  snapshotted: ${snap_count}   absent (new): ${absent_count}   total: ${#FILES[@]}"
echo "BACKUP_PROD_WEB_OK ${MANIFEST}"
