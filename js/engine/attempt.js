/**
 * js/engine/attempt.js — the EPHEMERAL attempt: one student sitting down to answer one
 * question, once. This is deliberately NOT the lifetime progress record.
 *
 * Why this part exists (PRODUCT_REVIEW_AND_IMPLEMENTATION_PLAN.md, Milestone 2,
 * defects SRS-01 / SRS-02 / SRS-03):
 *
 *   `js/pages/student.js` decides how to render a question from
 *   `progress[q.id].answered`, which is a LIFETIME flag — true forever after the
 *   first answer. So when a due SRS card comes back around, the page draws the
 *   question as already-answered: the old answer and the rationale are on screen
 *   and the option buttons get no click handler (`if (!qProg.answered) btn.onclick = ...`).
 *   The review cannot be done at all (SRS-01). On the free-response path the input is
 *   disabled and pre-filled with the stale answer while Submit stays live, so two
 *   clicks re-recorded the SAME frozen answer twice and drove `timesSeen` 1 -> 3 (SRS-02).
 *
 * The repair is a separate, short-lived object: an attempt. It carries the mode
 * ("is this a first sighting, a practice re-visit, or a genuine SRS review?"), a
 * status ("open" until graded, then "graded" forever), and a stable identity.
 * Lifetime history is never rewritten to make the UI behave — setting an old record
 * back to `answered:false` would be a data-destroying "fix" (CLAUDE.md mode 7).
 *
 * What this part does NOT do: it does not build the stored progress entry. That job
 * already belongs to `PSAT_ENGINE.buildProgressEntry` (js/engine/storage.js), which
 * appends to `attempts`, increments timesSeen / timesCorrect / timesIncorrect and
 * preserves errorTag / historicalErrorTags. Calling it EXACTLY ONCE per closed
 * attempt is the whole of the SRS-02 fix; writing a second builder here would be
 * CLAUDE.md mode 2 all over again.
 *
 * PURE and CLOCK-FREE: every function that needs the time takes `now` as an
 * argument. Nothing here reads Date.now(), and nothing here mutates its inputs —
 * `progressEntry` and `srsCard` are read-only.
 *
 * Part of the engine that was one 3,458-line srs.js until REFACTOR_PLAN.md WI-10.
 * Loading: same UMD shape as every other part — `module.exports` under Node,
 * `window.__PSAT_ENGINE_PARTS.attempt` in the browser. There is no build step, so
 * the pages load the parts as ordinary <script> tags in dependency order before
 * srs.js. Dependencies: none.
 */
