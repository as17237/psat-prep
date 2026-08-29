/**
 * Student analytics tab (index.html): with seedFixtureProfile, the
 * displayed accuracy/counts should equal the hand-computed FIXTURE
 * constants; with seedEmpty, no non-zero stat should appear anywhere
 * (CLAUDE.md mode 1).
 *
 * HISTORY (WI-08 -> WI-08.5): renderAnalytics() used to call the broken
 * updateHeaderStats() as its first statement, which threw on the missing
 * '#hdr-attempted' element and aborted the whole render, so no stat was
 * ever updated regardless of profile data. WI-08.5 null-guarded the two
 * dangling header reads. Both tests below are now plain must-pass
 * assertions, and the empty-state one now passes for the RIGHT reason --
 * known-defects.spec.js asserts that renderAnalytics() actually runs and
 * writes the fixture numbers, so "rendered zero" is distinguishable from
 * "never rendered".
 */
const { test, expect, seedEmpty, seedFixtureProfile, FIXTURE, findNonZeroDigits } = require('./fixtures');

test.describe('student analytics tab', () => {
  test('empty profile: no non-zero stat appears anywhere on the analytics tab', async ({ page }) => {
    await page.goto('/index.html');
    await seedEmpty(page);
    await page.click('#tab-analytics', { force: true });
    await page.waitForTimeout(200);

    // Prove renderAnalytics() actually RAN before trusting its zeros: these
    // three strings exist nowhere in the static HTML template (the lists are
    // empty <div>s there) and are written only by renderAnalytics(). Without
    // this, "correctly rendered zero" is indistinguishable from "crashed
    // before rendering anything" -- which is exactly what WI-08 found.
    await expect(page.locator('#strengths-list')).toContainText('No mastered skills yet');
    await expect(page.locator('#weaknesses-list')).toContainText('No weak areas identified yet');
    await expect(page.locator('#inprogress-list')).toContainText('No skills currently in progress');

    // CLAUDE.md mode 1: with localStorage cleared, no non-zero number may appear.
    const offenders = await findNonZeroDigits(
      page,
      '#stat-attempted, #stat-accuracy, #stat-weakness, #stat-flagged, #hdr-attempted, #hdr-accuracy',
      ['3,059', '3059'] // the real, static total question-bank count is not a "student stat"
    );
    expect(offenders).toEqual([]);
    await expect(page.locator('#stat-attempted')).toHaveText('0 / 3059');
    await expect(page.locator('#stat-accuracy')).toHaveText('0%');
    await expect(page.locator('#stat-flagged')).toHaveText('0');
    await expect(page.locator('#stat-weakness')).toHaveText('None yet');
  });

  test('fixture profile: analytics reflect the hand-computed 70% / 20-attempt numbers', async ({ page }) => {
    await page.goto('/index.html');
    await seedFixtureProfile(page);
    await page.click('#tab-analytics', { force: true });
    await page.waitForTimeout(200);

    await expect(page.locator('#stat-attempted')).toHaveText(`${FIXTURE.attemptedCount} / ${FIXTURE.totalQuestionsInBank}`);
    await expect(page.locator('#stat-accuracy')).toHaveText(`${FIXTURE.overallAccuracyPercent}%`);
    await expect(page.locator('#stat-flagged')).toHaveText(String(FIXTURE.flaggedCount));
    await expect(page.locator('#stat-weakness')).toHaveText(FIXTURE.topWeaknessLabel);
  });
});
