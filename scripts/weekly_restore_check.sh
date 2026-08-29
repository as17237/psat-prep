#!/usr/bin/env bash
# ==============================================================================
# scripts/weekly_restore_check.sh — WI-05 one-command wrapper for the WI-03 cycle
# ==============================================================================
#
# DR runbook §5.9 says a restore verification that skips the red demonstration
# (§5.7) doesn't count, and that this cycle must be re-run weekly for the
# duration of the refactor. Doing that by hand (five separate commands, one of
# them a manual Data Explorer edit) is exactly the kind of step that quietly
# stops happening. This script is the whole cycle as one command, and it hard
# fails — refusing to print the OK line — if the red demonstration does not
# actually happen or does not localise to exactly one corrupted document.
#
# Steps, in order:
#   0. Offline safety self-tests for all three scratch-only tools (no network).
#   1. Restore the WI-02 baseline into the scratch DB `psat-prep-db-drtest`.
#   2. Reconcile — MUST be green (exit 0).
#   3. RED DEMONSTRATION (mandatory, not skippable):
#        corrupt exactly one document in the scratch DB only
#        (scripts/corrupt_one_doc.js, itself guarded by assertScratchTarget)
#        -> reconcile again -> MUST exit nonzero with EXACTLY 1 deep-equal
#        mismatch. Any other outcome (reconcile passes, or mismatch count != 1)
#        is treated as a failed verification, not a passed one.
#   4. Repair: re-run the restore script, which re-inserts every document fresh
#      from the checksum-verified baseline export (the corrupted doc included) —
#      reusing the already-tested restore path rather than inventing a
#      single-document patch tool (CLAUDE.md mode 6: call the existing one).
#   5. Reconcile again — MUST be green (exit 0).
#   6. Teardown: delete the scratch database by literal name only.
#   7. Verify the Cosmos account now lists ONLY `psat-prep-db`.
#
# On any failure this script exits nonzero and does NOT print the OK line. It
# always attempts best-effort teardown of the scratch database on the way out
# (even after a failure) so a broken run does not leave a stray Cosmos database
# behind — teardown failures are reported, never silently swallowed, and never
# override the run's real exit code.
#
# This script writes ONLY to the scratch database `psat-prep-db-drtest`; it
# never touches `psat-prep-db`, never deletes a blob, and never runs
# restore_cosmos.js --apply (REFACTOR_PLAN.md §7.2).
#
# Credentials: COSMOS_KEY / AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY are
# fetched here via `az` (already logged in) and exported for this process only
# — never placed on argv (CLAUDE.md mode 7).
#
# Usage:
#   ./scripts/weekly_restore_check.sh
#
# Optional:
#   BASELINE_FOLDER   override which refactor-baseline/ snapshot to restore
#                     (defaults to the WI-02 accepted baseline; see
#                     scripts/restore_baseline_to_scratch.js).
# ==============================================================================

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STORAGE_ACCOUNT="psatprep4915"
RESOURCE_GROUP="rg-psat-prep"
COSMOS_ACCOUNT="psat-cosmos-15958"
SCRATCH_DB="psat-prep-db-drtest"
PROD_DB="psat-prep-db"

BASELINE_FOLDER="${BASELINE_FOLDER:-baseline_2026-08-29T14-09-29Z}"
export BASELINE_FOLDER

echo "======================================================================"
echo "WI-05 weekly_restore_check — full restore/reconcile/red-demo/teardown cycle"
echo "  Baseline folder : refactor-baseline/${BASELINE_FOLDER}"
echo "  Scratch DB      : ${SCRATCH_DB}"
echo "  Started         : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "======================================================================"

TEARDOWN_DONE=false
teardown() {
  if [ "$TEARDOWN_DONE" = "true" ]; then
    return 0
  fi
  echo ""
  echo "--- Teardown: deleting scratch database ${SCRATCH_DB} (best-effort) ---"
  if az cosmosdb sql database show --account-name "$COSMOS_ACCOUNT" --resource-group "$RESOURCE_GROUP" --name "$SCRATCH_DB" >/dev/null 2>&1; then
    if az cosmosdb sql database delete --account-name "$COSMOS_ACCOUNT" --resource-group "$RESOURCE_GROUP" --name "$SCRATCH_DB" --yes >/dev/null 2>&1; then
      echo "  ✓ deleted ${SCRATCH_DB}"
    else
      echo "  ✗ FAILED to delete ${SCRATCH_DB} — a human must clean this up manually." >&2
    fi
  else
    echo "  (${SCRATCH_DB} does not exist — nothing to delete)"
  fi
  TEARDOWN_DONE=true
}

fail() {
  echo "" >&2
  echo "FATAL: $1" >&2
  teardown
  exit 1
}

# Backstop: any command that fails WITHOUT going through fail() (this script does not
# run under `set -e` because several steps must inspect $? after an expected-nonzero
# exit) still triggers a best-effort teardown on the way out, so an unanticipated
# failure never leaves the scratch database behind. Idempotent via TEARDOWN_DONE.
trap teardown EXIT

# ------------------------------------------------------------------
# 0. Offline safety self-tests (no network, no credentials)
# ------------------------------------------------------------------
echo ""
echo "--- Step 0/7: offline --assert-test on all three scratch-only tools ---"
node scripts/restore_baseline_to_scratch.js --assert-test || fail "restore_baseline_to_scratch.js --assert-test did not exit 0"
node scripts/reconcile_restore.js --assert-test || fail "reconcile_restore.js --assert-test did not exit 0"
node scripts/corrupt_one_doc.js --assert-test || fail "corrupt_one_doc.js --assert-test did not exit 0"
echo "  ✓ all three offline guard self-tests passed"

