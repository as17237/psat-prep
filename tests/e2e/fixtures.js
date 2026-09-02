/**
 * WI-08 shared Playwright fixtures for the PSAT prep static app.
 *
 * EVERY spec in tests/e2e/ MUST `require('./fixtures')` and use the `test`
 * and `expect` exported from here instead of importing directly from
 * '@playwright/test'. That is what wires up the sync-interceptor quarantine
 * (REFACTOR_PLAN.md WI-08 / CLAUDE.md mode 7) on every page this harness
 * touches.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (read before changing it)
 * ---------------------------------------------------------------------------
 * The CURRENT, unmodified app hardcodes `APP_ENV.studentName = 'default_student'`
 * in index.html/parent.html/mistakes.html, and several pages call
 * PSAT_ENGINE.pullFromCloud/pushToCloud automatically on page load. That means
 * an un-intercepted browser session WILL attempt to read/write the live
 * student's Cosmos document the moment a page is opened. This fixture is the
 * only thing standing between this test suite and that outcome.
 *
 * Two enforcement modes:
 *
 *  - "stub" (used by the chromium-desktop / chromium-mobile projects, i.e.
 *    every local-server spec): every request to the api/sync route is
 *    answered entirely locally via route.fulfill(). It NEVER calls route.continue(),
 *    so no request -- regardless of what student_name it carries -- can ever
 *    reach a real socket. This is what lets us run the full baseline against
 *    the app exactly as it ships today (still hardcoded to default_student)
 *    without endangering live data, and it is deterministic (no live-network
 *    flake).
 *
 *  - "passthrough" (used by the @v2smoke project against the live deployed
 *    /v2/ site): requests are allowed to reach the real Azure Function, but
 *    ONLY after being proven safe. index.html fires an UNCONDITIONAL
 *    pullFromCloud(student_name=default_student) on every single page load
 *    (its "Automatic cloud sync on app start" handler) -- there is no way
 *    to load the page without triggering this, and this work item is not
 *    authorized to change that. So instead of failing every smoke run for
 *    something the frozen app does by design, any request whose URL or
 *    POST body contains the literal string "default_student" is REWRITTEN
 *    in flight -- every occurrence replaced with "e2e_test_student" -- and
 *    only the rewritten request is ever continued for real. The bytes that
 *    reach the live Cosmos-backed API always name the designated test
 *    identity, never the live student, regardless of what the app tried to
 *    send. As a backstop, if a rewritten request somehow still contains
 *    "default_student" (it shouldn't -- this is a plain string replace),
 *    the request is aborted and recorded as a quarantine violation, and the
 *    page fixture's teardown hard-fails the test by throwing.
 *
 * The interceptor negative test (interceptor-quarantine.spec.js) exercises
 * "passthrough" mode directly -- regardless of which project runs it -- to
 * prove (a) a default_student request is transparently rewritten rather
 * than ever reaching the network as-is, and (b) the hard-fail assertion
 * function wired into every spec's teardown does throw when a violation is
 * present.
 */
const path = require('path');
const fs = require('fs');
const base = require('@playwright/test');

// ---------------------------------------------------------------------------
// Dataset lookups (real IDs from data/questions_data.js -- NOT derived from
// srs.js logic; this is just "find a stable record", the same as reading a
// row out of a spreadsheet. All hand-computed expected values below were
// worked out on paper from these records' `correct_answer` fields.)
// ---------------------------------------------------------------------------
const BUNDLE_PATH = path.join(__dirname, '..', '..', 'data', 'questions_data.js');

function loadBundle() {
  const js = fs.readFileSync(BUNDLE_PATH, 'utf8');
  return JSON.parse(js.slice(js.indexOf('=') + 1, js.lastIndexOf(']') + 1));
}

const QUESTIONS = loadBundle();
const TOTAL_QUESTION_COUNT = QUESTIONS.length; // verified below, expect 3059

