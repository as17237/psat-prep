/**
 * js/engine/exam_state.js — the exam lifecycle's decisions, as pure functions.
 *
 * WI-22 / Milestone 1 of docs/PRODUCT_REVIEW_AND_IMPLEMENTATION_PLAN.md. Four
 * lifecycle defects were reproduced in a real browser (EX-01..EX-04); each one
 * exists because a decision that should be data lives inside a DOM handler:
 *
 *   EX-01  a passed module deadline made checkActiveExamResume() call
 *          clearActiveExamState() — the student's saved answers were DELETED.
 *   EX-02  a failed psat_exam_history write still rendered the report and then
 *          cleared the active snapshot: no recoverable copy of the report existed.
 *   EX-03  resumeActiveExamState() never recomputed the remaining seconds (the
 *          timer read 00:00) and never set examModuleExpired, so after expiry the
 *          review screen still accepted new answers.
 *   EX-04  the break counted interval ticks instead of persisting a wall-clock
 *          deadline, and nothing recorded which modules were already submitted, so
 *          a reload during the break reopened a submitted module as editable.
 *
 * The rules this module enforces, and why they are rules:
 *
 *   1. NOTHING HERE DELETES ANYTHING. No function returns "discard the state".
 *      Expiry produces a snapshot whose module is LOCKED with every answer intact
 *      and a stated continuation path (CLAUDE.md mode 7).
 *   2. ONE deadline computation: computeRemainingSeconds() is the only place
 *      remaining time is derived, and both the live tick and the resume path use
 *      it (CLAUDE.md mode 2 — a rule applied in one place but not its twin).
 *   3. Clock-free. Every decision function takes `now` as an explicit parameter;
 *      no Date.now() is called inside one. This is the repo's established pattern
 *      (calculateStreak(map, todayKey)) and it is what makes the tests real
 *      rather than monkeypatched (CLAUDE.md mode 4).
 *   4. Lean snapshots: question IDs only, never question objects, option text or
 *      rationales. This repo has shipped 193 KB and 209 KB localStorage records
 *      twice (CLAUDE.md mode 6); tests/test_exam_state.js measures the real byte
 *      size of a 98-question snapshot and asserts it stays under 20 KB.
 *   5. Missing data is null plus a stated warning, never an invented default
 *      (CLAUDE.md mode 1). Unknown provenance (blueprintVersion / isHighYield)
 *      stays null and is reported as unknown.
 *
 * Loading: the same UMD shape as every other engine part — `module.exports`
 * under Node, `window.__PSAT_ENGINE_PARTS.exam_state` in the browser. This part
 * has NO dependencies on other engine parts, so it may be loaded at any point in
 * the script order.
 */
