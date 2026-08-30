/**
 * WI-11 browser-truth specs for storage & sync hardening.
 *
 * Three things the Node unit suite cannot prove on its own, because they are
 * properties of the real page lifecycle rather than of a function:
 *
 *  1. INTERRUPTED SYNC — kill the network mid-session (route.abort on the sync
 *     endpoint), keep answering, reload, let the retry through, and assert each
 *     attempt is stored exactly once. This is the one that catches a
 *     double-counting outbox replay, which no amount of unit testing of
 *     enqueueOutboxOp would.
 *
 *  2. MIGRATION — seed genuinely v1-shaped psat_* state (no psat_schema_meta,
 *     SRS cards with history and no summary counters), load the page, and assert
 *     the v2 envelope exists, the v1 backups exist byte-identically, and every
 *     record survived.
 *
 *  3. DESTRUCTIVE ACTION — make the safety snapshot fail, trigger Reset All
 *     Progress, and assert the reset was refused and the data is untouched.
 *
 * Every expected value here is hand-written. All sync traffic is answered by the
 * fixture's stub quarantine, so nothing reaches the live API.
 */
const { test, expect, seedEmpty } = require('./fixtures');

// ---------------------------------------------------------------------------
// A hand-written v1 profile. No psat_schema_meta. SRS cards carry history but
// NO totalReviews / totalLapses / firstReviewedAt — the pre-WI-11 shape.
//
// Hand-computed expectations:
//   q_mig_a: 3 events, 1 of them grade 1  -> totalReviews 3, totalLapses 1
//   q_mig_b: 24 events, 4 of them grade 2 -> totalReviews 24, totalLapses 4,
//            history trimmed to the newest 20 (events 5..24)
// ---------------------------------------------------------------------------
const T0 = 1700000000000;
const DAY = 86400000;

const V1_STATE = {
  progress: {
    q_mig_a: { answered: true, selectedAnswer: 'A', isCorrect: true, timestamp: T0 + 1000, timesSeen: 1, timesCorrect: 1, timesIncorrect: 0 },
    q_mig_b: { answered: true, selectedAnswer: 'C', isCorrect: false, timestamp: T0 + 2000, timesSeen: 2, timesCorrect: 0, timesIncorrect: 2 },
  },
  srs: {
    q_mig_a: {
      questionId: 'q_mig_a', repetitions: 2, intervalDays: 3, easeFactor: 2.5, lastReviewedAt: T0 + 3 * DAY,
      history: [
        { reviewedAt: T0 + 1 * DAY, grade: 4, intervalDays: 1, responseTimeMs: 20000 },
        { reviewedAt: T0 + 2 * DAY, grade: 1, intervalDays: 1, responseTimeMs: 60000 },
        { reviewedAt: T0 + 3 * DAY, grade: 5, intervalDays: 3, responseTimeMs: 15000 },
      ],
    },
    q_mig_b: {
      questionId: 'q_mig_b', repetitions: 4, intervalDays: 6, easeFactor: 2.3, lastReviewedAt: T0 + 24 * DAY,
      history: Array.from({ length: 24 }, (_, i) => {
        const n = i + 1;
        return { reviewedAt: T0 + n * DAY, grade: [4, 5, 21, 23].includes(n) ? 2 : 5, intervalDays: 1, responseTimeMs: 30000 };
      }),
    },
  },
  sessions: { '2026-08-27': { date: '2026-08-27', questionsAnswered: 3, correct: 2, totalTimeMs: 90000 } },
  examHistory: [{ examId: 'v1_exam_1', completedAt: T0 + 4 * DAY, totalQuestions: 8, totalCorrect: 5 }],
};

/** Writes the v1 profile into localStorage WITHOUT any v2 marker. */
async function seedV1Profile(page) {
  await page.evaluate((s) => {
    [
      'psat_progress', 'psat_srs', 'psat_sessions', 'psat_exam_history',
      'psat_schema_meta', 'psat_sync_cursor', 'psat_sync_outbox',
      'psat_progress_v1_backup', 'psat_srs_v1_backup',
      'psat_sessions_v1_backup', 'psat_exam_history_v1_backup',
      'psat_sample_data_active', 'psat_pre_sample_backup', 'psat_active_exam_state',
    ].forEach((k) => localStorage.removeItem(k));
    localStorage.setItem('psat_progress', JSON.stringify(s.progress));
    localStorage.setItem('psat_srs', JSON.stringify(s.srs));
    localStorage.setItem('psat_sessions', JSON.stringify(s.sessions));
    localStorage.setItem('psat_exam_history', JSON.stringify(s.examHistory));
  }, V1_STATE);
}

