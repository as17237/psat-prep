#!/usr/bin/env bash
# ==============================================================================
# scripts/publish_explainers.sh — publish the static explainer pages to prod $web
# ==============================================================================
# The explainer content (explanations/*.html + explanations/index.json) is NOT
# part of APP_FILES — it is auxiliary static content that has always lived in
# $web alongside data/images, published out of band from the app deploy lanes.
# This script is that out-of-band path, made explicit and repeatable.
#
# It reuses deploy_common.sh's upload_blob(), so every file is gzipped AND served
# with the matching Content-Encoding: gzip header + correct content-type. (A file
# served gzipped WITHOUT that header renders as binary garble — which is exactly
# what Azure's 404 fallback document does, and why a MISSING explainer page looks
# corrupted rather than simply 404ing in the browser.)
#
# BETA note: pages carrying a `<!-- beta -->` marker have not had their numbers
# verified against the official cards. They are safe to publish because they show
# a BETA banner and stay unlinked from the normal student flow (the in-app gate
# only reveals them when APP_ENV.isBeta). Do NOT remove a page's beta marker
# until every number on it is card-verified (see explanations/README.md).
#
# Usage:   ./scripts/publish_explainers.sh            # publish all explainer files
#          ./scripts/publish_explainers.sh --dry-run  # list what would upload
# Credentials: AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY from the environment
#              (resolve_storage_credentials fetches the key via az if unset).
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/deploy_common.sh
source "$SCRIPT_DIR/lib/deploy_common.sh"

cd "$REPO_ROOT"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# The exact set to publish: every explainer page plus the id->page index the app
# fetches. Listed by glob against the repo, never a directory upload, so a stray
# local file cannot ride along.
FILES=()
for f in explanations/*.html; do
  [[ -e "$f" ]] || continue
  [[ "$(basename "$f")" == _* ]] && continue   # _template.html is not an explainer
  FILES+=("$f")
done
[[ -f explanations/index.json ]] && FILES+=("explanations/index.json")

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No explainer files found under explanations/ — nothing to publish." >&2
  exit 1
fi

echo "======================================================================"
echo "Publish explainers -> $SITE_BASE_URL/explanations/"
echo "  files: ${#FILES[@]}"
for f in "${FILES[@]}"; do
  beta=""
  grep -q '<!--[[:space:]]*beta\b' "$f" 2>/dev/null && beta="  [BETA — numbers not card-verified]"
  echo "    $f$beta"
done
echo "======================================================================"

if [[ "$DRY_RUN" == true ]]; then
  echo "DRY RUN: no upload performed."
  exit 0
fi

resolve_storage_credentials

for f in "${FILES[@]}"; do
  blob="$f"                       # repo-relative path == blob name (explanations/<file>)
  upload_blob "$f" "$blob" "explanations/"
  echo "  ✓ uploaded $blob"
done

echo "----------------------------------------------------------------------"
echo "PUBLISH_EXPLAINERS_OK ${#FILES[@]} file(s)"
echo "  Command of Evidence (beta): $SITE_BASE_URL/explanations/command-of-evidence-graphs.html"
echo "  Nonlinear functions (beta): $SITE_BASE_URL/explanations/nonlinear-functions-model.html"
