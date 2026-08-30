#!/usr/bin/env bash
# ==============================================================================
# scripts/deploy_v2.sh — deploy the working tree into the /v2/ soak lane ONLY
# ==============================================================================
# REFACTOR_PLAN.md WI-06. This is the isolation lane prod never had: it writes
# exclusively to blob names under `v2/` in the `$web` container. The production
# root is written by scripts/promote_to_prod.sh and by nothing else.
#
# Usage:
#   ./scripts/deploy_v2.sh                 # stage, transform, upload to $web/v2/
#   ./scripts/deploy_v2.sh --dry-run       # stage + transform + print plan, no az calls
#   ./scripts/deploy_v2.sh --check-name X  # run only the lane assert on blob name X
#                                          #   exit 0 = accepted, 3 = refused
#   ./scripts/deploy_v2.sh --keep-staging  # leave the staged copy on disk for inspection
#
# Credentials: AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY from the environment.
# Never passed on argv. If AZURE_STORAGE_KEY is unset the key is fetched via az.
#
# Rollback (documented, NOT run by this script):
#   az storage blob delete-batch --source '$web' --pattern 'v2/*'
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/deploy_common.sh
source "$SCRIPT_DIR/lib/deploy_common.sh"

LANE_PREFIX="v2/"

# --check-name short-circuits before anything else touches the filesystem or az.
handle_check_name "$LANE_PREFIX" "$@"

DRY_RUN=false
KEEP_STAGING=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --keep-staging) KEEP_STAGING=true ;;
    --check-name) ;;  # consumed above
    *) ;;
  esac
done

cd "$REPO_ROOT"

GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_DIRTY=""
if ! git diff --quiet HEAD 2>/dev/null; then GIT_DIRTY="-dirty"; fi
CLIENT_VERSION="v2-${GIT_SHA}${GIT_DIRTY}"

echo "======================================================================"
echo "🧪 PSAT 8/9 Prep — /v2/ soak-lane deploy"
echo "======================================================================"
echo "  • Lane prefix    : $LANE_PREFIX  (nothing outside it may be written)"
echo "  • Client version : $CLIENT_VERSION"
echo "  • Dry run        : $DRY_RUN"
echo ""

# ------------------------------------------------------------------------------
# 1. Stage a transformed copy of the app.
#
# Two transformations are applied to the STAGED copy only; the working-tree files
# stay version-neutral and lane-neutral (WI-06 requirement).
#
#   (a) client-version injection — an inline <script> right after <head> setting
#       window.PSAT_CLIENT_VERSION. srs.js reads that global lazily in
#       getClientVersion() and sends it as `client_version` in the sync POST.
#
#   (b) question-image path absolutisation — the app builds image srcs as the
#       RELATIVE path `data/<question_image>`. Under /v2/index.html that resolves
#       to /v2/data/images/… , which does not exist (and must not: duplicating
#       3,059 PNGs into the lane is not acceptable). This is exactly how the older
#       beta/ lane is broken today — verified 2026-08-29:
#         GET /beta/data/images/737870c6_question.png -> 404
#         GET /data/images/737870c6_question.png      -> 200
#       The smallest correct fix is to make the staged copy reference the root
#       absolute path `/data/<question_image>`, so /v2/ shares the single image
#       set already served at the site root.
# ------------------------------------------------------------------------------
STAGING_DIR="$(mktemp -d -t psat-v2-stage-XXXXXX)"
cleanup() {
  if [[ "$KEEP_STAGING" == "true" ]]; then
    echo "  • Staging kept at: $STAGING_DIR"
  else
    rm -rf "$STAGING_DIR"
  fi
}
trap cleanup EXIT

echo "▶ Step 1/4: Staging + transforming app files…"
echo "----------------------------------------------------------------------"

# WI-09: refuse to deploy if a js/ module exists but was never added to
# APP_FILES — the lane would serve a page whose controller 404s.
assert_app_files_cover_js_tree

IMAGE_REWRITES_TOTAL=0
VERSION_INJECTIONS=0

