/**
 * WI-09 no-behaviour-change proof: localStorage equivalence.
 *
 * Drives ONE scripted student session through index.html -- seed the
 * hand-written fixture profile, answer 2 practice questions, grade an SRS
 * card from the due queue, then start and finish a mini exam -- and dumps
 * every psat_* localStorage key at the end.
 *
 * The same spec is executed against the pre-refactor tree (git worktree at
 * the WI-09 base commit) and against the refactored tree; the two dumps are
 * deep-equalled. If moving ~5,100 lines of inline JS into ES modules changed
 * ANY stored byte, this spec is what catches it.
 *
 * DETERMINISM
 * -----------
 * Two sources of run-to-run variation are removed rather than normalised
 * away, so the comparison stays as strict as possible:
 *
 *   1. Math.random -- exam generation samples the 3,059-question bundle.
 *      An init script installs a fixed-seed LCG before any page script runs,
 *      so both trees generate the *same* exam from the *same* bundle.
 *      (This is injected from the test, not patched into app code --
 *      CLAUDE.md mode 4's "no monkeypatching the module under test".)
 *
 *   2. Wall-clock values -- normalised, never faked, so the app's real
 *      Date.now() code path is the one under test. Every normalised field is
 *      listed in NORMALISED_KEYS / NORMALISED_ID_PATTERNS below and is
 *      replaced with a constant placeholder in BOTH dumps.
 *
 * Everything else -- key set, object shape, answer records, correctness
 * flags, SM-2 fields, module reports, scores -- is compared byte-for-byte.
 */
const fs = require('fs');
const path = require('path');
const { test, expect, seedFixtureProfile, QUESTIONS } = require('./fixtures');

// ---------------------------------------------------------------------------
// Normalisation contract (documented, hand-written -- not derived from a dump)
// ---------------------------------------------------------------------------

// Object keys whose value is a wall-clock instant or an elapsed duration.
// Replaced with '<TS>' / '<MS>' in both dumps.
const NORMALISED_TIME_KEYS = new Set([
  'timestamp',
  'at',
  'dueAt',
  'lastReviewedAt',
  'firstReviewedAt',
  'reviewedAt',
  'createdAt',
  'completedAt',
  'startedAt',
  'updatedAt',
  'lastSeenAt',
  'firstSeenAt',
  'savedAt',
  'pausedAt',
  'moduleStartedAt',
  'questionShownAt',
]);
const NORMALISED_DURATION_KEYS = new Set([
  'timeSpentMs',
  'totalTimeSpentMs',
  'moduleTimeSpentMs',
  'remainingSeconds',
  'timeRemainingSeconds',
  'elapsedMs',
  'accumulatedForegroundTimeMs',
  'avgTimePerQuestionMs',
  'totalTimeMs',
  'responseTimeMs',
  'avgResponseTimeMs',
]);

// String values that embed a Date.now() (e.g. "exam_mini_1788...", "drill_...").
// No \b anchors: these epochs sit next to '_' which is itself a word char.
const EMBEDDED_EPOCH = /\d{13}/g;

// Keys holding a pre-formatted locale date string built from the clock.
const NORMALISED_DATE_STRING_KEYS = new Set(['formattedDate', 'dateStr', 'displayDate']);

// Top-level localStorage keys that are pure clock values.
const CLOCK_ONLY_KEYS = new Set(['psat_last_cloud_sync_time']);

function normalise(value, key) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => normalise(v, null));
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value)
      .sort()
      .forEach((k) => {
        out[k] = normalise(value[k], k);
      });
    return out;
  }
  if (key && NORMALISED_TIME_KEYS.has(key) && typeof value === 'number') return '<TS>';
  if (key && NORMALISED_DURATION_KEYS.has(key) && typeof value === 'number') return '<MS>';
  if (key && NORMALISED_DATE_STRING_KEYS.has(key) && typeof value === 'string') return '<DATESTR>';
  if (typeof value === 'string') return value.replace(EMBEDDED_EPOCH, '<EPOCH>');
  return value;
}

function normaliseDump(raw) {
  const out = {};
  Object.keys(raw)
    .sort()
    .forEach((k) => {
      if (CLOCK_ONLY_KEYS.has(k)) {
        out[k] = raw[k] === null ? null : '<TS>';
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw[k]);
      } catch (e) {
        out[k] = normalise(raw[k], null);
        return;
      }
      out[k] = normalise(parsed, null);
    });
  return out;
}

// Fixed-seed LCG (numerical recipes constants) -- deterministic exam sampling.
// window.__reseedRandom(n) lets the spec restart the sequence immediately
// before a generation step, so that any unrelated Math.random() consumers
// (badge/heartbeat code running on timers) cannot shift the stream.
const SEED_SCRIPT = `
  (function () {
    var s = 123456789;
    Math.random = function () {
      s = (1103515245 * s + 12345) % 2147483648;
      return s / 2147483648;
    };
    window.__reseedRandom = function (v) { s = v; };
  })();
`;

const DUE_IDS = ['27754367', '96fa19ad', '7326e8c1', 'bff1c061'];
const DUE_ORDER = QUESTIONS.filter((q) => DUE_IDS.includes(q.id)).map((q) => q.id);
const RW_QUESTIONS = QUESTIONS.filter((q) => q.test === 'Reading and Writing');

function correctOptionIndex(q) {
  const idx = q.options.findIndex((o) => o.key === q.correct_answer);
  if (idx === -1) throw new Error(`fixture question ${q.id} has no option matching its correct_answer`);
  return idx;
}

