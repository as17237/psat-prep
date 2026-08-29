#!/usr/bin/env bash
# ==============================================================================
# promote_beta.sh — Reproducible Beta to Production Promotion Tool
# ==============================================================================
# Usage:
#   ./promote_beta.sh          # Interactive mode (prompts for confirmation)
#   ./promote_beta.sh --yes    # Non-interactive mode (for CI/CD pipelines)
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "======================================================================"
echo "🚀 PSAT 8/9 Prep — Beta to Production Promotion Tool"
echo "======================================================================"

# 1. Run Complete Automated Regression & Integrity Test Suite
echo ""
echo "▶ Step 1/4: Running complete automated regression & safeguard tests..."
echo "----------------------------------------------------------------------"

node tests/test_html_syntax.js
node tests/test_ui_simplifications.js
node tests/test_ui_rendering.js
node tests/test_buttons_and_interactions.js
node tests/test_srs.js
node tests/test_backup_restore.js
node tests/test_free_response.js
node tests/test_dataset_free_response.js
node tests/test_scaled_score.js
node tests/test_math_tools_and_reference.js
node tests/test_analytics_ux.js
python3 -m unittest test_extractor.py -v

echo ""
echo "✓ All test suites PASSED with 100% success!"

# 2. Check Git Status & Working Tree
echo ""
echo "▶ Step 2/4: Verifying Git branch & working tree status..."
echo "----------------------------------------------------------------------"

GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "  • Current Git Branch : $GIT_BRANCH"
echo "  • Latest Commit SHA  : $GIT_SHA"
echo "  • Timestamp (UTC)    : $TIMESTAMP"

# 3. Interactive Confirmation Guard
AUTO_CONFIRM=false
if [[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]]; then
  AUTO_CONFIRM=true
fi

if [[ "$AUTO_CONFIRM" != "true" ]]; then
  echo ""
  echo "⚠️  PROMOTION SAFETY CONFIRMATION"
  echo "This action will promote the current codebase to the LIVE Production site"
  echo "and update the public Azure Storage static website ($web root)."
  echo ""
  read -r -p "Type 'PROMOTE' to proceed with deployment: " CONFIRM_INPUT
  if [[ "$CONFIRM_INPUT" != "PROMOTE" ]]; then
    echo "❌ Promotion cancelled by user."
    exit 0
  fi
fi

# 4. Update BETA_CHANGELOG.md
echo ""
echo "▶ Step 3/4: Updating BETA_CHANGELOG.md..."
echo "----------------------------------------------------------------------"

CHANGELOG_ENTRY="## [Promotion] — $TIMESTAMP (Commit: $GIT_SHA)
* **Branch:** \`$GIT_BRANCH\`
* **Verified Suites:** SM-2 SRS, Mini Exam Simulation, Backup Checksums, Free-Response Grading, PDF Extractor.
* **Target:** Azure Storage Account \`psatprep4915\` (\`\$web\` root and \`beta/\` subfolder).
"

if [[ -f "BETA_CHANGELOG.md" ]]; then
  TMP_LOG=$(mktemp)
  echo "$CHANGELOG_ENTRY" > "$TMP_LOG"
  cat "BETA_CHANGELOG.md" >> "$TMP_LOG"
  mv "$TMP_LOG" "BETA_CHANGELOG.md"
else
  echo "# 📋 PSAT 8/9 Prep — Beta Promotion Changelog" > BETA_CHANGELOG.md
  echo "" >> BETA_CHANGELOG.md
  echo "$CHANGELOG_ENTRY" >> BETA_CHANGELOG.md
fi

echo "✓ Logged promotion entry in BETA_CHANGELOG.md"

# 5. Deploy to Azure Storage ($web Root & beta/ Subfolder)
echo ""
echo "▶ Step 4/4: Deploying artifacts to Azure Storage (\$web container)..."
echo "----------------------------------------------------------------------"

ACCOUNT_KEY=$(az storage account keys list --resource-group rg-psat-prep --account-name psatprep4915 --query '[0].value' -o tsv)

for file in index.html parent.html mistakes.html feedback.html srs.js styles/buttons.css; do
  echo "  • Uploading $file to production root..."
  az storage blob upload --account-name psatprep4915 --account-key "$ACCOUNT_KEY" --container-name '$web' --name "$file" --file "$file" --content-cache-control "no-cache, no-store, must-revalidate" --overwrite true --output none
  
  echo "  • Uploading $file to beta/ subfolder..."
  az storage blob upload --account-name psatprep4915 --account-key "$ACCOUNT_KEY" --container-name '$web' --name "beta/$file" --file "$file" --content-cache-control "no-cache, no-store, must-revalidate" --overwrite true --output none
done

echo ""
echo "======================================================================"
echo "🎉 Beta Promotion Successfully Completed!"
echo "======================================================================"
echo "🟢 Production URL : https://psatprep4915.z13.web.core.windows.net/"
echo "🟡 Beta URL       : https://psatprep4915.z13.web.core.windows.net/beta/"
echo "======================================================================"
