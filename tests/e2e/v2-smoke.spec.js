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

  // WI-09: the pages load their controllers with <script type="module">.
  // A module served with a non-JavaScript MIME type, or blocked by CSP, is
  // silently NOT executed -- the page renders its static markup and every
  // inline on* handler is a no-op, with no network error to notice. This
  // test is what makes that failure loud on the live lane.
  const PAGE_HANDLERS = {
    'index.html': ['switchTab', 'applyFilters', 'startMiniExam', 'toggleReferenceSheet'],
    'parent.html': ['renderParentMetrics', 'switchBuilderTab', 'launchMistakesDrill', 'toggleReferenceSheet'],
    'mistakes.html': ['setSubjectTab', 'launchMistakesDrill', 'onSearchInput'],
    'feedback.html': ['handleFeedbackSubmit', 'clearAllFeedback', 'exportFeedbackMarkdown'],
  };

  for (const [file, handlers] of Object.entries(PAGE_HANDLERS)) {
    test(`@v2smoke ${file}: its ES module is served as JavaScript, executes, and publishes its inline handlers`, async ({ page }) => {
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));

      const moduleResponses = [];
      page.on('response', (r) => {
        if (/\/v2\/js\/.*\.js(\?|$)/.test(r.url())) {
          moduleResponses.push({ url: r.url(), status: r.status(), type: r.headers()['content-type'] || '' });
        }
      });

      await page.goto(new URL(file, V2_BASE_URL).toString());

      // Every js/ module the page pulled in must be 200 and JavaScript-typed.
      expect(moduleResponses.length, `${file} loaded no js/ module at all`).toBeGreaterThan(0);
      moduleResponses.forEach((m) => {
        expect(m.status, `${m.url} did not return 200`).toBe(200);
        expect(m.type, `${m.url} Content-Type must be a JavaScript type or the browser refuses the module`)
          .toMatch(/javascript|ecmascript/i);
      });

      // The module ran and republished the functions the markup's on* handlers call.
      const missing = await page.evaluate(
        (names) => names.filter((n) => typeof window[n] !== 'function'),
        handlers
      );
      expect(missing, `${file}: handlers missing from window (module did not execute?)`).toEqual([]);

      expect(pageErrors, `${file} raised uncaught page errors on the live lane`).toEqual([]);
    });
  }
});
