/**
 * WI-18 read-only validation mode: network-capture proof (index.html).
 *
 * The parallel-run validation loads /v2/ against the REAL default_student cloud
 * document to confirm it renders correctly — but it must be physically incapable
 * of writing to that document. `?readonly=1` (js/engine/sync.js isReadOnlyMode)
 * disables every cloud PUSH client-side. This spec proves that with a network
 * capture: with the flag on, a push attempt issues ZERO POSTs to the sync
 * endpoint; a positive-control test (flag off) proves the capture would actually
 * see a POST if one were made — so the "zero" is meaningful, not a dead assertion.
 *
 * Runs entirely against the local server + the fixture's sync quarantine; it never
 * touches live data. The live side-by-side comparison (WI-18b) is owner-run.
 */
const { test, expect, seedFixtureProfile } = require('./fixtures');

const SYNC_PATH = '/api/sync';

/** Records every POST issued to the sync endpoint (intercepted or not). */
function capturePosts(page) {
  const posts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes(SYNC_PATH)) posts.push(req.url());
  });
  return posts;
}

/** Attempt a full cloud push through the real engine, using the page's own URL/flag. */
function attemptPush(page) {
  return page.evaluate(() =>
    window.PSAT_ENGINE.pushToCloud(localStorage, fetch, 'default_student', window.location, { full: true })
  );
}

test.describe('WI-18 read-only mode (network capture)', () => {
  test('?readonly=1: a push attempt issues ZERO sync POSTs and reports reason "readonly"', async ({ page }) => {
    const posts = capturePosts(page);
    await page.goto('/index.html?readonly=1');
    await seedFixtureProfile(page); // real data present, so there is something to push
    // sanity: the URL still carries the flag after the fixture's reload
    expect(await page.evaluate(() => window.location.search)).toContain('readonly=1');

    const result = await attemptPush(page);
    expect(result.reason).toBe('readonly');
    expect(result.success).toBe(false);

    await page.waitForTimeout(300); // let any stray request surface
    expect(posts, `expected 0 sync POSTs in readonly mode, saw:\n${posts.join('\n')}`).toHaveLength(0);
  });

  test('positive control (flag off): the same push DOES issue a sync POST', async ({ page }) => {
    const posts = capturePosts(page);
    await page.goto('/index.html');
    await seedFixtureProfile(page);

    const result = await attemptPush(page);
    // Stub quarantine fulfills the request locally, so it "succeeds"; the point is
    // that a POST was actually issued — proving the readonly test's 0 is real.
    expect(result.reason).not.toBe('readonly');
    await page.waitForTimeout(300);
    expect(posts.length).toBeGreaterThanOrEqual(1);
  });
});
