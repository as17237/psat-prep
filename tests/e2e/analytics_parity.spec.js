/**
 * Analytics correctness + cross-portal parity (WI-17).
 *
 * One 60-attempt hand-designed fixture (fixtures.js seedAnalyticsProfile /
 * ANALYTICS), six real skills pushed across the mastered / focus / in-progress
 * thresholds. This spec verifies:
 *
 *  1. STUDENT "My Progress" (index.html #tab-analytics) renders every analytic
 *     the hand table specifies — the 4 headline stats, the mastered/focus/
 *     in-progress splits, and two specific skill badges.
 *  2. PARENT "Overview" (parent.html) renders its own, larger set — the same 4
 *     headline stats, the weak-skill gap count, SRS-due, an honest zero streak,
 *     and a gated-but-ready scaled score with the correct section sample sizes.
 *  3. TWIN-DRIFT (CLAUDE.md failure mode 2, as a permanent regression): the
 *     metrics that appear on BOTH portals render the SAME string on each. This
 *     is the check that would have caught "question_type fixed everywhere except
 *     parent.html" and its kin.
 *
 * Every expected value is hand-computed in fixtures.js ANALYTICS and was
 * confirmed against the real engine + the pages' grouping code before commit
 * (CLAUDE.md failure mode 4 — expectations are never read back from the code
 * under test). Across the three tests, >=12 distinct rendered metrics are
 * checked with 0 mismatches.
 */
const { test, expect, seedAnalyticsProfile, ANALYTICS } = require('./fixtures');

/** Reads the 4 metrics that exist on BOTH portals, from the student page. */
async function studentSharedMetrics(page) {
  return {
    attempted: (await page.locator('#stat-attempted').textContent()).trim(),
    accuracy: (await page.locator('#stat-accuracy').textContent()).trim(),
    flagged: (await page.locator('#stat-flagged').textContent()).trim(),
    topWeakness: (await page.locator('#stat-weakness').textContent()).trim(),
  };
}
/** The same 4 metrics, from the parent page. */
async function parentSharedMetrics(page) {
  return {
    attempted: (await page.locator('#stat-total-attempted').textContent()).trim(),
    accuracy: (await page.locator('#stat-overall-accuracy').textContent()).trim(),
    flagged: (await page.locator('#stat-flagged-count').textContent()).trim(),
    topWeakness: (await page.locator('#stat-top-weakness').textContent()).trim(),
  };
}

test.describe('analytics correctness + cross-portal parity', () => {
  test('student My Progress renders the hand-computed analytics', async ({ page }) => {
    await page.goto('/index.html');
    await seedAnalyticsProfile(page);
    await page.click('#tab-analytics', { force: true });

    await expect(page.locator('#stat-attempted')).toHaveText(ANALYTICS.totalDisplay);
    await expect(page.locator('#stat-accuracy')).toHaveText(`${ANALYTICS.overallAccuracyPercent}%`);
    await expect(page.locator('#stat-flagged')).toHaveText(String(ANALYTICS.flaggedCount));
    await expect(page.locator('#stat-weakness')).toHaveText(ANALYTICS.topWeaknessLabel);

    // Classification splits: count only the rendered skill items (direct <div>
    // children; the empty state is a <p>).
    await expect(page.locator('#strengths-list > div')).toHaveCount(ANALYTICS.masteredCount);
    await expect(page.locator('#weaknesses-list > div')).toHaveCount(ANALYTICS.focusCount);
    await expect(page.locator('#inprogress-list > div')).toHaveCount(ANALYTICS.inProgressCount);

    // Specific skill badges (accuracy + raw counts).
    await expect(page.locator('#strengths-list')).toContainText('Command of Evidence');
    await expect(page.locator('#strengths-list')).toContainText(ANALYTICS.masteredBadgeCommandOfEvidence);
    await expect(page.locator('#weaknesses-list')).toContainText('Words in Context');
    await expect(page.locator('#weaknesses-list')).toContainText(ANALYTICS.focusBadgeWordsInContext);
  });

  test('parent Overview renders the hand-computed analytics', async ({ page }) => {
    await page.goto('/parent.html');
    await seedAnalyticsProfile(page);

    await expect(page.locator('#stat-total-attempted')).toHaveText(ANALYTICS.totalDisplay);
    await expect(page.locator('#stat-overall-accuracy')).toHaveText(`${ANALYTICS.overallAccuracyPercent}%`);
    await expect(page.locator('#stat-flagged-count')).toHaveText(String(ANALYTICS.flaggedCount));
    await expect(page.locator('#stat-top-weakness')).toHaveText(ANALYTICS.topWeaknessLabel);

    // Parent-only gap widgets + honest zeros (empty sessions).
    await expect(page.locator('#gap-weak-skills')).toHaveText(String(ANALYTICS.weakSkillsCount));
    await expect(page.locator('#gap-due-srs')).toHaveText(String(ANALYTICS.srsDueCount));
    await expect(page.locator('#hero-srs-due')).toHaveText(`${ANALYTICS.srsDueCount} Questions`);
    await expect(page.locator('#hero-streak')).toHaveText('0 Days');

    // Scaled score: both sections are above MIN_PER_SECTION (34 RW, 26 Math), so
    // a real number renders (not the "—" gate). We assert it is a plausible
    // number and that the subtext cites the correct sample sizes — never a
    // hand-guessed scaled value (mode 1).
    const scoreText = (await page.locator('#hero-scaled-score').textContent()).trim();
    expect(scoreText).toMatch(/^\d+$/);
    const score = Number(scoreText);
    expect(score).toBeGreaterThanOrEqual(240);
    expect(score).toBeLessThanOrEqual(1440);
    await expect(page.locator('#hero-score-subtext')).toContainText(
      `Estimated from ${ANALYTICS.rwAttempted} Reading/Writing and ${ANALYTICS.mathAttempted} Math questions`
    );
    await expect(page.locator('#ela-section-score')).toContainText('Est. Section Score:');
    await expect(page.locator('#math-section-score')).toContainText('Est. Section Score:');
  });

  test('twin-drift: shared metrics render identically on student and parent (mode 2)', async ({ page }) => {
    await page.goto('/index.html');
    await seedAnalyticsProfile(page);
    await page.click('#tab-analytics', { force: true });
    await expect(page.locator('#stat-attempted')).toHaveText(ANALYTICS.totalDisplay); // ensure rendered
    const student = await studentSharedMetrics(page);

    await page.goto('/parent.html');
    await seedAnalyticsProfile(page);
    await expect(page.locator('#stat-total-attempted')).toHaveText(ANALYTICS.totalDisplay); // ensure rendered
    const parent = await parentSharedMetrics(page);

    // (a) the two portals agree with EACH OTHER, and (b) both agree with the
    // hand-computed table. Any drift between the portals fails here.
    expect(parent).toEqual(student);
    expect(student).toEqual({
      attempted: ANALYTICS.totalDisplay,
      accuracy: `${ANALYTICS.overallAccuracyPercent}%`,
      flagged: String(ANALYTICS.flaggedCount),
      topWeakness: ANALYTICS.topWeaknessLabel,
    });
  });
});
