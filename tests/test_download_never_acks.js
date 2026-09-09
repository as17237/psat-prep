/**
 * tests/test_download_never_acks.js — WI-33.
 *
 * A PULL must never acknowledge local changes. parent.js and mistakes.js wrote
 * downloaded state through safeSetStorage (which bumps the pending counter) and then
 * ZEROED that counter after a successful GET. A write saved on the student page and
 * then viewed on either page lost its unsent status: zero POSTs, no server record,
 * and parent displaying "Cosmos DB Synced (Just now)".
 *
 * student.js was fixed in WI-28; its twins were missed. This test is source-level on
 * purpose: the defect is that a page CALLS the wrong writer and then resets a counter,
 * which is a property of the call sites, not of any single function. It guards all
 * three pages so the next page to grow a sync path cannot quietly repeat it.
 *
 * Complements the behavioural coverage in tests/e2e/legacy_dirty_sync.spec.js.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const PAGES = ['js/pages/student.js', 'js/pages/parent.js', 'js/pages/mistakes.js'];

let n = 0;
const ok = (name) => { n++; console.log('  ok ' + n + ' — ' + name); };

const src = {};
PAGES.forEach((p) => { src[p] = fs.readFileSync(path.join(root, p), 'utf8'); });

// 1. Every pullFromCloud call passes the NON-bumping writer.
PAGES.forEach((p) => {
  const calls = src[p].match(/pullFromCloud\([^)]*\)/g) || [];
  assert.ok(calls.length > 0, p + ' is expected to pull from the cloud');
  calls.forEach((c) => {
    assert.ok(!/\bsafeSetStorage\b/.test(c),
      p + ' passes safeSetStorage to pullFromCloud: downloaded state would bump the ' +
      'pending counter and invent unsent changes. Use safeSetStorageDownloaded.');
  });
});
ok('no page hands safeSetStorage to pullFromCloud (' + PAGES.length + ' pages checked)');

// 2. No page zeroes the pending counter. Only a CONFIRMED upload may reduce it, and
//    it reconciles to the real remaining count rather than assuming zero.
PAGES.forEach((p) => {
  const zeroing = src[p].match(/psat_pending_sync_count['"]\s*,\s*['"]0['"]/g) || [];
  assert.deepStrictEqual(zeroing, [],
    p + " sets psat_pending_sync_count to '0'. A download proves nothing about the " +
    'upload, and hard-zeroing erases writes that were never sent.');
});
ok('no page hard-zeroes the pending counter');

// 3. Only the student page stamps a last-sync time, and only alongside a push.
PAGES.forEach((p) => {
  const stamps = (src[p].match(/psat_last_cloud_sync_time/g) || []).length;
  if (p === 'js/pages/student.js') {
    assert.ok(stamps > 0, 'the student page still records when a sync succeeded');
    const idx = src[p].indexOf("psat_last_cloud_sync_time', String(Date.now())");
    if (idx !== -1) {
      const guard = src[p].slice(Math.max(0, idx - 400), idx);
      assert.ok(/pushRes/.test(guard) && /ackPersisted/.test(guard),
        'the student page must only stamp a sync time behind a confirmed, persisted ' +
        'upload — never after a GET alone');
    }
  } else {
    const writes = src[p].match(/setItem\([^)]*psat_last_cloud_sync_time/g) || [];
    assert.deepStrictEqual(writes, [],
      p + ' stamps a last-sync time. Only a confirmed upload may claim that, and ' +
      'this page does not perform one.');
  }
});
ok('a last-sync time is only claimed behind a confirmed upload');

// 4. Mutations from any page must not fire-and-forget their upload.
{
  const m = src['js/pages/mistakes.js'];
  const idx = m.indexOf('PSAT_ENGINE.pushToCloud(localStorage)');
  assert.ok(idx !== -1, 'the mistakes page still uploads its error-tag change');
  const after = m.slice(idx, idx + 260);
  assert.ok(/\.then\(/.test(after) && /\.catch\(/.test(after),
    'setMistakeErrorTag ignored the upload outcome, so a failure was invisible and ' +
    'never retried. It must observe the result.');
}
ok('the mistakes page checks its error-tag upload outcome');

// 5. The non-bumping writer exists and genuinely does not touch the counter.
{
  const shared = fs.readFileSync(path.join(root, 'js/shared/storage.js'), 'utf8');
  const idx = shared.indexOf('export function safeSetStorageDownloaded');
  assert.ok(idx !== -1, 'safeSetStorageDownloaded must exist');
  const body = shared.slice(idx, shared.indexOf('\n}', idx));
  assert.ok(!/psat_pending_sync_count/.test(body),
    'safeSetStorageDownloaded must not touch the pending counter — that is its ' +
    'entire reason for existing');
}
ok('safeSetStorageDownloaded does not touch the pending counter');

console.log('\n✓ All ' + n + ' download-acknowledgement checks passed.\n');