for file in "${APP_FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "ERROR: expected app file '$file' is missing from the working tree." >&2
    exit 5
  fi
  mkdir -p "$STAGING_DIR/$(dirname "$file")"
  cp "$file" "$STAGING_DIR/$file"

  # (b) absolutise question-image paths
  before=$(grep -c "['\"\`]data/" "$STAGING_DIR/$file" || true)
  # `sed -i` differs between GNU (Linux/CI) and BSD (macOS): BSD requires a backup
  # suffix, so use the attached-suffix form `-i.bak` (accepted by both) and delete
  # the backup afterwards. The s|…|…|g backreference form itself is portable BRE.
  sed -i.bak \
    -e "s|'data/' + \([A-Za-z_][A-Za-z0-9_]*\)\.question_image|'/data/' + \1.question_image|g" \
    -e "s|\`data/\${\([A-Za-z_][A-Za-z0-9_]*\)\.question_image}\`|\`/data/\${\1.question_image}\`|g" \
    "$STAGING_DIR/$file"
  rm -f "$STAGING_DIR/$file.bak"
  rewrites=$(grep -c "['\"\`]/data/" "$STAGING_DIR/$file" || true)
  IMAGE_REWRITES_TOTAL=$((IMAGE_REWRITES_TOTAL + rewrites))

  # (a) inject the client version into HTML pages only
  case "$file" in
    *.html)
      if ! grep -q '<head>' "$STAGING_DIR/$file"; then
        echo "ERROR: $file has no <head> to inject the client version into." >&2
        exit 5
      fi
      # Inject after the FIRST <head> only. Done with awk, not sed, on purpose: the
      # previous sed form needed three GNU-only features that all break on BSD/macOS —
      # the `-i` backup suffix, a `\n` newline in the replacement, and the `0,/re/`
      # address range (BSD only has `1,/re/`). awk is portable and needs none of them.
      inject_tmp=$(mktemp)
      awk -v ver="$CLIENT_VERSION" '
        !injected && /<head>/ {
          sub(/<head>/, "<head>\n  <script>window.PSAT_CLIENT_VERSION = \"" ver "\";</script>")
          injected=1
        }
        { print }
      ' "$STAGING_DIR/$file" > "$inject_tmp" && mv "$inject_tmp" "$STAGING_DIR/$file"
      if ! grep -q "window.PSAT_CLIENT_VERSION = \"$CLIENT_VERSION\"" "$STAGING_DIR/$file"; then
        echo "ERROR: client-version injection did not take effect in $file." >&2
        exit 5
      fi
      VERSION_INJECTIONS=$((VERSION_INJECTIONS + 1))
      ;;
  esac

  echo "  • staged $file (image refs before=$before, absolutised=$rewrites)"
done

# Loud failure rather than a silently half-transformed lane (CLAUDE.md mode 5).
# Where the question-image path literals live (RECOUNTED at the end of WI-10;
# it was 7 across 6 files before WI-09, then 4 across 2 files, and WI-10 moved
# srs.js's three out of srs.js into three different engine parts — the total is
# unchanged at 4, but every file in the breakdown changed):
#   js/engine/scoring.js      1  (scoreStandardExam(), the questionReviews
#                                 image_url fallback — was srs.js:1800)
#   js/engine/storage.js      1  (rehydrateReport(), restoring image_url onto a
#                                 lean report — was srs.js:2210)
#   js/engine/grading.js      1  (renderRationale(), the inline screenshot —
#                                 was srs.js:2991)
#   srs.js                    0  (WI-10 reduced it to a facade with no literals)
#   js/shared/questions.js    1  (questionImageSrc(), the single home of what
#                                 used to be 4 inline copies across the pages:
#                                 index.html x2, parent.html, mistakes.html)
# Recount and re-pin this whenever the pattern moves; a stale number is a loud
# failure here rather than a silently half-transformed lane.
#
# WI-12 RECOUNT: added design.html, js/pages/design.js and js/components/*.js
# (statCard/banner/modal/progressBar/questionCard/navTabs/emptyState/dataTable
# + format.js), styles/tokens.css, styles/components.css and
# vendor/chart.min.js to the lane. None of them use the
# `'data/' + X.question_image` / `` `data/${X.question_image}` `` accessor
# pattern this script rewrites (design.js's question demo passes a real
# record straight to questionCard.js, which calls the existing
# questionImageSrc() helper in js/shared/questions.js instead of
# reimplementing the expression — CLAUDE.md mode 2), so the total stays 4.
EXPECTED_IMAGE_REWRITES=4
if [[ "$IMAGE_REWRITES_TOTAL" -ne "$EXPECTED_IMAGE_REWRITES" ]]; then
  echo "ERROR: expected $EXPECTED_IMAGE_REWRITES absolutised question-image references, found $IMAGE_REWRITES_TOTAL." >&2
  echo "       The image-path pattern in the app changed — update this script before deploying." >&2
  exit 6
