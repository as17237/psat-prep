/**
 * WI-22 — SRS repeat-review attempt integrity (SRS-01 / SRS-02 / SRS-03).
 *
 * THESE TESTS ARE WRITTEN TO BE RED against the current app. They assert the
 * CORRECTED behaviour described in docs/PRODUCT_REVIEW_AND_IMPLEMENTATION_PLAN.md
 * (Milestone 2 acceptance), not what the code does today.
 *
 * ---------------------------------------------------------------------------
 * Why the existing suite is blind to these defects (CLAUDE.md failure mode 4)
 * ---------------------------------------------------------------------------
 *  - tests/e2e/srs_progression.spec.js seeds `psat_progress` EMPTY
 *    (`seedOneDueCard` writes `psat_progress = {}`) before grading a mature SRS
 *    card. Every real due card belongs to a question the student has already
 *    answered, so the only case that matters -- progress.answered === true AND
 *    an overdue card -- is never exercised. With progress empty, loadQuestion()
 *    takes its `!qProg.answered` branch: fresh timing, live option handlers, no
 *    rationale. That is not the repeat-review path.
 *  - tests/e2e/srs-review-queue.spec.js grades a card from the fixture profile
 *    (which DOES seed progress + srs together) but only asserts a "Correct!"
 *    feedback banner and `#srs-status-badge` != 'SRS: New Card'. Both of those
 *    are ALREADY true before the click: loadQuestion() renders the stored
 *    feedback banner for an answered question, and the badge already shows
 *    "Reps 2 · Interval 1d (Due Now)". Nothing about the click is proven.
 *
 * So every assertion below is anchored to STORED STATE read straight out of
 * localStorage, with hand-written expected integers -- never to a banner that
 * could already be on screen.
 *
 * Seeded starting point (hand-written, see the seeders below and
 * tests/e2e/fixtures.js seedFixtureProfile): each reviewed question already has
 *   timesSeen: 1, exactly one entry in `attempts`, and an SRS card with
 *   history.length 1 and dueAt = now - 1 day.
 * summarizeSrsCard() in js/engine/scheduler.js derives totalReviews from
 * max(stored totalReviews, history.length) -> 1. So after exactly ONE genuine
 * review attempt the hand-computed targets are timesSeen 2 and totalReviews 2.
 */
const { test, expect, seedFixtureProfile, KNOWN_MATH_FR_QUESTION, QUESTIONS } = require('./fixtures');

const DAY = 86400000;

// Fixture-profile due cards (bundle order: 27754367, 96fa19ad, 7326e8c1, bff1c061).
// Both of the ones used here were seeded as a previous MISS, so "the original
// miss survives" is actually observable.
const MC_MISSED_RW = '96fa19ad'; // multiple_choice, correct 'B', seeded answer 'A' (wrong)
const MC_MISSED_MATH = 'bff1c061'; // multiple_choice, correct 'A', seeded answer 'B' (wrong)
const FIXTURE_DUE_COUNT = 4; // hand-counted from fixtures.js

const byId = (id) => QUESTIONS.find((q) => q.id === id);

async function readProgress(page, id) {
  return page.evaluate((qid) => (JSON.parse(localStorage.getItem('psat_progress') || '{}'))[qid], id);
}

async function readCard(page, id) {
  return page.evaluate((qid) => (JSON.parse(localStorage.getItem('psat_srs') || '{}'))[qid], id);
}

/** Opens the SRS due queue and walks Next until `id` is the question on screen. */
async function openDueQuestion(page, id) {
  await page.selectOption('#filter-status', 'due');
  await expect(page.locator('#q-index-badge')).toHaveText(`Q1 of ${FIXTURE_DUE_COUNT}`);
  for (let i = 0; i < FIXTURE_DUE_COUNT; i++) {
    const badge = (await page.locator('#q-id-badge').innerText()).trim();
    if (badge === `ID: ${id}`) return;
    await page.click('#btn-next', { force: true });
  }
  throw new Error(`due queue never showed ID: ${id}`);
}

/**
 * SRS-02 needs a free-response question that is BOTH previously answered and
 * overdue; the shared fixture profile only seeds MC cards that way, so this
 * spec seeds one inline in exactly the same record shape (verified against
 * js/engine/storage.js buildProgressEntry and js/engine/scheduler.js
 * scheduleNext output). No fixture file was modified.
 */
