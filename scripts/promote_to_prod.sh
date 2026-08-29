#!/usr/bin/env bash
# ==============================================================================
# scripts/promote_to_prod.sh — deploy to the PRODUCTION $web ROOT ONLY
# ==============================================================================
# REFACTOR_PLAN.md WI-06 (b). This is the only script permitted to write to the
# production root, and it writes to nothing else: every destination is asserted
# to be outside the v2/ and beta/ soak lanes.
#
# Differences from the old promote_beta.sh it replaces:
#   • it no longer touches beta/ in the same run (that was the whole defect);
#   • the typed PROMOTE confirmation happens BEFORE any Azure call;
#   • it checks deployed-vs-local data/questions_data.js byte size and warns
#     loudly on drift (the old script never deployed data/ at all, so the site
#     bundle could silently diverge from the repo).
#
# Usage:
#   ./scripts/promote_to_prod.sh                # full: tests -> confirm -> deploy
#   ./scripts/promote_to_prod.sh --yes          # non-interactive (CI)
#   ./scripts/promote_to_prod.sh --dry-run      # confirm gate only; NO tests, NO az,
#                                               #   NO upload. Prints the plan.
#   ./scripts/promote_to_prod.sh --check-name X # lane assert only (0 = ok, 3 = refused)
#
# Credentials: AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY from the environment.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/deploy_common.sh
source "$SCRIPT_DIR/lib/deploy_common.sh"

# The production root. An empty prefix; assert_blob_prefix() additionally refuses
# anything that would land in a soak lane.
LANE_PREFIX=""

handle_check_name "$LANE_PREFIX" "$@"

DRY_RUN=false
AUTO_CONFIRM=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --yes|-y) AUTO_CONFIRM=true ;;
    *) ;;
  esac
done

cd "$REPO_ROOT"

GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "======================================================================"
echo "🚀 PSAT 8/9 Prep — PRODUCTION promotion (\$web root only)"
echo "======================================================================"
echo "  • Branch  : $GIT_BRANCH"
echo "  • Commit  : $GIT_SHA"
echo "  • UTC     : $TIMESTAMP"
echo "  • Dry run : $DRY_RUN"
echo ""

