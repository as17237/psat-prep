/**
 * Parent portal (parent.html): the projected-score gate at <15 attempts per
 * section shows the placeholder ("—"), never a fabricated number
 * (CLAUDE.md mode 1, srs.js SCALING_ASSUMPTIONS.MIN_PER_SECTION === 15);
 * exam history and SRS/gap widgets render real fixture numbers; empty state
 * is clean.
 *
 * Unlike renderAnalytics() on index.html, parent.html's renderParentMetrics()
 * sets every element asserted below BEFORE the point where it can crash
 * (see known-defects.spec.js defect #3) -- the crash only affects the
 * trailing "Dynamic Top Recommendation" widget on an empty/near-empty
 * profile, which none of these assertions touch. So this whole spec runs
 * against real, unblocked behavior.
 */
const { test, expect, seedEmpty, seedFixtureProfile, FIXTURE } = require('./fixtures');

test.describe('parent portal', () => {
  test('empty state: score gated, all counters zero, no completed exams', async ({ page }) => {
    await page.goto('/parent.html');
    await seedEmpty(page);

    await expect(page.locator('#hero-scaled-score')).toHaveText('—');
    await expect(page.locator('#ela-section-score')).toHaveText('0 / 15 questions attempted');
    await expect(page.locator('#math-section-score')).toHaveText('0 / 15 questions attempted');
    await expect(page.locator('#stat-total-attempted')).toHaveText(`0 / ${FIXTURE.totalQuestionsInBank}`);
    await expect(page.locator('#stat-overall-accuracy')).toHaveText('0%');
    await expect(page.locator('#stat-flagged-count')).toHaveText('0');
    await expect(page.locator('#stat-top-weakness')).toHaveText('None yet');
    await expect(page.locator('#hero-streak')).toHaveText('0 Days');
    await expect(page.locator('#hero-srs-due')).toHaveText('0 Questions');
    await expect(page.locator('#gap-due-srs')).toHaveText('0');
    await expect(page.locator('#gap-weak-skills')).toHaveText('0');
    await expect(page.locator('#parent-exam-count-badge')).toHaveText('0 Completed Tests');
    await expect(page.locator('#parent-exam-history-container')).toContainText('No completed exams found yet.');
  });

  test('fixture profile: score gate still shows placeholder below 15/section; real history and gap numbers render', async ({ page }) => {
    await page.goto('/parent.html');
    await seedFixtureProfile(page);

    // 10 RW + 10 Math attempted -- both below MIN_PER_SECTION (15) -- so the
    // composite score must stay gated, never showing a fabricated number.
    await expect(page.locator('#hero-scaled-score')).toHaveText('—');
    await expect(page.locator('#ela-section-score')).toHaveText(`${FIXTURE.rwAttempted} / ${FIXTURE.minPerSection} questions attempted`);
    await expect(page.locator('#math-section-score')).toHaveText(`${FIXTURE.mathAttempted} / ${FIXTURE.minPerSection} questions attempted`);

    await expect(page.locator('#stat-total-attempted')).toHaveText(`${FIXTURE.attemptedCount} / ${FIXTURE.totalQuestionsInBank}`);
    await expect(page.locator('#stat-overall-accuracy')).toHaveText(`${FIXTURE.overallAccuracyPercent}%`);
    await expect(page.locator('#stat-flagged-count')).toHaveText(String(FIXTURE.flaggedCount));
    await expect(page.locator('#stat-top-weakness')).toHaveText(FIXTURE.topWeaknessLabel);

    // SRS / gap alerts: 4 due cards, 0 weak skills (every skill has < 3 attempts).
    await expect(page.locator('#hero-srs-due')).toHaveText(`${FIXTURE.srsDueCount} Questions`);
    await expect(page.locator('#gap-due-srs')).toHaveText(String(FIXTURE.srsDueCount));
    await expect(page.locator('#gap-weak-skills')).toHaveText(String(FIXTURE.weakSkillsCount));

    // One completed mini exam, with the hand-computed 63% / 75% / 50% breakdown.
    await expect(page.locator('#parent-exam-count-badge')).toHaveText('1 Completed Test');
    const historyText = await page.locator('#parent-exam-history-container').innerText();
    expect(historyText).toContain(`${FIXTURE.examTotalCorrect}/${FIXTURE.examTotalQuestions}`);
    expect(historyText).toContain(`(${FIXTURE.examAccuracyPercent}%)`);
    expect(historyText).toContain(`${FIXTURE.examRwCorrect}/${FIXTURE.examRwTotal} Correct (${FIXTURE.examRwAccuracyPercent}%)`);
    expect(historyText).toContain(`${FIXTURE.examMathCorrect}/${FIXTURE.examMathTotal} Correct (${FIXTURE.examMathAccuracyPercent}%)`);
  });

  // WI-14 shell: the 5-tab nav shows one tab's sections at a time; Overview is
  // the default. (Text-based assertions above still pass because they read
  // hidden elements' text, but here we verify visibility toggling.)
  test('five-tab nav toggles sections (Overview default; other tabs reachable)', async ({ page }) => {
    await page.goto('/parent.html');
    await seedFixtureProfile(page);

    // Default: an Overview section is visible; the Score & History section is hidden.
    await expect(page.locator('[data-ptab="overview"]').first()).toBeVisible();
    await expect(page.locator('#parent-exam-history-container')).toBeHidden();

    // Score & History
    await page.click('#ptab-scores');
    await expect(page.locator('#parent-exam-history-container')).toBeVisible();
    await expect(page.locator('[data-ptab="overview"]').first()).toBeHidden();

    // Exam Builder
    await page.click('#ptab-builder');
    await expect(page.locator('#gap-focus-summary-box')).toBeVisible();

    // Data & Backups (the new tab)
    await page.click('#ptab-data');
    await expect(page.locator('[data-ptab="data"]')).toBeVisible();

    // Back to Overview
    await page.click('#ptab-overview');
    await expect(page.locator('[data-ptab="overview"]').first()).toBeVisible();
    await expect(page.locator('#parent-exam-history-container')).toBeHidden();
  });
});
