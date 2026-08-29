#!/usr/bin/env bash
# ==============================================================================
# promote_beta.sh — REMOVED (REFACTOR_PLAN.md WI-06)
# ==============================================================================
# This script used to upload the same six files to the PRODUCTION ROOT and to
# beta/ in a single run. That coupling meant beta was never an isolation lane:
# nothing could soak anywhere without simultaneously going live.
#
# It has been split into three prefix-scoped scripts, each of which asserts that
# every destination blob name stays inside its own lane:
#
#   scripts/deploy_v2.sh        -> $web/v2/    (soak lane for the refactor)
#   scripts/deploy_beta.sh      -> $web/beta/  (legacy soak lane)
#   scripts/promote_to_prod.sh  -> $web root   (typed PROMOTE, full test suite,
#                                               question-bundle drift check)
# ==============================================================================

cat >&2 <<'EOF'
❌ promote_beta.sh has been removed — it deployed to production and beta at once.

Use the lane you actually mean:

  ./scripts/deploy_v2.sh          # deploy the working tree to $web/v2/  (soak)
  ./scripts/deploy_beta.sh        # deploy the working tree to $web/beta/ (soak)
  ./scripts/promote_to_prod.sh    # promote to the $web ROOT (requires typed PROMOTE)

Each accepts --dry-run to print its plan without calling Azure.
See REFACTOR_PLAN.md WI-06.
EOF

exit 1
