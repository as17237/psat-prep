/**
 * Adaptive MST routing, end-to-end in the browser (index.html, Standard PSAT 8/9).
 *
 * WI-16. The pure routing decision (routeAdaptiveTrack) and the module-generation
 * (27/27/22/22 with Hard/Easy M2 pools) are pinned by the Node suites
 * (tests/test_adaptive_routing.js). What ONLY a real browser run can prove is the
 * WIRING in js/pages/student.js:1591-1621 — that submitting module 1 actually
 * grades the answers, calls routeAdaptiveTrack, swaps module 2's questions to the
 * Hard vs Easy pool, and relabels it "(Upper/Standard Difficulty Track)". That
 * code path had no test that executed it; this spec is it.
 *
 * How the two branches are forced WITHOUT any production test seam:
 *   - The bank is the page global window.QUESTIONS_DATA ({id, type, correct_answer}).
 *   - psat_active_exam_state (persisted on every loadExamQuestion) exposes each
 *     module's ORDERED questionIds and, after a module submit, the resulting
 *     activeExamMeta.routingTracks.{rw,math} and modules[i].name.
 *   - MCQ options render A,B,C,D in fixed order (#exam-mcq-options .question-option,
 *     nth === letter). RW-M1 is 27/27 MCQ and Math-M1 has 17 MCQ, so answering
 *     every MCQ correctly clears the upper-track thresholds (>=16/27, >=13/22)
 *     regardless of the few Math free-response items, which we leave blank.
 *   - UPPER branch: answer M1 MCQ correctly. LOWER branch: answer nothing
 *     (0 correct -> Easy). Standard flow's only break is after module index 1.
 *
 * Slow by nature (dozens of real question interactions); the local http.server is
 * single-threaded, so run with --workers=1.
 */
const { test, expect, seedEmpty } = require('./fixtures');

const LETTER_INDEX = { A: 0, B: 1, C: 2, D: 3 };

/** {id -> {type, correct}} from the page's bank global. */
function bankMap(page) {
  return page.evaluate(() =>
    Object.fromEntries(window.QUESTIONS_DATA.map((q) => [q.id, { type: q.type, correct: q.correct_answer }]))
  );
}

/** Ordered question ids for a module, read from the persisted active-exam snapshot. */
function moduleQuestionIds(page, moduleIndex) {
  return page.evaluate((mi) => {
    const s = JSON.parse(localStorage.getItem('psat_active_exam_state'));
    return s.activeExamMeta.modules[mi].questionIds;
  }, moduleIndex);
}

/** The routing outcome + module labels currently recorded in the snapshot. */
function routingSnapshot(page) {
  return page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('psat_active_exam_state'));
    return {
      routingTracks: s.activeExamMeta.routingTracks,
      moduleNames: s.activeExamMeta.modules.map((m) => m.name),
    };
  });
}

async function startStandardExam(page) {
  await page.click('#tab-exam', { force: true });
  await page.click('button:has-text("Start Full PSAT 8/9 Exam")', { force: true });
  await expect(page.locator('#exam-active-q-pos')).toHaveText('Question 1 of 27');
}

/** Answer the current MCQ correctly; free-response is left blank (not needed to route). */
async function answerCurrentCorrectlyIfMcq(page, record) {
  if (!record || record.type === 'free_response') return;
  const idx = LETTER_INDEX[String(record.correct).trim().toUpperCase()];
  if (idx === undefined) return;
  await page.locator('#exam-mcq-options .question-option').nth(idx).click({ force: true });
}

/** Walk the current module answering every MCQ correctly, then submit it. */
async function driveModuleCorrect(page, moduleIndex, bank) {
  const ids = await moduleQuestionIds(page, moduleIndex);
  for (let i = 0; i < ids.length; i++) {
    await answerCurrentCorrectlyIfMcq(page, bank[ids[i]]);
    if (i < ids.length - 1) await page.click('#btn-exam-next', { force: true });
  }
  await page.click('#btn-exam-next', { force: true }); // last question -> "Review Module →"
  await expect(page.locator('#review-module-heading')).toBeVisible();
  await page.click('#btn-submit-module', { force: true });
}

