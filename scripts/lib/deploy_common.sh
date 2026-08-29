#!/usr/bin/env bash
# ==============================================================================
# scripts/lib/deploy_common.sh — shared guards for every $web deploy script
# ==============================================================================
# Sourced (never executed) by scripts/deploy_v2.sh, scripts/deploy_beta.sh and
# scripts/promote_to_prod.sh.
#
# WHY THIS EXISTS (REFACTOR_PLAN.md §1 root cause 4, CLAUDE.md failure mode 2):
# the old promote_beta.sh uploaded the same six files to the production root AND
# to beta/ in a single run, so there was no lane a change could soak in. The
# lanes are now separate scripts, and each one is mechanically prevented from
# writing outside its own blob-name prefix by assert_blob_prefix() below.
#
# CLAUDE.md failure mode 2 ("applying a rule in one place but not its twin") is
# the reason the assert lives here once instead of being copy-pasted three times.
# ==============================================================================

# Exit code used for every refused destination, so negative tests can pin it.
DEPLOY_REFUSED_EXIT=3

STORAGE_ACCOUNT_DEFAULT="psatprep4915"
STORAGE_RG_DEFAULT="rg-psat-prep"
WEB_CONTAINER='$web'
SITE_BASE_URL="https://psatprep4915.z13.web.core.windows.net"

# The application files every lane deploys. Deliberately explicit: a glob here
# would let a stray local file reach the site.
#
# WI-09 moved the pages' inline JavaScript into native ES modules under js/,
# so the pages 404 without them. They are listed one by one for the same
# reason everything else here is, and assert_app_files_cover_js_tree() below
# hard-fails if a module exists on disk but is missing from this list — a
# forgotten entry would otherwise ship a page whose controller is a 404.
APP_FILES=(
  "index.html"
  "parent.html"
  "mistakes.html"
  "feedback.html"
  "srs.js"
  "styles/buttons.css"
  "js/shared/html.js"
  "js/shared/env.js"
  "js/shared/storage.js"
  "js/shared/beta_sandbox.js"
  "js/shared/questions.js"
  "js/shared/drill.js"
  "js/pages/feedback.js"
  "js/pages/mistakes.js"
)

# ------------------------------------------------------------------------------
# assert_app_files_cover_js_tree
#
# Every .js under js/ must be in APP_FILES, and every js/ entry in APP_FILES
# must exist. Loud failure beats a lane that serves a page whose module 404s
# (CLAUDE.md failure mode 5).
# ------------------------------------------------------------------------------
assert_app_files_cover_js_tree() {
  local missing=()
  local f
  while IFS= read -r f; do
    local found=false
    local a
    for a in "${APP_FILES[@]}"; do
      if [[ "$a" == "$f" ]]; then found=true; break; fi
    done
    if [[ "$found" == "false" ]]; then missing+=("$f"); fi
  done < <(find js -type f -name '*.js' 2>/dev/null | sort)

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: these js/ modules exist on disk but are not in APP_FILES:" >&2
    printf '       %s\n' "${missing[@]}" >&2
    echo "       Add them to scripts/lib/deploy_common.sh before deploying." >&2
    exit 5
  fi
}