// ===========================================================================
test.describe('WI-11 v1 -> v2 local migration', () => {
// ===========================================================================
  test('a v1 profile is migrated on load: v2 envelope, v1 backups, data intact', async ({ page }) => {
    await page.goto('/index.html');
    await seedV1Profile(page);

    // The raw v1 bytes, captured before the migrating page load.
    const v1Raw = await page.evaluate(() => ({
      progress: localStorage.getItem('psat_progress'),
      srs: localStorage.getItem('psat_srs'),
      sessions: localStorage.getItem('psat_sessions'),
      examHistory: localStorage.getItem('psat_exam_history'),
    }));
    expect(await page.evaluate(() => localStorage.getItem('psat_schema_meta'))).toBeNull();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => localStorage.getItem('psat_schema_meta') !== null, null, { timeout: 10000 });

    const after = await page.evaluate(() => ({
      meta: JSON.parse(localStorage.getItem('psat_schema_meta')),
      srs: JSON.parse(localStorage.getItem('psat_srs')),
      progress: JSON.parse(localStorage.getItem('psat_progress')),
      examHistory: JSON.parse(localStorage.getItem('psat_exam_history')),
      backups: {
        progress: localStorage.getItem('psat_progress_v1_backup'),
        srs: localStorage.getItem('psat_srs_v1_backup'),
        sessions: localStorage.getItem('psat_sessions_v1_backup'),
        examHistory: localStorage.getItem('psat_exam_history_v1_backup'),
      },
    }));

    // 1. The v2 envelope exists.
    expect(after.meta.schemaVersion).toBe(2);
    expect(after.meta.migratedFrom).toBe(1);
    expect(typeof after.meta.migratedAt).toBe('number');

    // 2. The v1 backups are byte-identical to what was there before the load.
    expect(after.backups.progress).toBe(v1Raw.progress);
    expect(after.backups.srs).toBe(v1Raw.srs);
    expect(after.backups.sessions).toBe(v1Raw.sessions);
    expect(after.backups.examHistory).toBe(v1Raw.examHistory);

    // 3. Data intact, with exact hand-computed summaries.
    expect(Object.keys(after.progress).sort()).toEqual(['q_mig_a', 'q_mig_b']);
    expect(after.progress.q_mig_b.timesSeen).toBe(2);
    expect(after.examHistory).toHaveLength(1);
    expect(after.examHistory[0].examId).toBe('v1_exam_1');

    expect(after.srs.q_mig_a.totalReviews).toBe(3);
    expect(after.srs.q_mig_a.totalLapses).toBe(1);
    expect(after.srs.q_mig_a.firstReviewedAt).toBe(T0 + 1 * DAY);
    expect(after.srs.q_mig_a.history).toHaveLength(3);

    expect(after.srs.q_mig_b.totalReviews).toBe(24);
    expect(after.srs.q_mig_b.totalLapses).toBe(4);
    expect(after.srs.q_mig_b.history).toHaveLength(20);
    expect(after.srs.q_mig_b.history[0].reviewedAt).toBe(T0 + 5 * DAY); // 24 - 20 + 1
    expect(after.srs.q_mig_b.easeFactor).toBe(2.3); // unrelated fields preserved
  });

  test('a second load does not re-migrate and does not overwrite the v1 backups', async ({ page }) => {
    await page.goto('/index.html');
    await seedV1Profile(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => localStorage.getItem('psat_schema_meta') !== null, null, { timeout: 10000 });

    const first = await page.evaluate(() => ({
      meta: localStorage.getItem('psat_schema_meta'),
      srs: localStorage.getItem('psat_srs'),
      backupSrs: localStorage.getItem('psat_srs_v1_backup'),
    }));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => localStorage.getItem('psat_schema_meta') !== null, null, { timeout: 10000 });

    const second = await page.evaluate(() => ({
      meta: localStorage.getItem('psat_schema_meta'),
      srs: localStorage.getItem('psat_srs'),
      backupSrs: localStorage.getItem('psat_srs_v1_backup'),
    }));

    expect(second.meta).toBe(first.meta);       // migratedAt unchanged -> it did not run again
    expect(second.srs).toBe(first.srs);
    expect(second.backupSrs).toBe(first.backupSrs);
  });

  test('the documented rollback restores the v1 bytes exactly', async ({ page }) => {
    await page.goto('/index.html');
    await seedV1Profile(page);
    const v1Raw = await page.evaluate(() => ({
      progress: localStorage.getItem('psat_progress'),
      srs: localStorage.getItem('psat_srs'),
      sessions: localStorage.getItem('psat_sessions'),
      examHistory: localStorage.getItem('psat_exam_history'),
    }));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => localStorage.getItem('psat_schema_meta') !== null, null, { timeout: 10000 });
    // Migration really did change psat_srs (summaries backfilled, history trimmed).
    expect(await page.evaluate(() => localStorage.getItem('psat_srs'))).not.toBe(v1Raw.srs);

    const rb = await page.evaluate(() => window.PSAT_ENGINE.rollbackLocalStateToV1(localStorage, window.location));
    expect(rb.success).toBe(true);

    const restored = await page.evaluate(() => ({
      progress: localStorage.getItem('psat_progress'),
      srs: localStorage.getItem('psat_srs'),
      sessions: localStorage.getItem('psat_sessions'),
      examHistory: localStorage.getItem('psat_exam_history'),
      meta: localStorage.getItem('psat_schema_meta'),
      backupSrs: localStorage.getItem('psat_srs_v1_backup'),
    }));
    expect(restored.progress).toBe(v1Raw.progress);
    expect(restored.srs).toBe(v1Raw.srs);
    expect(restored.sessions).toBe(v1Raw.sessions);
    expect(restored.examHistory).toBe(v1Raw.examHistory);
    expect(restored.meta).toBeNull();
    // The rollback must never delete the backup it restored from.
    expect(restored.backupSrs).toBe(v1Raw.srs);
  });
});