if (TOTAL_QUESTION_COUNT !== 3059) {
  throw new Error(
    `tests/e2e/fixtures.js: expected 3059 questions in data/questions_data.js, found ${TOTAL_QUESTION_COUNT}. ` +
    'Question content is supposed to be frozen (CLAUDE.md mode 3 / REFACTOR_PLAN §7.4) -- stopping rather than ' +
    'silently testing against a different dataset.'
  );
}

function byId(id) {
  const q = QUESTIONS.find((x) => x.id === id);
  if (!q) throw new Error(`tests/e2e fixtures: question id ${id} not found in data/questions_data.js`);
  return q;
}

// The first Reading & Writing question in bundle order -- this is exactly
// what `filteredQuestions[0]` will be on index.html after selecting
// Subject = "Reading and Writing" with no other filters, because
// applyFilters() filters the bundle in place without shuffling.
const KNOWN_RW_QUESTION = byId('737870c6');
// The first Math question in bundle order (also the first free-response
// question in the whole bundle) -- same reasoning for Subject = "Math".
const KNOWN_MATH_FR_QUESTION = byId('6cdc66d9');

if (KNOWN_RW_QUESTION.type !== 'multiple_choice' || KNOWN_RW_QUESTION.correct_answer !== 'C') {
  throw new Error('tests/e2e fixtures: KNOWN_RW_QUESTION shape changed -- update the hand-picked fixture.');
}
if (KNOWN_MATH_FR_QUESTION.type !== 'free_response' || KNOWN_MATH_FR_QUESTION.correct_answer !== '2') {
  throw new Error('tests/e2e fixtures: KNOWN_MATH_FR_QUESTION shape changed -- update the hand-picked fixture.');
}

// ---------------------------------------------------------------------------
// The hand-written 20-question fixture profile (CLAUDE.md mode 4: expected
// values below are typed-in integers worked out by hand, not produced by
// calling srs.js or any app code).
//
//   Reading & Writing: 6 correct + 4 incorrect out of 10  -> 60%
//   Math:               8 correct + 2 incorrect out of 10 -> 80%
//   Overall:           14 correct + 6 incorrect out of 20 -> 70%
//   Flagged: 2 questions (1 RW correct, 1 Math incorrect)
//   SRS due now: 4 cards (2 RW, 2 Math): 27754367, 96fa19ad, 7326e8c1, bff1c061
//   SRS not due: 2 cards (857b8c7f, 874f12bd)
//   Remaining 14 questions: no SRS card at all.
//   Every one of the 20 questions is a *different* skill, so no skill ever
//   reaches the >=2 / >=3 attempt thresholds used by the mastery/weakness
//   classifiers -- every classifier must show "None yet" / 0, by hand
//   inspection of index.html renderAnalytics() and parent.html
//   renderParentMetrics() (both gate on attempted-count before ranking
//   accuracy). This keeps the fixture's expected values simple and exact.
// ---------------------------------------------------------------------------
const RW_CORRECT = [
  { id: '1b9fa866', answer: 'A', flagged: true },
  { id: 'fda10103', answer: 'D' },
  { id: '85fae948', answer: 'B' },
  { id: '27754367', answer: 'B', srs: 'due' },
  { id: '857b8c7f', answer: 'C', srs: 'notDue' },
  { id: '6af34bc0', answer: 'B' },
];
const RW_INCORRECT = [
  { id: '96fa19ad', correct: 'B', wrong: 'A', srs: 'due' },
  { id: 'bf403f2f', correct: 'B', wrong: 'A' },
  { id: 'a0946a9f', correct: 'D', wrong: 'A' },
  { id: '40c084e5', correct: 'B', wrong: 'A' },
];
const MATH_CORRECT = [
  { id: '7326e8c1', answer: 'A', srs: 'due' },
  { id: 'b98324c9', answer: '40' },
  { id: '2b0def60', answer: 'B' },
  { id: '67ee289f', answer: 'A' },
  { id: '13aa5fea', answer: 'C' },
  { id: 'eab61abb', answer: '168' },
  { id: '874f12bd', answer: 'C', srs: 'notDue' },
  { id: 'cd006b8a', answer: 'D' },
];
const MATH_INCORRECT = [
  { id: 'bff1c061', correct: 'A', wrong: 'B', srs: 'due' },
  { id: '03b5a12c', correct: 'C', wrong: 'A', flagged: true },
];

