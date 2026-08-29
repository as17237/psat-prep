/**
 * Exam flow (index.html): start a mini exam, answer a question, reload
 * mid-exam (resume state persists via psat_active_exam_state), finish, and
 * the score report renders.
 *
 * Unlike the Practice tab, the Exam tab renders questions through
 * loadExamQuestion()/renderExamMcqOptions() -- a separate code path from
 * loadQuestion() that does not reference the missing '#text-mode-warning'
 * element (see known-defects.spec.js defect #1), so starting, answering,
 * reloading and resuming an exam all work today and are tested as normal,
 * must-pass assertions below.
 *
 * Finishing the exam is a different story: finishExamAndShowReport() calls
 * saveProgress(), which unconditionally calls the SAME broken
 * updateHeaderStats() as the Analytics tab (missing '#hdr-attempted') --
 * see known-defects.spec.js defect #2b. That throws before the report ever
 * renders, before the exam is appended to psat_exam_history, and before the
 * in-progress exam state is cleared. The final "report renders" assertions
 * are marked test.fail() for that reason.
 */
const { test, expect, seedEmpty } = require('./fixtures');

async function answerCurrentExamQuestion(page) {
  const mcqVisible = await page.locator('#exam-mcq-options').isVisible();
  if (mcqVisible) {
    await page.locator('#exam-mcq-options button').first().click({ force: true });
  } else {
    await page.fill('#exam-spr-input', '1');
  }
}

test.describe('exam flow (mini exam)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/index.html');
    await seedEmpty(page);
    page.on('dialog', (d) => d.accept());
  });

  test('start, answer, reload mid-exam, resume, and walk to the last question', async ({ page }) => {
    await page.click('#tab-exam', { force: true });
    await page.click('button:has-text("Start Mini Exam")', { force: true });

    await expect(page.locator('#exam-active-q-pos')).toHaveText('Question 1 of 4');
    await answerCurrentExamQuestion(page);

    // The exam snapshot must be persisted before we ever reload.
    const persisted = await page.evaluate(() => localStorage.getItem('psat_active_exam_state'));
    expect(persisted).toBeTruthy();
    const persistedObj = JSON.parse(persisted);
    expect(persistedObj.currentModuleIndex).toBe(0);

    // Reload mid-exam.
    await page.reload({ waitUntil: 'domcontentloaded' });

    // The resume banner only refreshes when the exam lobby is (re)rendered,
    // which happens on switching to the Exam tab -- the natural place a
    // returning student would look.
    await page.click('#tab-exam', { force: true });
    await expect(page.locator('#exam-resume-banner')).toBeVisible();
    await expect(page.locator('#resume-exam-title')).toContainText('Mini');

    await page.click('#exam-resume-banner button:has-text("Resume Test")', { force: true });
    await expect(page.locator('#exam-active-q-pos')).toHaveText('Question 1 of 4');

    // Walk through the remaining 3 questions of module 1 (Q1 already
    // answered above), then one more "Next" off the last question lands on
    // the module review screen.
    for (let i = 0; i < 3; i++) {
      await page.click('#btn-exam-next', { force: true });
      await answerCurrentExamQuestion(page);
    }
    await page.click('#btn-exam-next', { force: true }); // Q4 -> module review screen
    await expect(page.locator('#review-module-heading')).toBeVisible();

    // Submit module 1 (triggers the mini exam's 1-minute break, not the
    // full 10-minute break).
    await page.click('#btn-submit-module', { force: true });
    await expect(page.locator('#exam-break')).toBeVisible();
    await page.click('#exam-break button:has-text("Resume Exam Early")', { force: true });

    // Module 2 (Math, 4 questions) is reachable and answerable.
    await expect(page.locator('#exam-active-q-pos')).toHaveText('Question 1 of 4');
    await answerCurrentExamQuestion(page);
    await page.click('#btn-exam-next', { force: true });
    await expect(page.locator('#exam-active-q-pos')).toHaveText('Question 2 of 4');
  });

  test('finishing the exam shows the score report and records history', async ({ page }) => {
    test.fail(true, 'blocked by known-defects.spec.js defect #2b (saveProgress -> updateHeaderStats crash on #hdr-attempted aborts finishExamAndShowReport before the report renders)');

    await page.click('#tab-exam', { force: true });
    await page.click('button:has-text("Start Mini Exam")', { force: true });

    for (let m = 0; m < 2; m++) {
      for (let i = 0; i < 4; i++) {
        await answerCurrentExamQuestion(page);
        if (i < 3) await page.click('#btn-exam-next', { force: true });
      }
      await page.click('#btn-exam-next', { force: true }); // -> module review screen
      await page.click('#btn-submit-module', { force: true });
      if (m === 0) {
        await expect(page.locator('#exam-break')).toBeVisible();
        await page.click('#exam-break button:has-text("Resume Exam Early")', { force: true });
      }
    }

    await expect(page.locator('#exam-report')).toBeVisible();
    await expect(page.locator('#report-total-score')).not.toHaveText('1390'); // static template placeholder must be overwritten
    const scoreText = await page.locator('#report-total-score').innerText();
    expect(scoreText.trim().length).toBeGreaterThan(0);

    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('psat_exam_history') || '[]'));
    expect(history.length).toBe(1);
    expect(history[0].type).toBe('mini_psat89');

    const activeAfterFinish = await page.evaluate(() => localStorage.getItem('psat_active_exam_state'));
    expect(activeAfterFinish).toBeNull();
  });
});
