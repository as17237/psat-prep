/**
 * @v2smoke -- a small subset of checks run against the LIVE deployed /v2/
 * copy at https://psatprep4915.z13.web.core.windows.net/v2/. Tagged so CI
 * can skip it (no live-network dependency required for the PR gate); run
 * locally with `npm run test:e2e:v2smoke`.
 *
 * This project uses the fixture's "passthrough" sync-quarantine mode (see
 * fixtures.js) -- real network calls are allowed through, but ANY request
 * containing "default_student" is aborted and hard-fails the test. This
 * spec does not do anything that would trigger a sync call (it never
 * answers a question or touches localStorage), so no sync traffic is
 * expected here at all; the quarantine is defense in depth.
 */
const { test, expect, V2_BASE_URL } = require('./fixtures');

test.describe('@v2smoke live /v2/ deployment', () => {
  test('@v2smoke page loads, bundle loads, a question image returns 200, PSAT_CLIENT_VERSION is present', async ({ page }) => {
    await page.goto(V2_BASE_URL);
    await expect(page).toHaveTitle(/PSAT/i);

    const bundleCount = await page.evaluate(() => (window.QUESTIONS_DATA || []).length);
    expect(bundleCount).toBe(3059);

    const clientVersion = await page.evaluate(() => window.PSAT_CLIENT_VERSION);
    expect(typeof clientVersion).toBe('string');
    expect(clientVersion.length).toBeGreaterThan(0);

    // Select a subject filter so a question with a real image loads, then
    // confirm the actual <img> the student would see resolves with a 200.
    await page.selectOption('#filter-subject', 'Reading and Writing');
    const imgSrc = await page.locator('#q-image').getAttribute('src');
    expect(imgSrc).toBeTruthy();

    const imgUrl = new URL(imgSrc, V2_BASE_URL).toString();
    const resp = await page.request.get(imgUrl);
    expect(resp.status()).toBe(200);
  });
});