// One completed mini exam (fixture_mini_exam_1): RW 3/4 correct (75%),
// Math 2/4 correct (50%), overall 5/8 correct -> round(5/8*100) = 62.5 -> 63%
// (JS Math.round rounds .5 up: Math.round(62.5) === 63).
const EXAM_RW = [
  { id: 'da9a6075', correct: 'A', user: 'A', isCorrect: true },
  { id: 'c2fe3dc4', correct: 'B', user: 'B', isCorrect: true },
  { id: '8d605fb1', correct: 'A', user: 'A', isCorrect: true },
  { id: 'd7eb6d4b', correct: 'B', user: 'C', isCorrect: false },
];
const EXAM_MATH = [
  { id: 'b7969d5a', correct: 'D', user: 'D', isCorrect: true },
  { id: '34924409', correct: 'A', user: 'A', isCorrect: true },
  { id: '7168a714', correct: 'C', user: 'A', isCorrect: false },
  { id: '012c92ef', correct: 'A', user: 'B', isCorrect: false },
];

// Cross-check every id used above is real and has the correct_answer we
// assumed, at module-load time (fails fast/loud rather than producing wrong
// expected values silently -- CLAUDE.md mode 3).
[...RW_CORRECT, ...MATH_CORRECT].forEach((r) => {
  const q = byId(r.id);
  if (q.correct_answer !== r.answer) {
    throw new Error(`fixtures.js: ${r.id} correct_answer is "${q.correct_answer}", fixture assumed "${r.answer}"`);
  }
});
[...RW_INCORRECT, ...MATH_INCORRECT].forEach((r) => {
  const q = byId(r.id);
  if (q.correct_answer !== r.correct) {
    throw new Error(`fixtures.js: ${r.id} correct_answer is "${q.correct_answer}", fixture assumed "${r.correct}"`);
  }
  if (r.wrong === r.correct) throw new Error(`fixtures.js: ${r.id} "wrong" answer equals correct answer`);
});
[...EXAM_RW, ...EXAM_MATH].forEach((r) => {
  const q = byId(r.id);
  if (q.correct_answer !== r.correct) {
    throw new Error(`fixtures.js: exam question ${r.id} correct_answer is "${q.correct_answer}", fixture assumed "${r.correct}"`);
  }
  if ((r.user === r.correct) !== r.isCorrect) {
    throw new Error(`fixtures.js: exam question ${r.id} isCorrect flag does not match user vs correct answer`);
  }
});

