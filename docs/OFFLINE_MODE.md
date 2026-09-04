# Offline exam mode (WI-20) — take a full exam on a plane

## What it does
1. **Prepare (while online).** On the **Exam** tab, "Take a full exam offline
   (airplane mode)" → **Prepare for offline**. This generates one full Standard
   PSAT 8/9 exam, pins it, stores the app (service worker precache), and downloads
   **that exam's** question images (~120–150 images, ~15 MB — never the full 324 MB
   bank). The status line shows a real cached/total count.
2. **Fly (offline).** Open the app URL with no internet. The service worker serves
   the app shell and the exam's images from cache. Start the pinned exam under
   **"Prepared offline exam"** and take it normally. Answers save to `localStorage`.
3. **Land (online).** On reconnect the app auto-syncs (pull → push, debounced 2.5 s)
   to Cosmos; the header badge shows offline/pending/synced honestly.

## The one hard requirement: it must be served from the SITE ROOT
Question images live at `/data/images/…` (the root), and a service worker only
controls URLs inside its own scope. A worker registered under `/v2/` is scoped to
`/v2/` and **cannot** cache-serve root images offline — so **offline mode works on
the production root only, not in the `/v2/` soak lane.** (Online use is fine on both.)

## Caching strategy (why a production SW here is safe)
- **Shell + navigation:** network-first — online always gets the fresh build; the
  cache is only the offline fallback. No "stuck on an old version" footgun.
- **Question images (`data/images/…`):** cache-first in a stable `psat-images`
  cache that survives shell updates (so a prepared exam isn't lost on a deploy).
- **Sync API (`/api/…`):** never cached — always the live network.
- Routing decision: `js/shared/sw_routing.js` (pure, unit-tested).

## Data safety
- The offline pin is **lean** (question ids only, rehydrated from the local bundle),
  like the resume snapshot — no storage bloat.
- Starting a pinned exam **refuses** if any question can't be resolved from the
  bundle, rather than running a short exam scored as full.
- Taking/finishing offline writes locally first; sync is decoupled and idempotent
  (durable outbox + non-destructive server merge), so nothing is lost offline.

## Deploy / rollback
- Ships via the normal lane scripts (`sw.js` + `js/shared/sw_routing.js` are in
  `APP_FILES`). `sw.js` is served `no-cache` so worker updates propagate.
- Production promotion keeps the WI-19 backup + rollback path
  (`scripts/backup_prod_web.sh` / `scripts/rollback_prod.sh`).
- **Killswitch** (if a bad worker ever ships): the network-first strategy means an
  online reload already self-heals; to force-remove, bump `VERSION` in `sw.js` and
  redeploy, or unregister via DevTools → Application → Service Workers.

## Verification
- `node tests/test_offline_exam.js` — 39 checks vs the real 3,059-question bundle
  (incl. drop-detection, watched red).
- `node tests/test_sw_routing.js` — 17 checks on the routing classifier.
- `tests/e2e/offline_exam.spec.js` — the real airplane journey in chromium:
  prepare online → offline **cold reload served by the SW** → prepared exam with a
  question image from cache → answer offline → reconnect pushes.
