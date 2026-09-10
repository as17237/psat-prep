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

// Exercises the deployed client and API through the mandatory test-identity rewrite.
// No profile is reset: this appends one explicitly named test report.
test('@v2smoke release pause, report parity, and retried metadata upload', async ({ page }) => {
  test.setTimeout(120000);
  const base = process.env.PSAT_RELEASE_SMOKE_ROOT || V2_BASE_URL;
  expect([V2_BASE_URL, new URL('/', V2_BASE_URL).href]).toContain(base);
  const endpoint = 'https://psat-api-4915.azurewebsites.net/api/sync?student_name=e2e_test_student';
  let rejectNextPost = false;
  let rejected = 0;
  await page.route('**/api/sync**', async route => {
    if (route.request().method() === 'POST' && rejectNextPost) {
      rejectNextPost = false;
      rejected++;
      return route.fulfill({ status: 503, body: 'Release-check transient failure' });
    }
    return route.fallback(); // mandatory quarantine rewrites before real network
  });
  page.on('dialog', d => d.accept());
  await page.goto(new URL('index.html', base).href);
  await expect.poll(() => page.evaluate(() => window.__coordState().status), { timeout: 30000 }).toBe('synced');
  const examId = 'release_check_' + Date.now();
  await page.evaluate(id => {
    const qs = ['Reading and Writing', 'Math'].flatMap(section =>
      QUESTIONS_DATA.filter(q => q.test === section && q.type === 'multiple_choice').slice(0, 15));
    startCustomTestDirect({ id, type: 'focused_custom_test', title: 'Release verification', questions: qs, timeLimitMinutes: 30 });
  }, examId);
  await page.click('#btn-pause-exam');
  const banked = await page.evaluate(() => JSON.parse(localStorage.getItem('psat_active_exam_state')).pausedRemainingSeconds);
  await page.reload();
  await page.click('#tab-exam');
  await page.evaluate(() => resumeActiveExamState());
  await expect(page.locator('#exam-paused-overlay')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('psat_active_exam_state')).pausedRemainingSeconds)).toBe(banked);
  await page.locator('#exam-paused-overlay button').click();
  rejectNextPost = true;
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('psat_active_exam_state'));
    saved.activeExamMeta.modules[0].questionIds.forEach((id, i) => {
      loadExamQuestion(i);
      selectExamMcqChoice(QUESTIONS_DATA.find(q => q.id === id).correct_answer);
    });
    showModuleReviewScreen(); submitCurrentExamModule();
  });
  await expect(page.locator('#report-total-score')).toHaveText('1440');
  await expect(page.locator('#report-pause-note')).toContainText('Paused 1 time');
  await expect.poll(() => page.evaluate(() => window.__coordState().status), { timeout: 30000 }).toBe('synced');
  expect(rejected).toBe(1);
  const response = await page.request.get(endpoint);
  expect(response.ok()).toBe(true);
  const cloud = (await response.json()).data;
  const report = cloud.examHistory.find(r => r.examId === examId);
  expect(report).toMatchObject({ totalQuestions: 30, totalCorrect: 30, pauseCount: 1 });
  expect(report.shortTestEstimate.totalScore).toBe(1440);
  expect(report.totalPausedMs).toBeGreaterThan(0);
  await page.goto(new URL('parent.html', base).href);
  await page.evaluate(id => openParentExamReview(id), examId);
  await expect(page.locator('#pmod-exam-score')).toContainText('1440');
  await expect(page.locator('#pmod-exam-estimate-note')).toContainText('Estimated from this test alone');
  await expect(page.locator('#pmod-exam-pause-note')).toContainText('Paused 1 time');
  await page.goto(new URL('mistakes.html', base).href);
  const qid = await page.evaluate(() => QUESTIONS_DATA[0].id);
  rejectNextPost = true;
  await page.evaluate(id => setMistakeErrorTag(id, 'concept_gap'), qid);
  await expect.poll(async () => {
    const r = await page.request.get(endpoint);
    return r.ok() ? (await r.json()).data.progress[qid]?.errorTag : null;
  }, { timeout: 30000 }).toBe('concept_gap');
  await expect(page.locator('#mistakes-sync-status-text')).toHaveText('All work saved', { timeout: 30000 });
  expect(rejected).toBe(2);
  console.log('RELEASE_LIVE_SMOKE_OK', base, examId, '30 correct, pause retained, 2 rejected uploads recovered; e2e_test_student only');
});