const FIXTURE = {
  // hand-computed expected analytics values (do not derive these at runtime)
  totalQuestionsInBank: TOTAL_QUESTION_COUNT, // 3059
  attemptedCount: 20,
  correctCount: 14,
  incorrectCount: 6,
  overallAccuracyPercent: 70, // 14/20
  rwAttempted: 10,
  rwCorrect: 6,
  rwAccuracyPercent: 60, // 6/10
  mathAttempted: 10,
  mathCorrect: 8,
  mathAccuracyPercent: 80, // 8/10
  flaggedCount: 2,
  srsDueCount: 4,
  srsNotDueCount: 2,
  topWeaknessLabel: 'None yet', // every skill has < 2 attempts
  weakSkillsCount: 0,
  // mistakes.html trouble-spot counts (buildTroubleSpots merges progress +
  // exam history; the 3 exam-only wrong questions are NOT in progress, so
  // they add 3 new trouble spots on top of the 6 practice mistakes)
  mistakesTotal: 9, // 6 practice + 3 exam-only
  mistakesRw: 5, // 4 practice RW + 1 exam RW (d7eb6d4b)
  mistakesMath: 4, // 2 practice Math + 2 exam Math (7168a714, 012c92ef)
  mistakesRecurring: 0, // every trouble spot has timesWrong === 1
  knownIncorrectPracticeId: '96fa19ad', // must appear in mistakes feed
  knownIncorrectExamOnlyId: 'd7eb6d4b', // must appear in mistakes feed too
  // exam history
  examHistoryCount: 1,
  examTotalQuestions: 8,
  examTotalCorrect: 5,
  examAccuracyPercent: 63, // round(5/8*100) = round(62.5) = 63
  examRwTotal: 4,
  examRwCorrect: 3,
  examRwAccuracyPercent: 75,
  examMathTotal: 4,
  examMathCorrect: 2,
  examMathAccuracyPercent: 50,
  // MIN_PER_SECTION gate (srs.js SCALING_ASSUMPTIONS.MIN_PER_SECTION === 15):
  // 10 RW / 10 Math attempted is below the gate on both sections, so the
  // parent portal's projected score must show the placeholder, never a number.
  minPerSection: 15,
};

// ---------------------------------------------------------------------------
// WI-17 analytics / cross-portal parity fixture
// ---------------------------------------------------------------------------
// A richer, 60-attempt hand-designed profile that pushes real skills ACROSS the
// mastered / focus / in-progress thresholds so the analytics classifications on
// index.html "My Progress" and parent.html "Overview" can be checked against a
// HAND-COMPUTED table (below) and against EACH OTHER (the twin-drift check).
//
// Six real bank skills; for each we take the first N multiple-choice questions
// (bundle order, deterministic) and mark the first `correct` of them correct.
// Accuracies are chosen to be unambiguous on BOTH portals' slightly different
// rules (student rounds accuracy and gates focus at >=3 attempts; parent uses
// unrounded accuracy, gates top-weakness at >=3 and weak-count at >=2), so no
// skill sits on a rounding boundary. All expected outputs were verified by
// running the real engine + the pages' grouping logic before this was committed.
const ANALYTICS_PLAN = [
  // tag, skill, test, attempts, correct  ->  classification
  { tag: 'A', skill: 'Command of Evidence', test: 'Reading and Writing', attempts: 15, correct: 15 }, // mastered 100%
  { tag: 'C', skill: 'Words in Context', test: 'Reading and Writing', attempts: 17, correct: 3 },     // focus 18% (TOP weakness)
  { tag: 'E', skill: 'Form, Structure, and Sense', test: 'Reading and Writing', attempts: 2, correct: 2 }, // in-progress (<3)
  { tag: 'B', skill: 'Linear functions', test: 'Math', attempts: 12, correct: 12 },                   // mastered 100%
  { tag: 'D', skill: 'Nonlinear functions', test: 'Math', attempts: 12, correct: 6 },                 // focus 50%
  { tag: 'F', skill: 'Nonlinear equations in one variable and systems of equations in two variables', test: 'Math', attempts: 2, correct: 1 }, // in-progress (<3)
];

// Build the concrete progress rows once (Node side), deterministically.
const ANALYTICS_ROWS = (() => {
  const rows = [];
  ANALYTICS_PLAN.forEach((p) => {
    const pool = QUESTIONS.filter(
      (q) => q.test === p.test && q.skill === p.skill && q.type === 'multiple_choice' && Array.isArray(q.options) && q.options.length === 4
    ).slice(0, p.attempts);
    if (pool.length !== p.attempts) {
      throw new Error(`fixtures.js ANALYTICS_PLAN: skill "${p.skill}" has ${pool.length} MCQ, need ${p.attempts}`);
    }
    pool.forEach((q, i) => {
      const isCorrect = i < p.correct;
      const wrong = q.options.find((o) => o.key !== q.correct_answer).key;
      rows.push({ id: q.id, isCorrect, selectedAnswer: isCorrect ? q.correct_answer : wrong });
    });
  });
  return rows;
})();