async function answerCurrentExamQuestion(page) {
  const mcqVisible = await page.locator('#exam-mcq-options').isVisible();
  if (mcqVisible) {
    await page.locator('#exam-mcq-options button').first().click({ force: true });
  } else {
    await page.fill('#exam-spr-input', '1');
  }
}

test.describe('localStorage equivalence (WI-09 no-behaviour-change proof)', () => {
  test('a scripted session produces an identical psat_* localStorage dump', async ({ page }) => {
    await page.addInitScript(SEED_SCRIPT);
    page.on('dialog', (d) => d.accept());

    await page.goto('/index.html');
    await seedFixtureProfile(page);

    // ---- 1. Two practice questions (one right, one wrong) -----------------
    await page.selectOption('#filter-subject', 'Reading and Writing');
    const q1 = RW_QUESTIONS[0];
    await expect(page.locator('#q-id-badge')).toHaveText(`ID: ${q1.id}`);
    await page.locator('#options-container button').nth(correctOptionIndex(q1)).click({ force: true });
    await expect(page.locator('#feedback-title')).toContainText('Correct!');

    // Walk forward to the next RW question the fixture has NOT already
    // answered (the seeded profile replays its stored feedback for anything
    // it has seen, which would record no new attempt). Bundle order is fixed
    // and applyFilters() does not shuffle, so this walk is deterministic.
    const seededIds = new Set(Object.keys(JSON.parse((await page.evaluate(() => localStorage.getItem('psat_progress'))) || '{}')));
    let q2 = null;
    for (let i = 1; i < RW_QUESTIONS.length && i < 12; i++) {
      await page.click('#btn-next', { force: true });
      if (!seededIds.has(RW_QUESTIONS[i].id) && RW_QUESTIONS[i].type === 'multiple_choice') {
        q2 = RW_QUESTIONS[i];
        break;
      }
    }
    if (!q2) throw new Error('ls-equivalence: no unanswered RW MCQ found in the first 12 bundle positions');
    await expect(page.locator('#q-id-badge')).toHaveText(`ID: ${q2.id}`);
    const wrongIdx = correctOptionIndex(q2) === 0 ? 1 : 0;
    await page.locator('#options-container button').nth(wrongIdx).click({ force: true });
    await expect(page.locator('#feedback-title')).toContainText('Incorrect');

    // ---- 2. Grade one SRS card from the due queue -------------------------
    await page.selectOption('#filter-subject', 'all');
    await page.selectOption('#filter-status', 'due');
    await expect(page.locator('#q-id-badge')).toHaveText(`ID: ${DUE_ORDER[0]}`);
    const dueQ = QUESTIONS.find((q) => q.id === DUE_ORDER[0]);
    await page.locator('#options-container button').nth(correctOptionIndex(dueQ)).click({ force: true });
    await expect(page.locator('#feedback-title')).toContainText('Correct!');

    // ---- 3. Start and finish a mini exam ----------------------------------
    await page.click('#tab-exam', { force: true });
    await page.evaluate(() => window.__reseedRandom(987654321));
    await page.click('button:has-text("Start Mini Exam")', { force: true });
    for (let m = 0; m < 2; m++) {
      for (let i = 0; i < 4; i++) {
        await answerCurrentExamQuestion(page);
        if (i < 3) await page.click('#btn-exam-next', { force: true });
      }
      await page.click('#btn-exam-next', { force: true });
      await page.click('#btn-submit-module', { force: true });
      if (m === 0) {
        await expect(page.locator('#exam-break')).toBeVisible();
        await page.click('#exam-break button:has-text("Resume Exam Early")', { force: true });
      }
    }
    await expect(page.locator('#exam-report')).toBeVisible();

    // ---- 4. Dump every psat_* key -----------------------------------------
    const raw = await page.evaluate(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf('psat_') === 0) out[k] = localStorage.getItem(k);
      }
      return out;
    });

    // Sanity: the session must actually have written something meaningful,
    // otherwise "the dumps match" would be a vacuous pass (CLAUDE.md mode 4).
    const progress = JSON.parse(raw.psat_progress || '{}');
    const history = JSON.parse(raw.psat_exam_history || '[]');
    expect(Object.keys(progress).length).toBeGreaterThanOrEqual(22); // 20 seeded + 2 new practice
    expect(history.length).toBe(2); // 1 seeded fixture exam + 1 completed in this session
    expect(raw.psat_srs).toBeTruthy();

    const dump = normaliseDump(raw);

    const outPath = process.env.LS_DUMP_OUT
      ? path.resolve(process.env.LS_DUMP_OUT)
      : path.join(__dirname, '..', '..', 'test-results', 'localstorage-dump.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(dump, null, 2));
    // eslint-disable-next-line no-console
    console.log(
      `[ls-equivalence] wrote ${outPath} -- ${Object.keys(dump).length} psat_* keys, ` +
        `${Object.keys(progress).length} progress entries, ${history.length} exam(s)`
    );

    // Default baseline: the dump captured from a git worktree at the WI-09
    // base commit 6d1c0e9 (pre-refactor), committed alongside this spec.
    // LS_BASELINE overrides it; LS_BASELINE=none skips the comparison (used
    // when *capturing* a baseline).
    const baselineEnv = process.env.LS_BASELINE;
    if (baselineEnv !== 'none') {
      const baselinePath = baselineEnv
        ? path.resolve(baselineEnv)
        : path.join(__dirname, 'fixtures', 'localstorage_baseline_6d1c0e9.json');
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
      expect(Object.keys(dump).sort()).toEqual(Object.keys(baseline).sort());
      expect(dump).toEqual(baseline);
      // eslint-disable-next-line no-console
      console.log(`[ls-equivalence] DEEP-EQUAL vs ${baselinePath} -- 0 differences`);
    }
  });
});
