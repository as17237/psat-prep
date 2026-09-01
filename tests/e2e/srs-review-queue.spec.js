/**
 * SRS review queue (index.html): with seeded due cards, the "Review Due
 * Today (SRS)" status filter shows exactly the due questions; grading a
 * due card via the practice UI works.
 *
 * The fixture profile (see tests/e2e/fixtures.js) seeds exactly 4 SRS cards
 * with dueAt in the past (27754367, 96fa19ad, 7326e8c1, bff1c061) and 2 with
 * dueAt in the future, out of the full 3,059-question bank -- so with
 * Subject=All / Difficulty=All / Status=due, the filtered pool must be
 * exactly those 4 questions, in bundle order.
 *
 * HISTORY: the "grading path works" assertion was marked test.fail() during
 * WI-08 for the same reason as practice-flow.spec.js -- index.html
 * loadQuestion() threw on the missing #text-mode-warning element before it
 * ever rendered the option buttons a grade click needs, and the "due"
 * filter routes through loadQuestion() too. WI-08.5 fixed that; it is now a
 * plain must-pass regression assertion.
 */
const { test, expect, seedFixtureProfile, seedEmpty, QUESTIONS } = require('./fixtures');

const DUE_IDS = ['27754367', '96fa19ad', '7326e8c1', 'bff1c061'];
// bundle order among the due ids (applyFilters() does not shuffle)
const EXPECTED_ORDER = QUESTIONS.filter((q) => DUE_IDS.includes(q.id)).map((q) => q.id);

test.describe('SRS review queue', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/index.html');
    await seedFixtureProfile(page);
  });

  test('the "Review Due Today" filter shows exactly the 4 seeded due cards', async ({ page }) => {
    expect(EXPECTED_ORDER.length).toBe(4); // sanity on the fixture itself

    await page.selectOption('#filter-status', 'due');
    await expect(page.locator('#q-index-badge')).toHaveText('Q1 of 4');
    await expect(page.locator('#q-id-badge')).toHaveText(`ID: ${EXPECTED_ORDER[0]}`);

    // Walk the whole due queue via Next and confirm it is exactly the 4
    // seeded due ids, in the order the app itself produces -- no more, no
    // fewer, and no undue questions leaking in.
    const seen = [await page.locator('#q-id-badge').innerText()];
    for (let i = 1; i < 4; i++) {
      await page.click('#btn-next', { force: true });
      seen.push(await page.locator('#q-id-badge').innerText());
    }
    expect(seen).toEqual(EXPECTED_ORDER.map((id) => `ID: ${id}`));
    // NOTE: we still do not assert #btn-next becomes disabled on the last
    // due question -- that behaviour is out of this spec's scope; the queue
    // contents are what it verifies.
  });

  test('grading a due card from the queue', async ({ page }) => {
    await page.selectOption('#filter-status', 'due');
    await expect(page.locator('#q-index-badge')).toHaveText('Q1 of 4');

    const dueQ = QUESTIONS.find((q) => q.id === EXPECTED_ORDER[0]);
    const correctIdx = dueQ.options.findIndex((o) => o.key === dueQ.correct_answer);
    await page.locator('#options-container button').nth(correctIdx).click({ force: true });
    await expect(page.locator('#feedback-title')).toContainText('Correct!');

    // After grading, the SRS badge should reflect an updated card (no
    // longer "New Card", repetitions incremented) -- this is the actual
    // scheduleNext() write-back the grading path is responsible for.
    await expect(page.locator('#srs-status-badge')).not.toHaveText('SRS: New Card');
  });
});

// WI-13: the Review tab surfaces the SRS due queue + the high-yield drill as
// first-class flows (previously a buried Practice filter option and an
// exam-lobby button). "Start review" applies the due filter and jumps to the
// Practice question UI, where recordAttempt() already reschedules via SM-2.
test.describe('Review tab (WI-13)', () => {
  test('empty profile: no cards due -> honest empty state + high-yield drill', async ({ page }) => {
    await page.goto('/index.html');
    await seedEmpty(page);

    await page.click('#tab-review', { force: true });
    await expect(page.locator('#view-review')).toBeVisible();
    await expect(page.locator('#view-review')).toContainText('Nothing due for review');
    await expect(page.locator('#view-review button:has-text("Start high-yield drill")')).toBeVisible();
    // Mode 1: an empty profile shows no fabricated "due now" count.
    await expect(page.locator('#view-review').getByText(/due now/)).toHaveCount(0);
  });

  test('fixture profile: real due count, and Start review opens the filtered Practice queue', async ({ page }) => {
    await page.goto('/index.html');
    await seedFixtureProfile(page);

    await page.click('#tab-review', { force: true });
    // The fixture seeds exactly 4 due cards (see this file's header) -- written
    // by hand, not derived from app logic.
    await expect(page.locator('#view-review')).toContainText('4 due now');
    await expect(page.locator('#view-review button:has-text("Start review (4)")')).toBeVisible();

    await page.click('#view-review button:has-text("Start review")');
    await expect(page.locator('#view-practice')).toBeVisible();
    await expect(page.locator('#filter-status')).toHaveValue('due');
    await expect(page.locator('#q-index-badge')).toHaveText('Q1 of 4');
  });
});