// Flag the first 3 attempted questions; make the first 4 attempted SRS-due.
const ANALYTICS_FLAG_IDS = ANALYTICS_ROWS.slice(0, 3).map((r) => r.id);
const ANALYTICS_DUE_IDS = ANALYTICS_ROWS.slice(0, 4).map((r) => r.id);

// Hand-computed expectation table (verified against the real engine + page logic).
const ANALYTICS = {
  totalAttempted: 60,
  totalDisplay: `60 / ${TOTAL_QUESTION_COUNT}`,
  overallAccuracyPercent: 65, // round(39/60*100)
  flaggedCount: 3,
  topWeaknessLabel: 'Words in Context (18%)', // min accuracy focus skill, round(3/17*100)=18
  masteredCount: 2, // Command of Evidence 100%, Linear functions 100%
  focusCount: 2, // Words in Context 18%, Nonlinear functions 50%
  inProgressCount: 2, // Form/Structure/Sense (2 att), Nonlinear equations (2 att)
  masteredBadgeCommandOfEvidence: '100% (15/15)',
  focusBadgeWordsInContext: '18% (3/17)',
  weakSkillsCount: 3, // parent gap-weak-skills: attempted>=2 & <75% -> Words(17), Nonlinear fns(12), Nonlinear eqns(2)
  srsDueCount: 4,
  rwAttempted: 34, // 15 + 17 + 2
  mathAttempted: 26, // 12 + 12 + 2
  totalQuestionsInBank: TOTAL_QUESTION_COUNT,
};

/**
 * Seeds the WI-17 analytics profile: 60 attempts across 6 skills, 3 flagged,
 * 4 SRS-due, empty sessions (so streak/study-time are an honest 0 on both pages).
 */
