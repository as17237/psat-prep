/**
 * KNOWN DEFECTS -- discovered while building the WI-08 browser-truth
 * baseline, NOT introduced by this work item. These are real, reproducible
 * defects in the CURRENT app (verified at git HEAD; `git show HEAD:index.html`
 * / `git show HEAD:parent.html` contain the same lines).
 *
 * WI-08's brief is additive only: "Rollback: n/a (additive)" and the
 * completion contract requires index.html/parent.html to be byte-identical
 * to HEAD at the end of this work item (see the red-demonstration step).
 * So these are NOT fixed here -- they are pinned as passing assertions
 * describing today's actual behavior, per CLAUDE.md's rule against writing
 * a test that cannot fail: the moment someone fixes any of these (in a
 * later work item), the corresponding assertion below will go RED, which
 * is the intended signal to update this file and un-mark the `test.fail()`
 * annotations in the other WI-08 specs that work around these defects.
 *
 * Root causes (all three are dangling references left over from the
 * "UI simplification pass" commit 7b22ff6, which removed DOM elements
 * without updating the JS that reads them -- CLAUDE.md mode 2/6):
 *
 *  1. index.html loadQuestion(): `document.getElementById('text-mode-warning')`
 *     returns null (that element was deleted from the template), and the
 *     unconditional `.classList.remove/add('hidden')` throws a TypeError on
 *     EVERY question load. Because this line runs before the "Options vs
 *     Free Response" and "Feedback & Rationale" sections of the same
 *     function, the exception aborts them too: answer option buttons are
 *     never rendered, free-response mode is never toggled, the
 *     correct/incorrect feedback banner never appears, and the rationale
 *     never renders. This affects the Practice tab and the SRS "Review Due
 *     Today" filter (both go through loadQuestion). It does NOT affect the
 *     Exam tab, which uses the separate loadExamQuestion()/renderExamMcqOptions()
 *     functions that do not reference '#text-mode-warning'.
 *
 *  2. index.html updateHeaderStats(): `document.getElementById('hdr-attempted')`
 *     returns null (also removed from the header in 7b22ff6) and the same
 *     unconditional `.innerText = ...` throws immediately. This function has
 *     TWO call sites, and both are broken by it:
 *       a) renderAnalytics() calls updateHeaderStats() as its very first
 *          statement, so the exception aborts renderAnalytics() entirely --
 *          #stat-attempted, #stat-accuracy, #stat-flagged, #stat-weakness
 *          and both charts never update, regardless of how much practice
 *          history exists. The Analytics tab is permanently stuck at its
 *          static HTML template values ("0 / 3,059", "0%", "None yet", "0").
 *       b) saveProgress() also calls updateHeaderStats() unconditionally,
 *          and finishExamAndShowReport() calls saveProgress() before doing
 *          ANYTHING else (before appending to psat_exam_history, before
 *          pushToCloud, before clearActiveExamState(), before
 *          renderExamReport()/showExamSubview('exam-report')). So finishing
 *          ANY exam throws at that saveProgress() call and the entire rest
 *          of finishExamAndShowReport() never runs: no score report ever
 *          renders, the completed exam is never recorded to
 *          psat_exam_history, and psat_active_exam_state is never cleared
 *          (a finished exam is stuck looking "in progress" forever). This
 *          is the same root cause as (a), not a fourth defect.
 *
 *  3. parent.html renderParentMetrics(): references an undefined variable
 *     `attemptedCount` (the declared variable is `totalAttempted`) inside
 *     the `else if (attemptedCount < 50)` branch of the "Dynamic Top
 *     Recommendation" widget. This is a ReferenceError, not a null-element
 *     issue. It only fires when the two earlier branches are both false
 *     (dueCardsCount === 0 AND weakSkillsCount === 0) -- i.e. on an empty
 *     or low-activity profile. Because renderParentMetrics() is called
 *     synchronously and un-guarded from the page's DOMContentLoaded
 *     handler, every call AFTER it in that handler
 *     (initCustomDomainSkills, setGapCount, syncParentFromCloud,
 *     updateParentSyncStatusBadge, refreshBackupStatus) is also skipped
 *     on an empty profile. Everything renderParentMetrics() itself sets
 *     BEFORE that branch (hero score, section scores, streak, gap
 *     counters, exam history) is unaffected.
 *
 *  4. feedback.html handleFeedbackSubmit(): a genuine server error (any
 *     non-ok HTTP status, including 500) and a genuine network/offline
 *     failure are both caught by the same `.then(res => ...)/.catch(err =>
 *     ...)` branch and rendered with the IDENTICAL text ("Feedback saved
 *     locally (Cosmos DB offline)") in the IDENTICAL static
 *     `text-emerald-600` (success-green) CSS class as the real success
 *     message -- #form-msg's class attribute is never reassigned. This is
 *     not a crash (nothing throws; the entry is never lost, since it is
 *     always written to localStorage before the network call), but per
 *     CLAUDE.md mode 5 ("a catch must either recover or report") there is
 *     no way for a student to visually distinguish "the server rejected
 *     this" from "you are offline" from "it worked" -- all three render the
 *     same reassuring green checkmark text.
 *
 *  5. index.html header nav is not responsive at the 390px mobile viewport:
 *     the header's flex row (`.flex.items-center.justify-between.h-16`) has
 *     no `flex-wrap` and its container has `overflow-x: visible` with no
 *     horizontal scroll affordance, so at 390px width the row's real
 *     content is ~961px wide against a ~358px visible area -- roughly two
 *     thirds of the header (including the Analytics tab, at x≈477px) is
 *     rendered off-screen to the right with no way for a real touch user to
 *     reach it (confirmed via getBoundingClientRect(), not just a failed
 *     click). This is a genuine mobile-usability defect, not a test
 *     artifact -- WI-08's other mobile specs work around it with
 *     `{ force: true }` clicks (which dispatch the click at the element's
 *     real DOM coordinates, bypassing the "is this reachable by a pointer"
 *     actionability check Playwright would otherwise correctly fail on).
 */
