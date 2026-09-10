/**
 * tests/e2e/exam_pause.spec.js — WI-37. Pause/resume in a real browser.
 *
 * The engine arithmetic is covered in tests/test_pause_and_short_score.js. What that
 * cannot show is the part most likely to hurt a student: a RELOAD while paused.
 *
 * A paused module deliberately has NO deadline, and the resume path's generic expiry
 * test treats a missing deadline as expired. Before the guard, reopening the tab
 * during a pause would therefore have thrown the module away with the answers in it.
 * That is the case this spec exists for; the rest is the visible contract around it.
 */
const { test, expect, seedEmpty } = require('./fixtures');

async function startMiniExamAndAnswer(page) {
  await page.click('#tab-exam', { force: true });
  await page.click('button:has-text("Start Mini Exam")', { force: true });
  await expect(page.locator('#exam-active')).toBeVisible({ timeout: 15000 });
  await page.locator('#exam-mcq-options button').first().click({ force: true });
}

function readTimer(page) {
  return page.locator('#exam-timer-display').innerText();
}

test.describe('exam pause and resume (WI-37)', () => {
  test('pausing stops the clock, blocks answering, and survives a reload with the time intact', async ({ page }) => {
    test.setTimeout(120000);

    await page.goto('/index.html');
    await seedEmpty(page);
    page.on('dialog', (d) => d.accept());
    await page.waitForFunction(() => typeof window.PSAT_ENGINE !== 'undefined', null, { timeout: 30000 });

    await startMiniExamAndAnswer(page);
    const answeredBefore = await page.evaluate(() =>
      Object.keys(JSON.parse(localStorage.getItem('psat_active_exam_state') || '{}').examUserAnswers || {}).length);
    expect(answeredBefore, 'one answer is recorded before pausing').toBeGreaterThanOrEqual(1);

    // ---- 1. Pause ----------------------------------------------------------
    await page.click('#btn-pause-exam', { force: true });
    await expect(page.locator('#exam-paused-overlay')).toBeVisible({ timeout: 10000 });

    const banked = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('psat_active_exam_state') || '{}').pausedRemainingSeconds);
    expect(banked, 'the remaining time is banked in the snapshot').toBeGreaterThan(0);

    const persisted = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('psat_active_exam_state') || '{}');
      return { phase: s.phase, deadline: s.examModuleDeadline };
    });
    expect(persisted.phase, 'the pause is persisted, not just in memory').toBe('paused');
    expect(persisted.deadline, 'and the deadline is REMOVED — a surviving one would expire while away').toBeFalsy();

    // ---- 2. The clock really is stopped ------------------------------------
    const t1 = await readTimer(page);
    await page.waitForTimeout(3000);
    const t2 = await readTimer(page);
    expect(t2, 'the displayed timer must not move while paused').toBe(t1);

    // ---- 3. Answering is blocked -------------------------------------------
    // Assert the function EXISTS before asserting what it returns: `undefined` is
    // falsy, so an un-exposed handler would have made this check pass vacuously.
    // It did, until step 6 caught it.
    const editState = await page.evaluate(() => ({
      exposed: typeof window.moduleCanEdit === 'function',
      canEdit: typeof window.moduleCanEdit === 'function' ? window.moduleCanEdit() : null
    }));
    expect(editState.exposed, 'moduleCanEdit must be reachable for this assertion to mean anything').toBe(true);
    expect(editState.canEdit, 'a stopped clock with a live answer handler would be unlimited time').toBe(false);

    // And prove it BEHAVIOURALLY, not just via the predicate. Answering while paused is
    // blocked by two independent things — the explicit phase check and the deadline
    // being null — so removing either alone leaves the other holding. A mutation test
    // on one guard is therefore absorbed by the other; only attempting a real answer
    // shows whether the contract actually holds.
    const beforeClick = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('psat_active_exam_state')).examUserAnswers);
    await page.evaluate(() => selectExamMcqChoice('D'));
    const afterClick = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('psat_active_exam_state')).examUserAnswers);
    expect(afterClick, 'a paused answer handler must not change an existing answer').toEqual(beforeClick);

    // ---- 4. THE CASE THIS SPEC EXISTS FOR: reload while paused -------------
    await page.reload();
    await page.waitForFunction(() => typeof window.PSAT_ENGINE !== 'undefined', null, { timeout: 30000 });
    await page.click('#tab-exam', { force: true });
    // Click the RESUME control precisely. A broad `#exam-resume-banner button` selector
    // matches the adjacent Discard button first, and this spec accepts dialogs — which
    // silently confirmed the discard and destroyed the very state under test. The
    // snapshot was intact right up to that click.
    await page.click('#exam-resume-banner button[onclick="resumeActiveExamState()"]', { force: true });
    await page.waitForTimeout(1500);

    const afterReload = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('psat_active_exam_state') || '{}');
      return {
        phase: s.phase,
        banked: s.pausedRemainingSeconds,
        answers: Object.keys(s.examUserAnswers || {}).length
      };
    });
    expect(afterReload.answers,
      'RELOAD WHILE PAUSED must not destroy the module. A paused module has no deadline, ' +
      'and the generic expiry test reads a missing deadline as expired.').toBeGreaterThanOrEqual(answeredBefore);
    expect(afterReload.phase, 'it comes back paused, not expired or running').toBe('paused');
    expect(afterReload.banked, 'with the banked time intact').toBe(banked);

    // ---- 5. Resume restores the banked time, not the wall clock ------------
    await expect(page.locator('#exam-paused-overlay')).toBeVisible({ timeout: 10000 });
    await page.click('#exam-paused-overlay button', { force: true });
    await expect(page.locator('#exam-paused-overlay')).toBeHidden({ timeout: 10000 });

    const resumed = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('psat_active_exam_state') || '{}');
      return {
        phase: s.phase,
        deadline: s.examModuleDeadline,
        remaining: window.PSAT_ENGINE.computeRemainingSeconds(s.examModuleDeadline, Date.now()),
        pausedMs: s.totalPausedMs
      };
    });
    expect(resumed.phase).toBe('module');
    expect(resumed.deadline, 'a fresh deadline is minted from the bank').toBeTruthy();
    // Time spent paused and reloading must not be charged: allow a couple of seconds
    // of genuine post-resume ticking, but nothing like the seconds actually elapsed.
    expect(resumed.remaining).toBeGreaterThan(banked - 5);
    expect(resumed.remaining).toBeLessThanOrEqual(banked);
    expect(resumed.pausedMs, 'the time away is recorded rather than hidden').toBeGreaterThan(0);

    // ---- 6. Answering works again ------------------------------------------
    const canEditNow = await page.evaluate(() => window.moduleCanEdit());
    expect(canEditNow, 'the student can answer again after resuming').toBe(true);
  });
});


test('failed resume stays paused through recovery without spending banked time', async ({ page }) => {
  await page.goto('/index.html');
  await seedEmpty(page);
  page.on('dialog', d => d.accept());
  await startMiniExamAndAnswer(page);
  await page.click('#btn-pause-exam', { force: true });
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('psat_active_exam_state')));
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.restoreStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key, value) {
      if (key === 'psat_active_exam_state') throw new DOMException('Synthetic full storage', 'QuotaExceededError');
      return original.call(this, key, value);
    };
    resumeExamNow();
  });
  await expect(page.locator('#save-recovery-panel')).toBeVisible();
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.restoreStorage());
  await page.click('#retry-pending-save');
  await page.waitForFunction(() => !window.__PSAT_WRITE_BLOCKED__);
  const recovered = await page.evaluate(() => JSON.parse(localStorage.getItem('psat_active_exam_state')));
  expect(recovered.phase).toBe('paused');
  expect(recovered.pausedRemainingSeconds).toBe(before.pausedRemainingSeconds);
  expect(recovered.examModuleDeadline).toBeNull();
  expect(recovered.examUserAnswers).toEqual(before.examUserAnswers);
});