// ===========================================================================
test.describe('WI-11 interrupted sync', () => {
// ===========================================================================
  test('attempts survive a dead network and a reload, each stored exactly once', async ({ page }) => {
    // Take over the sync route BEFORE the page loads: every sync request fails.
    // This wins over the fixture's stub because a later route() handler runs first.
    let syncFailures = 0;
    await page.route('**/api/sync**', async (route) => {
      syncFailures++;
      await route.abort('failed');
    });

    await page.goto('/index.html');
    await seedEmpty(page);
    await page.selectOption('#filter-subject', 'Reading and Writing');

    // Answer three questions with the network down. Answers must still be recorded
    // locally and queued; nothing may be lost because the push failed.
    //
    // Each answer is confirmed IN STORAGE before advancing. Clicking Next straight
    // after the option click races loadQuestion()'s re-render, and under full-suite
    // load that race loses an answer -- which made this spec intermittently report
    // 2 of 3 attempts. Waiting on the recorded state is the deterministic form.
    for (let i = 0; i < 3; i++) {
      await page.locator('#options-container button').first().click({ force: true });
      await page.waitForFunction(
        (expected) => Object.keys(JSON.parse(localStorage.getItem('psat_progress') || '{}')).length === expected,
        i + 1,
        { timeout: 10000 }
      );
      await page.locator('#btn-next').click({ force: true });
    }

    const offline = await page.evaluate(() => ({
      progress: JSON.parse(localStorage.getItem('psat_progress') || '{}'),
      outbox: JSON.parse(localStorage.getItem('psat_sync_outbox') || '[]'),
      cursor: localStorage.getItem('psat_sync_cursor'),
    }));
    expect(Object.keys(offline.progress)).toHaveLength(3);
    expect(offline.outbox).toHaveLength(3);
    // The cursor must NOT have advanced: nothing was acknowledged.
    expect(offline.cursor).toBeNull();
    expect(syncFailures).toBeGreaterThan(0);

    const offlineIds = offline.outbox.map((o) => o.id).sort();
    const offlineProgress = offline.progress;

    // Reload with the network still dead: the outbox must be durable.
    await page.reload({ waitUntil: 'domcontentloaded' });
    const afterReload = await page.evaluate(() => JSON.parse(localStorage.getItem('psat_sync_outbox') || '[]'));
    expect(afterReload.map((o) => o.id).sort()).toEqual(offlineIds);

    // Now let sync through, recording every POST body the client sends.
    const posts = [];
    await page.unroute('**/api/sync**');
    await page.route('**/api/sync**', async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        posts.push(body);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, updatedAt: Date.now(), ackOpIds: (body.outboxOps || []).map((o) => o.id) }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, exists: false }) });
    });

    // Answer one more question, which triggers the debounced push of everything.
    // The reload reset the filter and the question index to 0, and questions 0..2
    // are the ones already answered above — clicking one of those re-renders the
    // answered state instead of recording an attempt. Advance past them first.
    await page.selectOption('#filter-subject', 'Reading and Writing');
    for (let i = 0; i < 3; i++) {
      await page.locator('#btn-next').click({ force: true });
    }
    await page.locator('#options-container button').first().click({ force: true });
    await page.waitForFunction(
      () => Object.keys(JSON.parse(localStorage.getItem('psat_progress') || '{}')).length === 4,
      null,
      { timeout: 10000 }
    );
    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem('psat_sync_outbox') || '[]').length === 0,
      null,
      { timeout: 15000 }
    );

    const recovered = await page.evaluate(() => ({
      progress: JSON.parse(localStorage.getItem('psat_progress') || '{}'),
      outbox: JSON.parse(localStorage.getItem('psat_sync_outbox') || '[]'),
      cursor: JSON.parse(localStorage.getItem('psat_sync_cursor') || 'null'),
    }));

    // EXACTLY ONCE, checked three ways.
    expect(recovered.outbox).toHaveLength(0);
    expect(Object.keys(recovered.progress)).toHaveLength(4);
    // Each of the three offline questions still reports one attempt, not two.
    Object.keys(offlineProgress).forEach((qid) => {
      expect(recovered.progress[qid].timesSeen).toBe(1);
      expect(recovered.progress[qid].attempts).toHaveLength(1);
    });
    // Every op id delivered to the server is distinct.
    const deliveredIds = posts.flatMap((b) => (b.outboxOps || []).map((o) => o.id));
    expect(new Set(deliveredIds).size).toBe(deliveredIds.length);
    // Every offline attempt reached the server at least once.
    offlineIds.forEach((id) => expect(deliveredIds).toContain(id));
    // The cursor advanced only after a real acknowledgement.
    expect(typeof recovered.cursor.lastPushAt).toBe('number');
    expect(typeof recovered.cursor.lastAckAt).toBe('number');
  });
});