async function seedAnalyticsProfile(page) {
  await page.evaluate(
    ({ rows, flagIds, dueIds }) => {
      const now = Date.now();
      const flag = new Set(flagIds);
      const due = new Set(dueIds);
      const progress = {};
      const srs = {};
      rows.forEach((r) => {
        progress[r.id] = {
          answered: true,
          selectedAnswer: r.selectedAnswer,
          isCorrect: r.isCorrect,
          timeSpentMs: 30000,
          timingReliable: true,
          timestamp: now - 3600000,
          isFlagged: flag.has(r.id),
          errorTag: null,
          historicalErrorTags: [],
          timesSeen: 1,
          timesCorrect: r.isCorrect ? 1 : 0,
          timesIncorrect: r.isCorrect ? 0 : 1,
          accuracyPercent: r.isCorrect ? 100 : 0,
          attempts: [{ at: now - 3600000, selectedAnswer: r.selectedAnswer, isCorrect: r.isCorrect, timeSpentMs: 30000, source: 'practice' }],
        };
        if (due.has(r.id)) {
          srs[r.id] = { questionId: r.id, repetitions: 2, intervalDays: 1, easeFactor: 2.5, dueAt: now - 86400000, history: [{ at: now - 86400000, grade: 4 }] };
        }
      });
      localStorage.setItem('psat_progress', JSON.stringify(progress));
      localStorage.setItem('psat_srs', JSON.stringify(srs));
      localStorage.setItem('psat_sessions', JSON.stringify({}));
      localStorage.setItem('psat_exam_history', JSON.stringify([]));
      localStorage.removeItem('psat_active_exam_state');
      localStorage.removeItem('psat_sample_data_active');
    },
    { rows: ANALYTICS_ROWS, flagIds: ANALYTICS_FLAG_IDS, dueIds: ANALYTICS_DUE_IDS }
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
}

// ---------------------------------------------------------------------------
// Sync / network quarantine
// ---------------------------------------------------------------------------
const SYNC_HOST = 'psat-api-4915.azurewebsites.net';
const V2_HOST = 'psatprep4915.z13.web.core.windows.net';
const V2_BASE_URL = `https://${V2_HOST}/v2/`;
const FORBIDDEN_TOKEN = 'default_student';

// Hosts this harness is allowed to talk to besides the local test server.
// Anything else is an unexpected cross-origin request and gets aborted.
const ALLOWED_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  SYNC_HOST,
  V2_HOST,
  'cdn.tailwindcss.com',
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

function isSyncEndpoint(url) {
  try {
    return new URL(url).pathname.indexOf('/api/sync') !== -1;
  } catch (e) {
    return false;
  }
}

function containsForbiddenToken(url, postData) {
  if (url && url.indexOf(FORBIDDEN_TOKEN) !== -1) return true;
  if (postData && postData.indexOf(FORBIDDEN_TOKEN) !== -1) return true;
  return false;
}

function canned(method) {
  if (method === 'POST') {
    return { success: true, updatedAt: new Date().toISOString(), ackOpIds: [] };
  }
  // GET: `exists:false` guarantees pullFromCloud's merge branch never runs,
  // so the stub can never mutate localStorage out from under a seeded
  // fixture -- see srs.js pullFromCloud(), the `result.exists` check.
  return { success: true, exists: false };
}

/**
 * Installs the sync quarantine on `page`. Call this before any navigation.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{mode?: 'stub'|'passthrough', allowedHosts?: string[]}} opts
 */
async function installSyncQuarantine(page, opts) {
  const mode = (opts && opts.mode) || 'stub';
  const allowed = new Set([...ALLOWED_HOSTS, ...((opts && opts.allowedHosts) || [])]);

  page.__quarantineViolations = page.__quarantineViolations || [];
  page.__syncCalls = page.__syncCalls || [];
  page.__blockedRequests = page.__blockedRequests || [];

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();

    if (isSyncEndpoint(url)) {
      let postData = '';
      try {
        postData = request.postData() || '';
      } catch (e) {
        // no body (GET) -- fine
      }

      const forbidden = containsForbiddenToken(url, postData);

      if (mode === 'passthrough') {
        if (forbidden) {
          // The CURRENT app fires an unconditional pullFromCloud() with
          // student_name=default_student on every index.html/parent.html/
          // mistakes.html page load (see index.html's "Automatic cloud sync
          // on app start" DOMContentLoaded handler) -- there is no way to
          // avoid triggering this just by loading the page, and this work
          // item is not authorized to modify that behavior. So rather than
          // failing every /v2/ smoke run for something the frozen app does
          // unconditionally, REWRITE the request in flight -- replace every
          // occurrence of "default_student" with "e2e_test_student" in both
          // the URL and the POST body -- before ever letting it reach the
          // real network. Whatever the app tried to do, the bytes that
          // actually reach the live Cosmos-backed API always say
          // e2e_test_student, never default_student.
          const rewrittenUrl = url.split(FORBIDDEN_TOKEN).join('e2e_test_student');
          const rewrittenPostData = postData ? postData.split(FORBIDDEN_TOKEN).join('e2e_test_student') : postData;

          // Backstop: if the rewrite somehow failed to fully neutralize the
          // forbidden token (it shouldn't -- this is a plain string
          // replace), do NOT let the request through. This is the hard-fail
          // path the interceptor negative test exercises directly.
          if (containsForbiddenToken(rewrittenUrl, rewrittenPostData)) {
            page.__quarantineViolations.push({ url, postData, method: request.method(), stage: 'post-rewrite' });
            await route.abort('failed');
            return;
          }

          page.__syncCalls.push({
            url: rewrittenUrl,
            method: request.method(),
            postData: rewrittenPostData,
            rewrittenFrom: url,
          });
          const overrides = { url: rewrittenUrl };
          if (postData) overrides.postData = rewrittenPostData;
          await route.continue(overrides);
          return;
        }
        page.__syncCalls.push({ url, method: request.method(), postData, passthrough: true });
        await route.continue();
        return;
      }

      // mode === 'stub': never let a sync request reach a real socket,
      // regardless of what student_name it carries. The current app
      // hardcodes student_name=default_student, so `forbidden` will
      // routinely be true here -- that is expected and safe precisely
      // because this branch never calls route.continue().
      page.__syncCalls.push({ url, method: request.method(), postData, forbidden });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(canned(request.method())),
      });
      return;
    }

    const host = hostnameOf(url);
    if (!host || allowed.has(host)) {
      await route.continue();
      return;
    }
    page.__blockedRequests.push(url);
    await route.abort('blockedbyclient');
  });
}

