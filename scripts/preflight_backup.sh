#!/usr/bin/env bash
# ==============================================================================
# scripts/preflight_backup.sh — WI-05 per-work-item preflight gate
# ==============================================================================
#
# Run this before merging any work item that touches api/, storage, sync, or a
# deploy script (REFACTOR_PLAN.md §3, §7.3). It proves — not assumes — that a
# fresh, checksummed, complete cloud backup exists right now:
#
#   (a) POST https://psat-api-4915.azurewebsites.net/api/backup, parse the JSON
#       response, hard-fail on a non-2xx HTTP status or success:false.
#   (b) Confirm the blob the API says it wrote actually exists in the
#       `cosmos-backups` container (by the filename the API returned — never
#       assumed).
#   (c) Download the archive blob + its `.sha256` sidecar to a SYSTEM temp
#       directory (never the repo), re-hash the downloaded bytes locally, and
#       compare that hash against BOTH the sidecar contents and the `sha256`
#       field the API returned in its JSON response. Any of the three
#       disagreeing is a hard failure (CLAUDE.md mode 5: a checksum mismatch is
#       never "close enough").
#   (d) Sanity-check the counts embedded in the API response:
#         studentDocumentsBackedUp >= MIN_STUDENT_DOCS (10)
#         questionsCount           == EXPECTED_QUESTIONS_COUNT (3059)
#       A missing or zero questionsCount is a hard fail, not a warning — see
#       CLAUDE.md mode 1 ("zero is a schema error, not a fallback opportunity").
#   (e) On success, print exactly one final line:
#         PREFLIGHT_BACKUP_OK <filename>
#       so a calling work item's completion report can grep it.
#
# This script is READ + APPEND only against production: it calls the backup
# endpoint (which only ever adds new timestamped blobs — see backup.js — never
# deletes or overwrites a prior archive) and otherwise only reads blobs. It
# never deletes a backup blob (REFACTOR_PLAN.md §3 protected objects) and never
# touches Cosmos directly.
#
# Credentials: AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY are fetched here via
# `az` (already logged in) and exported for this process only — never placed on
# argv, matching every other script in this repo (CLAUDE.md mode 7).
#
# Usage:
#   ./scripts/preflight_backup.sh
#
# Optional overrides (mainly for the failure-path demonstration in this work
# item's own test run — do not use these to weaken the gate in real use):
#   PREFLIGHT_BACKUP_URL         override the backup endpoint
#   PREFLIGHT_EXPECT_SHA256      override the expected sha256 (testing only)
# ==============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STORAGE_ACCOUNT="psatprep4915"
RESOURCE_GROUP="rg-psat-prep"
BACKUP_CONTAINER="cosmos-backups"
API_BASE="https://psat-api-4915.azurewebsites.net"
BACKUP_URL="${PREFLIGHT_BACKUP_URL:-${API_BASE}/api/backup}"

# Sanity-check minimums. Variables, not numbers scattered through the logic
# below (REFACTOR_PLAN.md/CLAUDE.md mode 6: count positions, don't inline
# magic numbers) — and NOT to be loosened beyond what WI-05 specifies.
MIN_STUDENT_DOCS=10
EXPECTED_QUESTIONS_COUNT=3059

echo "======================================================================"
echo "WI-05 preflight_backup — on-demand backup + checksum verification gate"
echo "  Endpoint  : ${BACKUP_URL}"
echo "  Container : ${BACKUP_CONTAINER}"
echo "  Started   : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "======================================================================"

# ------------------------------------------------------------------
# Temp workspace — system temp dir only, always cleaned up.
# ------------------------------------------------------------------
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/preflight_backup.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# ------------------------------------------------------------------
# 0. Credentials from az (never on argv; exported for this process only)
# ------------------------------------------------------------------
echo ""
echo "--- Fetching storage account key ---"
AK="$(az storage account keys list --account-name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" --query '[0].value' -o tsv)"
if [ -z "$AK" ]; then
  echo "FATAL: could not obtain storage account key for ${STORAGE_ACCOUNT}" >&2
  exit 1
fi
export AZURE_STORAGE_ACCOUNT="$STORAGE_ACCOUNT"
export AZURE_STORAGE_KEY="$AK"

# ------------------------------------------------------------------
# (a) Trigger the backup and parse the JSON response
# ------------------------------------------------------------------
echo ""
echo "--- (a) POST ${BACKUP_URL} ---"
RESPONSE_FILE="${TMP_DIR}/backup_response.json"
HTTP_CODE="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' -X POST "$BACKUP_URL")" || {
  echo "FATAL: curl to ${BACKUP_URL} failed (network/connection error)." >&2
  exit 1
}
if [ "$HTTP_CODE" != "200" ]; then
  echo "FATAL: backup endpoint returned HTTP ${HTTP_CODE}, expected 200. Body:" >&2
  cat "$RESPONSE_FILE" >&2
  exit 1
