/**
 * tests/test_outbox_ack.js — WI-25. Outbox acknowledgement integrity.
 *
 * From the external review in docs/OFFLINE_SYNC_VALIDATION.md, finding 2. All three
 * defects were measured against the shipped code:
 *
 *   1 queued op + {ackOpIds: []}      -> queue 0, reported ack 1   (DATA LOSS)
 *   1 queued op + unrelated ack id    -> queue 1, reported ack 1   (lies)
 *   outbox write fails during ack     -> queue 1, reported success (lies)
 *
 * The first is the serious one: a server reply acknowledging NOTHING deleted every
 * operation in the request. On a plane that is the student's unsynced work.
 *
 * Expected values are hand-written. No clocks are patched.
 */
const assert = require('assert');
const PSAT_ENGINE = require('../srs.js');

let n = 0;
function check(name, fn) { return fn().then(() => { n++; console.log('  ok ' + n + ' — ' + name); }); }

function makeStore(initial) {
  const map = Object.assign({}, initial || {});
  return {
    map,
    failOnKey: null,
    getItem(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem(k, v) {
      if (this.failOnKey && k.indexOf(this.failOnKey) !== -1) {
        const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
      }
      map[k] = String(v);
    },
    removeItem(k) { delete map[k]; }
  };
}

const LOC = { pathname: '/index.html', search: '' };
const BASE = {
  psat_progress: '{}', psat_srs: '{}', psat_sessions: '{}', psat_exam_history: '[]'
};

function withOps(store, ops) {
  store.setItem('psat_sync_outbox', JSON.stringify(ops));
}
function queueLen(store) {
  return JSON.parse(store.getItem('psat_sync_outbox') || '[]').length;
}
function fetchReturning(body) {
  return () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

const OP_A = { id: 'att_q1_1000', type: 'question_attempt', timestamp: 1000, payload: { questionId: 'q1' } };
const OP_B = { id: 'att_q2_2000', type: 'question_attempt', timestamp: 2000, payload: { questionId: 'q2' } };

(async () => {
  // -------------------------------------------------------------------------
  await check('an EMPTY ackOpIds acknowledges NOTHING — the data-loss case', async () => {
    const store = makeStore(BASE);
    withOps(store, [OP_A]);
    const res = await PSAT_ENGINE.pushToCloud(
      store, fetchReturning({ success: true, ackOpIds: [], updatedAt: 1 }), 'default_student', LOC);
    assert.strictEqual(res.success, true, 'the server did accept the write');
    assert.strictEqual(queueLen(store), 1,
      'a reply acknowledging nothing must leave the operation queued. Clearing it here ' +
      'is unrecoverable loss of the student\'s unsynced work.');
    assert.strictEqual(res.ackCount, 0, 'and it must not claim to have acknowledged one');
  });

  await check('a MISSING ackOpIds field acknowledges nothing either', async () => {
    const store = makeStore(BASE);
    withOps(store, [OP_A, OP_B]);
    const res = await PSAT_ENGINE.pushToCloud(
      store, fetchReturning({ success: true, updatedAt: 1 }), 'default_student', LOC);
    assert.strictEqual(queueLen(store), 2);
    assert.strictEqual(res.ackCount, 0);
  });

  await check('an UNKNOWN acked id removes nothing and is not counted', async () => {
    const store = makeStore(BASE);
    withOps(store, [OP_A]);
    const res = await PSAT_ENGINE.pushToCloud(
      store, fetchReturning({ success: true, ackOpIds: ['op_never_sent'], updatedAt: 1 }),
      'default_student', LOC);
    assert.strictEqual(queueLen(store), 1, 'an id we never sent must not drop a real op');
    assert.strictEqual(res.ackCount, 0);
  });

  await check('a PARTIAL acknowledgement removes exactly the confirmed op', async () => {
    const store = makeStore(BASE);
    withOps(store, [OP_A, OP_B]);
    const res = await PSAT_ENGINE.pushToCloud(
      store, fetchReturning({ success: true, ackOpIds: [OP_A.id], updatedAt: 1 }),
      'default_student', LOC);
    assert.strictEqual(res.ackCount, 1);
    const left = JSON.parse(store.getItem('psat_sync_outbox'));
    assert.deepStrictEqual(left.map((o) => o.id), [OP_B.id], 'only the unconfirmed op remains');
  });

  await check('DUPLICATE acked ids are counted once, not twice', async () => {
    const store = makeStore(BASE);
    withOps(store, [OP_A, OP_B]);
    const res = await PSAT_ENGINE.pushToCloud(
      store, fetchReturning({ success: true, ackOpIds: [OP_A.id, OP_A.id], updatedAt: 1 }),
      'default_student', LOC);
    assert.strictEqual(res.ackCount, 1);
    assert.strictEqual(queueLen(store), 1);
  });

  await check('a storage failure during ack keeps the queue and does NOT claim it drained', async () => {
    const store = makeStore(BASE);
    withOps(store, [OP_A]);
    store.failOnKey = 'psat_sync_outbox';
    const res = await PSAT_ENGINE.pushToCloud(
      store, fetchReturning({ success: true, ackOpIds: [OP_A.id], updatedAt: 1 }),
      'default_student', LOC);
    assert.strictEqual(queueLen(store), 1, 'the op is still queued because the write failed');
    assert.strictEqual(res.ackCount, 0, 'so nothing may be reported as acknowledged');
    assert.strictEqual(res.ackPersisted, false, 'and the caller must be able to SEE that');
    assert.strictEqual(res.pendingOps, 1, 'pending count must reflect the real queue');
  });

  await check('ackOutboxOps returns null on write failure, 0 on no-match — they differ', async () => {
    const ok = makeStore(BASE);
    withOps(ok, [OP_A]);
    assert.strictEqual(PSAT_ENGINE.ackOutboxOps(ok, ['nope'], LOC), 0, 'no match is 0');

    const bad = makeStore(BASE);
    withOps(bad, [OP_A]);
    bad.failOnKey = 'psat_sync_outbox';
    assert.strictEqual(PSAT_ENGINE.ackOutboxOps(bad, [OP_A.id], LOC), null,
      'a failed persist must be null, never 0 — conflating them is how a full queue ' +
      'gets reported as drained');
  });

  await check('a full acknowledgement still drains the queue', async () => {
    const store = makeStore(BASE);
    withOps(store, [OP_A, OP_B]);
    const res = await PSAT_ENGINE.pushToCloud(
      store, fetchReturning({ success: true, ackOpIds: [OP_A.id, OP_B.id], updatedAt: 1 }),
      'default_student', LOC);
    assert.strictEqual(res.ackCount, 2);
    assert.strictEqual(res.pendingOps, 0);
    assert.strictEqual(res.ackPersisted, true);
  });

  console.log('\n✓ All ' + n + ' outbox acknowledgement checks passed.\n');
})().catch((e) => { console.error('\nTEST FAILURE: ' + (e && e.message)); process.exit(1); });
