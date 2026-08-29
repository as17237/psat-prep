/**
 * Student analytics tab (index.html): with seedFixtureProfile, the
 * displayed accuracy/counts should equal the hand-computed FIXTURE
 * constants; with seedEmpty, no non-zero stat should appear anywhere
 * (CLAUDE.md mode 1).
 *
 * IMPORTANT CAVEAT (see known-defects.spec.js defect #2): renderAnalytics()
 * calls the broken updateHeaderStats() as its first statement, which throws
 * on the missing '#hdr-attempted' element and aborts the rest of
 * renderAnalytics() -- so NONE of #stat-attempted/#stat-accuracy/
 * #stat-flagged/#stat-weakness are ever updated by JS today, regardless of
 * profile data. That means:
 *   - the "real numbers from the fixture profile" assertion is genuinely
 *     unreachable today and is marked test.fail() (see known-defects.spec.js
 *     defect #2 for the direct pin on this crash).
 *   - the "no non-zero stat on an empty profile" assertion below still
 *     passes, but for two overlapping reasons: seedEmpty() legitimately has
 *     zero attempts AND the crash means nothing is ever re-rendered either
 *     way. This test cannot, by itself, distinguish "correctly rendered
 *     zero" from "never rendered at all" -- known-defects.spec.js is the
 *     spec that actually proves which one it is.
 */
const { test, expect, seedEmpty, seedFixtureProfile, FIXTURE, findNonZeroDigits } = require('./fixtures');

test.describe('student analytics tab', () => {
  test('empty profile: no non-zero stat appears anywhere on the analytics tab', async ({ page }) => {
    await page.goto('/index.html');
    await seedEmpty(page);
    await page.click('#tab-analytics', { force: true });
    await page.waitForTimeout(200);

    const offenders = await findNonZeroDigits(
      page,
      '#stat-attempted, #stat-accuracy, #stat-weakness, #stat-flagged, #hdr-attempted, #hdr-accuracy',
      ['3,059', '3059'] // the real, static total question-bank count is not a "student stat"
    );
    expect(offenders).toEqual([]);
  });

  test('fixture profile: analytics reflect the hand-computed 70% / 20-attempt numbers', async ({ page }) => {
    test.fail(true, 'blocked by known-defects.spec.js defect #2 (updateHeaderStats crash on #hdr-attempted aborts renderAnalytics before any stat updates)');

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