fi

SUCCESS="$(python3 -c "import json,sys; print(json.load(open('$RESPONSE_FILE')).get('success'))")"
if [ "$SUCCESS" != "True" ]; then
  echo "FATAL: backup endpoint responded 200 but success!=true. Body:" >&2
  cat "$RESPONSE_FILE" >&2
  exit 1
fi

FILENAME="$(python3 -c "import json; print(json.load(open('$RESPONSE_FILE')).get('filename') or '')")"
SIDECAR_FILENAME="$(python3 -c "import json; print(json.load(open('$RESPONSE_FILE')).get('sidecarFilename') or '')")"
API_SHA256="$(python3 -c "import json; print(json.load(open('$RESPONSE_FILE')).get('sha256') or '')")"
SIZE_BYTES="$(python3 -c "import json; print(json.load(open('$RESPONSE_FILE')).get('sizeBytes') or 0)")"
STUDENT_DOCS="$(python3 -c "import json; print(json.load(open('$RESPONSE_FILE')).get('studentDocumentsBackedUp'))")"
FEEDBACK_DOCS="$(python3 -c "import json; print(json.load(open('$RESPONSE_FILE')).get('feedbackDocumentsBackedUp'))")"
QUESTIONS_COUNT="$(python3 -c "import json; print(json.load(open('$RESPONSE_FILE')).get('questionsCount'))")"
PAYLOAD_VERSION="$(python3 -c "import json; print(json.load(open('$RESPONSE_FILE')).get('payloadVersion') or '')")"

if [ -z "$FILENAME" ] || [ -z "$SIDECAR_FILENAME" ] || [ -z "$API_SHA256" ]; then
  echo "FATAL: backup response missing filename/sidecarFilename/sha256. Body:" >&2
  cat "$RESPONSE_FILE" >&2
  exit 1
fi

# Allow overriding the expected sha256 ONLY for the deliberate failure-path
# demonstration in this work item's own test run; never used in real gate runs.
EXPECT_SHA256="${PREFLIGHT_EXPECT_SHA256:-$API_SHA256}"

echo "  success              : $SUCCESS"
echo "  filename             : $FILENAME"
echo "  sidecarFilename      : $SIDECAR_FILENAME"
echo "  sha256 (from API)    : $API_SHA256"
echo "  sizeBytes            : $SIZE_BYTES"
echo "  studentDocumentsBackedUp : $STUDENT_DOCS"
echo "  feedbackDocumentsBackedUp: $FEEDBACK_DOCS"
echo "  questionsCount       : $QUESTIONS_COUNT"
echo "  payloadVersion       : $PAYLOAD_VERSION"

# ------------------------------------------------------------------
# (d) Sanity-check counts — BEFORE spending time on blob download, but the
# checksum step (c) still runs regardless so a report always shows the full
# picture; count failures are collected and reported, then the script exits
# nonzero at the end if any failed.
# ------------------------------------------------------------------
COUNT_FAILURES=0

if [ -z "$STUDENT_DOCS" ] || [ "$STUDENT_DOCS" = "None" ]; then
  echo "  ✗ studentDocumentsBackedUp missing from response" >&2
  COUNT_FAILURES=$((COUNT_FAILURES + 1))
elif [ "$STUDENT_DOCS" -lt "$MIN_STUDENT_DOCS" ]; then
  echo "  ✗ studentDocumentsBackedUp=$STUDENT_DOCS < minimum $MIN_STUDENT_DOCS" >&2
  COUNT_FAILURES=$((COUNT_FAILURES + 1))
else
  echo "  ✓ studentDocumentsBackedUp=$STUDENT_DOCS >= $MIN_STUDENT_DOCS"
fi

if [ -z "$QUESTIONS_COUNT" ] || [ "$QUESTIONS_COUNT" = "None" ] || [ "$QUESTIONS_COUNT" = "0" ]; then
  echo "  ✗ questionsCount is missing or zero ($QUESTIONS_COUNT) — hard fail" >&2
  COUNT_FAILURES=$((COUNT_FAILURES + 1))
elif [ "$QUESTIONS_COUNT" != "$EXPECTED_QUESTIONS_COUNT" ]; then
  echo "  ✗ questionsCount=$QUESTIONS_COUNT != expected $EXPECTED_QUESTIONS_COUNT" >&2
  COUNT_FAILURES=$((COUNT_FAILURES + 1))