# ------------------------------------------------------------------
# Credentials from az (never on argv; exported for this process only)
# ------------------------------------------------------------------
echo ""
echo "--- Fetching credentials ---"
AK="$(az storage account keys list --account-name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" --query '[0].value' -o tsv)"
[ -n "$AK" ] || fail "could not obtain storage account key for ${STORAGE_ACCOUNT}"
export AZURE_STORAGE_ACCOUNT="$STORAGE_ACCOUNT"
export AZURE_STORAGE_KEY="$AK"

COSMOS_KEY="$(az cosmosdb keys list --name "$COSMOS_ACCOUNT" --resource-group "$RESOURCE_GROUP" --query primaryMasterKey -o tsv)"
[ -n "$COSMOS_KEY" ] || fail "could not obtain Cosmos key for ${COSMOS_ACCOUNT}"
export COSMOS_KEY

# ------------------------------------------------------------------
# 1. Restore
# ------------------------------------------------------------------
echo ""
echo "--- Step 1/7: restore baseline -> ${SCRATCH_DB} ---"
node scripts/restore_baseline_to_scratch.js || fail "restore_baseline_to_scratch.js failed"

# ------------------------------------------------------------------
# 2. Reconcile — must be green
# ------------------------------------------------------------------
echo ""
echo "--- Step 2/7: reconcile (expect PASS) ---"
node scripts/reconcile_restore.js
RECONCILE1_STATUS=$?
if [ $RECONCILE1_STATUS -ne 0 ]; then
  fail "reconcile_restore.js exited ${RECONCILE1_STATUS} on a freshly restored scratch DB — restore is not trustworthy, aborting before any red demonstration."
fi
echo "  ✓ reconcile PASS (pre-corruption)"

# ------------------------------------------------------------------
# 3. RED DEMONSTRATION — mandatory
# ------------------------------------------------------------------
echo ""
echo "--- Step 3/7: RED DEMONSTRATION — corrupt exactly one document ---"
CORRUPT_OUTPUT="$(node scripts/corrupt_one_doc.js)"
CORRUPT_STATUS=$?
echo "$CORRUPT_OUTPUT"
if [ $CORRUPT_STATUS -ne 0 ]; then
  fail "corrupt_one_doc.js exited ${CORRUPT_STATUS} — could not perform the red demonstration."
fi
if ! echo "$CORRUPT_OUTPUT" | grep -q '^CORRUPT_ONE_DOC_OK '; then
  fail "corrupt_one_doc.js did not print CORRUPT_ONE_DOC_OK — cannot confirm the red demonstration actually corrupted a document."
fi

echo ""
echo "--- reconcile after corruption (expect FAIL, exactly 1 mismatch) ---"
RECONCILE2_OUTPUT="$(node scripts/reconcile_restore.js 2>&1)"
RECONCILE2_STATUS=$?
echo "$RECONCILE2_OUTPUT"

if [ $RECONCILE2_STATUS -eq 0 ]; then
  fail "reconcile_restore.js exited 0 (PASS) AFTER corrupt_one_doc.js ran — the red demonstration did not register. A reconciler never seen to fail is not evidence (CLAUDE.md mode 4)."
fi

MISMATCH_LINE="$(echo "$RECONCILE2_OUTPUT" | grep 'deep-equal failures (all containers):' || true)"
MISMATCH_COUNT="$(echo "$MISMATCH_LINE" | grep -oE '[0-9]+' | tail -1)"
if [ -z "$MISMATCH_COUNT" ]; then
  fail "could not find a 'deep-equal failures (all containers):' line in the post-corruption reconcile output."
fi
if [ "$MISMATCH_COUNT" != "1" ]; then
  fail "expected EXACTLY 1 deep-equal mismatch after corrupting one document, got ${MISMATCH_COUNT}. Something other than the deliberate corruption is wrong."
fi
echo "  ✓ red demonstration confirmed: reconcile exited ${RECONCILE2_STATUS} (nonzero) with exactly 1 mismatch"

# ------------------------------------------------------------------
# 4. Repair — re-insert from the verified export (re-run the tested restore path)
# ------------------------------------------------------------------
echo ""
echo "--- Step 4/7: repair (re-restore ${SCRATCH_DB} from the verified baseline export) ---"
node scripts/restore_baseline_to_scratch.js || fail "repair restore failed"

# ------------------------------------------------------------------
# 5. Reconcile again — must be green
# ------------------------------------------------------------------
echo ""
echo "--- Step 5/7: reconcile after repair (expect PASS) ---"
node scripts/reconcile_restore.js
RECONCILE3_STATUS=$?
if [ $RECONCILE3_STATUS -ne 0 ]; then
  fail "reconcile_restore.js exited ${RECONCILE3_STATUS} after repair — repair did not actually fix the corruption."
fi
echo "  ✓ reconcile PASS (post-repair)"

# ------------------------------------------------------------------
# 6/7. Teardown + verify only psat-prep-db remains
# ------------------------------------------------------------------
echo ""
echo "--- Step 6/7: teardown ---"
teardown

echo ""
echo "--- Step 7/7: verify only ${PROD_DB} remains ---"
REMAINING="$(az cosmosdb sql database list --account-name "$COSMOS_ACCOUNT" --resource-group "$RESOURCE_GROUP" --query '[].name' -o tsv)"
echo "  databases now on ${COSMOS_ACCOUNT}: $(echo "$REMAINING" | tr '\n' ' ')"
if [ "$REMAINING" != "$PROD_DB" ]; then
  fail "expected exactly one database (${PROD_DB}) after teardown, found: $(echo "$REMAINING" | tr '\n' ',')"
fi
echo "  ✓ only ${PROD_DB} remains"

echo ""
echo "======================================================================"
echo "WEEKLY_RESTORE_CHECK_OK ${BASELINE_FOLDER}"
