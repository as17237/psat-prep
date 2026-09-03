#!/usr/bin/env bash
# ==============================================================================
# scripts/rollback_prod.sh <manifest.json> — restore production $web to a
# pre-cutover snapshot taken by scripts/backup_prod_web.sh.
# ==============================================================================
# WI-19 rollback path. For every file in the manifest:
#   - "snapshot": copy the recorded point-in-time snapshot back over the base
#                 blob (byte-for-byte restore of the pre-cutover version).
#   - "absent"  : the file did not exist before the promotion (the promotion
#                 added it), so DELETE the base blob to return to that state.
#
# Data safety:
#   - Writes ONLY to the production root ($web, empty prefix); every destination
#     is checked with assert_blob_prefix, so it can never touch /v2/ or /beta/.
#   - Requires a typed ROLLBACK confirmation before any Azure write (--yes for CI).
#   - --dry-run prints the exact plan and makes no Azure call.
#   - The snapshots it restores from are never deleted, so a rollback is itself
#     reversible (re-promote, or restore a newer backup).
#
# Usage:
#   ./scripts/rollback_prod.sh refactor-baseline/pre_cutover_<ts>/manifest.json
#   ./scripts/rollback_prod.sh <manifest> --dry-run
#   ./scripts/rollback_prod.sh <manifest> --yes         # non-interactive
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/deploy_common.sh
source "$SCRIPT_DIR/lib/deploy_common.sh"
cd "$REPO_ROOT"

MANIFEST="${1:-}"
if [[ -z "$MANIFEST" || ! -f "$MANIFEST" ]]; then
  echo "ERROR: pass a manifest written by scripts/backup_prod_web.sh." >&2
  echo "usage: ./scripts/rollback_prod.sh <manifest.json> [--dry-run] [--yes]" >&2
  exit 2
fi

DRY_RUN=false
AUTO_CONFIRM=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --yes|-y)  AUTO_CONFIRM=true ;;
  esac
done

# Parse the manifest into "status<TAB>name<TAB>snapshot" lines with node (jq-free).
# Command substitution + here-string (not `< <(node …)`) so a slow reader under
# `set -o pipefail` can't hand node an EPIPE mid-write.
LANE_PREFIX=""
ROWS_RAW=$(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const lines = m.files.map(f => [f.status, f.name, f.snapshot || ""].join("\t"));
  process.stdout.write(lines.join("\n"));
' "$MANIFEST")
if [[ -z "$ROWS_RAW" ]]; then
  echo "ERROR: manifest ${MANIFEST} lists no files." >&2
  exit 2
fi
# Portable line-split (macOS ships bash 3.2, which has no `mapfile`).
ROWS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && ROWS+=("$line")
done <<< "$ROWS_RAW"

echo "======================================================================"
echo "⏮  PRODUCTION ROLLBACK from ${MANIFEST}"
echo "  • container : ${WEB_CONTAINER} (root)"
echo "  • files     : ${#ROWS[@]}"
echo "  • dry run   : ${DRY_RUN}"
echo "======================================================================"

# Assert every destination is the production root BEFORE confirming or writing.
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r status name snapshot <<< "$row"
  assert_blob_prefix "$name" "$LANE_PREFIX" >/dev/null
done

restore_n=0; delete_n=0
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r status name snapshot <<< "$row"
  if [[ "$status" == "snapshot" ]]; then restore_n=$((restore_n + 1)); else delete_n=$((delete_n + 1)); fi
done

echo "  Plan: restore ${restore_n} file(s) from snapshot, delete ${delete_n} file(s) added by the promotion."
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  for row in "${ROWS[@]}"; do
    IFS=$'\t' read -r status name snapshot <<< "$row"
    if [[ "$status" == "snapshot" ]]; then
      echo "  [dry-run] restore ${name} <- snapshot ${snapshot}"
    else
      echo "  [dry-run] delete  ${name} (was absent pre-cutover)"
    fi
  done
  echo ""
  echo "ROLLBACK_PROD_DRY_RUN_OK ${MANIFEST}"
  exit 0
fi

if [[ "$AUTO_CONFIRM" != "true" ]]; then
  echo "⚠️  This OVERWRITES the LIVE production site at ${SITE_BASE_URL}/ with the"
  echo "    pre-cutover snapshot. Soak lanes (/v2/, /beta/) are NOT touched."
  read -r -p "Type 'ROLLBACK' to proceed: " CONFIRM_INPUT || CONFIRM_INPUT=""
  if [[ "$CONFIRM_INPUT" != "ROLLBACK" ]]; then
    echo "❌ Rollback cancelled — nothing was written."
    exit 1
  fi
fi

resolve_storage_credentials

for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r status name snapshot <<< "$row"
  if [[ "$status" == "snapshot" ]]; then
    echo "  ⏮ restore ${name} <- ${snapshot}"
    az storage blob copy start \
      --destination-container "$WEB_CONTAINER" --destination-blob "$name" \
      --source-container "$WEB_CONTAINER" --source-blob "$name" --source-snapshot "$snapshot" \
      --account-name "$AZURE_STORAGE_ACCOUNT" --account-key "$AZURE_STORAGE_KEY" \
      --output none
  else
    echo "  🗑 delete  ${name} (added by the promotion)"
    az storage blob delete --container-name "$WEB_CONTAINER" --name "$name" --output none
  fi
done

echo "----------------------------------------------------------------------"
echo "  restored ${restore_n}, deleted ${delete_n}."
echo "ROLLBACK_PROD_OK ${MANIFEST}"