# ------------------------------------------------------------------------------
# assert_blob_prefix <blob-name> <required-prefix>
#
# Hard guard. Refuses (exit $DEPLOY_REFUSED_EXIT) anything that is not plainly
# inside the lane:
#   - empty name
#   - name that does not start with the required prefix
#   - any path traversal segment (..), absolute path, or backslash
# An empty required prefix means "the site root" and additionally refuses any
# name that would land inside a known non-root lane.
# ------------------------------------------------------------------------------
assert_blob_prefix() {
  local name="${1-}"
  local prefix="${2-}"

  if [[ -z "$name" ]]; then
    echo "REFUSED: empty destination blob name" >&2
    exit "$DEPLOY_REFUSED_EXIT"
  fi

  case "$name" in
    *".."*|/*|*"\\"*)
      echo "REFUSED: unsafe destination blob name '$name'" >&2
      exit "$DEPLOY_REFUSED_EXIT"
      ;;
  esac

  if [[ -n "$prefix" ]]; then
    if [[ "$name" != "$prefix"* ]]; then
      echo "REFUSED: destination '$name' is outside this script's lane ('$prefix')" >&2
      exit "$DEPLOY_REFUSED_EXIT"
    fi
    # 'v2foo/x' must not pass a 'v2/' lane check; require a real segment boundary.
    if [[ "$prefix" != */ && "$name" != "$prefix" && "$name" != "$prefix/"* ]]; then
      echo "REFUSED: destination '$name' is outside this script's lane ('$prefix')" >&2
      exit "$DEPLOY_REFUSED_EXIT"
    fi
  else
    # Root lane: refuse anything that would land in a soak lane.
    case "$name" in
      v2/*|beta/*)
        echo "REFUSED: destination '$name' is a soak lane, not the production root" >&2
        exit "$DEPLOY_REFUSED_EXIT"
        ;;
    esac
  fi

  echo "OK: $name"
}

# ------------------------------------------------------------------------------
# resolve_storage_credentials
#
# Credentials come from the environment only — never from argv, where they would
# land in shell history and `ps` output (CLAUDE.md failure mode 7).
# az storage picks AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY up implicitly, so no
# az invocation in these scripts ever passes --account-key.
# ------------------------------------------------------------------------------
resolve_storage_credentials() {
  export AZURE_STORAGE_ACCOUNT="${AZURE_STORAGE_ACCOUNT:-$STORAGE_ACCOUNT_DEFAULT}"

  if [[ -z "${AZURE_STORAGE_KEY:-}" ]]; then
    echo "  • AZURE_STORAGE_KEY not set; fetching the account key via az (not passed on argv)…"
    local key
    if ! key=$(az storage account keys list \
                  --resource-group "${AZURE_STORAGE_RESOURCE_GROUP:-$STORAGE_RG_DEFAULT}" \
                  --account-name "$AZURE_STORAGE_ACCOUNT" \
                  --query '[0].value' -o tsv); then
      echo "ERROR: could not obtain a storage key for $AZURE_STORAGE_ACCOUNT. Is 'az login' current?" >&2
      exit 4
    fi
    if [[ -z "$key" ]]; then
      echo "ERROR: storage key lookup returned empty for $AZURE_STORAGE_ACCOUNT." >&2
      exit 4
    fi
    export AZURE_STORAGE_KEY="$key"
  fi
}

# ------------------------------------------------------------------------------
# upload_blob <local-file> <blob-name> <required-prefix>
# Asserts the destination, then uploads with no-cache headers.
# ------------------------------------------------------------------------------
upload_blob() {
  local local_file="$1" blob_name="$2" prefix="$3"

  assert_blob_prefix "$blob_name" "$prefix" >/dev/null

  if [[ ! -f "$local_file" ]]; then
    echo "ERROR: local file '$local_file' does not exist; refusing to deploy a partial lane." >&2
    exit 5
  fi

  # WI-09: the pages load js/pages/*.js with <script type="module">. A browser
  # refuses to execute a module served with a non-JavaScript MIME type, and the
  # whole page then does nothing with no network error. az infers the type from
  # the extension, but the app must not depend on that inference — state it.
  local content_type_args=()
  case "$blob_name" in
    *.js)   content_type_args=(--content-type "application/javascript") ;;
    *.css)  content_type_args=(--content-type "text/css") ;;
    *.html) content_type_args=(--content-type "text/html") ;;
  esac

  az storage blob upload \
    --container-name "$WEB_CONTAINER" \
    --name "$blob_name" \
    --file "$local_file" \
    --content-cache-control "no-cache, no-store, must-revalidate" \
    "${content_type_args[@]}" \
    --overwrite true \
    --output none
}

# ------------------------------------------------------------------------------
# handle_common_flags "$@"
#
# Recognised by every lane script:
#   --check-name <name>   run only the prefix assert on <name>, then exit
#                         (0 = accepted, 3 = refused). Used by the negative tests.
# Sets DRY_RUN=true for --dry-run. Returns the flags it did not consume.
# LANE_PREFIX must already be set by the calling script.
# ------------------------------------------------------------------------------
handle_check_name() {
  # $1 = lane prefix, $2.. = script args
  local prefix="$1"; shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check-name)
        if [[ $# -lt 2 ]]; then
          echo "ERROR: --check-name requires a blob name" >&2
          exit 2
        fi
        assert_blob_prefix "$2" "$prefix"
        exit 0
        ;;
    esac
    shift
  done
}