const { test, expect, seedEmpty, seedFixtureProfile, FIXTURE } = require('./fixtures');

test.describe('known defects (pin today\'s real behavior; must go red when fixed)', () => {
  test('index.html: loading a practice question throws and never renders options/rationale (defect #1)', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/index.html');
    await seedEmpty(page);
    await page.selectOption('#filter-subject', 'Reading and Writing');

    expect(errors.some((m) => /Cannot read properties of null/.test(m))).toBeTruthy();
    // Fingerprint of the exact defect: options never get any button children.
    expect(await page.locator('#options-container button').count()).toBe(0);
    // ...and the feedback/rationale UI that would prove grading works never appears.
    await expect(page.locator('#feedback-banner')).toBeHidden();
  });

  test('index.html: opening Analytics never updates any stat, even with real practice history (defect #2)', async ({ page }) => {
    await page.goto('/index.html');
    await seedFixtureProfile(page); // 20 real attempts, 70% accuracy -- see FIXTURE
    expect(FIXTURE.overallAccuracyPercent).toBe(70); // sanity on the fixture itself

    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.click('#tab-analytics', { force: true });
    await page.waitForTimeout(200);

    expect(errors.length).toBeGreaterThan(0);
    // The dashboard is stuck on its static template value -- with the
    // comma, proving updateHeaderStats() never successfully ran -- even
    // though 20 real (mostly-correct) attempts exist in localStorage.
    await expect(page.locator('#stat-attempted')).toHaveText('0 / 3,059');
    await expect(page.locator('#stat-accuracy')).toHaveText('0%');
  });

  test('index.html: finishing an exam never shows the report or records history (defect #2b)', async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/index.html');
    await seedEmpty(page);
    await page.click('#tab-exam', { force: true });
    await page.click('button:has-text("Start Mini Exam")', { force: true });

    // Answer and click through all 4 module-1 questions, then submit --
    // this is enough to reach the same saveProgress() -> updateHeaderStats()
    // crash that blocks every exam finish, without needing the full 2-module
    // walkthrough (see exam-flow.spec.js for the full happy-path walk).
    for (let i = 0; i < 4; i++) {
      const mcqVisible = await page.locator('#exam-mcq-options').isVisible();
      if (mcqVisible) await page.locator('#exam-mcq-options button').first().click({ force: true });
      else await page.fill('#exam-spr-input', '1');
      if (i < 3) await page.click('#btn-exam-next', { force: true });
    }
    await page.click('#btn-exam-next', { force: true }); // -> module review screen
    await page.click('#btn-submit-module', { force: true }); // mini exam module 0 -> break screen, no crash yet
    await page.click('#exam-break button:has-text("Resume Exam Early")', { force: true });

    for (let i = 0; i < 4; i++) {
      const mcqVisible = await page.locator('#exam-mcq-options').isVisible();
      if (mcqVisible) await page.locator('#exam-mcq-options button').first().click({ force: true });
      else await page.fill('#exam-spr-input', '1');
      if (i < 3) await page.click('#btn-exam-next', { force: true });
    }
    await page.click('#btn-exam-next', { force: true }); // -> module review screen
    await page.click('#btn-submit-module', { force: true }); // module 1 (last) -> finishExamAndShowReport()
    await page.waitForTimeout(300);

    expect(errors.some((m) => /Cannot set properties of null/.test(m))).toBeTruthy();
    await expect(page.locator('#exam-report')).toBeHidden();
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('psat_exam_history') || '[]'));
    expect(history.length).toBe(0);
    // The exam looks permanently "in progress" because clearActiveExamState()
    // is also after the crash point.
    const activeState = await page.evaluate(() => localStorage.getItem('psat_active_exam_state'));
    expect(activeState).toBeTruthy();
  });

  test('parent.html: an empty profile hits a ReferenceError in the recommendation widget (defect #3)', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/parent.html');
    await seedEmpty(page);
    await page.waitForTimeout(200);

    expect(errors.some((m) => /attemptedCount is not defined/.test(m))).toBeTruthy();
    // Everything renderParentMetrics() sets BEFORE the crash point is fine.
    await expect(page.locator('#hero-scaled-score')).toHaveText('—');
  });

  test('feedback.html: a 500 renders the same success-green text as a real success (defect #4)', async ({ page }) => {
    await page.route('**/api/feedback', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));

    await page.goto('/feedback.html');
    await page.selectOption('#fb-category', { index: 1 });
    await page.fill('#fb-title', 'defect #4 pin');
    await page.fill('#fb-desc', 'proving the 500 path is not visually distinguishable from success');
    await page.click('#feedback-form button[type="submit"]', { force: true });

    await expect(page.locator('#form-msg')).toContainText('saved locally');
    const cls = await page.locator('#form-msg').getAttribute('class');
    expect(cls).toContain('text-emerald-600'); // same class a real success uses -- no error styling exists
  });

  test.describe('at the 390px mobile viewport (forced regardless of project)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('index.html: the Analytics tab is rendered off-screen and unreachable by touch (defect #5)', async ({ page }) => {
      await page.goto('/index.html');
      await seedEmpty(page);

      const box = await page.locator('#tab-analytics').boundingBox();
      expect(box).toBeTruthy();
      // The tab sits past the right edge of a 390px viewport -- a real
      // touch user has no horizontal scroll affordance to reach it.
      expect(box.x).toBeGreaterThan(390);

      const overflow = await page.evaluate(() => {
        const row = document.querySelector('header .flex.items-center.justify-between.h-16');
        return { scrollWidth: row.scrollWidth, clientWidth: row.clientWidth };
      });
      expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth * 2);
    });
  });
});
