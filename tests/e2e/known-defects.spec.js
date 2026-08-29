/**
 * WI-08 discovered five real defects in the shipped app. WI-08.5 (urgent
 * hotfix) fixed four of them; this file now holds the REGRESSION assertions
 * for those four -- they assert the FIXED behavior and go red if any of the
 * crashes comes back -- plus the one remaining pinned canary (#5).
 *
 * All four fixed defects share one root cause: commit 7b22ff6 ("UI
 * simplification pass") deleted DOM elements without updating the JS that
 * reads them, so `document.getElementById(...)` returned null and the very
 * next unconditional property write threw (CLAUDE.md mode 2/6).
 *
 *  1. FIXED -- index.html loadQuestion() threw on `#text-mode-warning`
 *     (and would also have thrown on `#q-text-body` and `#mismatch-notice`,
 *     both deleted by the same commit). Because that ran before the
 *     "Options vs Free Response" and "Feedback & Rationale" sections of the
 *     same function, the exception aborted them too: option buttons never
 *     rendered, free-response mode never toggled, the feedback banner never
 *     appeared and the rationale never rendered -- on the Practice tab and
 *     on the SRS "Review Due Today" filter, both of which go through
 *     loadQuestion(). All three reads are now null-guarded, as is
 *     setViewMode() (reached from loadQuestion()), which read three more
 *     deleted elements.
 *
 *  2. FIXED -- index.html updateHeaderStats() threw on `#hdr-attempted`
 *     (and `#hdr-accuracy`), both removed from the header in 7b22ff6. That
 *     broke BOTH of its call sites:
 *       a) renderAnalytics() calls it as its first statement, so the whole
 *          Analytics tab was stuck on its static template values
 *          ("0 / 3,059", "0%", "None yet", "0") no matter how much practice
 *          history existed;
 *       b) saveProgress() calls it unconditionally, and
 *          finishExamAndShowReport() calls saveProgress() BEFORE appending
 *          to psat_exam_history, before pushToCloud, before
 *          clearActiveExamState() and before renderExamReport() -- so
 *          finishing ANY exam threw and none of that ever happened.
 *     Both reads are now null-guarded.
 *
 *  3. FIXED -- parent.html renderParentMetrics() referenced an undefined
 *     variable `attemptedCount` (the declared variable is `totalAttempted`)
 *     in the `else if` branch of the "Dynamic Top Recommendation" widget --
 *     a ReferenceError that only fired when dueCardsCount === 0 AND
 *     weakSkillsCount === 0, i.e. on an empty or low-activity profile, and
 *     which then skipped every later call in the DOMContentLoaded handler
 *     (initCustomDomainSkills, setGapCount, syncParentFromCloud,
 *     updateParentSyncStatusBadge, refreshBackupStatus). Now reads
 *     `totalAttempted`.
 *
 *  4. FIXED -- feedback.html handleFeedbackSubmit() rendered a genuine
 *     server rejection (any non-ok status) and a genuine network failure
 *     with the IDENTICAL text and the IDENTICAL success-green
 *     `text-emerald-600` class as a real success -- #form-msg's class was
 *     never reassigned, so a student could not tell "the server rejected
 *     this" from "it worked" (CLAUDE.md mode 5). There is now a single
 *     setFormMsg(text, kind) owner for #form-msg with distinct pending /
 *     success / error styling; the error state is red, says NOT synced,
 *     names the failure, tells the student what to do, and does not
 *     auto-clear.
 *
 *  5. STILL OPEN (owned by WI-13, deliberately NOT fixed here) --
 *     index.html header nav is not responsive at the 390px mobile viewport:
 *     the header's flex row (`.flex.items-center.justify-between.h-16`) has
 *     no `flex-wrap` and its container has `overflow-x: visible` with no
 *     horizontal scroll affordance, so at 390px width the row's real
 *     content is ~961px wide against a ~358px visible area -- roughly two
 *     thirds of the header (including the Analytics tab, at x~477px) is
 *     rendered off-screen to the right with no way for a real touch user to
 *     reach it (confirmed via getBoundingClientRect(), not just a failed
 *     click). Its canary below stays pinned as a passing description of
 *     today's behavior and must go red when WI-13 fixes it.
 */
const { test, expect, seedEmpty, seedFixtureProfile, FIXTURE } = require('./fixtures');

