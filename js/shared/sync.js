import { APP_ENV } from './env.js';
import { safeSetStorageDownloaded, readSyncBadgeState } from './storage.js';

// One download/upload/acknowledgement policy for every page that edits a profile.
export function createPageSync({ onState, onPull }) {
  const pendingKey = APP_ENV.storagePrefix + 'psat_pending_sync_count';
  let debounce = null;
  function legacyCount() {
    return Math.max(0, parseInt(localStorage.getItem(pendingKey) || '0', 10) || 0);
  }
  async function drain() {
    if (window.__PSAT_WRITE_BLOCKED__) {
      return { success: false, skipped: true, error: 'Local save needs recovery' };
    }
    const pull = await PSAT_ENGINE.pullFromCloud(localStorage, null, APP_ENV.studentName,
      safeSetStorageDownloaded, window.location);
    if (!pull.success) return { ...pull, pullSuccess: false, pushSuccess: false };
    onPull();

    const before = legacyCount();
    const push = await PSAT_ENGINE.pushToCloud(localStorage, null, APP_ENV.studentName,
      window.location, before > 0 ? { full: true } : undefined);
    const pendingOps = PSAT_ENGINE.getOutboxOps(localStorage, window.location).length;
    // Only the accepted full snapshot covers legacy writes. Later local edits stay
    // dirty even when this response acknowledges every operation it was sent.
    if (push.success && push.ackPersisted !== false) {
      const covered = push.syncMode === 'full' ? before : 0;
      localStorage.setItem(pendingKey, String(Math.max(pendingOps, legacyCount() - covered)));
    }
    const pendingLegacy = legacyCount();
    const success = push.success === true && push.ackPersisted !== false &&
      pendingOps === 0 && pendingLegacy === 0;
    if (success) {
      localStorage.setItem(APP_ENV.storagePrefix + 'psat_last_cloud_sync_time', String(Date.now()));
    }
    return { ...push, success, pullSuccess: true, pushSuccess: push.success === true,
      pendingOps, pendingLegacy,
      error: success ? null : push.error || 'Local changes are awaiting confirmation' };
  }
  const coordinator = PSAT_ENGINE.createSyncCoordinator({
    run: () => navigator.locks
      ? navigator.locks.request('psat-sync-' + APP_ENV.storagePrefix, drain)
      : drain(),
    onState
  });
  function requestSync(reason = 'manual', isManual = false) {
    clearTimeout(debounce);
    return coordinator.requestSync(reason).then(result => {
      if (isManual) {
        alert(result.success ? 'All saved changes are confirmed on the server.' :
          'Sync has not completed. Changes remain on this device. ' +
          (coordinator.getState().status === 'retrying' ? 'Retrying automatically.' : result.error || 'Please try again.'));
      }
      return result;
    });
  }
  function schedule() {
    clearTimeout(debounce);
    debounce = setTimeout(() => requestSync('write'), 1500);
  }
  window.addEventListener('online', () => requestSync('reconnect'));
  window.addEventListener('offline', () => onState(coordinator.getState()));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && readSyncBadgeState().pending > 0) requestSync('foreground');
  });
  window.addEventListener('storage', event => {
    if (event.key?.startsWith(APP_ENV.storagePrefix + 'psat_')) {
      onState(coordinator.getState());
      if (readSyncBadgeState().pending > 0) schedule();
    }
  });
  return { requestSync, schedule, getState: coordinator.getState };
}

export function syncStatusText(state) {
  const { pending, lastSync } = readSyncBadgeState();
  if (navigator.onLine === false) return `Saved on this device — offline (${pending} waiting)`;
  if (state.status === 'syncing') return 'Syncing…';
  if (state.status === 'retrying') return `Saved on this device — retrying (${pending} waiting)`;
  if (state.status === 'failed') return `Saved on this device — sync failed (${pending} waiting)`;
  if (pending > 0) return `${pending} change(s) waiting to sync`;
  return lastSync ? 'All work saved' : 'Saved on this device — not yet synced';
}
