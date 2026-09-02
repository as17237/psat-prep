/**
 * SM-2 progression, end-to-end in the browser (index.html, WI-17).
 *
 * srs-review-queue.spec.js proves the due FILTER shows the right cards and that
 * grading writes *something* back. This spec proves the WRITE-BACK is numerically
 * correct: a real grade earned through the practice UI (correctness + measured
 * response time) produces the exact SM-2 card the algorithm specifies — ease
 * factor, repetition count, interval, and the future due date.
 *
 * The clock is INJECTED via Playwright's fake clock (page.clock), never
 * monkeypatched: we pin "now" to T0, render the question (so the app stamps its
 * "shown at" at T0), fast-forward a controlled RESPONSE_MS, then answer. That
 * makes both the derived grade (gradeAttempt keys off elapsed ms) and the due
 * date (scheduleNext keys off Date.now()) fully deterministic, so every expected
 * value below is HAND-computed (CLAUDE.md failure mode 4) — not read back from
 * the engine.
 *
 * SM-2 recap (js/engine/scheduler.js): passing ladder reps 0->interval 1,
 * 1->3, 2->7, 3+->round(interval*EF'); a fail (grade<3) resets reps 0 / interval 1.
 * EF' = EF + (0.1 - (5-q)*(0.08 + (5-q)*0.02)), floored at 1.3.
 * gradeAttempt: wrong->1; correct & 501-44999ms->5; 45000-90000ms->4; else->3.
 */
const { test, expect, seedEmpty, QUESTIONS } = require('./fixtures');

const DAY = 86400000;
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0); // fixed, arbitrary "now"
const RESPONSE_MS = 10000; // 10s: reliable (>500ms) AND fast (<45000ms) -> grade 5 when correct
const ANSWER_NOW = T0 + RESPONSE_MS; // the Date.now() the app sees at the click

// Real bank MCQ questions (4 options), with their hand-verified correct letters.
const Q_FRESH = QUESTIONS.find((q) => q.id === '737870c6'); // correct C
const Q_LADDER = QUESTIONS.find((q) => q.id === '1b9fa866'); // correct A
const Q_LAPSE = QUESTIONS.find((q) => q.id === 'da9a6075'); // correct A

function optionIndex(q, letter) {
  return q.options.findIndex((o) => o.key === letter);
}
function wrongIndex(q) {
  return q.options.findIndex((o) => o.key !== q.correct_answer);
}

/** Seed exactly one SRS card, due in the past, and nothing else. */
async function seedOneDueCard(page, card) {
  await page.evaluate((c) => {
    localStorage.setItem('psat_srs', JSON.stringify({ [c.questionId]: c }));
    localStorage.setItem('psat_progress', JSON.stringify({}));
    localStorage.setItem('psat_sessions', JSON.stringify({}));
    localStorage.removeItem('psat_active_exam_state');
    localStorage.removeItem('psat_sample_data_active');
  }, card);
  await page.reload({ waitUntil: 'domcontentloaded' });
}

/** Open the due queue and confirm the seeded card is the one on screen. */
async function openDueCard(page, id) {
  await page.selectOption('#filter-status', 'due');
  await expect(page.locator('#q-index-badge')).toHaveText('Q1 of 1');
  await expect(page.locator('#q-id-badge')).toHaveText(`ID: ${id}`);
}

async function readCard(page, id) {
  return page.evaluate((qid) => JSON.parse(localStorage.getItem('psat_srs'))[qid], id);
}

test.describe('SM-2 progression (browser grade path, injected clock)', () => {
  test.beforeEach(async ({ page }) => {
    // Install a hair before T0, then pauseAt(T0) so the clock is FROZEN at exactly
    // T0 (install alone keeps ticking in real time, which drifts the due date by
    // ~1s). Frozen means Date.now() stays T0 until we fastForward, so the app
    // stamps "shown at" = T0 and the post-fastForward answer time is exact.
    await page.clock.install({ time: T0 - 5000 });
    await page.clock.pauseAt(T0);
    await page.goto('/index.html');
    await seedEmpty(page);
  });

  test('fresh card graded 5 (correct, fast) -> reps 1, interval 1 day, EF 2.6, due T0+10s+1d', async ({ page }) => {
    await seedOneDueCard(page, {
      questionId: Q_FRESH.id, repetitions: 0, intervalDays: 1, easeFactor: 2.5,
      dueAt: T0 - DAY, history: [],
    });
    await openDueCard(page, Q_FRESH.id);

    await page.clock.fastForward(RESPONSE_MS);
    await page.locator('#options-container button').nth(optionIndex(Q_FRESH, Q_FRESH.correct_answer)).click({ force: true });
    await expect(page.locator('#feedback-title')).toContainText('Correct!');

    const card = await readCard(page, Q_FRESH.id);
    expect(card.repetitions).toBe(1);
    expect(card.intervalDays).toBe(1);
    expect(card.easeFactor).toBeCloseTo(2.6, 5); // 2.5 + 0.1
    expect(card.dueAt).toBe(ANSWER_NOW + 1 * DAY);
  });

  test('mature card (reps 3, interval 7) graded 5 -> reps 4, interval 19 days, EF 2.7', async ({ page }) => {
    await seedOneDueCard(page, {
      questionId: Q_LADDER.id, repetitions: 3, intervalDays: 7, easeFactor: 2.6,
      dueAt: T0 - DAY, history: [{ reviewedAt: T0 - 8 * DAY, grade: 4, intervalDays: 7, responseTimeMs: 12000 }],
    });
    await openDueCard(page, Q_LADDER.id);

    await page.clock.fastForward(RESPONSE_MS);
    await page.locator('#options-container button').nth(optionIndex(Q_LADDER, Q_LADDER.correct_answer)).click({ force: true });
    await expect(page.locator('#feedback-title')).toContainText('Correct!');

    const card = await readCard(page, Q_LADDER.id);
    expect(card.repetitions).toBe(4);
    expect(card.intervalDays).toBe(19); // round(7 * 2.7) = round(18.9)
    expect(card.easeFactor).toBeCloseTo(2.7, 5); // 2.6 + 0.1
    expect(card.dueAt).toBe(ANSWER_NOW + 19 * DAY);
  });

  test('mature card answered WRONG -> grade 1 resets ladder (reps 0, interval 1 day), EF 2.16', async ({ page }) => {
    await seedOneDueCard(page, {
      questionId: Q_LAPSE.id, repetitions: 3, intervalDays: 19, easeFactor: 2.7,
      dueAt: T0 - DAY, history: [{ reviewedAt: T0 - 20 * DAY, grade: 5, intervalDays: 19, responseTimeMs: 9000 }],
    });
    await openDueCard(page, Q_LAPSE.id);

    await page.clock.fastForward(RESPONSE_MS);
    await page.locator('#options-container button').nth(wrongIndex(Q_LAPSE)).click({ force: true });
    await expect(page.locator('#feedback-title')).toContainText('Incorrect');

    const card = await readCard(page, Q_LAPSE.id);
    expect(card.repetitions).toBe(0);
    expect(card.intervalDays).toBe(1);
    // EF' = 2.7 + (0.1 - (5-1)*(0.08 + (5-1)*0.02)) = 2.7 + (0.1 - 4*0.16) = 2.7 - 0.54 = 2.16
    expect(card.easeFactor).toBeCloseTo(2.16, 5);
    expect(card.dueAt).toBe(ANSWER_NOW + 1 * DAY);
  });
});