test.describe('WI-08.5 hotfix regressions (defects #1-#4 must stay fixed)', () => {
  test('index.html: loading a practice question renders options and no page error (defect #1 fixed)', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/index.html');
    await seedEmpty(page);
    await page.selectOption('#filter-subject', 'Reading and Writing');

    // The exact crash that used to fire on every question load.
    expect(errors).toEqual([]);
    // ...and the rendering that used to be aborted by it now happens.
    expect(await page.locator('#options-container button').count()).toBeGreaterThan(0);
    // Feedback stays hidden until the question is answered -- then it shows.
    await expect(page.locator('#feedback-banner')).toBeHidden();
    await page.locator('#options-container button').first().click({ force: true });
    await expect(page.locator('#feedback-banner')).toBeVisible();
    await expect(page.locator('#rationale-container')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('index.html: opening Analytics renders the real fixture numbers (defect #2 fixed)', async ({ page }) => {
    await page.goto('/index.html');
    await seedFixtureProfile(page); // 20 real attempts, 70% accuracy -- see FIXTURE
    expect(FIXTURE.overallAccuracyPercent).toBe(70); // sanity on the fixture itself

    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.click('#tab-analytics', { force: true });
    await page.waitForTimeout(200);

    expect(errors).toEqual([]);
    // No longer the static template value "0 / 3,059" -- these are the
    // hand-computed fixture numbers, proving renderAnalytics() actually ran.
    await expect(page.locator('#stat-attempted')).toHaveText(
      `${FIXTURE.attemptedCount} / ${FIXTURE.totalQuestionsInBank}`
    );
    await expect(page.locator('#stat-accuracy')).toHaveText(`${FIXTURE.overallAccuracyPercent}%`);
    await expect(page.locator('#stat-flagged')).toHaveText(String(FIXTURE.flaggedCount));
  });

  test('index.html: finishing an exam shows the report and records history (defect #2b fixed)', async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/index.html');
    await seedEmpty(page);
    await page.click('#tab-exam', { force: true });
    await page.click('button:has-text("Start Mini Exam")', { force: true });

    for (let m = 0; m < 2; m++) {
      for (let i = 0; i < 4; i++) {
        const mcqVisible = await page.locator('#exam-mcq-options').isVisible();
        if (mcqVisible) await page.locator('#exam-mcq-options button').first().click({ force: true });
        else await page.fill('#exam-spr-input', '1');
        if (i < 3) await page.click('#btn-exam-next', { force: true });
      }
      await page.click('#btn-exam-next', { force: true }); // -> module review screen
      await page.click('#btn-submit-module', { force: true });
      if (m === 0) {
        await page.click('#exam-break button:has-text("Resume Exam Early")', { force: true });
      }
    }
    await page.waitForTimeout(300);

    expect(errors).toEqual([]);
    await expect(page.locator('#exam-report')).toBeVisible();

    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('psat_exam_history') || '[]'));
    expect(history.length).toBe(1);
    // clearActiveExamState() is after the old crash point, so this proves it ran.
    const activeState = await page.evaluate(() => localStorage.getItem('psat_active_exam_state'));
    expect(activeState).toBeNull();
  });

  /**
   * Real-world recovery case for the hotfix: the student's exam CRASHED at
   * finish under the old code, which means psat_active_exam_state is still
   * sitting in their browser holding a fully-answered exam. Under the fixed
   * code that held state must resume from the lobby and finish cleanly --
   * report rendered, history written, active state cleared.
   *
   * The snapshot is not hand-written: it is captured from the app's own
   * writer mid-exam (so its shape can never drift from what the real
   * student's browser holds), then finished after a reload.
   */
  test('index.html: an exam left mid-flight by the old crash resumes and finishes cleanly (WI-08.5 recovery)', async ({ page }) => {
    page.on('dialog', (d) => d.accept());

    // --- 1. Produce a real held psat_active_exam_state, then hard-reload,
    //        exactly as a student returning after the crash would.
    await page.goto('/index.html');
    await seedEmpty(page);
    await page.click('#tab-exam', { force: true });
    await page.click('button:has-text("Start Mini Exam")', { force: true });
    for (let i = 0; i < 4; i++) {
      const mcqVisible = await page.locator('#exam-mcq-options').isVisible();
      if (mcqVisible) await page.locator('#exam-mcq-options button').first().click({ force: true });
      else await page.fill('#exam-spr-input', '1');
      if (i < 3) await page.click('#btn-exam-next', { force: true });
    }

    const held = await page.evaluate(() => localStorage.getItem('psat_active_exam_state'));
    expect(held).toBeTruthy();
    const heldObj = JSON.parse(held);
    expect(heldObj.currentModuleIndex).toBe(0);
    expect(Object.keys(heldObj.examUserAnswers || {}).length).toBeGreaterThan(0);
    // Nothing was written to history by the crashed finish.
    const historyBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('psat_exam_history') || '[]'));
    expect(historyBefore.length).toBe(0);

    // --- 2. Return to the app with that state still held.
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('#tab-exam', { force: true });
    await expect(page.locator('#exam-resume-banner')).toBeVisible();
    await page.click('#exam-resume-banner button:has-text("Resume Test")', { force: true });

    // --- 3. Finish it under the fixed code.
    await page.click('#btn-exam-next', { force: true }); // Q4 -> module review
    await page.click('#btn-submit-module', { force: true });
    await page.click('#exam-break button:has-text("Resume Exam Early")', { force: true });
    for (let i = 0; i < 4; i++) {
      const mcqVisible = await page.locator('#exam-mcq-options').isVisible();
      if (mcqVisible) await page.locator('#exam-mcq-options button').first().click({ force: true });
      else await page.fill('#exam-spr-input', '1');
      if (i < 3) await page.click('#btn-exam-next', { force: true });
    }
    await page.click('#btn-exam-next', { force: true }); // -> module review
    await page.click('#btn-submit-module', { force: true }); // -> finishExamAndShowReport()
    await page.waitForTimeout(300);

    expect(errors).toEqual([]);
    await expect(page.locator('#exam-report')).toBeVisible();
    const scoreText = (await page.locator('#report-total-score').innerText()).trim();
    expect(scoreText.length).toBeGreaterThan(0);
    expect(scoreText).not.toBe('1390'); // static template placeholder

    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('psat_exam_history') || '[]'));
    expect(history.length).toBe(1);
    expect(history[0].type).toBe('mini_psat89');
    const activeAfter = await page.evaluate(() => localStorage.getItem('psat_active_exam_state'));
    expect(activeAfter).toBeNull();
    // Exam answers were folded into practice progress by the same function.
    const progressCount = await page.evaluate(
      () => Object.keys(JSON.parse(localStorage.getItem('psat_progress') || '{}')).length
    );
    expect(progressCount).toBe(8);
  });

  test('parent.html: an empty profile renders with no page error (defect #3 fixed)', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/parent.html');
    await seedEmpty(page);
    await page.waitForTimeout(200);

    expect(errors).toEqual([]);
    // The score is still correctly gated on an empty profile (CLAUDE.md mode 1).
    await expect(page.locator('#hero-scaled-score')).toHaveText('—');
    // The recommendation branch that used to throw now renders its real copy:
    // 0 attempts < 50, so the mini-diagnostic recommendation is the right one.
    await expect(page.locator('#parent-rec-title')).toContainText('Mini PSAT 8/9 Diagnostic');
    await expect(page.locator('#parent-rec-cta')).toHaveAttribute('href', 'index.html?mode=mini_psat89');
  });

  test('feedback.html: a 500 renders a visibly distinct red error, never the success state (defect #4 fixed)', async ({ page }) => {
    await page.route('**/api/feedback', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));

    await page.goto('/feedback.html');
    await page.selectOption('#fb-category', { index: 1 });
    await page.fill('#fb-title', 'defect #4 regression');
    await page.fill('#fb-desc', 'proving the 500 path is now visually distinguishable from success');
    await page.click('#feedback-form button[type="submit"]', { force: true });

    const msg = page.locator('#form-msg');
    await expect(msg).toContainText('NOT synced');
    await expect(msg).toContainText('500'); // names the real failure
    const cls = await msg.getAttribute('class');
    expect(cls).not.toContain('text-emerald-600'); // never the success colour
    expect(cls).toContain('text-rose-700');
    await expect(msg).toHaveAttribute('role', 'alert');
    // Red, not green, as an actual rendered colour -- not just a class name.
    const colour = await msg.evaluate((el) => getComputedStyle(el).color);
    expect(colour).toBe('rgb(190, 18, 60)'); // tailwind rose-700

    // The error must NOT auto-clear the way the success message does.
    await page.waitForTimeout(4000);
    await expect(msg).toContainText('NOT synced');

    // The entry is still safe locally -- the failure is reported, not lost.
    await expect(page.locator('#feedback-count')).toHaveText('1');
  });

  test('feedback.html: a network failure renders the same distinct error state (defect #4 fixed)', async ({ page }) => {
    await page.route('**/api/feedback', (route) => route.abort('failed'));

    await page.goto('/feedback.html');
    await page.selectOption('#fb-category', { index: 1 });
    await page.fill('#fb-title', 'defect #4 offline regression');
    await page.fill('#fb-desc', 'offline path must also be visibly distinct from success');
    await page.click('#feedback-form button[type="submit"]', { force: true });

    const msg = page.locator('#form-msg');
    await expect(msg).toContainText('NOT synced');
    await expect(msg).toContainText('offline');
    const cls = await msg.getAttribute('class');
    expect(cls).not.toContain('text-emerald-600');
    expect(cls).toContain('text-rose-700');
    await expect(page.locator('#feedback-count')).toHaveText('1');
  });

  test('feedback.html: a real success still renders the green success state (defect #4 fix did not invert)', async ({ page }) => {
    await page.route('**/api/feedback', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
    );

    await page.goto('/feedback.html');
    await page.selectOption('#fb-category', { index: 1 });
    await page.fill('#fb-title', 'defect #4 success regression');
    await page.fill('#fb-desc', 'the success path must keep its own distinct styling');
    await page.click('#feedback-form button[type="submit"]', { force: true });

    const msg = page.locator('#form-msg');
    await expect(msg).toContainText('synced to Cosmos DB successfully');
    const cls = await msg.getAttribute('class');
    expect(cls).toContain('text-emerald-600');
    expect(cls).not.toContain('text-rose-700');
  });
});

test.describe('known defects still open (pin today\'s real behavior; must go red when fixed)', () => {
  test.describe('at the 390px mobile viewport (forced regardless of project)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('index.html: the Analytics tab is rendered off-screen and unreachable by touch (defect #5, owned by WI-13)', async ({ page }) => {
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
