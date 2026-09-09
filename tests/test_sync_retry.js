/**
 * tests/test_sync_retry.js — WI-26. Retry after a transient reconnect failure.
 *
 * Review finding 3 (docs/OFFLINE_SYNC_VALIDATION.md). The reconnect handler scheduled
 * exactly ONE sync 2.5s after the `online` event. If the API happened to be down at
 * that instant the attempt failed and nothing retried — an idle student's work stayed
 * queued until they answered again, reloaded, or pressed Sync. Measured on desktop and
 * mobile: after a 503 the server recovered, and over the next 6.5s POST count stayed
 * 1 -> 1 with 1 op queued.
 *
 * Timers and randomness are INJECTED, so backoff is exact and nothing sleeps.
 * Expected values are hand-written.
 */
const assert = require('assert');
const PSAT_ENGINE = require('../srs.js');
const { classifySyncOutcome, nextRetryDelayMs, createSyncCoordinator, SYNC_RETRY } = PSAT_ENGINE;

let n = 0;
const ok = (name) => { n++; console.log('  ok ' + n + ' — ' + name); };
const settle = () => new Promise((r) => setImmediate(r));

// Completion watchdog. Several checks await a promise; break the timeout handling and
// one of them awaits a promise that never settles, so node drains its loop and exits 0
// with no output — indistinguishable from success. This is the same trap that hid the
// service-worker timer bug (CLAUDE.md: a run that produced no output has verified nothing).
let allChecksDone = false;
process.on('exit', function (code) {
  if (code === 0 && !allChecksDone) {
    console.error('\nTEST FAILURE: the sync retry checks never completed — a promise ' +
      'never settled, most likely because a request or its body is not bounded.');
    process.exitCode = 1;
  }
});

// A hand-driven clock: nothing fires until fire() is called.
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => pending.delete(id),
    fire: () => { const all = [...pending.values()]; pending.clear(); all.forEach((p) => p.fn()); },
    delays: () => [...pending.values()].map((p) => p.ms),
    count: () => pending.size
  };
}

