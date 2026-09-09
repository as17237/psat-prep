/**
 * tests/e2e/legacy_dirty_sync.spec.js — WI-31.
 *
 * A local write made through safeSetStorage bumps psat_pending_sync_count but does NOT
 * append an outbox operation. The drain's completion check looked only at the outbox,
 * so it reported `synced` and stopped while that change was still undelivered:
 *
 *   legacy pending 1 · local flag true · server flag false
 *   coordinator synced · pendingRequest false · retryScheduled false
 *
 * Worse, the change is invisible to a DELTA push — buildSyncDelta selects on
 * `p.timestamp`, and toggling a flag does not move it — so even a retry would never
 * have carried it. The fix folds legacy state into completion AND escalates the next
 * push to a full one.
 *
 * The reviewer was explicit about how to test it, and both clauses are honoured here:
 *   - the second upload must happen with NO further user action;
 *   - acceptance is judged by the SERVER's updated value, never a zeroed counter,
 *     because a counter reaching zero is exactly the false signal that hid this twice.
 */
const { test, expect, seedEmpty } = require('./fixtures');

const QID = 'q_legacy_dirty';

test.describe('legacy dirty state reaches the server (WI-31)', () => {
  test('a local write made during an upload is delivered automatically, and the server value changes', async ({ page }) => {
    test.setTimeout(120000);

    // A tiny simulated server that records the last accepted flag for QID.
    const server = { flag: null, posts: 0 };
    await page.route('**/api/sync**', async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ success: true, exists: false })
        });
      }
      server.posts++;
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch (e) { body = {}; }
      const entry = (body.progress || {})[QID];
      if (entry && typeof entry.isFlagged === 'boolean') server.flag = entry.isFlagged;
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, updatedAt: Date.now(), ackOpIds: (body.outboxOps || []).map((o) => o.id) })
      });
    });

    await page.goto('/index.html');
    await seedEmpty(page);
    page.on('dialog', (d) => d.accept());
    await page.waitForFunction(() => typeof window.PSAT_ENGINE !== 'undefined', null, { timeout: 30000 });

    // Seed the question with flag FALSE and let a first sync carry it.
    await page.evaluate((qid) => {
      const p = JSON.parse(localStorage.getItem('psat_progress') || '{}');
      p[qid] = { answered: true, isCorrect: true, isFlagged: false, timestamp: Date.now(),
                 timesSeen: 1, timesCorrect: 1, timesIncorrect: 0, attempts: [] };
      localStorage.setItem('psat_progress', JSON.stringify(p));
    }, QID);
    await page.evaluate(() => window.manualTriggerCloudSync(false));
    expect(server.flag, 'the first upload carries the original value').toBe(false);

    // Now the defect's shape: a LEGACY-ONLY write — counter bumped, no outbox op, and
    // crucially no change to `timestamp`, so a delta push cannot see it.
    const beforeOutbox = await page.evaluate((qid) => {
      const p = JSON.parse(localStorage.getItem('psat_progress') || '{}');
      p[qid].isFlagged = true;                     // newer state, same timestamp
      localStorage.setItem('psat_progress', JSON.stringify(p));
      const key = 'psat_pending_sync_count';
      localStorage.setItem(key, String((parseInt(localStorage.getItem(key) || '0', 10) || 0) + 1));
      return window.PSAT_ENGINE.getOutboxOps(localStorage, window.location).length;
    }, QID);
    expect(beforeOutbox, 'the write is legacy-only — nothing is queued in the outbox').toBe(0);

    // PHASE A — dirt present BEFORE the drain.
    // The push is escalated to FULL because the legacy counter is non-zero, so this
    // single drain carries the change. Acceptance is judged on the SERVER's value.
    const outcomeA = await page.evaluate(() => window.manualTriggerCloudSync(false));
    expect(outcomeA.pendingOps, 'the outbox really is empty — this is legacy-only dirt').toBe(0);
    expect(
      server.flag,
      'the newer value must reach the server. A delta push cannot see it (timestamp ' +
      'unchanged), so this only passes because legacy dirt forces a FULL push.'
    ).toBe(true);
    expect(outcomeA.success, 'and with it delivered, the drain may report completion').toBe(true);
    expect(outcomeA.pendingLegacy).toBe(0);

    // PHASE B — the reviewer's exact case: a write that lands WHILE a push is in
    // flight. That upload cannot contain it, so the drain must NOT report completion,
    // and the change must be delivered with NO further user action.
    server.flag = false;                       // server is stale again
    let releaseHeld;
    const held = new Promise((r) => { releaseHeld = r; });
    let holdNext = true;
    await page.unroute('**/api/sync**');
    await page.route('**/api/sync**', async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ success: true, exists: false }) });
      }
      if (holdNext) {
        holdNext = false;
        await held;                            // the in-flight window
      }
      server.posts++;
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch (e) { body = {}; }
      const entry = (body.progress || {})[QID];
      if (entry && typeof entry.isFlagged === 'boolean') server.flag = entry.isFlagged;
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, updatedAt: Date.now(), ackOpIds: (body.outboxOps || []).map((o) => o.id) }) });
    });

    // Give this drain something the DELTA will actually carry, otherwise pushToCloud
    // returns `no_changes` without posting, resolves instantly, and there is no
    // in-flight window to write into. (That is what the first version of this test
    // accidentally measured.)
    await page.evaluate(() => {
      const p = JSON.parse(localStorage.getItem('psat_progress') || '{}');
      p.q_delta_carrier = { answered: true, isCorrect: true, isFlagged: false,
        timestamp: Date.now(), timesSeen: 1, timesCorrect: 1, timesIncorrect: 0, attempts: [] };
      localStorage.setItem('psat_progress', JSON.stringify(p));
    });

    const inFlight = page.evaluate(() => window.manualTriggerCloudSync(false));
    await page.waitForTimeout(800);
    // Newer local state, saved while that upload is still open.
    await page.evaluate((qid) => {
      const p = JSON.parse(localStorage.getItem('psat_progress') || '{}');
      p[qid].isFlagged = true;
      localStorage.setItem('psat_progress', JSON.stringify(p));
      const key = 'psat_pending_sync_count';
      localStorage.setItem(key, String((parseInt(localStorage.getItem(key) || '0', 10) || 0) + 1));
    }, QID);
    releaseHeld();
    const outcomeB = await inFlight;

    console.log('LEGACY_NOW ' + await page.evaluate(() => localStorage.getItem('psat_pending_sync_count')));
    expect(
      outcomeB.success,
      'a drain must NOT report completion while a change saved during its own upload ' +
      'is still undelivered — that is what let the coordinator stop and strand it'
    ).toBe(false);
    expect(outcomeB.pendingLegacy, 'and the outcome must say how much is left').toBeGreaterThan(0);
    const verdict = await page.evaluate((o) => window.PSAT_ENGINE.classifySyncOutcome(o), outcomeB);
    expect(verdict, 'leftover dirty state is transient, not a permanent failure').toBe('retry');

    // NO further user action beyond asking the coordinator once: it must converge.
    await page.evaluate(() => window.requestSync('test-reconnect'));
    await page.waitForFunction(() => {
      const c = window.__coordState && window.__coordState();
      return c && c.status === 'synced';
    }, null, { timeout: 30000 });

    expect(server.flag, 'the change saved mid-upload must reach the server automatically').toBe(true);
    const finalState = await page.evaluate(() => ({
      legacy: parseInt(localStorage.getItem('psat_pending_sync_count') || '0', 10) || 0,
      outbox: window.PSAT_ENGINE.getOutboxOps(localStorage, window.location).length
    }));
    expect(finalState.outbox).toBe(0);
    expect(finalState.legacy, 'and only then may the pending count clear').toBe(0);
  });
});
