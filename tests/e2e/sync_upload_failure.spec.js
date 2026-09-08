/**
 * tests/e2e/sync_upload_failure.spec.js — WI-28 finding 1, in a real browser.
 *
 * The isolated coordinator tests (tests/test_sync_retry.js) pass a SUBSTITUTED result
 * shape into `run`, so they proved the retry policy and completely missed the
 * integration error: manualTriggerCloudSync returned `pullRes`, the DOWNLOAD's result.
 * With a healthy GET and a failing POST the coordinator saw `success:true`, called the
 * drain complete, and stopped — leaving an unconfirmed operation queued forever.
 *
 * Reproduced by the reviewer on desktop and mobile: POST count stayed 2 -> 2 over
 * 6.5s with 1 op still queued. This spec pins the corrected behaviour: a failed upload
 * must NOT be reported as a completed sync, and the queue must survive.
 *
 * The route below overrides the fixture quarantine for the sync endpoint only, and
 * still never reaches a real socket.
 */
const { test, expect, seedEmpty } = require('./fixtures');

test.describe('sync upload failure (WI-28 finding 1)', () => {
  test('a healthy GET with a failing POST is not reported as synced, and the queue survives', async ({ page }) => {
    test.setTimeout(90000);

    let postCount = 0;
    let getCount = 0;
    // Registered BEFORE navigation so it wins over the fixture's catch-all.
    await page.route('**/api/sync**', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        getCount++;
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ success: true, exists: false })
        });
      }
      postCount++;
      // The upload is refused every time; the download stays perfectly healthy.
      return route.fulfill({
        status: 503, contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Service Unavailable' })
      });
    });

    await page.goto('/index.html');
    await seedEmpty(page);
    page.on('dialog', (d) => d.accept());
    await page.waitForFunction(() => typeof window.PSAT_ENGINE !== 'undefined', null, { timeout: 30000 });

    // Queue one real operation.
    await page.evaluate(() => {
      window.PSAT_ENGINE.enqueueOutboxOp(localStorage, 'question_attempt', {
        questionId: 'q_upload_fail', selectedAnswer: 'A', isCorrect: true,
        timeSpentMs: 12000, timestamp: 1788000000000
      }, window.location);
    });
    const before = await page.evaluate(() =>
      window.PSAT_ENGINE.getOutboxOps(localStorage, window.location).length);
    expect(before, 'one operation is queued to start with').toBe(1);

    // Drive the real handler the coordinator calls.
    const outcome = await page.evaluate(() => window.manualTriggerCloudSync(false));

    expect(getCount, 'the download must have happened').toBeGreaterThan(0);
    expect(postCount, 'and the upload must have been attempted').toBeGreaterThan(0);

    expect(
      outcome && outcome.success,
      'FINDING 1: a failed upload must NOT report success just because the download ' +
      'worked. Returning the GET result made the coordinator stop with work still queued.'
    ).toBe(false);
    expect(outcome.pullSuccess, 'the download genuinely did succeed').toBe(true);
    expect(outcome.pushSuccess, 'the upload genuinely did not').toBe(false);
    expect(outcome.pendingOps, 'and the operation is still queued, not silently dropped').toBe(1);

    const after = await page.evaluate(() =>
      window.PSAT_ENGINE.getOutboxOps(localStorage, window.location).length);
    expect(after, 'the durable queue survives a failed upload').toBe(1);

    // A 503 is transient, so the engine must classify this outcome as retryable —
    // this is what makes the coordinator schedule another attempt on its own.
    const verdict = await page.evaluate((o) => window.PSAT_ENGINE.classifySyncOutcome(o), outcome);
    expect(verdict, 'a 503 upload failure must be retryable, not treated as done').toBe('retry');
  });

  test('a rejected payload (400) is permanent, so it is reported instead of retried forever', async ({ page }) => {
    test.setTimeout(90000);
    await page.route('**/api/sync**', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ success: true, exists: false }) });
      }
      return route.fulfill({ status: 400, contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'bad payload' }) });
    });

    await page.goto('/index.html');
    await seedEmpty(page);
    page.on('dialog', (d) => d.accept());
    await page.waitForFunction(() => typeof window.PSAT_ENGINE !== 'undefined', null, { timeout: 30000 });

    await page.evaluate(() => {
      window.PSAT_ENGINE.enqueueOutboxOp(localStorage, 'question_attempt', {
        questionId: 'q_bad', selectedAnswer: 'B', isCorrect: false,
        timeSpentMs: 9000, timestamp: 1788000000001
      }, window.location);
    });

    const outcome = await page.evaluate(() => window.manualTriggerCloudSync(false));
    expect(outcome.success).toBe(false);

    // The engine reports `error: 'HTTP_400'` with no numeric status field; the original
    // numeric-only check classified that as retryable and would have burned the whole
    // attempt budget on a payload that can never succeed.
    const verdict = await page.evaluate((o) => window.PSAT_ENGINE.classifySyncOutcome(o), outcome);
    expect(verdict, 'a 4xx rejection must be permanent so the student SEES it').toBe('permanent');

    const after = await page.evaluate(() =>
      window.PSAT_ENGINE.getOutboxOps(localStorage, window.location).length);
    expect(after, 'and the work is still kept locally, never discarded').toBe(1);
  });
});
