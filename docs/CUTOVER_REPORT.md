# CUTOVER REPORT — PSAT 8/9 Prep refactor (WI-19)

**Promotion commit:** `2efdb75` · **Promoted:** 2026-09-03 ~15:54 UTC · **Result:** `PROMOTE_TO_PROD_OK 2efdb75`
**Live site:** https://psatprep4915.z13.web.core.windows.net/ · **Canary twin:** `/v2/` (kept live)

This report packages the go/no-go evidence for promoting the rebuilt app (WI-09…WI-18)
from the `/v2/` soak lane to the production `$web` root, and records the backup/rollback
path. **Production hosting only changed; no Cosmos/student data was touched** — prod and
`/v2/` read and write the same `default_student` documents.

---

## 1. Gate evidence

| Gate item | Status | Evidence |
|---|---|---|
| Full Playwright suite green | ✅ | **57 passed** (`--project=chromium-desktop --workers=1`, 2026-09-03) |
| Node unit/integration suites | ✅ | **22/22** pass |
| Offline integrity tests | ✅ | 5/5 (`test_datamodel`, `test_shard_routing`, `test_merge_pins`, `test_snapshot_diff`, `test_doc_size_budget`) |
| Live data-integrity suite (read-only vs prod) | ✅ | **11/11 `INTEGRITY_SUITE_OK`** |
| Data pipeline invariants | ✅ | `test_extractor` 7 pass + 2 skip; validator `3059 0 2158`; `rebuild_bundle` drift 0 |
| Fresh preflight backup | ✅ | `PREFLIGHT_BACKUP_OK cosmos_backup_2026-09-03T15-46-04-934Z.json` (checksum-verified against sidecar + API) |
| Bundle parity (prod vs local) | ✅ | `data/questions_data.js` local == prod == 6,080,994 bytes (no drift) |
| Feature parity WI-13/14/15 | ✅ | student/parent/mistakes/feedback rebuilt on the WI-12 design system; Tailwind CDN removed; merged to main |
| Data-migration safety (WI-18) | ✅ | `default_student` → shard-authoritative; byte-for-byte round-trip **through Cosmos**; `SNAPSHOT_DIFF_NO_REMOVALS_OK` (0 progress/SRS/exam removals) |

## 2. Backup + rollback (the WI-19 deliverable)

**Pre-cutover backup** — byte + header-perfect Azure blob **snapshots** of every file the
promotion touched, taken *before* the overwrite:
- Manifest: `refactor-baseline/pre_cutover_20260903T154400Z/manifest.json` (committed).
- 7 files snapshotted (the pre-refactor prod: index/parent/mistakes/feedback.html, srs.js,
  styles/buttons.css, data/questions_data.js); 35 files recorded `absent` (new since WI-09,
  to be deleted on rollback).
- Tool: `scripts/backup_prod_web.sh` (snapshot/read only; never overwrites a base blob).

**Rollback path** — `scripts/rollback_prod.sh <manifest>`: restores each file from its
snapshot and deletes files that were absent pre-cutover, returning prod exactly to its
pre-promotion state. Root-only (`assert_blob_prefix`), typed `ROLLBACK` confirm, `--dry-run`.

**Rollback rehearsal (0 diffs):** exercised end-to-end on a throwaway `$web` blob —
```
⏮ restore _rollback_rehearsal.txt <- <snapshot>   → base == ORIGINAL   (expected ORIGINAL)
🗑 delete  _rollback_rehearsal_new.txt              → exists == false    (expected false)
ROLLBACK_PROD_OK
```
The rehearsal caught and fixed two real defects before the tool was trusted: a
`mapfile < <(node …)` EPIPE crash under `set -euo pipefail`, and `mapfile` being absent on
macOS bash 3.2.

**One-line rollback if needed:**
```
export AZURE_STORAGE_ACCOUNT=psatprep4915 AZURE_STORAGE_KEY=$(az storage account keys list --account-name psatprep4915 --resource-group rg-psat-prep --query "[0].value" -o tsv)
bash scripts/rollback_prod.sh refactor-baseline/pre_cutover_20260903T154400Z/manifest.json
```
Data needs no rollback: both versions share the same Cosmos documents and merge semantics
are non-destructive; a rolled-back client simply resumes reading the same state.

## 3. Post-promotion smoke check (live)

- `index.html` → HTTP 200, gzip, 99,637 B decompressed (was the 2026-08-29 version); links
  `styles/tokens.css` (WI-12), loads `js/engine/adaptive_config.js` (WI-18), shows the WI-16
  "Practice-Based Scaled Estimate" label, **0** `cdn.tailwindcss.com` references.
- `parent.html` → HTTP 200. `/v2/` canary → HTTP 200. `data/questions_data.js` → `QUESTIONS_DATA` intact.

## 4. Deviations from the plan (recorded honestly)

- **Expedited cutover.** WI-18's ≥5-school-day live parallel-run window was **not** run to
  full length before promotion; the `/v2/` lane soak + the read-only integrity suite + the
  proven backup/rollback were accepted as sufficient at the owner's direction. The `/v2/`
  canary twin remains live for continued comparison.
- **Backup mechanism.** The plan described a pre-cutover git tag + `$web` file archive;
  this used Azure blob **snapshots** instead (byte + header perfect, in-place, and directly
  restorable), plus a committed manifest. Functionally equivalent, more faithful.

## 5. Remaining to close the refactor

- [ ] **Human sign-off** — owner click-through of the live site.
- [ ] **48 h of green daily integrity reports** post-cutover (`run_integrity.js` +
      `snapshot_diff.js` vs the day-prior backup, growth-only). Datapoint #1 (2026-09-03):
      **11/11 `INTEGRITY_SUITE_OK`**.
- [ ] Then the refactor is formally closed.

**Known future work (not blocking):** the master's `examHistory` (~15 KB, grows per exam)
is not sharded; well under budget today and the reframed DOC-SIZE check will catch it if it
approaches the limit.

---
_Sign-off:_ _________________________  _Date:_ ____________