(async () => {
  // ---- classification -----------------------------------------------------
  assert.strictEqual(classifySyncOutcome({ success: true }), 'ok');
  assert.strictEqual(classifySyncOutcome({ success: false, error: 'Failed to fetch' }), 'retry');
  assert.strictEqual(classifySyncOutcome(null), 'retry', 'a thrown/absent result is transient');
  assert.strictEqual(classifySyncOutcome({ success: false, status: 503 }), 'retry');
  assert.strictEqual(classifySyncOutcome({ success: false, status: 400 }), 'permanent',
    'a rejected payload will never succeed on retry; loop forever and the student never sees it');
  assert.strictEqual(classifySyncOutcome({ success: false, skipped: true, reason: 'readonly' }), 'permanent');
  ok('outcomes classify into ok / retry / permanent');

  // ---- backoff ------------------------------------------------------------
  // rand() = 0.5 makes jitter exactly zero, so these are the pure doubling values.
  const noJitter = () => 0.5;
  assert.deepStrictEqual(
    [1, 2, 3, 4, 5].map((a) => nextRetryDelayMs(a, noJitter)),
    [2000, 4000, 8000, 16000, 32000],
    'base 2s doubling, hand-computed');
  assert.strictEqual(nextRetryDelayMs(SYNC_RETRY.maxAttempts + 1, noJitter), null,
    'attempts are bounded — a permanently dead server must not be retried forever');
  assert.strictEqual(nextRetryDelayMs(0, noJitter), null, 'attempt is 1-based');
  ok('backoff doubles from 2s, is capped, and gives up after maxAttempts');

  assert.strictEqual(nextRetryDelayMs(20, noJitter, { ...SYNC_RETRY, maxAttempts: 40 }),
    SYNC_RETRY.maxDelayMs, 'a long outage saturates at the 5-minute cap, never beyond');
  const lo = nextRetryDelayMs(3, () => 0, SYNC_RETRY);
  const hi = nextRetryDelayMs(3, () => 1, SYNC_RETRY);
  assert.strictEqual(lo, 6000);   // 8000 - 25%
  assert.strictEqual(hi, 10000);  // 8000 + 25%
  assert.ok(lo >= 0, 'jitter can never produce a negative delay');
  ok('jitter spreads +/-25% around the capped delay and never goes negative');

  // ---- THE REPRODUCTION: transient failure, then recovery, with no new event
  {
    const t = fakeTimers();
    let calls = 0;
    const co = createSyncCoordinator({
      timers: t,
      rand: noJitter,
      run: () => {
        calls++;
        // First attempt hits a 503; the server recovers immediately afterwards.
        return Promise.resolve(calls === 1 ? { success: false, status: 503 } : { success: true });
      }
    });

    co.requestSync('reconnect');
    await settle();
    assert.strictEqual(calls, 1, 'the reconnect attempt ran');
    assert.strictEqual(co.getState().status, 'retrying');
    assert.strictEqual(co.getState().retryScheduled, true,
      'FINDING 3: a retry must be scheduled WITHOUT another answer or connectivity event');
    assert.deepStrictEqual(t.delays(), [2000]);

    t.fire();                       // the scheduled retry runs on its own
    await settle();
    assert.strictEqual(calls, 2, 'it retried by itself');
    assert.strictEqual(co.getState().status, 'synced');
    assert.strictEqual(co.getState().attempt, 0, 'a success resets the backoff ladder');
  }
  ok('FINDING 3: a transient failure retries itself and succeeds once the server recovers');

  // ---- a permanent failure must NOT loop ----------------------------------
  {
    const t = fakeTimers();
    let calls = 0;
    const co = createSyncCoordinator({
      timers: t, rand: noJitter,
      run: () => { calls++; return Promise.resolve({ success: false, status: 400, error: 'bad payload' }); }
    });
    co.requestSync('reconnect');
    await settle();
    assert.strictEqual(calls, 1);
    assert.strictEqual(co.getState().status, 'failed');
    assert.strictEqual(co.getState().retryScheduled, false, 'no retry loop on a permanent error');
    assert.strictEqual(co.getState().lastError, 'bad payload', 'and the reason stays visible');
  }
  ok('a permanent failure stops and reports instead of spinning');

  // ---- single flight ------------------------------------------------------
  {
    const t = fakeTimers();
    let calls = 0;
    let release;
    const co = createSyncCoordinator({
      timers: t, rand: noJitter,
      run: () => { calls++; return new Promise((r) => { release = r; }); }
    });
    co.requestSync('a');
    await settle();
    co.requestSync('b');
    co.requestSync('c');
    await settle();
    assert.strictEqual(calls, 1, 'requests arriving mid-flight must not stack parallel pushes');
    assert.strictEqual(co.getState().pendingRequest, true, 'they coalesce into one follow-up');
    release({ success: true });
    await settle(); await settle();
    assert.strictEqual(calls, 2, 'and exactly one follow-up drain runs afterwards');
  }
  ok('one drain in flight; concurrent requests coalesce into a single follow-up');

  // ---- exhaustion ---------------------------------------------------------
  {
    const t = fakeTimers();
    let calls = 0;
    const co = createSyncCoordinator({
      timers: t, rand: noJitter,
      config: { ...SYNC_RETRY, maxAttempts: 3 },
      run: () => { calls++; return Promise.resolve({ success: false, error: 'Failed to fetch' }); }
    });
    co.requestSync('reconnect');
    await settle();
    for (let i = 0; i < 5 && t.count() > 0; i++) { t.fire(); await settle(); }
    assert.strictEqual(calls, 4, '1 initial + 3 retries, then it stops');
    assert.strictEqual(co.getState().status, 'failed');
    assert.strictEqual(co.getState().retryScheduled, false);
  }
  ok('a server that never recovers is retried a bounded number of times, then reported');

  // ---- stop() -------------------------------------------------------------
  {
    const t = fakeTimers();
    const co = createSyncCoordinator({
      timers: t, rand: noJitter,
      run: () => Promise.resolve({ success: false, error: 'down' })
    });
    co.requestSync('reconnect');
    await settle();
    assert.strictEqual(t.count(), 1);
    co.stop();
    assert.strictEqual(t.count(), 0, 'stop() cancels the pending retry');
  }
  ok('stop() cancels a scheduled retry');

  // ---- a throwing run must not kill the coordinator -----------------------
  {
    const t = fakeTimers();
    let calls = 0;
    const co = createSyncCoordinator({
      timers: t, rand: noJitter,
      run: () => { calls++; if (calls === 1) throw new Error('boom'); return Promise.resolve({ success: true }); }
    });
    co.requestSync('reconnect');
    await settle();
    assert.strictEqual(co.getState().status, 'retrying', 'a synchronous throw is transient, not fatal');
    t.fire(); await settle();
    assert.strictEqual(co.getState().status, 'synced');
  }
  ok('a throwing run is treated as transient and recovers');

  // ---- WI-29 finding 2: the deadline must cover BODY consumption ------------
  // The timer used to clear when HEADERS arrived; callers then awaited res.json().
  // A server answering instantly but stalling its body left the drain pending
  // forever — measured at 21,038 ms against a 20,000 ms timeout.
  {
    const store = {
      m: { psat_progress: '{}', psat_srs: '{}', psat_sessions: '{}', psat_exam_history: '[]' },
      getItem(k) { return this.m[k] || null; },
      setItem(k, v) { this.m[k] = String(v); },
      removeItem(k) { delete this.m[k]; }
    };
    const stalledBody = () => Promise.resolve({
      ok: true, status: 200, json: () => new Promise(() => {})   // never settles
    });
    const t0 = Date.now();
    const res = await PSAT_ENGINE.pushToCloud(store, stalledBody, 'default_student',
      { pathname: '/', search: '' });
    const ms = Date.now() - t0;
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, 'SYNC_TIMEOUT',
      'a stalled response BODY must hit the timeout, not hang the drain forever');
    assert.ok(ms < PSAT_ENGINE.SYNC_REQUEST_TIMEOUT_MS + 5000,
      'it must settle near the configured deadline, not beyond it (took ' + ms + 'ms)');
    assert.strictEqual(PSAT_ENGINE.classifySyncOutcome(res), 'retry',
      'and a timeout is transient, so the coordinator retries it');
    console.log('    stalled body settled after ' + ms + 'ms (deadline ' +
      PSAT_ENGINE.SYNC_REQUEST_TIMEOUT_MS + 'ms)');
  }
  ok('FINDING 2: a stalled response body is bounded by the sync timeout');

  allChecksDone = true;
  console.log('\n✓ All ' + n + ' sync retry checks passed.\n');
})().catch((e) => { console.error('\nTEST FAILURE: ' + (e && e.message)); process.exit(1); });