fi
# WI-12 added design.html as a 5th HTML page — it needs the client version
# injected exactly like the original four (index/parent/mistakes/feedback).
EXPECTED_VERSION_INJECTIONS=5
if [[ "$VERSION_INJECTIONS" -ne "$EXPECTED_VERSION_INJECTIONS" ]]; then
  echo "ERROR: expected $EXPECTED_VERSION_INJECTIONS HTML pages to receive the client version, got $VERSION_INJECTIONS." >&2
  exit 6
fi
# No relative question-image path may survive into the lane; it would 404 under /v2/.
if grep -rn -e "'data/' + [A-Za-z_][A-Za-z0-9_]*\.question_image" \
            -e "\`data/\${[A-Za-z_][A-Za-z0-9_]*\.question_image}\`" "$STAGING_DIR"; then
  echo "ERROR: a relative question-image path survived staging; it would 404 under /v2/." >&2
  exit 6
fi
echo "  ✓ $IMAGE_REWRITES_TOTAL image references absolutised, $VERSION_INJECTIONS pages versioned"

# ------------------------------------------------------------------------------
# 2. Build the destination list and assert every single name is inside the lane.
#
# The question bundle is loaded by the pages as the RELATIVE src
# `data/questions_data.js`, so the lane needs its own copy at v2/data/… — this is
# the same pattern the existing beta/ lane uses (beta/data/questions_data.js
# exists as its own blob; beta/data/images/ does not). The bundle is uploaded
# unchanged from the working tree; data/* is frozen (REFACTOR_PLAN.md §7 rule 4).
# ------------------------------------------------------------------------------
echo ""
echo "▶ Step 2/4: Asserting every destination is inside '$LANE_PREFIX'…"
echo "----------------------------------------------------------------------"

SRC_PATHS=()
DEST_NAMES=()
for file in "${APP_FILES[@]}"; do
  SRC_PATHS+=("$STAGING_DIR/$file")
  DEST_NAMES+=("${LANE_PREFIX}${file}")
done
SRC_PATHS+=("$REPO_ROOT/data/questions_data.js")
DEST_NAMES+=("${LANE_PREFIX}data/questions_data.js")

for name in "${DEST_NAMES[@]}"; do
  assert_blob_prefix "$name" "$LANE_PREFIX"
done

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "▶ Steps 3-4 skipped (--dry-run): no Azure call, no blob written."
  for i in "${!DEST_NAMES[@]}"; do
    echo "  [dry-run] would upload ${SRC_PATHS[$i]} -> \$web/${DEST_NAMES[$i]}"
  done
  echo ""
  echo "DEPLOY_V2_DRY_RUN_OK $CLIENT_VERSION"
  exit 0
fi

# ------------------------------------------------------------------------------
# 3. Upload.
# ------------------------------------------------------------------------------
echo ""
echo "▶ Step 3/4: Uploading to \$web/$LANE_PREFIX …"
echo "----------------------------------------------------------------------"
resolve_storage_credentials

for i in "${!DEST_NAMES[@]}"; do
  echo "  • ${DEST_NAMES[$i]}"
  upload_blob "${SRC_PATHS[$i]}" "${DEST_NAMES[$i]}" "$LANE_PREFIX"
done

# ------------------------------------------------------------------------------
# 4. Verify what actually landed.
# ------------------------------------------------------------------------------
echo ""
echo "▶ Step 4/4: Verifying deployed blobs…"
echo "----------------------------------------------------------------------"
az storage blob list --container-name "$WEB_CONTAINER" --prefix "$LANE_PREFIX" \
  --num-results '*' --query '[].{name:name,bytes:properties.contentLength}' -o tsv

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$SITE_BASE_URL/v2/index.html")
echo "  • GET $SITE_BASE_URL/v2/index.html -> $HTTP_CODE"
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "ERROR: /v2/index.html did not return 200 after deploy." >&2
  exit 7
fi

echo ""
echo "======================================================================"
echo "✅ /v2/ lane deployed — production root untouched."
echo "   URL            : $SITE_BASE_URL/v2/index.html"
echo "   client_version : $CLIENT_VERSION"
echo "   Rollback       : az storage blob delete-batch --source '\$web' --pattern 'v2/*'"
echo "======================================================================"
echo "DEPLOY_V2_OK $CLIENT_VERSION"
