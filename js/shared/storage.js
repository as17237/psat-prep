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
 */
import { APP_ENV } from './env.js';

// The keys whose write bumps the pending-sync counter — unchanged from the
// inline copies, listed once instead of three times.
const SYNCED_KEYS = ['psat_progress', 'psat_exam_history', 'psat_srs'];

let pendingSyncListener = null;

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
