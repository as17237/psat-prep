/**
 * Mistakes page (mistakes.html): seeded mistakes render; the feed shows the
 * incorrect questions, aggregated from BOTH practice progress and exam
 * history via PSAT_ENGINE.buildTroubleSpots(). This page does not go
 * through index.html's loadQuestion()/updateHeaderStats(), so it is not
 * affected by known-defects.spec.js #1/#2.
 */
const { test, expect, seedEmpty, seedFixtureProfile, FIXTURE } = require('./fixtures');

test.describe('mistakes page', () => {
  test('empty state: zero mistakes, clean empty message', async ({ page }) => {
    await page.goto('/mistakes.html');
    await seedEmpty(page);

    await expect(page.locator('#cnt-total')).toHaveText('0');
    await expect(page.locator('#cnt-math')).toHaveText('0');
    await expect(page.locator('#cnt-rw')).toHaveText('0');
    await expect(page.locator('#cnt-recurring')).toHaveText('0');
    await expect(page.locator('#stat-total-missed-badge')).toHaveText('0 Questions Missed');
    await expect(page.locator('#mistakes-feed-container')).toContainText('No trouble questions found');
  });

  test('fixture profile: counts match the hand-computed trouble-spot totals; both practice and exam-only mistakes render', async ({ page }) => {
    await page.goto('/mistakes.html');
    await seedFixtureProfile(page);

    await expect(page.locator('#cnt-total')).toHaveText(String(FIXTURE.mistakesTotal));
    await expect(page.locator('#cnt-math')).toHaveText(String(FIXTURE.mistakesMath));
    await expect(page.locator('#cnt-rw')).toHaveText(String(FIXTURE.mistakesRw));
    await expect(page.locator('#cnt-recurring')).toHaveText(String(FIXTURE.mistakesRecurring));
    await expect(page.locator('#stat-total-missed-badge')).toHaveText(`${FIXTURE.mistakesTotal} Questions Missed`);

    // A practice-sourced mistake and an exam-only-sourced mistake must both
    // appear as rendered question cards (buildTroubleSpots merges the two
    // sources; this proves both code paths actually reach the DOM).
    await expect(page.locator(`#qcard-${FIXTURE.knownIncorrectPracticeId}`)).toBeVisible();
    await expect(page.locator(`#qcard-${FIXTURE.knownIncorrectExamOnlyId}`)).toBeVisible();
  });
});
