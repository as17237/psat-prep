/**
 * Feedback form (feedback.html): fill the form, submit against a stubbed
 * api/feedback 200 route -> success message; submit against a stubbed 500 ->
 * a message still appears (CLAUDE.md mode 5 checks that a failure is never
 * silently swallowed with no visible signal at all).
 *
 * NOTE on the 500 case: the current app's handleFeedbackSubmit() catches
 * both the !res.ok and network-error cases and shows the exact same text
 * ("Feedback saved locally (Cosmos DB offline)") it would show on a genuine
 * offline/no-network condition, styled with the SAME static emerald/success
 * class as the real success message (#form-msg's class is never changed).
 * There is no visually distinguishable "error" state for a real server
 * failure (as opposed to being offline) -- entered here as the honest,
 * verified current behavior; see known-defects.spec.js defect #4 for the
 * pinned assertion that this is unchanged.
 */
const { test, expect } = require('./fixtures');

async function fillForm(page) {
  await page.selectOption('#fb-category', { index: 1 });
  await page.fill('#fb-qid', '737870c6');
  await page.fill('#fb-title', 'E2E test feedback entry');
  await page.fill('#fb-desc', 'Automated Playwright submission for WI-08 baseline coverage.');
}

test.describe('feedback form', () => {
  test('submit succeeds against a stubbed 200', async ({ page }) => {
    await page.route('**/api/feedback', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
    );

    await page.goto('/feedback.html');
    await fillForm(page);
    await page.click('#feedback-form button[type="submit"]', { force: true });

    await expect(page.locator('#form-msg')).toContainText('synced to Cosmos DB successfully');
    await expect(page.locator('#feedback-count')).toHaveText('1');
  });

  test('submit against a stubbed 500 still shows a visible message (not a silent failure)', async ({ page }) => {
    await page.route('**/api/feedback', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));

    await page.goto('/feedback.html');
    await fillForm(page);
    await page.click('#feedback-form button[type="submit"]', { force: true });

    // The entry is never lost -- it is always saved to localStorage first,
    // before the network call -- and SOME message is always shown (never a
    // silent, unindicated failure).
    await expect(page.locator('#form-msg')).not.toBeEmpty();
    await expect(page.locator('#form-msg')).toContainText('saved locally');
    await expect(page.locator('#feedback-count')).toHaveText('1');
  });
});