/**
 * The hard-fail assertion. Wired into every spec's page teardown via the
 * `test` export below. Throws (failing the test) if any request was
 * recorded as a quarantine violation -- i.e. a "passthrough" mode request
 * that tried to reach the live API with default_student in the URL or body.
 */
function assertNoQuarantineViolations(page) {
  const violations = page.__quarantineViolations || [];
  if (violations.length > 0) {
    const detail = violations.map((v) => `${v.method} ${v.url}`).join('; ');
    throw new Error(
      `QUARANTINE VIOLATION: ${violations.length} request(s) attempted to reach the live sync API ` +
      `with "default_student" in the URL or POST body: ${detail}`
    );
  }
}

// ---------------------------------------------------------------------------
// localStorage seeders
// ---------------------------------------------------------------------------

/** Wipes every psat_* key. Must be called after page.goto() (localStorage is origin-scoped). */
async function seedEmpty(page) {
  await page.evaluate(() => {
    [
      'psat_progress',
      'psat_srs',
      'psat_sessions',
      'psat_exam_history',
      'psat_active_exam_state',
      'psat_uat_feedback',
      'psat_sample_data_active',
      'psat_pending_sync_count',
      'psat_last_cloud_sync_time',
    ].forEach((k) => localStorage.removeItem(k));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
}

/**
 * Seeds the hand-written 20-question fixture profile (see FIXTURE above)
 * plus one completed mini exam, then reloads so the page's own render
 * functions pick it up from localStorage exactly as they would for a real
 * student. Must be called after page.goto().
 */
async function seedFixtureProfile(page) {
  await page.evaluate(
    ({ rwCorrect, rwIncorrect, mathCorrect, mathIncorrect, examRw, examMath }) => {
      const now = Date.now();
      const progress = {};
      const srs = {};

      function addProgress(id, selectedAnswer, isCorrect, flagged) {
        progress[id] = {
          answered: true,
          selectedAnswer: selectedAnswer,
          isCorrect: isCorrect,
          timeSpentMs: 30000,
          timingReliable: true,
          timestamp: now - 3600000,
          isFlagged: !!flagged,
          errorTag: null,
          historicalErrorTags: [],
          timesSeen: 1,
          timesCorrect: isCorrect ? 1 : 0,
          timesIncorrect: isCorrect ? 0 : 1,
          accuracyPercent: isCorrect ? 100 : 0,
          attempts: [{ at: now - 3600000, selectedAnswer: selectedAnswer, isCorrect: isCorrect, timeSpentMs: 30000, source: 'practice' }],
        };
      }

      function addSrs(id, mode) {
        if (!mode) return;
        srs[id] = {
          questionId: id,
          repetitions: 2,
          intervalDays: mode === 'due' ? 1 : 7,
          easeFactor: 2.5,
          dueAt: mode === 'due' ? (now - 86400000) : (now + 7 * 86400000),
          history: [{ at: now - 86400000, grade: 4 }],
        };
      }

      rwCorrect.forEach((r) => { addProgress(r.id, r.answer, true, r.flagged); addSrs(r.id, r.srs); });
      mathCorrect.forEach((r) => { addProgress(r.id, r.answer, true, r.flagged); addSrs(r.id, r.srs); });
      rwIncorrect.forEach((r) => { addProgress(r.id, r.wrong, false, r.flagged); addSrs(r.id, r.srs); });
      mathIncorrect.forEach((r) => { addProgress(r.id, r.wrong, false, r.flagged); addSrs(r.id, r.srs); });

      function examQuestion(r) {
        return { questionId: r.id, userAnswer: r.user, isCorrect: r.isCorrect, answered: true, timeSpentMs: 45000 };
      }

      const examHistory = [{
        examId: 'fixture_mini_exam_1',
        type: 'mini_psat89',
        examTitle: 'Mini PSAT 8/9 Quick Exam',
        completedAt: now - 7200000,
        totalTimeSpentMs: 600000,
        totalQuestions: 8,
        totalCorrect: 5,
        overallAccuracyPercent: 63,
        moduleReports: [
          { section: 'Reading and Writing', questions: examRw.map(examQuestion) },
          { section: 'Math', questions: examMath.map(examQuestion) },
        ],
      }];

      localStorage.setItem('psat_progress', JSON.stringify(progress));
      localStorage.setItem('psat_srs', JSON.stringify(srs));
      localStorage.setItem('psat_sessions', JSON.stringify({}));
      localStorage.setItem('psat_exam_history', JSON.stringify(examHistory));
      localStorage.removeItem('psat_active_exam_state');
      localStorage.removeItem('psat_sample_data_active');
    },
    {
      rwCorrect: RW_CORRECT,
      rwIncorrect: RW_INCORRECT,
      mathCorrect: MATH_CORRECT,
      mathIncorrect: MATH_INCORRECT,
      examRw: EXAM_RW,
      examMath: EXAM_MATH,
    }
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
}

/** Scans all elements matching `selector` for any digit that isn't part of an allowed static string (e.g. the "/ 3059" bank total). Returns offending texts. */
async function findNonZeroDigits(page, selector, allowList) {
  return page.$$eval(
    selector,
    (els, allow) => {
      const offenders = [];
      els.forEach((el) => {
        const text = (el.innerText || el.textContent || '').trim();
        if (!text) return;
        if (allow.some((a) => text.indexOf(a) !== -1)) return;
        // Strip allowed substrings before checking for stray non-zero digits.
        let stripped = text;
        allow.forEach((a) => { stripped = stripped.split(a).join(''); });
        if (/[1-9]/.test(stripped)) offenders.push({ id: el.id, text: text });
      });
      return offenders;
    },
    allowList || []
  );
}

// ---------------------------------------------------------------------------
// test/expect exports
// ---------------------------------------------------------------------------
const test = base.test.extend({
  page: async ({ page }, use, testInfo) => {
    const projectName = testInfo.project.name;
    const mode = projectName === 'v2smoke' ? 'passthrough' : 'stub';
    await installSyncQuarantine(page, { mode });

    // Defense in depth: fail loudly on uncaught page errors rather than
    // letting a broken page silently render nothing (CLAUDE.md mode 5).
    page.__pageErrors = [];
    page.on('pageerror', (err) => page.__pageErrors.push(err));

    await use(page);

    assertNoQuarantineViolations(page);
  },
});

const expect = base.expect;

module.exports = {
  test,
  expect,
  installSyncQuarantine,
  assertNoQuarantineViolations,
  seedEmpty,
  seedFixtureProfile,
  seedAnalyticsProfile,
  findNonZeroDigits,
  FIXTURE,
  ANALYTICS,
  KNOWN_RW_QUESTION,
  KNOWN_MATH_FR_QUESTION,
  QUESTIONS,
  SYNC_HOST,
  V2_HOST,
  V2_BASE_URL,
  FORBIDDEN_TOKEN,
  ALLOWED_HOSTS,
};
