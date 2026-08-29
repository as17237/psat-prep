#!/usr/bin/env bash
# ==============================================================================
# scripts/deploy_beta.sh — deploy the working tree into the beta/ lane ONLY
# ==============================================================================
# REFACTOR_PLAN.md WI-06 (b). Replaces the beta half of the old promote_beta.sh,
# which pushed the identical files to the production root AND beta/ in a single
# run — so beta was never an isolation lane at all.
#
# This script writes exclusively to blob names under `beta/` in `$web`.
#
# Usage:
#   ./scripts/deploy_beta.sh                 # upload to $web/beta/
#   ./scripts/deploy_beta.sh --dry-run       # print plan, make no az call
#   ./scripts/deploy_beta.sh --check-name X  # lane assert only (0 = ok, 3 = refused)
#   ./scripts/deploy_beta.sh --with-bundle   # also upload beta/data/questions_data.js
#
# NOTE on images: the beta lane does NOT carry data/images/, so question
# screenshots 404 under /beta/ (verified 2026-08-29). The /v2/ lane fixes this by
# absolutising image paths at staging time (see scripts/deploy_v2.sh). Beta is
# left as-is here deliberately: WI-06 does not authorise a beta content change.
#
# Rollback (documented, NOT run by this script):
#   az storage blob delete-batch --source '$web' --pattern 'beta/*'
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/deploy_common.sh
source "$SCRIPT_DIR/lib/deploy_common.sh"

LANE_PREFIX="beta/"

handle_check_name "$LANE_PREFIX" "$@"

DRY_RUN=false
WITH_BUNDLE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --with-bundle) WITH_BUNDLE=true ;;
    *) ;;
  esac
done

cd "$REPO_ROOT"

GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

echo "======================================================================"
echo "🟡 PSAT 8/9 Prep — beta lane deploy"
echo "======================================================================"
echo "  • Lane prefix : $LANE_PREFIX  (nothing outside it may be written)"
echo "  • Commit      : $GIT_SHA"
echo "  • Dry run     : $DRY_RUN"
echo ""

SRC_PATHS=()
DEST_NAMES=()
# WI-09: refuse to deploy if a js/ module exists but was never added to
# APP_FILES — the lane would serve a page whose controller 404s.
assert_app_files_cover_js_tree

for file in "${APP_FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "ERROR: expected app file '$file' is missing from the working tree." >&2
    exit 5
  fi
  SRC_PATHS+=("$REPO_ROOT/$file")
  DEST_NAMES+=("${LANE_PREFIX}${file}")
done
if [[ "$WITH_BUNDLE" == "true" ]]; then
  SRC_PATHS+=("$REPO_ROOT/data/questions_data.js")
  DEST_NAMES+=("${LANE_PREFIX}data/questions_data.js")
fi

echo "▶ Asserting every destination is inside '$LANE_PREFIX'…"
echo "----------------------------------------------------------------------"
for name in "${DEST_NAMES[@]}"; do
  assert_blob_prefix "$name" "$LANE_PREFIX"
done

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  for i in "${!DEST_NAMES[@]}"; do
    echo "  [dry-run] would upload ${SRC_PATHS[$i]} -> \$web/${DEST_NAMES[$i]}"
  done
  echo ""
  echo "DEPLOY_BETA_DRY_RUN_OK $GIT_SHA"
  exit 0
fi

echo ""
echo "▶ Uploading to \$web/$LANE_PREFIX …"
echo "----------------------------------------------------------------------"
resolve_storage_credentials

for i in "${!DEST_NAMES[@]}"; do
  echo "  • ${DEST_NAMES[$i]}"
  upload_blob "${SRC_PATHS[$i]}" "${DEST_NAMES[$i]}" "$LANE_PREFIX"
done

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$SITE_BASE_URL/beta/index.html")
echo "  • GET $SITE_BASE_URL/beta/index.html -> $HTTP_CODE"
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "ERROR: /beta/index.html did not return 200 after deploy." >&2
  exit 7
fi

echo ""
echo "======================================================================"
echo "✅ beta lane deployed — production root untouched."
echo "   URL      : $SITE_BASE_URL/beta/"
echo "   Rollback : az storage blob delete-batch --source '\$web' --pattern 'beta/*'"
echo "======================================================================"
echo "DEPLOY_BETA_OK $GIT_SHA"