(function (root, factory) {
  var DEPS = [];
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory.apply(null, DEPS.map(function (d) { return require('./' + d + '.js'); }));
  } else {
    var parts = root.__PSAT_ENGINE_PARTS = root.__PSAT_ENGINE_PARTS || {};
    parts.attempt = factory.apply(null, DEPS.map(function (d) {
      if (!parts[d]) {
        throw new Error(
          'js/engine/attempt.js requires js/engine/' + d + '.js, which has not loaded yet. ' +
          'Load the engine parts in this order before srs.js: grading, scheduler, scoring, storage, examgen, sync.'
        );
      }
      return parts[d];
    }));
  }
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Version stamped onto every emitted attempt event. Milestone 3 will ingest these
   * events durably; a version on the record is what lets that migration read old ones.
   */
  var ATTEMPT_SCHEMA_VERSION = 1;

  /**
   * How the student arrived at this question. The mode is what the UI branches on
   * instead of the lifetime `answered` flag.
   *
   *   FIRST_SEEN  — never answered before; nothing prior exists to show.
   *   SRS_REVIEW  — answered before AND the card is due (or the due filter brought
   *                 them here): a genuine new attempt, prior answer must be hidden.
   *   PRACTICE    — answered before, card not due: the student is looking back at
   *                 their own work, so the prior answer and rationale stay visible.
   */
  var ATTEMPT_MODES = {
    PRACTICE: 'practice',
    SRS_REVIEW: 'srs_review',
    FIRST_SEEN: 'first_seen'
  };

  /**
   * OPEN   — accepting exactly one response.
   * GRADED — a response was recorded; this attempt can never record another.
   */
  var ATTEMPT_STATUS = {
    OPEN: 'open',
    GRADED: 'graded'
  };

  var VALID_MODES = [ATTEMPT_MODES.PRACTICE, ATTEMPT_MODES.SRS_REVIEW, ATTEMPT_MODES.FIRST_SEEN];

  function isFiniteNumber(n) {
    return typeof n === 'number' && isFinite(n);
  }

  /**
   * The stable, content-derived identity of one attempt.
   *
   * Deliberately the SAME shape js/engine/storage.js already derives for an
   * append-only outbox op — `att_<questionId>_<timestamp>` (outboxOpIdentity) — and
   * built from the attempt's START time, so that a re-run of the submit handler
   * produces the same id, the outbox de-duplicates it at the point of entry, and
   * the attempt id and the op id are literally the same string. Random ids would
   * make a retry look like a second answer, which is the sync-layer twin of SRS-02.
   */
  /**
   * WI-22 — the ONE timing-reliability rule.
   *
   * This predicate existed as two inline copies in js/pages/student.js: the
   * practice path (`totalRaw < 600000 && totalRaw > 500`) and the exam path.
   * Before WI-22 the exam copy read `isReliable = timeSpent > 0`, so ANY nonzero
   * duration counted as a real measurement and a 1 ms answer earned SM-2 grade 5
   * — the "phantom minutes" defect (CLAUDE.md mode 1). The two copies are the
   * mode-2 shape that let them drift in the first place, so the rule lives here
   * and both call sites use it.
   *
   * Below the floor we cannot distinguish thinking from a stray click; above the
   * ceiling the tab was almost certainly left open. Neither is a measurement, and
   * an unmeasured answer must grade 3 (Hesitant), never 5.
   *
   * @param {*} timeSpentMs elapsed foreground milliseconds, or null/undefined
   * @returns {boolean} true only when this duration is real evidence
   */
  var TIMING_FLOOR_MS = 500;
  var TIMING_CEILING_MS = 600000;

  function isTimingReliable(timeSpentMs) {
    return typeof timeSpentMs === 'number' &&
      !isNaN(timeSpentMs) &&
      timeSpentMs > TIMING_FLOOR_MS &&
      timeSpentMs < TIMING_CEILING_MS;
  }


  function deriveAttemptId(questionId, startedAt) {
    return 'att_' + questionId + '_' + startedAt;
  }

  /**
   * Opens a new attempt on one question.
   *
   * @param {{questionId:(string|number), mode:string, progressEntry:(Object|null),
   *          srsCard:(Object|null), now:number}} input
   * @returns {Object} a new open attempt; neither `progressEntry` nor `srsCard` is mutated
   * @throws {TypeError} on a missing question id, an unknown mode, or a non-numeric `now`
   *   — a bad input here would silently produce an attempt whose identity collides or
   *   whose mode re-creates SRS-01, so it fails loudly instead (CLAUDE.md mode 5).
   */
  function startAttempt(input) {
    var i = input || {};
    if (i.questionId === undefined || i.questionId === null || i.questionId === '') {
      throw new TypeError('startAttempt requires a questionId');
    }
    if (VALID_MODES.indexOf(i.mode) === -1) {
      throw new TypeError('startAttempt requires mode to be one of ' + VALID_MODES.join(', ') + ' (got ' + i.mode + ')');
    }
    if (!isFiniteNumber(i.now)) {
      throw new TypeError('startAttempt requires a numeric `now` (this module never reads the clock itself)');
    }

    var prev = i.progressEntry || {};
    var card = i.srsCard || {};

    // Everything below is a MEASUREMENT read off stored state, or null. No defaults
    // are invented for absent data (CLAUDE.md mode 1).
    return {
      schemaVersion: ATTEMPT_SCHEMA_VERSION,
      attemptId: deriveAttemptId(i.questionId, i.now),
      questionId: i.questionId,
      mode: i.mode,
      status: ATTEMPT_STATUS.OPEN,
      startedAt: i.now,
      gradedAt: null,
      // Read-only snapshot of what existed BEFORE this attempt, for the UI and for
      // asserting exact counter deltas afterwards.
      priorAnswered: prev.answered === true,
      priorTimesSeen: isFiniteNumber(prev.timesSeen) ? prev.timesSeen : null,
      priorSelectedAnswer: (prev.answered === true && prev.selectedAnswer !== undefined) ? prev.selectedAnswer : null,
      priorTotalReviews: isFiniteNumber(card.totalReviews) ? card.totalReviews : null,
      priorDueAt: isFiniteNumber(card.dueAt) ? card.dueAt : null
    };
  }

  /**
   * Should the page hide the previously stored answer, rationale and feedback banner,
   * and wire up live controls instead?
   *
   * This is the SRS-01 fix: `loadQuestion` must branch on THIS, not on the lifetime
   * `progress[q.id].answered`. An open SRS review hides the prior answer even though
   * the question was answered before — that prior answer is history, not this
   * attempt's result, and it stays untouched in storage either way.
   *
   * False for a graded attempt, so revisiting a question the student just finished
   * still shows the result (Milestone 2: "revisiting a completed attempt should
   * display its result without recording another attempt"), and false in practice
   * mode, where looking back at your own past work is the point.
   */
  function shouldHidePriorAnswer(attempt) {
    if (!attempt || typeof attempt !== 'object') return false;
    if (attempt.status !== ATTEMPT_STATUS.OPEN) return false;
    return attempt.mode === ATTEMPT_MODES.SRS_REVIEW;
  }

  /**
   * The ONE submission guard. Both the multiple-choice path and the free-response
   * path call this and nothing else — SRS-02 happened because the two paths each
   * had their own idea of when a submit was allowed (CLAUDE.md mode 2: one rule,
   * one implementation).
   *
   * @returns {{allowed:boolean, reason:string}} `reason` is plain English and
   *   distinct per refusal so the caller can show it to the student verbatim.
   *   It is '' when the submission is allowed.
   */
  function canSubmitAttempt(attempt, now) {
    if (!attempt || typeof attempt !== 'object') {
      return {
        allowed: false,
        reason: 'No attempt is open for this question. Reload the question before answering.'
      };
    }
    if (!isFiniteNumber(now)) {
      return {
        allowed: false,
        reason: 'This answer cannot be recorded without a real timestamp for the submission.'
      };
    }
    if (attempt.status === ATTEMPT_STATUS.GRADED) {
      return {
        allowed: false,
        reason: 'This attempt has already been graded and recorded once. Move to the next question or start a new review to answer again.'
      };
    }
    if (attempt.status !== ATTEMPT_STATUS.OPEN) {
      return {
        allowed: false,
        reason: 'This attempt is in an unrecognised state (' + attempt.status + ') and cannot accept an answer.'
      };
    }
    if (!isFiniteNumber(attempt.startedAt)) {
      return {
        allowed: false,
        reason: 'This attempt has no recorded start time, so its answer cannot be graded.'
      };
    }
    return { allowed: true, reason: '' };
  }

  /**
   * Grades and closes an attempt.
   *
   * Returns a NEW closed attempt (the input is not mutated) plus the immutable
   * `event`: the complete record of this one attempt, and the only thing the caller
   * needs to write progress, schedule the card and enqueue the outbox op.
   *
   * Missing or unreliable timing is recorded as `timeSpentMs: null` with
   * `timingReliable: false` — never a substituted default. Inventing 30 s / 60 s
   * timing defaults is a defect this project shipped twice, and it silently earned
   * the BEST SM-2 grade; PSAT_ENGINE.gradeAttempt turns null timing into the
   * conservative grade 3 (CLAUDE.md mode 1).
   *
   * @param {Object} attempt an OPEN attempt from startAttempt
   * @param {{selectedAnswer:*, isCorrect:boolean, timeSpentMs:(number|null),
   *          timingReliable:boolean}} outcome
   * @param {number} now the grading timestamp
   * @returns {{attempt:Object, event:Object}}
   * @throws {Error} if the attempt cannot accept a submission. Throwing rather than
   *   returning a null event is deliberate: a returned flag nobody checks is how this
   *   project has shipped silent data loss before (CLAUDE.md mode 5). Callers guard
   *   with canSubmitAttempt() first.
   */
  function closeAttempt(attempt, outcome, now) {
    var gate = canSubmitAttempt(attempt, now);
    if (!gate.allowed) {
      throw new Error('closeAttempt refused: ' + gate.reason);
    }

    var o = outcome || {};
    var reliable = (o.timingReliable === true) && isFiniteNumber(o.timeSpentMs) && o.timeSpentMs > 0;
    var timeSpentMs = reliable ? o.timeSpentMs : null;

    var event = {
      schemaVersion: ATTEMPT_SCHEMA_VERSION,
      attemptId: attempt.attemptId,
      questionId: attempt.questionId,
      mode: attempt.mode,
      selectedAnswer: (o.selectedAnswer === undefined) ? null : o.selectedAnswer,
      isCorrect: o.isCorrect === true,
      timeSpentMs: timeSpentMs,
      timingReliable: reliable,
      startedAt: attempt.startedAt,
      gradedAt: now
    };
    if (typeof Object.freeze === 'function') Object.freeze(event);

    var closed = {};
    Object.keys(attempt).forEach(function (k) { closed[k] = attempt[k]; });
    closed.status = ATTEMPT_STATUS.GRADED;
    closed.gradedAt = now;

    return { attempt: closed, event: event };
  }

  /**
   * Maps a closed attempt's event onto the argument object that
   * PSAT_ENGINE.buildProgressEntry (js/engine/storage.js) already expects.
   *
   * It exists so the page never hand-assembles that object at two call sites and
   * never slides an argument one position along the way (CLAUDE.md mode 6 — the
   * round-4 fix that landed `timingReliable` in the `dateStr` slot). It builds NO
   * progress entry itself: the caller passes the result straight to
   * buildProgressEntry, exactly once per event.
   */
  function toProgressAttemptInput(event, source) {
    var e = event || {};
    return {
      attemptId: e.attemptId,
      selectedAnswer: e.selectedAnswer,
      isCorrect: e.isCorrect === true,
      timeSpentMs: isFiniteNumber(e.timeSpentMs) ? e.timeSpentMs : null,
      timingReliable: e.timingReliable === true,
      at: e.gradedAt,
      source: source || 'practice'
    };
  }

  /**
   * Maps a closed attempt's event onto the outbox payload for a 'question_attempt' op.
   *
   * `timestamp` is the attempt's START time on purpose: storage.js derives the op id
   * as 'att_' + questionId + '_' + timestamp, so this makes the op id and the
   * attemptId the same string, and a replayed submit de-duplicates instead of
   * counting twice.
   */
  function toOutboxPayload(event) {
    var e = event || {};
    return {
      questionId: e.questionId,
      selectedAnswer: e.selectedAnswer,
      isCorrect: e.isCorrect === true,
      timeSpentMs: isFiniteNumber(e.timeSpentMs) ? e.timeSpentMs : null,
      timestamp: e.startedAt,
      attemptId: e.attemptId,
      mode: e.mode,
      schemaVersion: isFiniteNumber(e.schemaVersion) ? e.schemaVersion : ATTEMPT_SCHEMA_VERSION
    };
  }

  /**
   * Decides the mode from real stored state. Precedence, most specific first:
   *
   *   1. Never answered (no progress entry, or an entry whose `answered` is not true —
   *      flagging a question creates `{answered:false, isFlagged:true}` in the real
   *      page, so an entry alone does not mean an answer) -> FIRST_SEEN. This wins
   *      even under the due filter: a question the student has never answered is not
   *      a review of anything.
   *   2. Answered before AND (the due filter brought them here, OR the card's dueAt
   *      has passed at `now`) -> SRS_REVIEW.
   *   3. Otherwise -> PRACTICE.
   *
   * @param {Object|null} progressEntry the stored lifetime entry, read-only
   * @param {Object|null} srsCard the stored SM-2 card, read-only
   * @param {string|null} filterStatus the practice filter in effect ('due', 'all', …)
   * @param {number} now
   * @throws {TypeError} when `now` is not a number — guessing here would silently
   *   classify an overdue review as practice and re-create SRS-01.
   */
  function resolveAttemptMode(progressEntry, srsCard, filterStatus, now) {
    if (!isFiniteNumber(now)) {
      throw new TypeError('resolveAttemptMode requires a numeric `now` (this module never reads the clock itself)');
    }
    var prev = progressEntry || {};
    if (prev.answered !== true) return ATTEMPT_MODES.FIRST_SEEN;

    var card = srsCard || {};
    var cardIsDue = isFiniteNumber(card.dueAt) && card.dueAt <= now;
    if (filterStatus === 'due' || cardIsDue) return ATTEMPT_MODES.SRS_REVIEW;

    return ATTEMPT_MODES.PRACTICE;
  }

  return {
    ATTEMPT_SCHEMA_VERSION: ATTEMPT_SCHEMA_VERSION,
    TIMING_FLOOR_MS: TIMING_FLOOR_MS,
    TIMING_CEILING_MS: TIMING_CEILING_MS,
    isTimingReliable: isTimingReliable,
    ATTEMPT_MODES: ATTEMPT_MODES,
    ATTEMPT_STATUS: ATTEMPT_STATUS,
    deriveAttemptId: deriveAttemptId,
    startAttempt: startAttempt,
    shouldHidePriorAnswer: shouldHidePriorAnswer,
    canSubmitAttempt: canSubmitAttempt,
    closeAttempt: closeAttempt,
    toProgressAttemptInput: toProgressAttemptInput,
    toOutboxPayload: toOutboxPayload,
    resolveAttemptMode: resolveAttemptMode
  };
});
