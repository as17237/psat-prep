/**
 * Student practice flow (index.html): pick a domain/subject filter, answer
 * one MCQ correctly (click the real answer button for the known fixture
 * question's correct_answer), see the rationale render, answer the next
 * one incorrectly, then switch to Math and answer a known free-response
 * (SPR) question.
 *
 * NOTE: the interactive-answer assertions below are marked test.fail()
 * because of a real, pre-existing defect in the current app -- see
 * tests/e2e/known-defects.spec.js defect #1 (index.html loadQuestion()
 * throws on `#text-mode-warning`, which is missing from the template, and
 * that exception aborts option/rationale/feedback rendering before it
 * happens). The filter-navigation assertions (which DO work today, because
 * they run before the crash point) are left as normal, must-pass
 * assertions. When defect #1 is fixed, these test.fail() blocks will start
 * unexpectedly passing, which Playwright reports as a failure -- that is
 * the intended signal to remove the annotation and the known-defects pin.
 */
const { test, expect, seedEmpty, KNOWN_RW_QUESTION, KNOWN_MATH_FR_QUESTION, QUESTIONS } = require('./fixtures');

// Second Reading & Writing question in bundle order -- used for the
// "answer incorrectly" step. Looked up from the real dataset, not derived
// from any app logic.
const SECOND_RW_QUESTION = QUESTIONS.filter((q) => q.test === 'Reading and Writing')[1];

function correctOptionIndex(q) {
  const idx = q.options.findIndex((o) => o.key === q.correct_answer);
  if (idx === -1) throw new Error(`fixture question ${q.id} has no option matching its correct_answer`);
  return idx;
}

test.describe('student practice flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/index.html');
    await seedEmpty(page);
  });

  test('picking a subject filter loads the expected stable question', async ({ page }) => {
    await page.selectOption('#filter-subject', 'Reading and Writing');
    await expect(page.locator('#q-id-badge')).toHaveText(`ID: ${KNOWN_RW_QUESTION.id}`);
    await expect(page.locator('#q-domain-badge')).toHaveText(KNOWN_RW_QUESTION.domain);

    await page.selectOption('#filter-subject', 'Math');
    await expect(page.locator('#q-id-badge')).toHaveText(`ID: ${KNOWN_MATH_FR_QUESTION.id}`);
  });

  test('answer correctly, see rationale, then answer the next one incorrectly', async ({ page }) => {
    test.fail(true, 'blocked by known-defects.spec.js defect #1 (index.html loadQuestion crash on #text-mode-warning)');

    await page.selectOption('#filter-subject', 'Reading and Writing');
    await expect(page.locator('#q-id-badge')).toHaveText(`ID: ${KNOWN_RW_QUESTION.id}`);

    const correctIdx = correctOptionIndex(KNOWN_RW_QUESTION);
    await page.locator('#options-container button').nth(correctIdx).click({ force: true });

    await expect(page.locator('#feedback-banner')).toBeVisible();
    await expect(page.locator('#feedback-title')).toContainText('Correct!');
    await expect(page.locator('#rationale-container')).toBeVisible();
    const rationaleText = await page.locator('#rationale-body').innerText();
    expect(rationaleText.trim().length).toBeGreaterThan(0);

    // Advance to the next question and answer it incorrectly.
    await page.click('#btn-next', { force: true });
    await expect(page.locator('#q-id-badge')).toHaveText(`ID: ${SECOND_RW_QUESTION.id}`);

    const correctIdx2 = correctOptionIndex(SECOND_RW_QUESTION);
    const wrongIdx2 = correctIdx2 === 0 ? 1 : 0;
    await page.locator('#options-container button').nth(wrongIdx2).click({ force: true });

    await expect(page.locator('#feedback-title')).toContainText('Incorrect');
    await expect(page.locator('#rationale-container')).toBeVisible();
  });

  test('enter a free-response answer for a known SPR question', async ({ page }) => {
    test.fail(true, 'blocked by known-defects.spec.js defect #1 (free-response-container never toggles visible)');

    await page.selectOption('#filter-subject', 'Math');

    await expect(page.locator('#q-id-badge')).toHaveText(`ID: ${KNOWN_MATH_FR_QUESTION.id}`);
    await expect(page.locator('#free-response-container')).toBeVisible();
    await expect(page.locator('#options-container')).toBeHidden();

    await page.fill('#free-response-input', KNOWN_MATH_FR_QUESTION.correct_answer);
    await page.click('#free-response-container button', { force: true });

    await expect(page.locator('#feedback-title')).toContainText('Correct!');
  });
});
