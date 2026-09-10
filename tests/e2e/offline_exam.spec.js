/**
 * tests/e2e/offline_exam.spec.js — WI-20 offline exam mode, end to end.
 *
 * Proves the whole airplane journey in a real browser against the real 3,059-
 * question bundle: prepare WHILE ONLINE (generate + pin one exam, prefetch its
 * images) -> go OFFLINE -> do a COLD reload that only succeeds if the service
 * worker serves the shell -> start the prepared exam with a question image that
 * renders FROM CACHE -> answer offline -> come back online -> the reconnect
 * handler pushes to the (quarantined) sync endpoint. This is the CLAUDE.md #1
 * gate: the real code path against the real dataset, not a mock.
 *
 * Only the sync endpoint is stubbed — by the mandatory fixture quarantine — and
 * that stub is exactly what lets us assert the reconnect push fired.
 */
const { test, expect, seedEmpty } = require('./fixtures');
const { intercept, state } = require('./synthetic_sync');

test.describe('offline exam mode (WI-20)', () => {
  test('prepare online, take offline after a cold reload, sync on reconnect', async ({ page, context }) => {
    test.setTimeout(150000); // precaching the shell + ~150 images over the local server

    const server = state();
    await intercept(page, context, server);
    await page.goto('/index.html');
    await seedEmpty(page);
    page.on('dialog', (d) => d.accept());

    // 1. The service worker installs and takes control (clients.claim).
    await page.waitForFunction(
      () => navigator.serviceWorker && navigator.serviceWorker.controller,
      null,
      { timeout: 30000 }
    );

    // 2. Prepare for offline: generate + pin one exam and prefetch its images.
    //    The control lives on the Exam tab's lobby.
    await page.click('#tab-exam', { force: true });
    await page.click('#offline-prep-btn', { force: true });
    await expect(page.locator('#offline-prep-status')).toContainText('Offline-ready', { timeout: 90000 });

    // 3. The caches and the pin are REALLY populated (assert against Cache
    //    Storage + localStorage directly — no assumed numbers, failure mode 1).
    const report = await page.evaluate(async () => {
      const keys = await caches.keys();
      const shellName = keys.find((k) => k.startsWith('psat-shell-'));
      const shell = shellName ? await caches.open(shellName) : null;
      const idx = shell ? await shell.match('index.html', { ignoreSearch: true }) : null;
      const bundle = shell ? await shell.match('data/questions_data.js', { ignoreSearch: true }) : null;
      const imgs = await caches.open('psat-images');
      const imgKeys = await imgs.keys();
      const pin = JSON.parse(localStorage.getItem('psat_offline_prepared_exam') || 'null');
      return {
        hasShell: !!shellName,
        hasIndex: !!idx,
        hasBundle: !!bundle,
        imageCount: imgKeys.length,
        pinImages: pin && pin.imageCached,
        pinTotal: pin && pin.imageTotal,
        pinModules: pin && pin.examMeta && pin.examMeta.modules.length,
      };
    });
    expect(report.hasShell).toBe(true);
    expect(report.hasIndex).toBe(true);
    expect(report.hasBundle).toBe(true);
    expect(report.imageCount).toBeGreaterThan(100);
    expect(report.pinImages).toBe(report.pinTotal); // every prepared image cached
    expect(report.pinModules).toBe(4);

    // 4. GO OFFLINE and COLD-reload. Only the SW can serve this navigation now.
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(
      () => Array.isArray(window.QUESTIONS_DATA) && window.QUESTIONS_DATA.length === 3059,
      null,
      { timeout: 20000 }
    );
    await page.click('#tab-exam', { force: true });
    await expect(page.locator('#offline-prepared-panel')).toBeVisible();

    // 5. Start the prepared exam offline.
    await page.click('button:has-text("Start prepared exam")', { force: true });
    await expect(page.locator('#exam-active')).toBeVisible({ timeout: 15000 });

    // 6. WALK SEVERAL QUESTIONS OFFLINE. For each: its question image must render
    //    FROM CACHE (naturalWidth > 0 with no network), we answer it, and advance.
    //    This proves real multi-question offline exam-taking, not just one card.
    //    Reading & Writing Module 1 has 27 questions, so 5 stays inside it.
    const QUESTIONS_TO_WALK = 5;
    const seenImages = [];
    for (let i = 1; i <= QUESTIONS_TO_WALK; i++) {
      await expect(page.locator('#exam-active-q-pos')).toHaveText(`Question ${i} of 27`, { timeout: 10000 });
      const src = await page
        .waitForFunction(
          () => {
            const img = document.getElementById('exam-q-image');
            return img && img.complete && img.naturalWidth > 0 ? (img.currentSrc || img.src) : null;
          },
          null,
          { timeout: 10000 }
        )
        .then((h) => h.jsonValue());
      seenImages.push(src);

      const mcq = page.locator('#exam-mcq-options button');
      if (await mcq.count()) await mcq.first().click({ force: true });
      else await page.fill('#exam-spr-input', '1');

      if (i < QUESTIONS_TO_WALK) await page.click('#btn-exam-next', { force: true });
    }
    // Every walked question showed a real cached image, and they were distinct
    // questions (not the same card rendered five times).
    expect(seenImages.every((s) => typeof s === 'string' && /data\/images\//.test(s))).toBe(true);
    expect(new Set(seenImages).size).toBe(QUESTIONS_TO_WALK);
    // The answers are really recorded in the offline exam state.
    const answered = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('psat_active_exam_state') || '{}');
      return Object.keys(s.examUserAnswers || {}).length;
    });
    expect(answered).toBeGreaterThanOrEqual(QUESTIONS_TO_WALK);

    // 7. Back online -> queued work must end up ACCEPTED, and nothing unacknowledged
    //    may be left behind.
    //
    // This asserted `posts increased`, which is the wrong proxy and produced a false
    // alarm that cost a revert. pushToCloud legitimately returns `no_changes` WITHOUT
    // issuing a POST when the delta and the outbox are both empty, so a prior full
    // upload followed by no new work correctly skips the request. What matters is the
    // STATE: no unacknowledged operation is stranded.
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(6000);

    const syncState = await page.evaluate(() => ({
      queued: window.PSAT_ENGINE.getOutboxOps(localStorage, window.location).length,
      posts: null
    }));
    expect(
      syncState.queued,
      'after reconnect no unacknowledged operation may be stranded — either it was ' +
      'uploaded and acknowledged, or there was genuinely nothing to send'
    ).toBe(0);

    // The answers of an UNFINISHED exam live in psat_active_exam_state, which
    // buildSyncDelta does not carry. They are safe on this device and resume here,
    // but they are explicitly NOT synced — asserted so the limitation stays visible
    // rather than being mistaken for cross-device durability.
    const stillLocal = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('psat_active_exam_state') || '{}');
      return Object.keys(s.examUserAnswers || {}).length;
    });
    expect(stillLocal, 'the in-progress answers survive locally').toBeGreaterThanOrEqual(QUESTIONS_TO_WALK);

    // Finish all four modules offline, then lose the first server acknowledgement.
    await context.setOffline(true);
    server.connected = false;
    await page.reload();
    await page.click('#tab-exam', { force: true });
    await page.evaluate(() => resumeActiveExamState());
    for (let module = 0; module < 4; module++) {
      if (module === 2) await page.evaluate(() => resumeExamAfterBreak());
      await page.evaluate(() => { showModuleReviewScreen(); submitCurrentExamModule(); });
    }
    await expect(page.locator('#exam-report')).toBeVisible();
    const completed = await page.evaluate(() => JSON.parse(localStorage.getItem('psat_exam_history'))[0]);
    expect(completed.totalQuestions).toBe(98);
    expect(completed.totalAttempted).toBe(5);
    expect(completed.examId).toEqual(expect.any(String));
    expect(completed.examId.length).toBeGreaterThan(0);
    const queuedBefore = await page.evaluate(() => PSAT_ENGINE.getOutboxOps(localStorage, location).length);
    expect(queuedBefore).toBeGreaterThan(0);
    expect(server.cloud.examHistory).toHaveLength(0);

    server.connected = true;
    server.loseAck = true;
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => server.cloud.examHistory.length).toBe(1);
    await expect.poll(() => page.evaluate(() => PSAT_ENGINE.getOutboxOps(localStorage, location).length),
      { timeout: 20000 }).toBe(0);
    expect(server.cloud.examHistory).toHaveLength(1);
    expect(server.cloud.examHistory[0].examId).toBe(completed.examId);
    expect(Object.keys(server.cloud.progress)).toHaveLength(5);
    for (const entry of Object.values(server.cloud.progress)) expect(entry.timesSeen).toBe(1);
    expect(server.posts.filter(p => p.examHistory.some(r => r.examId === completed.examId)).length).toBeGreaterThanOrEqual(2);
    console.log('Offline completion: 98 questions, 5 attempts, one server report after lost-ack replay.');

  });
});