# ------------------------------------------------------------------------------
# 1. Full regression suite (skipped in --dry-run, which exists to exercise the
#    refusal paths without a multi-minute run).
# ------------------------------------------------------------------------------
echo "▶ Step 1/5: Full automated regression suite…"
echo "----------------------------------------------------------------------"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [dry-run] would run every tests/test_*.js suite and python3 -m unittest test_extractor.py"
else
  shopt -s nullglob
  NODE_SUITES=(tests/test_*.js)
  shopt -u nullglob
  if [[ ${#NODE_SUITES[@]} -eq 0 ]]; then
    echo "ERROR: no Node test suites found — refusing to promote untested code." >&2
    exit 8
  fi
  for suite in "${NODE_SUITES[@]}"; do
    echo "  • $suite"
    node "$suite"
  done
  python3 -m unittest test_extractor.py -v
  echo "  ✓ ${#NODE_SUITES[@]} Node suites + test_extractor.py passed"
fi

# ------------------------------------------------------------------------------
# 2. Destination assertions — before anything is confirmed or uploaded.
# ------------------------------------------------------------------------------
echo ""
echo "▶ Step 2/5: Asserting every destination is the production root…"
echo "----------------------------------------------------------------------"
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
  DEST_NAMES+=("$file")
done
for name in "${DEST_NAMES[@]}"; do
  assert_blob_prefix "$name" "$LANE_PREFIX"
done

# ------------------------------------------------------------------------------
# 3. Typed confirmation. MUST come before the first Azure call.
# ------------------------------------------------------------------------------
echo ""
echo "▶ Step 3/5: Promotion safety confirmation…"
echo "----------------------------------------------------------------------"
if [[ "$AUTO_CONFIRM" == "true" ]]; then
  echo "  • --yes given; confirmation bypassed."
else
  echo "⚠️  This OVERWRITES the LIVE production site at $SITE_BASE_URL/"
  echo "    Files replaced: ${DEST_NAMES[*]}"
  echo "    The previous versions of these blobs are NOT retained by this script."
  echo "    Soak lanes (/v2/, /beta/) are NOT touched."
  echo ""
  read -r -p "Type 'PROMOTE' to proceed: " CONFIRM_INPUT || CONFIRM_INPUT=""
  if [[ "$CONFIRM_INPUT" != "PROMOTE" ]]; then
    echo "❌ Promotion cancelled — nothing was uploaded and no Azure call was made."
    exit 1
  fi
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "▶ Steps 4-5 skipped (--dry-run): no Azure call, no blob written."
  for i in "${!DEST_NAMES[@]}"; do
    echo "  [dry-run] would upload ${SRC_PATHS[$i]} -> \$web/${DEST_NAMES[$i]}"
  done
  echo ""
  echo "PROMOTE_TO_PROD_DRY_RUN_OK $GIT_SHA"
  exit 0
fi

# ------------------------------------------------------------------------------
# 4. Bundle drift check (first Azure call).
#
# The app files below do NOT include data/questions_data.js — the deployed bundle
# is updated out of band. If the deployed bytes differ from the local bytes, the
# code about to ship was tested against a different question bank than the one
# production serves. Warn loudly; do not silently continue as if equal.
# ------------------------------------------------------------------------------
echo ""
echo "▶ Step 4/5: data/questions_data.js deployed-vs-local drift check…"
echo "----------------------------------------------------------------------"
resolve_storage_credentials

LOCAL_BUNDLE_BYTES=$(wc -c < "$REPO_ROOT/data/questions_data.js" | tr -d ' ')
DEPLOYED_BUNDLE_BYTES=$(az storage blob show \
  --container-name "$WEB_CONTAINER" \
  --name 'data/questions_data.js' \
  --query 'properties.contentLength' -o tsv 2>/dev/null || echo "MISSING")

echo "  • local    : $LOCAL_BUNDLE_BYTES bytes"
echo "  • deployed : $DEPLOYED_BUNDLE_BYTES bytes"

BUNDLE_DRIFT=false
if [[ "$DEPLOYED_BUNDLE_BYTES" == "MISSING" ]]; then
  BUNDLE_DRIFT=true
  echo ""
  echo "  ⚠️⚠️⚠️  BUNDLE DRIFT: data/questions_data.js is NOT PRESENT in \$web."
elif [[ "$DEPLOYED_BUNDLE_BYTES" != "$LOCAL_BUNDLE_BYTES" ]]; then
  BUNDLE_DRIFT=true
  echo ""
  echo "  ⚠️⚠️⚠️  BUNDLE DRIFT: deployed question bundle differs from the local one"
  echo "         by $((LOCAL_BUNDLE_BYTES - DEPLOYED_BUNDLE_BYTES)) bytes."
else
  echo "  ✓ no drift"
fi

if [[ "$BUNDLE_DRIFT" == "true" ]]; then
  echo "         The code being promoted was tested against a DIFFERENT question bank"
  echo "         than production serves. Fix the bundle before promoting, or accept"
  echo "         explicitly by re-running with PROMOTE_ACCEPT_BUNDLE_DRIFT=1."
  echo ""
  if [[ "${PROMOTE_ACCEPT_BUNDLE_DRIFT:-}" != "1" ]]; then
    echo "❌ Promotion halted on bundle drift. Nothing was uploaded."
    exit 9
  fi
  echo "  • PROMOTE_ACCEPT_BUNDLE_DRIFT=1 set; continuing despite drift."
fi

# ------------------------------------------------------------------------------
# 5. Upload + changelog.
# ------------------------------------------------------------------------------
echo ""
echo "▶ Step 5/5: Uploading to the production root…"
echo "----------------------------------------------------------------------"
for i in "${!DEST_NAMES[@]}"; do
  echo "  • ${DEST_NAMES[$i]}"
  upload_blob "${SRC_PATHS[$i]}" "${DEST_NAMES[$i]}" "$LANE_PREFIX"
done

CHANGELOG_ENTRY="## [Promotion] — $TIMESTAMP (Commit: $GIT_SHA)
* **Branch:** \`$GIT_BRANCH\`
* **Tool:** \`scripts/promote_to_prod.sh\` (production root only; soak lanes untouched)
* **Bundle drift check:** local $LOCAL_BUNDLE_BYTES B vs deployed $DEPLOYED_BUNDLE_BYTES B
* **Target:** Azure Storage \`$AZURE_STORAGE_ACCOUNT\` (\`\$web\` root)
"
if [[ -f "BETA_CHANGELOG.md" ]]; then
  TMP_LOG=$(mktemp)
  echo "$CHANGELOG_ENTRY" > "$TMP_LOG"
  cat "BETA_CHANGELOG.md" >> "$TMP_LOG"
  mv "$TMP_LOG" "BETA_CHANGELOG.md"
else
  printf '# 📋 PSAT 8/9 Prep — Promotion Changelog\n\n%s\n' "$CHANGELOG_ENTRY" > BETA_CHANGELOG.md
fi
echo "  ✓ logged in BETA_CHANGELOG.md"

echo ""
echo "======================================================================"
echo "🎉 Production promotion complete."
echo "   URL : $SITE_BASE_URL/"
echo "======================================================================"
echo "PROMOTE_TO_PROD_OK $GIT_SHA"
