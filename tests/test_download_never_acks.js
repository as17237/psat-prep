// Execute the shared page policy: a download cannot acknowledge local writes.
const assert = require('assert');
const vm = require('vm');
const E = require('../srs');
const { moduleScript } = require('./helpers/page_source');

function fixture(pushResult, duringPush) {
  const data = { psat_pending_sync_count: '3' };
  const storage = {
    getItem: key => data[key] ?? null,
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: key => { delete data[key]; }
  };
  let uploads = 0;
  const context = vm.createContext({
    localStorage: storage, console,
    window: { location: { pathname: '/index.html', search: '' }, addEventListener() {} },
    document: { addEventListener() {} }, navigator: {},
    setTimeout: () => 1, clearTimeout() {},
    PSAT_ENGINE: { ...E,
      createSyncCoordinator: opts => E.createSyncCoordinator({ ...opts,
        timers: { setTimeout: () => 1, clearTimeout() {} } }),
      pullFromCloud: async (local, fetch, student, write) => {
        assert.strictEqual(write('psat_progress', { cloud: { answered: true } }), true);
        assert.strictEqual(data.psat_pending_sync_count, '3', 'GET must not change dirty count');
        assert.strictEqual(data.psat_last_cloud_sync_time, undefined);
        return { success: true };
      },
      pushToCloud: async (local, fetch, student, location, options) => {
        uploads++;
        assert.strictEqual(options.full, true, 'legacy edits must be included in the upload');
        if (duringPush) duringPush(storage);
        return pushResult;
      }
    }
  });
  vm.runInContext(moduleScript('js/shared/sync.js') +
    '\nglobalThis.sync = createPageSync({ onState() {}, onPull() {} });', context);
  return { data, sync: context.sync, uploads: () => uploads };
}

(async () => {
  for (const result of [
    { success: false, status: 503 },
    { success: true, ackPersisted: false, syncMode: 'full' },
    { success: true, ackPersisted: true, syncMode: 'delta' }
  ]) {
    const f = fixture(result);
    assert.strictEqual((await f.sync.requestSync()).success, false);
    assert.strictEqual(f.data.psat_pending_sync_count, '3');
    assert.strictEqual(f.data.psat_last_cloud_sync_time, undefined);
    assert.strictEqual(f.uploads(), 1);
  }
  const accepted = { success: true, ackPersisted: true, syncMode: 'full' };
  const f = fixture(accepted);
  assert.strictEqual((await f.sync.requestSync()).success, true);
  assert.strictEqual(f.data.psat_pending_sync_count, '0');
  assert.ok(Number(f.data.psat_last_cloud_sync_time) > 0);

  const newer = fixture(accepted, s => s.setItem('psat_pending_sync_count', '4'));
  assert.strictEqual((await newer.sync.requestSync()).success, false);
  assert.strictEqual(newer.data.psat_pending_sync_count, '1');
  assert.strictEqual(newer.data.psat_last_cloud_sync_time, undefined);
  assert.strictEqual(newer.sync.getState().status, 'retrying');

  const pending = fixture(accepted, s => s.setItem('psat_sync_outbox', JSON.stringify([{ id: 'unacknowledged' }])));
  assert.strictEqual((await pending.sync.requestSync()).success, false);
  assert.strictEqual(pending.data.psat_pending_sync_count, '1');
  assert.strictEqual(pending.data.psat_last_cloud_sync_time, undefined);
  console.log('6 shared download/upload acknowledgement scenarios passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
