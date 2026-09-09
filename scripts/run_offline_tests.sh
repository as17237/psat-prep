#!/usr/bin/env bash
# ==============================================================================
# scripts/run_offline_tests.sh — every Node suite that needs no credentials.
# ==============================================================================
# WI-32 (review finding: "wire existing safety tests into CI"). CI directly named
# three suites — free_response, srs, dataset_free_response — so the ones written to
# protect the sync and offline paths never ran there: test_outbox_ack,
# test_sync_retry, test_storage_v2, test_offline_pin_identity, test_page_syntax and
# the rest. A regression suite nobody runs is decoration.
#
# ONE command, used identically by a developer and by CI, so the two cannot drift.
# It discovers suites rather than listing them, because a hand-maintained list is
# exactly how the previous gap appeared.
#
# Deliberately EXCLUDED: anything requiring Azure credentials or the network. Those
# stay in the operational gates (scripts/preflight_backup.sh,
# tests/integrity/run_integrity.js) and are not weakened by being separate.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# tests/integrity/run_integrity.js talks to live Cosmos; test_backup_cli and friends
# are offline and stay in. Add a suite here only with a stated reason.
NETWORK_SUITES=("tests/integrity/run_integrity.js")

is_network() {
  local f="$1"
  for n in "${NETWORK_SUITES[@]}"; do [ "$f" = "$n" ] && return 0; done
  return 1
}

# Not `mapfile`: this runs under macOS's bash 3.2 as well as CI's bash 5.
SUITES=()
while IFS= read -r line; do SUITES+=("$line"); done < <(ls tests/test_*.js tests/integrity/test_*.js 2>/dev/null | sort)

pass=0; fail=0; failed=()
echo "Running ${#SUITES[@]} offline Node suites…"
for f in "${SUITES[@]}"; do
  if is_network "$f"; then echo "  skip (needs network): $f"; continue; fi
  if node "$f" >/tmp/psat_suite_out 2>&1; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); failed+=("$f")
    echo "  FAIL: $f"
    tail -12 /tmp/psat_suite_out | sed 's/^/      /'
  fi
done

echo "----------------------------------------------------------------------"
echo "offline node suites: ${pass} passed, ${fail} failed"
if [ "$fail" -ne 0 ]; then
  printf '  failed: %s\n' "${failed[@]}"
  exit 1
fi
# A discovery-based runner that finds nothing would pass silently — the exact
# failure mode this script exists to prevent.
if [ "$pass" -lt 30 ]; then
  echo "ERROR: only ${pass} suites ran; expected at least 30. Discovery is broken." >&2
  exit 1
fi
echo "OFFLINE_TESTS_OK ${pass}"
