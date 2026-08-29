/**
 * Feedback form (feedback.html): fill the form, submit against a stubbed
 * api/feedback 200 route -> success message; submit against a stubbed 500 ->
 * a message still appears (CLAUDE.md mode 5 checks that a failure is never
 * silently swallowed with no visible signal at all).
 *
 * NOTE on the 500 case (WI-08 -> WI-08.5): handleFeedbackSubmit() used to
 * render a server rejection with the exact same text and the same
 * emerald/success class as a real success. WI-08.5 introduced a single
 * setFormMsg(text, kind) owner for #form-msg with distinct pending /
 * success / error styling, so a failure is now a red, non-auto-clearing,
 * actionable message. The full styling assertions live in
 * known-defects.spec.js; this spec keeps the coarser "never silently
 * swallowed" check.
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
    // before the network call -- and the failure is now REPORTED, not
    // dressed up as a success (CLAUDE.md mode 5).
    await expect(page.locator('#form-msg')).not.toBeEmpty();
    await expect(page.locator('#form-msg')).toContainText('NOT synced');
    await expect(page.locator('#form-msg')).not.toContainText('successfully');
    await expect(page.locator('#feedback-count')).toHaveText('1');
  });
});