(function (root, factory) {
  var DEPS = [];
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory.apply(null, DEPS.map(function (d) { return require('./' + d + '.js'); }));
  } else {
    var parts = root.__PSAT_ENGINE_PARTS = root.__PSAT_ENGINE_PARTS || {};
    parts.exam_state = factory.apply(null, DEPS.map(function (d) {
      if (!parts[d]) {
        throw new Error(
          'js/engine/exam_state.js requires js/engine/' + d + '.js, which has not loaded yet.'
        );
      }
      return parts[d];
    }));
  }
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * The version this build writes. The shape shipped before WI-22 carried no
   * version field at all; absence of `schemaVersion` therefore MEANS 1, exactly
   * as absence of psat_schema_meta means schemaVersion 1 in js/engine/storage.js.
   */
  var EXAM_STATE_SCHEMA_VERSION = 2;

  /** The four phases an in-progress exam can be persisted in. */
  var EXAM_PHASES = {
    MODULE: 'module',
    REVIEW: 'review',
    BREAK: 'break',
    // WI-35: an explicit student-initiated pause. Distinct from BREAK, which is the
    // scheduled between-section break the exam format mandates and whose length the
    // app controls. A pause has no deadline at all — it ends only when the student
    // says so — so the two cannot share a representation.
    PAUSED: 'paused',
    COMPLETED_PENDING_SAVE: 'completed_pending_save'
  };

  var PHASE_LIST = [
    EXAM_PHASES.PAUSED,
    EXAM_PHASES.MODULE,
    EXAM_PHASES.REVIEW,
    EXAM_PHASES.BREAK,
    EXAM_PHASES.COMPLETED_PENDING_SAVE
  ];

  // ---------------------------------------------------------------------------
  // small helpers (private)
  // ---------------------------------------------------------------------------

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** A shallow copy of a plain map, or {} — never a reference to the caller's object. */
  function copyMap(v) {
    var out = {};
    if (!isPlainObject(v)) return out;
    Object.keys(v).forEach(function (k) { out[k] = v[k]; });
    return out;
  }

  /** Normalises a module-index list: integers only, de-duplicated, ascending. */
  function normalizeIndexList(list) {
    var seen = {};
    var out = [];
    if (!Array.isArray(list)) return out;
    list.forEach(function (n) {
      var i = typeof n === 'string' ? parseInt(n, 10) : n;
      if (!isFiniteNumber(i)) return;
      i = Math.floor(i);
      if (i < 0) return;
      if (seen[i]) return;
      seen[i] = true;
      out.push(i);
    });
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  function normalizePhase(phase) {
    if (typeof phase === 'string' && PHASE_LIST.indexOf(phase) !== -1) return phase;
    if (phase === undefined || phase === null || phase === '') {
      // The pre-v2 shape had no phase field and could only ever be persisted from
      // inside a module, so absence is a measurement of that shape, not a guess.
      return EXAM_PHASES.MODULE;
    }
    // A phase string we do not recognise is a programming error. Report it
    // (CLAUDE.md mode 5 — a catch/fallback must recover OR report) and fall back
    // to the most restrictive-but-usable phase.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('exam_state: unrecognised exam phase "' + phase + '"; treating it as "' + EXAM_PHASES.MODULE + '".');
    }
    return EXAM_PHASES.MODULE;
  }

  /** IDs for one module, whether the caller passed rehydrated questions or IDs. */
  function moduleQuestionIds(m) {
    if (!m) return [];
    if (Array.isArray(m.questionIds)) {
      return m.questionIds.filter(function (id) { return id !== undefined && id !== null; });
    }
    if (Array.isArray(m.questions)) {
      return m.questions
        .map(function (q) { return q && q.id !== undefined ? q.id : null; })
        .filter(function (id) { return id !== null; });
    }
    return [];
  }

  /**
   * The lean form of one module. STRICTLY whitelisted: anything not named here
   * (question text, options, rationales, images) never reaches localStorage.
   */
  function leanModule(m) {
    var ids = moduleQuestionIds(m);
    return {
      id: m && m.id !== undefined ? m.id : null,
      section: m && m.section !== undefined ? m.section : null,
      moduleNumber: m && isFiniteNumber(m.moduleNumber) ? m.moduleNumber : null,
      name: m && m.name !== undefined ? m.name : null,
      track: m && m.track ? m.track : null,
      questionsCount: isFiniteNumber(m && m.questionsCount) ? m.questionsCount : ids.length,
      timeLimitSeconds: isFiniteNumber(m && m.timeLimitSeconds) ? m.timeLimitSeconds : null,
      questionIds: ids
    };
  }

  /** Adaptive pools, reduced to ID lists. Returns null when there are none. */
  function leanPools(pools) {
    if (!isPlainObject(pools)) return null;
    var out = {};
    var any = false;
    Object.keys(pools).forEach(function (key) {
      var arr = pools[key];
      if (!Array.isArray(arr)) return;
      any = true;
      out[key] = arr.map(function (q) {
        if (q && typeof q === 'object') return q.id !== undefined ? q.id : null;
        return q;
      }).filter(function (id) { return id !== undefined && id !== null; });
    });
    return any ? out : null;
  }

  // ---------------------------------------------------------------------------
  // 1. Building the snapshot
  // ---------------------------------------------------------------------------

  /**
   * Builds the lean, versioned in-progress snapshot that goes into
   * `psat_active_exam_state`.
   *
   * @param {Object} input
   *   input.exam                 the live exam object (modules may hold full questions)
   *   input.phase                one of EXAM_PHASES; absent means 'module'
   *   input.currentModuleIndex   integer
   *   input.currentQuestionIndex integer
   *   input.moduleDeadline       ABSOLUTE epoch ms for the current module, or null
   *   input.breakDeadline        ABSOLUTE epoch ms for a break, or null
   *   input.breakDurationSeconds the break's nominal length, or null
   *   input.submittedModules     array of already-submitted module indexes
   *   input.submittedAt          map of moduleIndex -> epoch ms of submission
   *   input.answers/times/markedForReview  the student's work (copied, not referenced)
   *   input.viewMode             'card' | 'text'
   *   input.blueprintVersion     provenance; null when the caller does not know it
   *   input.isHighYield          provenance; null when the caller does not know it
   *   input.pendingCompletion    set only by buildPendingCompletion()
   *   input.now                  epoch ms; becomes savedAt. Absent -> savedAt null.
   * @returns {Object} a new snapshot. Nothing passed in is mutated.
   */
  function buildExamSnapshot(input) {
    var i = input || {};
    var exam = i.exam || {};
    var modules = Array.isArray(exam.modules) ? exam.modules : [];

    return {
      schemaVersion: EXAM_STATE_SCHEMA_VERSION,
      examMeta: {
        id: exam.id !== undefined ? exam.id : null,
        title: exam.title !== undefined ? exam.title : null,
        type: exam.type !== undefined ? exam.type : null,
        isAdaptive: exam.isAdaptive === true,
        routingTracks: isPlainObject(exam.routingTracks) ? copyMap(exam.routingTracks) : null,
        adaptivePools: leanPools(exam.adaptivePools),
        totalQuestions: isFiniteNumber(exam.totalQuestions) ? exam.totalQuestions : null,
        totalTimeMinutes: isFiniteNumber(exam.totalTimeMinutes) ? exam.totalTimeMinutes : null,
        breakMinutes: isFiniteNumber(exam.breakMinutes) ? exam.breakMinutes : null,
        createdAt: isFiniteNumber(exam.createdAt) ? exam.createdAt : null,
        // Provenance. Unknown stays null — never a default (CLAUDE.md mode 1).
        blueprintVersion: (i.blueprintVersion !== undefined && i.blueprintVersion !== null)
          ? i.blueprintVersion
          : ((exam.blueprintVersion !== undefined && exam.blueprintVersion !== null) ? exam.blueprintVersion : null),
        isHighYield: (typeof i.isHighYield === 'boolean')
          ? i.isHighYield
          : (typeof exam.isHighYield === 'boolean' ? exam.isHighYield : null),
        modules: modules.map(leanModule)
      },
      phase: normalizePhase(i.phase),
      currentModuleIndex: isFiniteNumber(i.currentModuleIndex) ? Math.floor(i.currentModuleIndex) : 0,
      currentQuestionIndex: isFiniteNumber(i.currentQuestionIndex) ? Math.floor(i.currentQuestionIndex) : 0,
      moduleDeadline: isFiniteNumber(i.moduleDeadline) ? i.moduleDeadline : null,
      breakDeadline: isFiniteNumber(i.breakDeadline) ? i.breakDeadline : null,
      breakDurationSeconds: isFiniteNumber(i.breakDurationSeconds) ? i.breakDurationSeconds : null,
      submittedModules: normalizeIndexList(i.submittedModules),
      submittedAt: copyMap(i.submittedAt),
      submittedModulesInferred: i.submittedModulesInferred === true,
      answers: copyMap(i.answers),
      times: copyMap(i.times),
      markedForReview: copyMap(i.markedForReview),
      viewMode: (i.viewMode === 'text' || i.viewMode === 'card') ? i.viewMode : 'card',
      pendingCompletion: i.pendingCompletion || null,
      savedAt: isFiniteNumber(i.now) ? i.now : null
    };
  }

  // ---------------------------------------------------------------------------
  // 2. The ONE deadline computation
  // ---------------------------------------------------------------------------

  /**
   * Whole seconds remaining until an ABSOLUTE deadline. The only place in the app
   * where remaining time is derived — the live tick, the resume path, the break
   * and the answer guard all call this one function.
   *
   * Ceil, not round: the result is 0 if and only if `now` has reached or passed
   * the deadline, so "remaining === 0" and "expired" are the same statement.
   * (Rounding would report 0 with 400 ms still on the clock.)
   *
   * A missing or non-numeric deadline returns 0 and is NOT silently normal: every
   * caller that resumes reports it in `warnings` instead of inventing a duration
   * (CLAUDE.md mode 1).
   */
  function computeRemainingSeconds(deadline, now) {
    if (!isFiniteNumber(deadline) || !isFiniteNumber(now)) return 0;
    var ms = deadline - now;
    if (ms <= 0) return 0;
    return Math.ceil(ms / 1000);
  }

  /** True only when a valid deadline exists and `now` has reached it. */
  function isDeadlinePassed(deadline, now) {
    if (!isFiniteNumber(deadline) || !isFiniteNumber(now)) return false;
    return now >= deadline;
  }

  // ---------------------------------------------------------------------------
  // 3. Locks and the answer guard
  // ---------------------------------------------------------------------------

  /**
   * Is this module closed to further edits?
   *
   * Locked when: it was submitted; or it is behind the current module (a module
   * you have moved past is never reopened — EX-04); or it is the current module
   * and its deadline has passed / it has been flagged expired (EX-03).
   */
  function isModuleLocked(state, moduleIndex, now) {
    if (!state || !isFiniteNumber(moduleIndex)) return false;
    var idx = Math.floor(moduleIndex);
    var submitted = normalizeIndexList(state.submittedModules);
    if (submitted.indexOf(idx) !== -1) return true;
    var current = isFiniteNumber(state.currentModuleIndex) ? Math.floor(state.currentModuleIndex) : 0;
    if (idx < current) return true;
    if (idx > current) return false;
    if (state.moduleExpired === true) return true;
    // `now` is optional: a resume state records the instant its expiry was
    // evaluated (`expiryCheckedAt`), so a caller with no clock in hand still gets
    // the same answer resumeExamSnapshot() gave.
    var at = isFiniteNumber(now) ? now : state.expiryCheckedAt;
    return isDeadlinePassed(state.moduleDeadline, at);
  }

  /**
   * The guard every answer-writing handler calls before recording an answer,
   * a grid-in value or a mark-for-review toggle.
   *
   * The `reason` strings are shown to the student, so they are plain English; the
   * `code` is the stable value to branch on.
   *
   * @returns {{allowed:boolean, reason:string, code:string}}
   */
  function canAcceptAnswer(state, moduleIndex, now) {
    if (!state) {
      return {
        allowed: false,
        code: 'no_state',
        reason: 'There is no exam in progress, so this answer cannot be recorded.'
      };
    }

    var idx = isFiniteNumber(moduleIndex) ? Math.floor(moduleIndex) : null;
    var current = isFiniteNumber(state.currentModuleIndex) ? Math.floor(state.currentModuleIndex) : 0;
    if (idx === null || idx !== current) {
      return {
        allowed: false,
        code: 'wrong_module',
        reason: 'That question belongs to a different module from the one you are working on now.'
      };
    }

    if (normalizeIndexList(state.submittedModules).indexOf(idx) !== -1) {
      return {
        allowed: false,
        code: 'submitted',
        reason: 'You already submitted this module, so its answers are locked.'
      };
    }

    var expired = state.moduleExpired === true || isDeadlinePassed(state.moduleDeadline, now);
    if (expired) {
      return {
        allowed: false,
        code: 'expired',
        reason: 'Time is up for this module. Everything you already answered is saved, but no new answers can be recorded.'
      };
    }

    var phase = normalizePhase(state.phase);
    if (phase !== EXAM_PHASES.MODULE) {
      var byPhase = {};
      byPhase[EXAM_PHASES.REVIEW] = 'You are on this module’s review screen. Open the question again before changing its answer.';
      byPhase[EXAM_PHASES.BREAK] = 'You are on a scheduled break. Answers cannot be recorded until the next module starts.';
      byPhase[EXAM_PHASES.COMPLETED_PENDING_SAVE] = 'This exam is finished and its report is waiting to be saved, so answers cannot be changed.';
      return {
        allowed: false,
        code: 'wrong_phase',
        reason: byPhase[phase]
      };
    }

    return { allowed: true, code: 'ok', reason: '' };
  }

  // ---------------------------------------------------------------------------
  // 4. Transitions — each returns a NEW snapshot and destroys nothing
  // ---------------------------------------------------------------------------

  /**
   * Records that a module has been submitted. The answers stay exactly where they
   * are; only the lock is added. A submitted module can never be reopened
   * (EX-04), and re-submitting the same index is a no-op rather than a duplicate.
   */
  function markModuleSubmitted(snapshot, moduleIndex, now) {
    var next = cloneSnapshot(snapshot);
    if (!isFiniteNumber(moduleIndex)) return next;
    var idx = Math.floor(moduleIndex);
    var submitted = normalizeIndexList(next.submittedModules);
    if (submitted.indexOf(idx) === -1) submitted.push(idx);
    submitted.sort(function (a, b) { return a - b; });
    next.submittedModules = submitted;
    next.submittedAt = copyMap(next.submittedAt);
    if (next.submittedAt[idx] === undefined) {
      next.submittedAt[idx] = isFiniteNumber(now) ? now : null;
    }
    next.savedAt = isFiniteNumber(now) ? now : next.savedAt;
    return next;
  }

  /**
   * Enters the scheduled break, storing an ABSOLUTE deadline (EX-04). A reload
   * during the break therefore resumes the break with the correct remaining time
   * instead of restarting a countdown integer.
   *
   * An invalid break length produces `breakDeadline: null` rather than an invented
   * duration; resumeExamSnapshot() then reports it in `warnings`.
   */
  function enterBreak(snapshot, breakSeconds, now) {
    var next = cloneSnapshot(snapshot);
    next.phase = EXAM_PHASES.BREAK;
    if (isFiniteNumber(breakSeconds) && breakSeconds > 0 && isFiniteNumber(now)) {
      next.breakDurationSeconds = breakSeconds;
      next.breakDeadline = now + (breakSeconds * 1000);
    } else {
      next.breakDurationSeconds = null;
      next.breakDeadline = null;
    }
    next.breakStartedAt = isFiniteNumber(now) ? now : null;
    next.savedAt = isFiniteNumber(now) ? now : next.savedAt;
    return next;
  }

  /**
   * WI-35 — pause the running module.
   *
   * The module timer is a wall-clock DEADLINE, not a countdown, so pausing cannot
   * simply stop a tick: the deadline would keep arriving. Instead we bank the seconds
   * that were left and drop the deadline entirely. resumeFromPause() then mints a NEW
   * deadline from the banked remainder, so paused wall-clock time is never charged to
   * the student.
   *
   * Every pause is recorded — count and total duration — because time away from a
   * timed test is a fact about the attempt, and a report that hides it would overstate
   * how the student performed under timed conditions (CLAUDE.md mode 1). The caller is
   * responsible for showing it.
   *
   * Refuses to pause anything but a live module: there is nothing meaningful about
   * pausing a review screen, a scheduled break, or a finished exam.
   *
   * @returns {{ok:boolean, reason:string, snapshot:Object}} snapshot is unchanged when ok is false
   */
  function pauseExam(snapshot, now) {
    var snap = snapshot || null;
    if (!snap) return { ok: false, reason: 'There is no exam to pause.', snapshot: snap };
    if (snap.phase === EXAM_PHASES.PAUSED) {
      return { ok: false, reason: 'The exam is already paused.', snapshot: snap };
    }
    if (snap.phase !== EXAM_PHASES.MODULE) {
      return { ok: false, reason: 'Only a module in progress can be paused.', snapshot: snap };
    }
    if (!isFiniteNumber(now)) {
      return { ok: false, reason: 'Cannot pause without a valid clock.', snapshot: snap };
    }

    var remaining = computeRemainingSeconds(snap.moduleDeadline, now);
    if (remaining <= 0) {
      // Pausing an already-expired module would hand back time the student no longer
      // has. Let expiry take its normal course instead.
      return { ok: false, reason: 'Time for this module has already run out.', snapshot: snap };
    }

    var next = cloneSnapshot(snap);
    next.phase = EXAM_PHASES.PAUSED;
    next.pausedAt = now;
    next.pausedRemainingSeconds = remaining;
    next.resumePhase = EXAM_PHASES.MODULE;
    // The deadline is REMOVED, not kept. A stale deadline surviving a pause is how a
    // paused exam would silently expire while the student was away.
    next.moduleDeadline = null;
    next.pauseCount = (isFiniteNumber(snap.pauseCount) ? snap.pauseCount : 0) + 1;
    next.savedAt = now;
    return { ok: true, reason: '', snapshot: next };
  }

  /**
   * WI-35 — resume a paused module, restoring exactly the banked time.
   *
   * The new deadline is `now + banked`, so however long the student was away, they get
   * back the seconds they had — no more and no less.
   */
  function resumeFromPause(snapshot, now) {
    var snap = snapshot || null;
    if (!snap) return { ok: false, reason: 'There is no exam to resume.', snapshot: snap };
    if (snap.phase !== EXAM_PHASES.PAUSED) {
      return { ok: false, reason: 'The exam is not paused.', snapshot: snap };
    }
    if (!isFiniteNumber(now)) {
      return { ok: false, reason: 'Cannot resume without a valid clock.', snapshot: snap };
    }
    var banked = isFiniteNumber(snap.pausedRemainingSeconds) ? snap.pausedRemainingSeconds : null;
    if (banked === null || banked <= 0) {
      // Never invent a duration. Without a banked remainder we cannot know how long
      // was left, and guessing would either rob the student or gift them time.
      return { ok: false, reason: 'The paused time could not be read, so the module cannot be resumed safely.', snapshot: snap };
    }

    var next = cloneSnapshot(snap);
    var pausedMs = isFiniteNumber(snap.pausedAt) ? Math.max(0, now - snap.pausedAt) : 0;
    next.phase = EXAM_PHASES.MODULE;
    next.moduleDeadline = now + (banked * 1000);
    next.totalPausedMs = (isFiniteNumber(snap.totalPausedMs) ? snap.totalPausedMs : 0) + pausedMs;
    next.pausedAt = null;
    next.pausedRemainingSeconds = null;
    next.resumePhase = null;
    next.savedAt = now;
    return { ok: true, reason: '', snapshot: next };
  }

  /**
   * EX-02. Moves the snapshot into `completed_pending_save`, CARRYING the finished
   * lean report inside the active-exam key.
   *
   * The caller writes psat_exam_history first and only clears the active key once
   * that write is confirmed; until then this snapshot is the recoverable copy of
   * the report. Nothing here writes to storage — the caller owns that — and
   * nothing here deletes the student's answers, so a failed history write leaves
   * both the report AND the raw answers behind.
   */
  function buildPendingCompletion(snapshot, leanReport, now) {
    var next = cloneSnapshot(snapshot);
    next.phase = EXAM_PHASES.COMPLETED_PENDING_SAVE;
    // Every module of a completed exam is submitted; lock them all.
    var count = (next.examMeta && Array.isArray(next.examMeta.modules)) ? next.examMeta.modules.length : 0;
    var submitted = normalizeIndexList(next.submittedModules);
    for (var k = 0; k < count; k++) {
      if (submitted.indexOf(k) === -1) submitted.push(k);
    }
    submitted.sort(function (a, b) { return a - b; });
    next.submittedModules = submitted;
    next.pendingCompletion = {
      examId: (leanReport && leanReport.examId !== undefined && leanReport.examId !== null)
        ? leanReport.examId
        : ((next.examMeta && next.examMeta.id !== undefined) ? next.examMeta.id : null),
      report: leanReport || null,
      builtAt: isFiniteNumber(now) ? now : null,
      savedToHistory: false,
      savedAt: null
    };
    next.savedAt = isFiniteNumber(now) ? now : next.savedAt;
    return next;
  }

  /**
   * Marks the pending completion as durably saved. The caller may then clear the
   * active-exam key; until it calls this, the report is still recoverable.
   */
  function markCompletionSaved(snapshot, now) {
    var next = cloneSnapshot(snapshot);
    if (!next.pendingCompletion) return next;
    next.pendingCompletion = copyMap(next.pendingCompletion);
    next.pendingCompletion.savedToHistory = true;
    next.pendingCompletion.savedAt = isFiniteNumber(now) ? now : null;
    next.savedAt = isFiniteNumber(now) ? now : next.savedAt;
    return next;
  }

  /**
   * EX-02's idempotence half: has this exam's report already reached history?
   * A retry after a failed write must not append a second copy.
   */
  function isCompletionRecorded(examHistory, examId) {
    if (!Array.isArray(examHistory)) return false;
    if (examId === undefined || examId === null || examId === '') return false;
    for (var i = 0; i < examHistory.length; i++) {
      var entry = examHistory[i];
      if (entry && entry.examId === examId) return true;
    }
    return false;
  }

  /** Deep-enough copy: the snapshot is plain JSON, so this is exact and cheap. */
  function cloneSnapshot(snapshot) {
    if (!snapshot) {
      return buildExamSnapshot({});
    }
    return JSON.parse(JSON.stringify(snapshot));
  }

  // ---------------------------------------------------------------------------
  // 5. v1 -> v2 migration
  // ---------------------------------------------------------------------------

  /**
   * Upgrades an existing (unversioned) snapshot from a real student's
   * localStorage. Lossless and additive: every answer, time and mark comes back.
   *
   * The v1 shape is:
   *   { activeExamMeta, currentModuleIndex, currentExamQIndex, examModuleDeadline,
   *     examUserAnswers, examUserTimes, examMarkedForReview, examViewMode, savedAt }
   *
   * `submittedModules` is INFERRED for v1, not measured: v1 only advanced
   * currentModuleIndex from submitCurrentExamModule(), so every module before the
   * current one had been submitted. The inference is recorded as
   * `submittedModulesInferred: true` so no reader mistakes it for a measurement
   * (CLAUDE.md mode 1). Under-locking would re-create EX-04; over-locking a module
   * the student never reached is impossible, because indexes above the current one
   * are untouched.
   *
   * Fields the v1 snapshot carried that this function does not know about are
   * preserved verbatim under `legacyFields`, so a migration can never be the thing
   * that dropped a field.
   */
  function migrateExamSnapshot(oldSnapshot, now) {
    if (!isPlainObject(oldSnapshot)) return null;
    if (oldSnapshot.schemaVersion === EXAM_STATE_SCHEMA_VERSION) {
      // Already v2: idempotent, and it must not be re-shaped.
      return cloneSnapshot(oldSnapshot);
    }

    var meta = oldSnapshot.activeExamMeta || oldSnapshot.activeExam || {};
    var modules = Array.isArray(meta.modules) ? meta.modules : [];
    var currentIdx = isFiniteNumber(oldSnapshot.currentModuleIndex)
      ? Math.floor(oldSnapshot.currentModuleIndex) : 0;

    var inferredSubmitted = [];
    for (var k = 0; k < currentIdx; k++) inferredSubmitted.push(k);

    var snapshot = buildExamSnapshot({
      exam: {
        id: meta.id,
        title: meta.title,
        type: meta.type,
        isAdaptive: meta.isAdaptive === true,
        routingTracks: meta.routingTracks,
        adaptivePools: meta.adaptivePools,
        totalQuestions: meta.totalQuestions,
        totalTimeMinutes: meta.totalTimeMinutes,
        breakMinutes: meta.breakMinutes,
        createdAt: meta.createdAt,
        modules: modules
      },
      phase: EXAM_PHASES.MODULE,
      currentModuleIndex: currentIdx,
      currentQuestionIndex: oldSnapshot.currentExamQIndex,
      moduleDeadline: oldSnapshot.examModuleDeadline,
      breakDeadline: null,
      breakDurationSeconds: null,
      submittedModules: inferredSubmitted,
      submittedAt: {},
      submittedModulesInferred: inferredSubmitted.length > 0,
      answers: oldSnapshot.examUserAnswers,
      times: oldSnapshot.examUserTimes,
      markedForReview: oldSnapshot.examMarkedForReview,
      viewMode: oldSnapshot.examViewMode,
      // v1 recorded neither. Unknown provenance stays unknown.
      blueprintVersion: null,
      isHighYield: null,
      now: now
    });

    // v1's savedAt is a real measurement of when the student last worked; keep it.
    snapshot.savedAt = isFiniteNumber(oldSnapshot.savedAt) ? oldSnapshot.savedAt : snapshot.savedAt;
    snapshot.migratedFrom = 1;
    snapshot.migratedAt = isFiniteNumber(now) ? now : null;

    var known = {
      activeExamMeta: 1, activeExam: 1, currentModuleIndex: 1, currentExamQIndex: 1,
      examModuleDeadline: 1, examUserAnswers: 1, examUserTimes: 1,
      examMarkedForReview: 1, examViewMode: 1, savedAt: 1, schemaVersion: 1
    };
    var legacy = {};
    var hasLegacy = false;
    Object.keys(oldSnapshot).forEach(function (key) {
      if (known[key]) return;
      legacy[key] = oldSnapshot[key];
      hasLegacy = true;
    });
    if (hasLegacy) snapshot.legacyFields = legacy;

    return snapshot;
  }

  // ---------------------------------------------------------------------------
  // 6. Resume
  // ---------------------------------------------------------------------------

  function buildQuestionMap(questionsById) {
    var map = {};
    if (Array.isArray(questionsById)) {
      questionsById.forEach(function (q) { if (q && q.id !== undefined) map[q.id] = q; });
      return map;
    }
    if (isPlainObject(questionsById)) return questionsById;
    return map;
  }

  /**
   * Turns a stored snapshot back into a runnable exam state.
   *
   * EX-01: this NEVER answers "throw the snapshot away". A passed deadline yields
   * `ok: true` with `moduleExpired: true`, `moduleLocked: true`, every answer
   * intact and `continuation: 'open_module_review_locked'`. `ok: false` is
   * returned only when there is literally nothing to resume (no snapshot, or a
   * snapshot with no modules) — and even then the caller is told to preserve, not
   * to clear.
   *
   * EX-03: `remainingSeconds` is recomputed here through computeRemainingSeconds,
   * and `moduleExpired` is set, so the resumed timer is correct and the review
   * screen is read-only after expiry.
   *
   * EX-04: a snapshot in the break phase resumes as a break, with the remaining
   * break time derived from the absolute `breakDeadline`; submitted modules stay
   * locked.
   *
   * Questions missing from the bank are reported (`integrity.complete === false`,
   * `continuation: 'repair_required'`) and the state still carries every answer —
   * the previous behaviour cleared the snapshot outright.
   *
   * @returns {{ok:boolean, reason:string, state:(Object|null), warnings:string[]}}
   */
  function resumeExamSnapshot(snapshot, questionsById, now) {
    var warnings = [];

    if (!isPlainObject(snapshot)) {
      return {
        ok: false,
        reason: 'no_saved_exam',
        state: null,
        warnings: ['There is no saved in-progress exam to resume.']
      };
    }

    var snap = snapshot;
    if (snap.schemaVersion !== EXAM_STATE_SCHEMA_VERSION) {
      snap = migrateExamSnapshot(snapshot, now);
      warnings.push('This saved exam was written by an older version of the app and was upgraded on load; all saved answers were carried over.');
    }

    var meta = snap.examMeta || {};
    var leanModules = Array.isArray(meta.modules) ? meta.modules : [];
    if (leanModules.length === 0) {
      return {
        ok: false,
        reason: 'no_modules_in_snapshot',
        state: null,
        warnings: warnings.concat([
          'The saved exam has no modules recorded, so it cannot be reopened. The saved answers have been left in place untouched.'
        ])
      };
    }

    var qMap = buildQuestionMap(questionsById);
    var missingQuestionIds = [];
    var rehydratedModules = leanModules.map(function (m) {
      var ids = Array.isArray(m.questionIds) ? m.questionIds : [];
      var qs = [];
      ids.forEach(function (qid) {
        var q = qMap[qid];
        if (q) qs.push(q);
        else missingQuestionIds.push(qid);
      });
      return {
        id: m.id,
        section: m.section,
        moduleNumber: m.moduleNumber,
        name: m.name,
        track: m.track,
        questionsCount: isFiniteNumber(m.questionsCount) ? m.questionsCount : ids.length,
        timeLimitSeconds: m.timeLimitSeconds,
        questionIds: ids.slice(),
        questions: qs
      };
    });

    if (missingQuestionIds.length > 0) {
      warnings.push(
        missingQuestionIds.length + ' question(s) from this saved exam are not in the question bank on this device. ' +
        'Your answers have been kept; scoring this exam would be incomplete until they load.'
      );
    }

    var pools = null;
    if (isPlainObject(meta.adaptivePools)) {
      pools = {};
      Object.keys(meta.adaptivePools).forEach(function (key) {
        var ids = Array.isArray(meta.adaptivePools[key]) ? meta.adaptivePools[key] : [];
        pools[key] = ids.map(function (qid) { return qMap[qid]; }).filter(Boolean);
      });
    }

    var phase = normalizePhase(snap.phase);
    var currentIdx = isFiniteNumber(snap.currentModuleIndex) ? Math.floor(snap.currentModuleIndex) : 0;
    if (currentIdx < 0 || currentIdx >= rehydratedModules.length) {
      warnings.push(
        'The saved module index (' + snap.currentModuleIndex + ') is outside this exam’s ' +
        rehydratedModules.length + ' modules; resuming at the last module instead. No answers were changed.'
      );
      currentIdx = Math.max(0, Math.min(rehydratedModules.length - 1, currentIdx));
    }

    // --- the ONE deadline computation, used for both the module and the break --
    var moduleDeadline = isFiniteNumber(snap.moduleDeadline) ? snap.moduleDeadline : null;
    if (moduleDeadline === null && phase !== EXAM_PHASES.BREAK && phase !== EXAM_PHASES.COMPLETED_PENDING_SAVE) {
      warnings.push('This saved exam has no recorded module deadline, so no time can be shown for it. The module is locked and your answers are kept; open the module review to submit what you have.');
    }
    var remainingSeconds = computeRemainingSeconds(moduleDeadline, now);
    // No usable deadline means we cannot prove there is time left, so the module
    // is treated as out of time (locked, answers intact) rather than given an
    // invented allowance.
    var moduleExpired = (moduleDeadline === null) ? true : isDeadlinePassed(moduleDeadline, now);

    var breakDeadline = isFiniteNumber(snap.breakDeadline) ? snap.breakDeadline : null;
    if (phase === EXAM_PHASES.BREAK && breakDeadline === null) {
      warnings.push('This saved break has no recorded end time, so it shows as finished. Start the next module when you are ready.');
    }
    var breakRemainingSeconds = computeRemainingSeconds(breakDeadline, now);

    var submittedModules = normalizeIndexList(snap.submittedModules);

    var state = {
      schemaVersion: EXAM_STATE_SCHEMA_VERSION,
      exam: {
        id: meta.id !== undefined ? meta.id : null,
        title: meta.title !== undefined ? meta.title : null,
        type: meta.type !== undefined ? meta.type : null,
        isAdaptive: meta.isAdaptive === true,
        routingTracks: meta.routingTracks || null,
        adaptivePools: pools,
        totalQuestions: isFiniteNumber(meta.totalQuestions) ? meta.totalQuestions : null,
        totalTimeMinutes: isFiniteNumber(meta.totalTimeMinutes) ? meta.totalTimeMinutes : null,
        breakMinutes: isFiniteNumber(meta.breakMinutes) ? meta.breakMinutes : null,
        createdAt: isFiniteNumber(meta.createdAt) ? meta.createdAt : null,
        modules: rehydratedModules
      },
      phase: phase,
      currentModuleIndex: currentIdx,
      currentQuestionIndex: isFiniteNumber(snap.currentQuestionIndex) ? Math.floor(snap.currentQuestionIndex) : 0,
      answers: copyMap(snap.answers),
      times: copyMap(snap.times),
      markedForReview: copyMap(snap.markedForReview),
      viewMode: (snap.viewMode === 'text') ? 'text' : 'card',
      moduleDeadline: moduleDeadline,
      remainingSeconds: remainingSeconds,
      moduleExpired: moduleExpired,
      breakDeadline: breakDeadline,
      breakDurationSeconds: isFiniteNumber(snap.breakDurationSeconds) ? snap.breakDurationSeconds : null,
      breakRemainingSeconds: breakRemainingSeconds,
      submittedModules: submittedModules,
      submittedAt: copyMap(snap.submittedAt),
      submittedModulesInferred: snap.submittedModulesInferred === true,
      // Provenance: reported, never invented.
      provenance: {
        blueprintVersion: (meta.blueprintVersion === undefined) ? null : meta.blueprintVersion,
        isHighYield: (typeof meta.isHighYield === 'boolean') ? meta.isHighYield : null,
        known: (meta.blueprintVersion !== undefined && meta.blueprintVersion !== null)
          || (typeof meta.isHighYield === 'boolean')
      },
      integrity: {
        complete: missingQuestionIds.length === 0,
        missingQuestionIds: missingQuestionIds
      },
      pendingCompletion: snap.pendingCompletion || null,
      savedAt: isFiniteNumber(snap.savedAt) ? snap.savedAt : null,
      // `expiryCheckedAt` is the `now` this state's expiry was evaluated at, so
      // isModuleLocked() can re-derive the same answer without a clock of its own.
      expiryCheckedAt: isFiniteNumber(now) ? now : null
    };

    state.moduleLocked = isModuleLocked(state, currentIdx);

    var continuation;
    if (missingQuestionIds.length > 0) {
      continuation = 'repair_required';
    } else if (phase === EXAM_PHASES.COMPLETED_PENDING_SAVE) {
      continuation = 'save_pending_report';
    } else if (phase === EXAM_PHASES.BREAK) {
      continuation = breakRemainingSeconds > 0 ? 'resume_break' : 'start_next_module';
    } else if (state.moduleLocked) {
      continuation = 'open_module_review_locked';
    } else if (phase === EXAM_PHASES.REVIEW) {
      continuation = 'open_module_review';
    } else {
      continuation = 'resume_module';
    }
    state.continuation = continuation;

    return { ok: true, reason: 'resumed', state: state, warnings: warnings };
  }

  return {
    EXAM_STATE_SCHEMA_VERSION: EXAM_STATE_SCHEMA_VERSION,
    EXAM_PHASES: EXAM_PHASES,
    buildExamSnapshot: buildExamSnapshot,
    resumeExamSnapshot: resumeExamSnapshot,
    computeRemainingSeconds: computeRemainingSeconds,
    canAcceptAnswer: canAcceptAnswer,
    isModuleLocked: isModuleLocked,
    markModuleSubmitted: markModuleSubmitted,
    enterBreak: enterBreak,
    pauseExam: pauseExam,
    resumeFromPause: resumeFromPause,
    buildPendingCompletion: buildPendingCompletion,
    markCompletionSaved: markCompletionSaved,
    isCompletionRecorded: isCompletionRecorded,
    migrateExamSnapshot: migrateExamSnapshot,
    // Part-level helper, exported because the live timer tick and the resume path
    // must agree on "has the deadline passed".
    isDeadlinePassed: isDeadlinePassed
  };
});