async function seedAnsweredDueFreeResponse(page, id, priorAnswer) {
  await page.evaluate(
    ({ qid, prior }) => {
      const now = Date.now();
      localStorage.setItem(
        'psat_progress',
        JSON.stringify({
          [qid]: {
            answered: true,
            selectedAnswer: prior,
            isCorrect: false,
            timeSpentMs: 30000,
            timingReliable: true,
            timestamp: now - 3600000,
            isFlagged: false,
            errorTag: null,
            historicalErrorTags: [],
            timesSeen: 1,
            timesCorrect: 0,
            timesIncorrect: 1,
            accuracyPercent: 0,
            attempts: [{ at: now - 3600000, selectedAnswer: prior, isCorrect: false, timeSpentMs: 30000, source: 'practice' }],
          },
        })
      );
      localStorage.setItem(
        'psat_srs',
        JSON.stringify({
          [qid]: {
            questionId: qid,
            repetitions: 2,
            intervalDays: 1,
            easeFactor: 2.5,
            dueAt: now - 86400000,
            history: [{ reviewedAt: now - 86400000, grade: 4, intervalDays: 1, responseTimeMs: 30000 }],
          },
        })
      );
      localStorage.setItem('psat_sessions', JSON.stringify({}));
      localStorage.setItem('psat_exam_history', JSON.stringify([]));
      localStorage.removeItem('psat_active_exam_state');
      localStorage.removeItem('psat_sample_data_active');
    },
    { qid: id, prior: priorAnswer }
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
}

test.describe('WI-22 SRS repeat-review attempt integrity', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await page.goto('/index.html');
  });

  // -------------------------------------------------------------------------
  // SRS-01
  // -------------------------------------------------------------------------
  test('SRS-01: a due MC card that was already answered starts a NEW hidden-answer attempt and moves the card', async ({ page }) => {
    // Realistic seed: progress AND srs together. Deliberately NOT emptying
    // progress first -- that is the evasion srs_progression.spec.js makes.
    await seedFixtureProfile(page);

    const q = byId(MC_MISSED_RW);
    expect(q.type).toBe('multiple_choice');
    expect(q.correct_answer).toBe('B');

    const before = await readProgress(page, MC_MISSED_RW);
    const cardBefore = await readCard(page, MC_MISSED_RW);
    // Sanity on the seed itself (must PASS -- if these fail the test is
    // mis-seeded, not detecting the defect).
    expect(before.answered).toBe(true);
    expect(before.selectedAnswer).toBe('A');
    expect(before.timesSeen).toBe(1);
    expect(cardBefore.dueAt).toBeLessThan(Date.now());

    await openDueQuestion(page, MC_MISSED_RW);

    // --- a fresh review attempt must not hand the student the answer ---
    await expect.soft(page.locator('#feedback-banner'), 'prior answer banner must be hidden on a fresh review attempt').toBeHidden();
    await expect.soft(page.locator('#rationale-container'), 'rationale must be hidden until this attempt is graded').toBeHidden();
    expect
      .soft(
        await page.locator('#options-container button.is-correct, #options-container button.is-incorrect').count(),
        'no option may be pre-marked correct/incorrect before the student answers this attempt'
      )
      .toBe(0);

    // Give the foreground timer something real to measure (recordAttempt only
    // trusts > 500 ms), then answer CORRECTLY this time.
    await page.waitForTimeout(1200);
    await page.locator('#options-container button[data-option-key="B"]').click({ force: true });

    // --- the click must be a real, graded attempt ---
    await expect.soft(page.locator('#feedback-title'), 'grading this attempt must report THIS attempt (was a miss before)').toContainText('Correct!');

    const after = await readProgress(page, MC_MISSED_RW);
    const cardAfter = await readCard(page, MC_MISSED_RW);

    expect.soft(after.timesSeen, 'a new review attempt must increment timesSeen by exactly 1').toBe(2);
    expect.soft(after.timesCorrect, 'the new correct attempt must be counted').toBe(1);
    expect.soft(after.timesIncorrect, 'the ORIGINAL miss must survive the new attempt').toBe(1);
    expect.soft(after.selectedAnswer, 'latest answer must be the new one').toBe('B');
    expect.soft(after.isCorrect, 'latest attempt must be graded correct').toBe(true);
    expect.soft((after.attempts || []).length, 'the attempt log must gain one entry, not replace the old one').toBe(2);
    expect.soft((after.attempts || [])[0], 'attempts[0] must still be the original miss').toMatchObject({ selectedAnswer: 'A', isCorrect: false });

    // --- the SRS card must actually change ---
    expect.soft(cardAfter.totalReviews, 'totalReviews must go 1 -> 2 (exactly one new review)').toBe(2);
    expect.soft((cardAfter.history || []).length, 'one new SRS history event must be appended').toBe(2);
    expect.soft(typeof cardAfter.lastReviewedAt, 'the card must record a new last-review time').toBe('number');
    expect.soft(cardAfter.lastReviewedAt || 0, 'last-review time must be newer than the seeded review').toBeGreaterThan(cardBefore.history[0].at || 0);
    expect.soft(cardAfter.dueAt, 'the due date must move into the future').toBeGreaterThan(Date.now());
    expect.soft(cardAfter.dueAt, 'the due date must move off the seeded overdue value').toBeGreaterThan(cardBefore.dueAt);

    // --- and it must leave the due queue ---
    await page.selectOption('#filter-status', 'all');
    await page.selectOption('#filter-status', 'due');
    await expect
      .soft(page.locator('#q-index-badge'), 'the reviewed card must drop out of the due queue (4 -> 3)')
      .toHaveText(`Q1 of ${FIXTURE_DUE_COUNT - 1}`);
  });

  // -------------------------------------------------------------------------
  // SRS-02
  // -------------------------------------------------------------------------
  test('SRS-02: a due SPR card accepts exactly ONE new submission and never resubmits the frozen old answer', async ({ page }) => {
    const q = KNOWN_MATH_FR_QUESTION; // 6cdc66d9, free_response, correct '2'
    expect(q.type).toBe('free_response');
    expect(q.correct_answer).toBe('2');

    const PRIOR_ANSWER = '5'; // wrong, and deliberately NOT the correct answer
    await seedAnsweredDueFreeResponse(page, q.id, PRIOR_ANSWER);

    const before = await readProgress(page, q.id);
    expect(before.timesSeen).toBe(1); // seed sanity (must pass)

    await page.selectOption('#filter-status', 'due');
    await expect(page.locator('#q-index-badge')).toHaveText('Q1 of 1');
    await expect(page.locator('#q-id-badge')).toHaveText(`ID: ${q.id}`);

    const input = page.locator('#free-response-input');
    const submit = page.locator('#free-response-container button:has-text("Submit")');

    // --- the input must be usable and empty for a NEW attempt ---
    await expect.soft(input, 'the SPR input must be enabled for a fresh review attempt').toBeEnabled();
    expect.soft(await input.inputValue(), 'the SPR input must be empty for a fresh review attempt, not pre-filled with the old answer').toBe('');
    await expect.soft(page.locator('#feedback-banner'), 'prior result must be hidden on a fresh review attempt').toBeHidden();

    // Type the new answer if the app lets us. If the input is still frozen
    // (today's defect), we deliberately do NOT force a value -- we go straight
    // to the double-click reproduction, which is exactly what the review
    // recorded: two clicks resubmitted the frozen old answer and drove
    // timesSeen 1 -> 3.
    if (await input.isEnabled()) {
      await page.waitForTimeout(1200);
      await input.fill(q.correct_answer);
    }

    await submit.click({ force: true });

    // --- one submission per attempt: the control must be spent ---
    await expect.soft(submit, 'Submit must be disabled once this attempt has been graded').toBeDisabled();

    // Second click (double-click / impatient student). force:true dispatches the
    // click without actionability checks, so a properly disabled button simply
    // does nothing -- which is the desired outcome.
    await submit.click({ force: true });

    const after = await readProgress(page, q.id);
    const cardAfter = await readCard(page, q.id);

    // THE exact reproduction, read out of psat_progress:
    expect(after.timesSeen, 'two Submit clicks must record exactly ONE attempt: timesSeen 1 -> 2 (the defect drives it to 3)').toBe(2);
    expect.soft(after.timesSeen + 0, 'timesSeen must never jump by 2 for one attempt').not.toBe(3);
    expect.soft((after.attempts || []).length, 'exactly one new attempt entry').toBe(2);
    expect.soft((after.attempts || [])[0], 'the original miss must still be in the attempt log').toMatchObject({ selectedAnswer: PRIOR_ANSWER, isCorrect: false });
    expect.soft(after.selectedAnswer, 'the stored answer must be the one typed for THIS attempt, not the frozen old value').toBe(q.correct_answer);
    expect.soft(cardAfter.totalReviews, 'totalReviews must go 1 -> 2, not 1 -> 3').toBe(2);
    expect.soft(cardAfter.dueAt, 'the due date must move into the future').toBeGreaterThan(Date.now());
  });

  // -------------------------------------------------------------------------
  // SRS-03
  // -------------------------------------------------------------------------
  test('SRS-03: counter integrity after one genuine review — new attempt identity, +1 review, nothing rewritten', async ({ page }) => {
    await seedFixtureProfile(page);

    const q = byId(MC_MISSED_MATH);
    expect(q.type).toBe('multiple_choice');
    expect(q.correct_answer).toBe('A');

    const before = await readProgress(page, MC_MISSED_MATH);
    const cardBefore = await readCard(page, MC_MISSED_MATH);
    expect(before.timesSeen).toBe(1); // seed sanity (must pass)
    expect((before.attempts || []).length).toBe(1);
    expect(before.attempts[0].selectedAnswer).toBe('B');

    await openDueQuestion(page, MC_MISSED_MATH);
    await page.waitForTimeout(1200);
    await page.locator('#options-container button[data-option-key="A"]').click({ force: true });

    const after = await readProgress(page, MC_MISSED_MATH);
    const cardAfter = await readCard(page, MC_MISSED_MATH);

    // 1. A new attempt identity exists, distinct from the original.
    expect.soft((after.attempts || []).length, 'a second, separate attempt record must exist').toBe(2);
    const a0 = (after.attempts || [])[0];
    const a1 = (after.attempts || [])[1];
    expect.soft(a1, 'the new attempt must exist').toBeTruthy();
    if (a1) {
      expect.soft(a1.at, 'the new attempt must carry its own, later timestamp identity').toBeGreaterThan(a0.at);
      expect.soft(JSON.stringify(a1), 'the new attempt must be distinguishable from the original').not.toBe(JSON.stringify(a0));
      expect.soft(a1.isCorrect, 'the new attempt was answered correctly').toBe(true);
      // Milestone 2 acceptance: "foreground timing works on fresh review attempts".
      expect.soft(a1.timingReliable, 'a fresh review attempt must be timed, not recorded as untimed').toBe(true);
      expect.soft(typeof a1.timeSpentMs === 'number' ? a1.timeSpentMs : 0, 'a fresh review attempt must record real elapsed ms').toBeGreaterThan(500);
    }

    // 2. The total review count increments by exactly one.
    expect.soft(cardAfter.totalReviews, 'totalReviews must be exactly 2 after exactly one new review').toBe(2);
    expect.soft(after.timesSeen, 'timesSeen must be exactly 2 after exactly one new review').toBe(2);
    expect.soft((cardAfter.history || []).length, 'exactly one new SRS history event').toBe(2);

    // 3. The previous miss and its history are still present -- nothing deleted
    //    or rewritten to make the UI work.
    expect.soft(a0, 'the original attempt record must be untouched').toMatchObject({
      at: before.attempts[0].at,
      selectedAnswer: 'B',
      isCorrect: false,
    });
    expect.soft(after.timesIncorrect, 'the original miss must still be counted').toBe(1);
    expect.soft(after.timesCorrect, 'the new correct attempt must be counted').toBe(1);
    expect.soft(after.answered, 'progress must not be reset to unanswered to make the review UI work').toBe(true);
    expect.soft((cardAfter.history || [])[0], 'the seeded SRS history event must survive').toMatchObject({ grade: cardBefore.history[0].grade });

    // 4. The due date has moved.
    expect.soft(cardAfter.dueAt, 'the due date must move into the future').toBeGreaterThan(Date.now());
    expect.soft(cardAfter.dueAt - cardBefore.dueAt, 'the due date must move forward, not stay put').toBeGreaterThan(DAY);
  });
});