else
  echo "  ✓ questionsCount=$QUESTIONS_COUNT == $EXPECTED_QUESTIONS_COUNT"
fi

# ------------------------------------------------------------------
# (b) Verify the blob exists in cosmos-backups
# ------------------------------------------------------------------
echo ""
echo "--- (b) Verifying blob exists in ${BACKUP_CONTAINER} ---"
BLOB_EXISTS="$(az storage blob exists --container-name "$BACKUP_CONTAINER" --name "$FILENAME" --query exists -o tsv)"
if [ "$BLOB_EXISTS" != "true" ]; then
  echo "FATAL: blob '${FILENAME}' reported by the API does not exist in ${BACKUP_CONTAINER}." >&2
  exit 1
fi
echo "  ✓ blob exists: ${BACKUP_CONTAINER}/${FILENAME}"

SIDECAR_EXISTS="$(az storage blob exists --container-name "$BACKUP_CONTAINER" --name "$SIDECAR_FILENAME" --query exists -o tsv)"
if [ "$SIDECAR_EXISTS" != "true" ]; then
  echo "FATAL: sidecar '${SIDECAR_FILENAME}' does not exist in ${BACKUP_CONTAINER}." >&2
  exit 1
fi
echo "  ✓ sidecar exists: ${BACKUP_CONTAINER}/${SIDECAR_FILENAME}"

BLOB_SIZE="$(az storage blob show --container-name "$BACKUP_CONTAINER" --name "$FILENAME" --query 'properties.contentLength' -o tsv)"
echo "  blob contentLength (Azure) : $BLOB_SIZE"
if [ -n "$SIZE_BYTES" ] && [ "$SIZE_BYTES" != "0" ] && [ "$BLOB_SIZE" != "$SIZE_BYTES" ]; then
  echo "FATAL: blob contentLength ($BLOB_SIZE) != API sizeBytes ($SIZE_BYTES)." >&2
  exit 1
fi
echo "  ✓ blob size matches API response"

# ------------------------------------------------------------------
# (c) Download + re-hash + compare against sidecar AND API response
# ------------------------------------------------------------------
echo ""
echo "--- (c) Downloading blob + sidecar to ${TMP_DIR} and re-hashing ---"
LOCAL_BLOB="${TMP_DIR}/${FILENAME}"
LOCAL_SIDECAR="${TMP_DIR}/${SIDECAR_FILENAME}"

az storage blob download --container-name "$BACKUP_CONTAINER" --name "$FILENAME" --file "$LOCAL_BLOB" --no-progress >/dev/null
az storage blob download --container-name "$BACKUP_CONTAINER" --name "$SIDECAR_FILENAME" --file "$LOCAL_SIDECAR" --no-progress >/dev/null

DOWNLOADED_BYTES="$(stat -c '%s' "$LOCAL_BLOB" 2>/dev/null || stat -f '%z' "$LOCAL_BLOB")"
LOCAL_SHA256="$(sha256sum "$LOCAL_BLOB" | awk '{print $1}')"
SIDECAR_SHA256="$(awk '{print $1}' "$LOCAL_SIDECAR" | tr 'A-F' 'a-f')"

echo "  downloaded bytes        : $DOWNLOADED_BYTES"
echo "  locally computed sha256 : $LOCAL_SHA256"
echo "  sidecar sha256          : $SIDECAR_SHA256"
echo "  API-reported sha256     : $EXPECT_SHA256"

CHECKSUM_OK=true
if [ "$LOCAL_SHA256" != "$SIDECAR_SHA256" ]; then
  echo "FATAL: CHECKSUM MISMATCH — downloaded bytes hash to $LOCAL_SHA256 but sidecar says $SIDECAR_SHA256." >&2
  CHECKSUM_OK=false
fi
if [ "$LOCAL_SHA256" != "$EXPECT_SHA256" ]; then
  echo "FATAL: CHECKSUM MISMATCH — downloaded bytes hash to $LOCAL_SHA256 but the API response's sha256 field says $EXPECT_SHA256." >&2
  CHECKSUM_OK=false
fi
if [ "$CHECKSUM_OK" != "true" ]; then
  exit 1
fi
echo "  ✓ checksum verified against BOTH the sidecar and the API response"

# ------------------------------------------------------------------
# Final gate
# ------------------------------------------------------------------
if [ "$COUNT_FAILURES" -ne 0 ]; then
  echo ""
  echo "FATAL: $COUNT_FAILURES count sanity-check(s) failed (see ✗ lines above)." >&2
  exit 1
fi

echo ""
echo "======================================================================"
echo "PREFLIGHT_BACKUP_OK ${FILENAME}"
