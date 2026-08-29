/**
 * tests/test_backup_status_widget.js
 *
 * Executes the REAL backup-freshness widget code from parent.html (the source slice is
 * extracted and evaluated, not regex-matched) against a minimal DOM stub and an injected
 * fake fetch. No network, no browser.
 *
 * What must hold (CLAUDE.md modes 1 and 5):
 *   - while loading: "…", no colour claim, no number
 *   - healthy: green pill showing the REAL measured age from the API
 *   - unhealthy/stale: red pill AND a visible red banner carrying the API's reason
 *   - fetch failure / bad status / malformed body: a visible "Backup status unavailable"
 *     state -- never blank, never a leftover green, never a fixed checkmark
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const parentHtml = fs.readFileSync(path.join(__dirname, '..', 'parent.html'), 'utf8');

// ---------------------------------------------------------------------------
// Extract the widget source slice from parent.html and evaluate it for real.
// ---------------------------------------------------------------------------
const startMarker = "const PARENT_API_BASE = 'https://psat-api-4915.azurewebsites.net/api';";
const endMarker = "document.addEventListener('DOMContentLoaded', () => {";
const startIdx = parentHtml.indexOf(startMarker);
assert.ok(startIdx > -1, 'parent.html must declare PARENT_API_BASE for the widget');
const endIdx = parentHtml.indexOf(endMarker, startIdx);
assert.ok(endIdx > startIdx, 'The widget block must sit above the DOMContentLoaded bootstrap');
const widgetSource = parentHtml.slice(startIdx, endIdx);

for (const fn of ['formatBackupAge', 'renderBackupStatus', 'refreshBackupStatus']) {
  assert.ok(widgetSource.includes('function ' + fn), `Widget slice must contain ${fn}`);
}
// A hardcoded success mark in this widget would be a fabricated measurement.
assert.ok(!/✓|check-circle|Backed up/.test(widgetSource),
  'The widget must not contain a hardcoded success mark or "Backed up" claim');

// ---------------------------------------------------------------------------
// Minimal DOM stub.
// ---------------------------------------------------------------------------
function makeElement(id) {
  return {
    id,
    className: '',
    textContent: '',
    classList: {
      _self: null,
      add(...names) { for (const n of names) if (!this._self.className.split(/\s+/).includes(n)) this._self.className = (this._self.className + ' ' + n).trim(); },
      remove(...names) { const keep = this._self.className.split(/\s+/).filter(c => c && !names.includes(c)); this._self.className = keep.join(' '); },
      contains(n) { return this._self.className.split(/\s+/).includes(n); }
    }
  };
}

let elements;
function resetDom() {
  elements = {};
  for (const id of [
    'backup-status-pill', 'backup-status-pill-text', 'backup-status-pill-detail',
    'backup-status-banner', 'backup-status-banner-icon-wrap',
    'backup-status-banner-title', 'backup-status-banner-detail'
  ]) {
    const el = makeElement(id);
    el.classList._self = el;
    elements[id] = el;
  }
  // Initial markup state from parent.html.
  elements['backup-status-banner'].className =
    'hidden p-4 sm:p-5 rounded-2xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 shadow-lg border-2';
}

const sandbox = {
  document: { getElementById: (id) => elements[id] || null },
  console: { error: () => {}, log: () => {} },
  lucide: { createIcons: () => {} },
  fetch: null,
  isFinite: isFinite,
  Date: Date,
  String: String,
  Math: Math,
  JSON: JSON
};

const vm = require('vm');
const context = vm.createContext(sandbox);
vm.runInContext(widgetSource + '\nthis.__api = { formatBackupAge, renderBackupStatus, refreshBackupStatus, PARENT_API_BASE };', context);
const api = sandbox.__api;

assert.strictEqual(api.PARENT_API_BASE, 'https://psat-api-4915.azurewebsites.net/api');

console.log('Testing parent.html cloud-backup freshness widget (real code, stubbed DOM)...');

// ---------------------------------------------------------------------------
// 1. Age formatting is a real conversion, and refuses nonsense.
// ---------------------------------------------------------------------------
assert.strictEqual(api.formatBackupAge(4), '4.0h ago');
assert.strictEqual(api.formatBackupAge(25.9), '25.9h ago');
assert.strictEqual(api.formatBackupAge(0.5), '30m ago');
assert.strictEqual(api.formatBackupAge(72), '3.0d ago');
assert.strictEqual(api.formatBackupAge(null), null, 'A null age must stay null, never become 0');
assert.strictEqual(api.formatBackupAge(undefined), null);
console.log('✓ formatBackupAge converts real measurements and returns null for missing data');

// ---------------------------------------------------------------------------
// 2. Loading state shows "…" and no colour claim.
// ---------------------------------------------------------------------------
resetDom();
api.renderBackupStatus('loading');
assert.strictEqual(elements['backup-status-pill-text'].textContent, 'Cloud backup: …');
assert.ok(elements['backup-status-banner'].classList.contains('hidden'), 'Loading must not show a banner');
assert.ok(!/emerald|rose|amber/.test(elements['backup-status-pill'].className),
  'Loading must not claim green, red, or amber');
assert.ok(!/\d/.test(elements['backup-status-pill-text'].textContent), 'Loading must show no number');
console.log('✓ Loading state renders "…" with no colour and no fabricated number');

// ---------------------------------------------------------------------------
// 3. Healthy state: green, real age from the API response.
// ---------------------------------------------------------------------------
resetDom();
api.renderBackupStatus('healthy', {
  healthy: true, ageHours: 4, lastSuccessAt: '2026-08-29T14:00:00.000Z',
  lastFailureAt: null, reason: 'Last successful backup is 4 h old.'
});
assert.strictEqual(elements['backup-status-pill-text'].textContent, 'Cloud backup: 4.0h ago');
assert.ok(elements['backup-status-pill'].classList.contains('bg-emerald-50'), 'Healthy pill must be green');
assert.ok(elements['backup-status-banner'].classList.contains('hidden'), 'Healthy must show no banner');
assert.ok(/Last success/.test(elements['backup-status-pill-detail'].textContent));
console.log('✓ Healthy state renders green with the measured age (4.0h ago)');

// ---------------------------------------------------------------------------
// 4. Unhealthy/stale: red pill + VISIBLE red banner carrying the API's reason.
// ---------------------------------------------------------------------------
resetDom();
api.renderBackupStatus('unhealthy', {
  healthy: false, ageHours: 30.25, lastSuccessAt: '2026-08-28T12:00:00.000Z',
  lastFailureAt: '2026-08-29T02:00:00.000Z',
  reason: 'Last successful backup is 30.25 h old (stale: the limit is 26 h).'
});
assert.ok(/STALE/.test(elements['backup-status-pill-text'].textContent));
assert.ok(/30\.3h ago/.test(elements['backup-status-pill-text'].textContent), 'Red pill must still show the real age');
assert.ok(elements['backup-status-pill'].classList.contains('bg-rose-50'), 'Unhealthy pill must be red');
assert.ok(!elements['backup-status-banner'].classList.contains('hidden'), 'Unhealthy MUST show the banner');
assert.ok(elements['backup-status-banner'].classList.contains('border-rose-500'), 'Banner must be red');
assert.ok(/stale/i.test(elements['backup-status-banner-detail'].textContent), "Banner must carry the API's reason");
assert.ok(/Last failure marker/.test(elements['backup-status-banner-detail'].textContent));
console.log('✓ Unhealthy state renders a visible red banner with the real reason and age');

// ---------------------------------------------------------------------------
// 5. No backup at all: honest "No cloud backup found", never "0h ago".
// ---------------------------------------------------------------------------
resetDom();
api.renderBackupStatus('unhealthy', {
  healthy: false, ageHours: null, lastSuccessAt: null, lastFailureAt: null,
  reason: 'No successful cosmos_backup_*.json archive found in the cosmos-backups container.'
});
assert.strictEqual(elements['backup-status-pill-text'].textContent, 'No cloud backup found');
assert.ok(!elements['backup-status-banner'].classList.contains('hidden'));
assert.ok(/No successful backup has been recorded/.test(elements['backup-status-banner-detail'].textContent));
console.log('✓ Empty container renders "No cloud backup found", never a 0-hour age');

// ---------------------------------------------------------------------------
// 6. Fetch failure paths through the real refreshBackupStatus().
// ---------------------------------------------------------------------------
(async () => {
  // 6A. Network rejection.
  resetDom();
  sandbox.fetch = async () => { throw new Error('NetworkError: Failed to fetch'); };
  await api.refreshBackupStatus(true);
  assert.strictEqual(elements['backup-status-pill-text'].textContent, 'Backup status unavailable');
  assert.ok(elements['backup-status-pill'].classList.contains('bg-amber-50'), 'Unavailable pill must be amber');
  assert.ok(!elements['backup-status-banner'].classList.contains('hidden'),
    'A failed status check MUST be visible, not silent');
  assert.ok(/BACKUP STATUS UNAVAILABLE/.test(elements['backup-status-banner-title'].textContent));
  assert.ok(/Failed to fetch/.test(elements['backup-status-pill-detail'].textContent),
    'The real error must be reported, not hidden');
  console.log('✓ Network failure renders a visible "Backup status unavailable" state with the real error');

  // 6B. Non-OK HTTP response.
  resetDom();
  sandbox.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await api.refreshBackupStatus(true);
  assert.strictEqual(elements['backup-status-pill-text'].textContent, 'Backup status unavailable');
  assert.ok(/HTTP 503/.test(elements['backup-status-pill-detail'].textContent));
  assert.ok(!elements['backup-status-banner'].classList.contains('hidden'));
  console.log('✓ HTTP 503 renders "Backup status unavailable" (never a green from a broken call)');

  // 6C. Malformed body (no healthy flag) must not be treated as healthy.
  resetDom();
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
  await api.refreshBackupStatus(true);
  assert.strictEqual(elements['backup-status-pill-text'].textContent, 'Backup status unavailable');
  assert.ok(!elements['backup-status-pill'].classList.contains('bg-emerald-50'));
  console.log('✓ A malformed response is reported as unavailable, not silently treated as healthy');

  // 6D. THE critical case: a green already on screen must be cleared by a later failure.
  resetDom();
  sandbox.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ success: true, healthy: true, ageHours: 2, lastSuccessAt: '2026-08-29T16:00:00.000Z', lastFailureAt: null, reason: 'ok' })
  });
  await api.refreshBackupStatus(true);
  assert.ok(elements['backup-status-pill'].classList.contains('bg-emerald-50'), 'Precondition: green rendered');
  sandbox.fetch = async () => { throw new Error('gateway timeout'); };
  await api.refreshBackupStatus(true);
  assert.ok(!elements['backup-status-pill'].classList.contains('bg-emerald-50'),
    'A stale green MUST NOT survive a failed status check');
  assert.strictEqual(elements['backup-status-pill-text'].textContent, 'Backup status unavailable');
  console.log('✓ A previously rendered green is cleared when the next check fails');

  // 6E. Healthy end-to-end through the real fetch path, using the exact shape the live
  //     endpoint returned today (2026-08-29: healthy true, ageHours 0, 5 archives).
  resetDom();
  let requestedUrl = null;
  sandbox.fetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true, status: 200,
      json: async () => ({
        success: true, container: 'cosmos-backups', checkedAt: '2026-08-29T15:47:28.753Z',
        lastSuccessAt: '2026-08-29T15:47:20.000Z', lastAttemptAt: '2026-08-29T15:47:20.000Z',
        lastFailureAt: null, ageHours: 0, healthy: true,
        reason: 'Last successful backup is 0 h old.', successBackupCount: 5,
        failureMarkerCount: 0, maxAgeHours: 26
      })
    };
  };
  await api.refreshBackupStatus(true);
  assert.strictEqual(requestedUrl, 'https://psat-api-4915.azurewebsites.net/api/backup-status');
  assert.strictEqual(elements['backup-status-pill-text'].textContent, 'Cloud backup: 0m ago');
  assert.ok(elements['backup-status-banner'].classList.contains('hidden'));
  console.log('✓ Live response shape (measured 2026-08-29) renders green with 0m ago and no banner');

  console.log('✓ All parent.html backup-status widget tests passed!\n');
})().catch(err => {
  console.error('\n❌ test_backup_status_widget.js FAILED:', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
