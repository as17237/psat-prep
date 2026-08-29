/**
 * js/shared/storage.js — the prefix-aware localStorage accessors used by the
 * student app, the parent portal and the mistakes page.
 *
 * WI-09 duplication ledger:
 *   safeGetStorage  3 sites (index.html, parent.html, mistakes.html) -> 1
 *   safeSetStorage  3 sites (index.html, parent.html, mistakes.html) -> 1
 *
 * Two differences existed between the three copies and are resolved here:
 *
 *  1. mistakes.html's safeGetStorage swallowed the parse error silently while
 *     index.html's and parent.html's logged `console.warn('Storage read error
 *     for key:', key, e)`. CLAUDE.md failure mode 5 says a catch must recover
 *     OR report; the two-out-of-three form does both, so that is the one kept.
 *     The only observable difference on the mistakes page is one extra console
 *     warning on a corrupt value — the returned default is unchanged.
 *
 *  2. safeSetStorage's pending-sync bump called a differently named badge
 *     refresher on each page (updateSyncStatusBadge / updateParentSyncStatusBadge
 *     / updateMistakesSyncBadge). Rather than fork the function three ways, the
 *     page registers its refresher through onPendingSyncCountChanged() during
 *     module evaluation, before any write can happen.
 *
 * Storage semantics are frozen for WI-09 (WI-11 owns them): the key names, the
 * prefix, the JSON encoding, the pending-counter arithmetic and the boolean
 * return contract are all byte-identical to the inline originals.
 *
 * ---------------------------------------------------------------------------
 * WI-11: this module is also where the v1 -> v2 local migration runs.
 * ---------------------------------------------------------------------------
 * It has to happen before ANY page reads student state, and all three page
 * controllers read their state during module evaluation (`let progress =
 * safeGetStorage('psat_progress', {})` at the top of student.js, and the same
 * pattern in parent.js and mistakes.js). Every one of them imports this module
 * to do that, and an ES module body runs exactly once before its first importer
 * continues — so running the migration here means it runs exactly once per page
 * load, before the first read, at ONE site rather than three (CLAUDE.md mode 2).
 *
 * The engine parts are plain <script> tags in each page's <head>/body, and
 * classic scripts always finish before a `type="module"` script executes, so
 * PSAT_ENGINE is guaranteed to exist by the time this runs. It is still guarded:
 * a page that somehow loads without the engine must keep working on its v1 data
 * rather than throwing during module evaluation and rendering nothing.
 */
import { APP_ENV } from './env.js';

// The keys whose write bumps the pending-sync counter — unchanged from the
// inline copies, listed once instead of three times.
const SYNCED_KEYS = ['psat_progress', 'psat_exam_history', 'psat_srs'];

let pendingSyncListener = null;

/**
 * The result of this page load's v1 -> v2 migration attempt, so a page can render
 * an honest banner instead of guessing. Null until runLocalSchemaMigration() runs.
 */
let migrationReport = null;

/** @returns {Object|null} the migration report for this page load. */
export function getMigrationReport() {
  return migrationReport;
}

/**
 * Runs the one-time, non-destructive v1 -> v2 local migration for this lane.
 * Idempotent: on an already-migrated profile it performs no writes at all.
 */
function runLocalSchemaMigration() {
  try {
    if (typeof PSAT_ENGINE === 'undefined' || !PSAT_ENGINE.migrateLocalStateToV2) {
      migrationReport = { success: false, migrated: false, error: 'engine_unavailable' };
      console.warn('PSAT_ENGINE is not loaded; skipping the v1->v2 local migration and reading the existing v1 state as-is.');
      return;
    }
    migrationReport = PSAT_ENGINE.migrateLocalStateToV2(localStorage, window.location);
    if (migrationReport.migrated) {
      console.info(
        `PSAT local state migrated to schemaVersion ${migrationReport.schemaVersion}: ` +
        `${migrationReport.cardsUpgraded} SRS cards summarised, ${migrationReport.eventsTrimmed} history events trimmed, ` +
        `v1 backups kept in ${migrationReport.backedUpKeys.join(', ') || '(none needed)'}.`
      );
    } else if (!migrationReport.success) {
      // Report, never swallow: the profile stays on v1 and will retry next load.
      console.error('PSAT v1->v2 local migration did not run: ' + migrationReport.error);
    }
  } catch (e) {
    migrationReport = { success: false, migrated: false, error: e && e.message };
    console.error('PSAT v1->v2 local migration threw; continuing on the existing v1 state:', e);
  }
}

runLocalSchemaMigration();

/** Registers the page's sync-badge refresher. Called once, at page-module load. */
export function onPendingSyncCountChanged(fn) {
  pendingSyncListener = typeof fn === 'function' ? fn : null;
}

export function safeGetStorage(key, defaultVal) {
  try {
    const item = localStorage.getItem(APP_ENV.storagePrefix + key);
    return item ? JSON.parse(item) : defaultVal;
  } catch (e) {
    console.warn('Storage read error for key:', key, e);
    return defaultVal;
  }
}

export function safeSetStorage(key, val) {
  try {
    localStorage.setItem(APP_ENV.storagePrefix + key, JSON.stringify(val));
    if (SYNCED_KEYS.indexOf(key) !== -1) {
      const currentPending = parseInt(localStorage.getItem(APP_ENV.storagePrefix + 'psat_pending_sync_count') || '0', 10);
      localStorage.setItem(APP_ENV.storagePrefix + 'psat_pending_sync_count', String(currentPending + 1));
      if (pendingSyncListener) pendingSyncListener();
    }
    return true;
  } catch (e) {
    console.error('Storage write error for key:', key, e);
    return false;
  }
}

/**
 * The pending/last-sync pair every page's badge renders. Extracted because all
 * three badge functions computed it identically (outbox length vs the legacy
 * counter, max wins) and only differed in how they formatted it.
 *
 * WI-09 duplication ledger: 3 sites -> 1.
 */
export function readSyncBadgeState() {
  const outboxOps = (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.getOutboxOps) ? PSAT_ENGINE.getOutboxOps(localStorage, window.location) : [];
  const pendingLegacy = parseInt(localStorage.getItem(APP_ENV.storagePrefix + 'psat_pending_sync_count') || '0', 10);
  const pending = Math.max(outboxOps.length, pendingLegacy);
  const lastSync = localStorage.getItem(APP_ENV.storagePrefix + 'psat_last_cloud_sync_time');
  const minutesAgo = lastSync ? Math.floor((Date.now() - parseInt(lastSync, 10)) / 60000) : null;
  return { pending: pending, lastSync: lastSync, minutesAgo: minutesAgo };
}