/** Leave the current module entirely unanswered (0 correct), then submit it. */
async function driveModuleBlank(page) {
  await page.locator('#exam-palette-pills button').last().click({ force: true }); // jump to last question
  await page.click('#btn-exam-next', { force: true }); // last question -> "Review Module →"
  await expect(page.locator('#review-module-heading')).toBeVisible();
  await page.click('#btn-submit-module', { force: true });
}

async function resumeAfterBreak(page) {
  await expect(page.locator('#exam-break')).toBeVisible();
  await page.click('#exam-break button:has-text("Resume Exam Early")', { force: true });
}

async function expectScoredReport(page) {
  await expect(page.locator('#exam-report')).toBeVisible();
  await expect(page.locator('#report-total-score')).not.toHaveText('1390'); // static template placeholder must be overwritten
  const score = (await page.locator('#report-total-score').innerText()).trim();
  expect(score.length).toBeGreaterThan(0);
}

test.describe('adaptive MST routing (Standard PSAT 8/9)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/index.html');
    await seedEmpty(page);
    page.on('dialog', (d) => d.accept()); // submit-module confirm()s
  });

  test('UPPER track: acing both module-1s routes RW and Math module-2 to the Hard pool', async ({ page }) => {
    test.setTimeout(180000);
    await startStandardExam(page);
    const bank = await bankMap(page);

    // RW module 1 (index 0): answer all 27 MCQ correctly -> upper track.
    await driveModuleCorrect(page, 0, bank);
    await expect(page.locator('#exam-active-q-pos')).toHaveText('Question 1 of 27'); // now in RW M2
    let snap = await routingSnapshot(page);
    expect(snap.routingTracks.rw).toBe('Hard');
    expect(snap.moduleNames[1]).toContain('Upper Difficulty Track');

    // RW module 2 (index 1): content irrelevant to routing -> submit -> break.
    await driveModuleBlank(page);
    await resumeAfterBreak(page);
    await expect(page.locator('#exam-active-q-pos')).toHaveText('Question 1 of 22'); // now in Math M1

    // Math module 1 (index 2): 17 MCQ correct clears >=13/22 -> upper track.
    await driveModuleCorrect(page, 2, bank);
    await expect(page.locator('#exam-active-q-pos')).toHaveText('Question 1 of 22'); // now in Math M2
    snap = await routingSnapshot(page);
    expect(snap.routingTracks.math).toBe('Hard');
    expect(snap.moduleNames[3]).toContain('Upper Difficulty Track');

    // Math module 2 (index 3): submit -> finish -> scored report.
    await driveModuleBlank(page);
    await expectScoredReport(page);
  });

  test('LOWER track: leaving both module-1s blank routes RW and Math module-2 to the Easy pool', async ({ page }) => {
    test.setTimeout(180000);
    await startStandardExam(page);

    // RW module 1 blank -> 0 correct -> standard/easy track.
    await driveModuleBlank(page);
    await expect(page.locator('#exam-active-q-pos')).toHaveText('Question 1 of 27'); // RW M2
    let snap = await routingSnapshot(page);
    expect(snap.routingTracks.rw).toBe('Easy');
    expect(snap.moduleNames[1]).toContain('Standard Difficulty Track');

    await driveModuleBlank(page); // RW M2 -> break
    await resumeAfterBreak(page);
    await expect(page.locator('#exam-active-q-pos')).toHaveText('Question 1 of 22'); // Math M1

    await driveModuleBlank(page); // Math M1 blank -> easy
    await expect(page.locator('#exam-active-q-pos')).toHaveText('Question 1 of 22'); // Math M2
    snap = await routingSnapshot(page);
    expect(snap.routingTracks.math).toBe('Easy');
    expect(snap.moduleNames[3]).toContain('Standard Difficulty Track');

    await driveModuleBlank(page); // Math M2 -> finish
    await expectScoredReport(page);
  });
});