// ===========================================================================
test.describe('WI-11 destructive actions', () => {
// ===========================================================================
  test('a failing safety snapshot aborts Reset All Progress and leaves data untouched', async ({ page }) => {
    await page.goto('/index.html');
    await seedV1Profile(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => localStorage.getItem('psat_schema_meta') !== null, null, { timeout: 10000 });

    const before = await page.evaluate(() => ({
      progress: localStorage.getItem('psat_progress'),
      srs: localStorage.getItem('psat_srs'),
      sessions: localStorage.getItem('psat_sessions'),
      examHistory: localStorage.getItem('psat_exam_history'),
    }));

    // Make ONLY the snapshot write fail, exactly as a quota-exhausted browser would.
    await page.evaluate(() => {
      const real = Storage.prototype.setItem;
      window.__realSetItem = real;
      Storage.prototype.setItem = function (k, v) {
        if (String(k).indexOf('psat_snapshot_') === 0) {
          const e = new Error('QuotaExceededError');
          e.name = 'QuotaExceededError';
          throw e;
        }
        return real.call(this, k, v);
      };
    });

    // Both dialogs the flow raises: the confirm (accept it) and the abort alert.
    const dialogMessages = [];
    page.on('dialog', async (d) => {
      dialogMessages.push(d.message());
      await d.accept();
    });

    await page.evaluate(() => window.resetAllProgress());
    await page.evaluate(() => { Storage.prototype.setItem = window.__realSetItem; });

    // The reset must have been refused, and said so.
    expect(dialogMessages.length).toBeGreaterThanOrEqual(2);
    expect(dialogMessages.join(' | ')).toContain('Reset Cancelled');

    const after = await page.evaluate(() => ({
      progress: localStorage.getItem('psat_progress'),
      srs: localStorage.getItem('psat_srs'),
      sessions: localStorage.getItem('psat_sessions'),
      examHistory: localStorage.getItem('psat_exam_history'),
    }));
    expect(after).toEqual(before);
  });

  test('restoring real data with no pre-demo backup deletes nothing', async ({ page }) => {
    await page.goto('/index.html');
    await seedV1Profile(page);
    // Demo mode "active" but with NO psat_pre_sample_backup -- the corrupt state the
    // old code responded to by deleting all four keys.
    await page.evaluate(() => {
      localStorage.setItem('psat_sample_data_active', 'true');
      localStorage.removeItem('psat_pre_sample_backup');
    });

    const before = await page.evaluate(() => ({
      progress: localStorage.getItem('psat_progress'),
      srs: localStorage.getItem('psat_srs'),
      sessions: localStorage.getItem('psat_sessions'),
      examHistory: localStorage.getItem('psat_exam_history'),
    }));

    const dialogMessages = [];
    page.on('dialog', async (d) => { dialogMessages.push(d.message()); await d.accept(); });

    await page.evaluate(() => window.restoreRealStudentData());

    expect(dialogMessages.join(' | ')).toContain('Restore Cancelled');
    const after = await page.evaluate(() => ({
      progress: localStorage.getItem('psat_progress'),
      srs: localStorage.getItem('psat_srs'),
      sessions: localStorage.getItem('psat_sessions'),
      examHistory: localStorage.getItem('psat_exam_history'),
    }));
    expect(after).toEqual(before);
  });
});
