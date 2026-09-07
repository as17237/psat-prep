/**
 * js/engine/test_planner.js — Milestone 4A: the pure planner behind the parent's
 * "Build a focused test" builder (topic + arbitrary count + available minutes).
 *
 * WHAT THIS IS
 * ------------
 * ONE function, `planTest`, answers the preview question and the launch question.
 * `docs/PRODUCT_REVIEW_AND_IMPLEMENTATION_PLAN.md` (Milestone 4A) recorded that
 * today's parent preview is computed by `updateGapTestCalculations` while the real
 * set comes out of `generateCustomTest`, so the two disagree. Preview and launch
 * MUST be the same call here; the UI renders `planTest(...)` and the runner starts
 * `plan.questionIds` in the frozen order. Nothing else may size a focused test.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not build a runnable test object. Assembling `{id, title, questions, …}`
 * is `examgen.generateCustomTest`'s job and stays there (CLAUDE.md mode 2 — two
 * functions doing one job IS the bug). This module hands the caller a frozen,
 * de-duplicated, ordered id list plus the sizing/timing rationale.
 *
 * Documented defects in the existing custom path that this planner exists to stop
 * (all three were reproduced against the real bank during the September 6 review):
 *   • `count` silently clamped by `Math.min(filtered.length, …)` — a short pool
 *     quietly shrank the test. Here a shortage is an explicit result that the
 *     parent must accept; the plan never silently shrinks.
 *   • `timeLimitMinutes` set a timer but never sized the workload — 10 minutes
 *     returned 20 questions. Here time mode RECOMMENDS a count that fits.
 *   • an emptied filter reverted to the previous pool — `questionType:'spr'` on
 *     Reading and Writing returned ten questions and zero SPR. Here eligibility is
 *     strict and never relaxed; an empty pool is `status:'no_match'` with a filter
 *     trace naming the step that emptied it.
 *
 * TIME ESTIMATES ARE THE MODE-1 DANGER ZONE (CLAUDE.md failure mode 1)
 * -------------------------------------------------------------------
 * Every per-question estimate carries `basis` and `measured:boolean`.
 *   • `measured:true`  — the median of the student's OWN reliable, independent
 *     first attempts, and only where the sample meets the minimum in
 *     PLANNER_ASSUMPTIONS. Unreliable timing (`timingReliable !== true`),
 *     implausible durations (inactive-tab inflation), and repeat attempts on an
 *     already-answered question (the answer may be known) are excluded.
 *   • `measured:false` — an explicitly LABELLED planning assumption. Its default
 *     per-subject pacing is derived from the published PSAT 8/9 section structure
 *     in adaptive_config (`PSAT_89_SPECS`), not invented here, but it is still an
 *     assumption about THIS student and must never be shown as a measurement.
 * `describePlan` turns that into words a parent reads. Never print a plan's
 * seconds without its basis.
 *
 * PURITY
 * ------
 * Clock-free and randomness-injectable: `context.now` is required, and every
 * shuffle goes through an injected `context.random`, so a test reproduces a form
 * exactly (CLAUDE.md mode 4 — no monkeypatched clocks). `progressMap` / `srsMap` /
 * the bank are read-only; the plan is built from new objects.
 *
 * Ordering is NOT `examgen._prioritizeUnseen` for one reason only: that helper
 * shuffles through `Math.random` with no injection point, so preview and launch
 * could not be proven to agree and no fixture could pin a form. The unseen-first
 * POLICY below is the same one (unseen shuffled first, then seen by timesSeen then
 * oldest attempt); changing examgen to accept an rng is the better long-term fix
 * and is out of scope for this work item.
 *
 * Loading: same buildless UMD shape as the other engine parts — `module.exports`
 * under Node, `window.__PSAT_ENGINE_PARTS.test_planner` in the browser.
 * Dependencies: adaptive_config (published PSAT 8/9 pacing only).
 */
(function (root, factory) {
  var DEPS = ['adaptive_config'];
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory.apply(null, DEPS.map(function (d) { return require('./' + d + '.js'); }));
  } else {
    var parts = root.__PSAT_ENGINE_PARTS = root.__PSAT_ENGINE_PARTS || {};
    parts.test_planner = factory.apply(null, DEPS.map(function (d) {
      if (!parts[d]) {
        throw new Error(
          'js/engine/test_planner.js requires js/engine/' + d + '.js, which has not loaded yet. ' +
          'Load js/engine/adaptive_config.js before js/engine/test_planner.js.'
        );
      }
      return parts[d];
    }));
  }
})(typeof self !== 'undefined' ? self : this, function (adaptive_config) {
  'use strict';

  var PSAT_89_SPECS = adaptive_config.PSAT_89_SPECS;

  var PLANNER_SCHEMA_VERSION = 1;

  // ---------------------------------------------------------------------------
  // Vocabularies. Strict: anything not listed here is a validation error, never a
  // silently-dropped or coerced value.
  // ---------------------------------------------------------------------------
  var SIZE_MODES = { COUNT: 'count', TIME: 'time' };
  var SUBJECT_VALUES = ['Reading and Writing', 'Math'];
  var DIFFICULTY_VALUES = ['Easy', 'Medium', 'Hard'];
  var QUESTION_TYPE_VALUES = ['any', 'mcq', 'spr'];
  var SELECTION_PREFERENCES = ['unseen_first', 'unseen_only', 'mistakes', 'due_reviews', 'all'];
  var TIMING_MODES = ['timed', 'untimed'];

  var PLAN_CATEGORY = 'custom_focused_practice';

  /**
   * Published PSAT 8/9 pacing, read out of adaptive_config rather than retyped:
   * section minutes / section questions. RW 64 min / 54 q; Math 70 min / 44 q;
   * whole test 134 min / 98 q for anything that names no subject.
   * These are real published facts about the EXAM. Applied to a student they are
   * still an ASSUMPTION about that student — hence basis 'assumed_official_pacing'.
   */
  function _pacingSecondsFromSpecs() {
    var out = {};
    var sections = (PSAT_89_SPECS && PSAT_89_SPECS.sections) || {};
    Object.keys(sections).forEach(function (k) {
      var s = sections[k];
      if (s && s.name && s.totalMinutes > 0 && s.totalQuestions > 0) {
        out[s.name] = Math.round((s.totalMinutes * 60) / s.totalQuestions);
      }
    });
    return out;
  }

  var PLANNER_ASSUMPTIONS = {
    version: 'PLANNER_ASSUMPTIONS_2026_V1',
    schemaVersion: PLANNER_SCHEMA_VERSION,

    // --- Gates on MEASURED data. Below these sample sizes the student's own
    //     timing is too noisy to plan with, and we fall back to a labelled
    //     assumption rather than showing a per-question model built on 1-2 points.
    MIN_OBSERVATIONS_SKILL_DIFFICULTY: 5,
    MIN_OBSERVATIONS_SKILL: 8,
    MIN_OBSERVATIONS_SUBJECT_DIFFICULTY: 12,
    ESTIMATOR: 'median', // robust to one 20-minute tab-left-open outlier

    // --- Observation hygiene. Anything outside this band is discarded, not
    //     clamped: 2 s is a mis-click, 10 min is a walk-away with the tab open.
    MIN_PLAUSIBLE_SECONDS: 3,
    MAX_PLAUSIBLE_SECONDS: 600,

    // --- LABELLED planning assumptions (NOT measurements of this student).
    //     DEFAULT_SECONDS_BY_SUBJECT is derived from the published section
    //     structure in adaptive_config.PSAT_89_SPECS.
    DEFAULT_SECONDS_BY_SUBJECT: _pacingSecondsFromSpecs(),
    DEFAULT_SECONDS_FALLBACK: (PSAT_89_SPECS && PSAT_89_SPECS.totalTimeMinutes > 0 && PSAT_89_SPECS.totalQuestions > 0)
      ? Math.round((PSAT_89_SPECS.totalTimeMinutes * 60) / PSAT_89_SPECS.totalQuestions)
      : 90,
    // Hand-authored, UNVALIDATED. Only ever applied on top of an ASSUMED estimate;
    // a measured median already contains the student's real free-response speed.
    FREE_RESPONSE_MULTIPLIER: 1.15,
    // Hand-authored, UNVALIDATED. Untimed practice is not a timed section: the
    // plan says so in words rather than reusing one universal speed.
    UNTIMED_PRACTICE_MULTIPLIER: 1.25,

    // --- Product bounds the UI must show.
    MAX_REQUESTED_COUNT: 100,
    MAX_AVAILABLE_MINUTES: 240,
    MAX_SELECTED_VALUES: 60,

    PROVENANCE: {
      DEFAULT_SECONDS_BY_SUBJECT: 'published College Board PSAT 8/9 section structure via adaptive_config.PSAT_89_SPECS',
      FREE_RESPONSE_MULTIPLIER: 'hand-authored, unvalidated',
      UNTIMED_PRACTICE_MULTIPLIER: 'hand-authored, unvalidated',
      MIN_OBSERVATIONS_SKILL_DIFFICULTY: 'hand-authored sample-size gate, unvalidated',
      MIN_OBSERVATIONS_SKILL: 'hand-authored sample-size gate, unvalidated',
      MIN_OBSERVATIONS_SUBJECT_DIFFICULTY: 'hand-authored sample-size gate, unvalidated'
    }
  };

  // Frozen so a caller cannot silently retune a labelled constant at runtime and
  // have the UI keep calling the result a measurement.
  function _deepFreeze(o) {
    if (!o || typeof o !== 'object' || typeof Object.freeze !== 'function') return o;
    Object.keys(o).forEach(function (k) { _deepFreeze(o[k]); });
    return Object.freeze(o);
  }
  _deepFreeze(PLANNER_ASSUMPTIONS);

  // ---------------------------------------------------------------------------
  // Small pure helpers
  // ---------------------------------------------------------------------------
  function isFiniteNumber(n) { return typeof n === 'number' && isFinite(n); }
  function own(obj, key) { return !!obj && Object.prototype.hasOwnProperty.call(obj, key); }
  function get(obj, key) { return own(obj, key) ? obj[key] : undefined; }
  function bare() { return Object.create(null); }

  function median(sortedOrNot) {
    var a = sortedOrNot.slice().sort(function (x, y) { return x - y; });
    if (a.length === 0) return null;
    var mid = Math.floor(a.length / 2);
    return (a.length % 2 === 1) ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  function shuffleWith(arr, rng) {
    var copy = arr.slice();
    for (var i = copy.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      if (j < 0) j = 0;
      if (j > i) j = i;
      var t = copy[i]; copy[i] = copy[j]; copy[j] = t;
    }
    return copy;
  }

  function uniqueStrings(list) {
    var seen = bare(); var out = [];
    list.forEach(function (v) { if (!own(seen, v)) { seen[v] = true; out.push(v); } });
    return out;
  }

  // ---------------------------------------------------------------------------
  // normalizePlanRequest — strict validation, no coercion of nonsense.
  //
  // ONE normalized request drives preview, launch, share-link parsing and the
  // saved report. Idempotent: normalizing an already-normalized request returns
  // the same request (share links round-trip through it).
  // ---------------------------------------------------------------------------
  function _absent(v) { return v === undefined || v === null || v === ''; }

  function _parseCount(value, field, errors, max) {
    var n = value;
    if (typeof n === 'string') {
      if (!/^\d+$/.test(n)) {
        errors.push({ field: field, code: 'not_an_integer', message: field + ' must be a whole number; got "' + n + '".' });
        return null;
      }
      n = Number(n);
    }
    if (typeof n !== 'number') {
      errors.push({ field: field, code: 'not_a_number', message: field + ' must be a number.' });
      return null;
    }
    if (!isFinite(n)) {
      errors.push({ field: field, code: 'not_finite', message: field + ' must be a finite number (NaN and Infinity are rejected).' });
      return null;
    }
    if (Math.floor(n) !== n) {
      errors.push({ field: field, code: 'not_an_integer', message: field + ' must be a whole number; got ' + n + '.' });
      return null;
    }
    if (n <= 0) {
      errors.push({ field: field, code: 'not_positive', message: field + ' must be greater than zero; got ' + n + '.' });
      return null;
    }
    if (isFiniteNumber(max) && n > max) {
      errors.push({ field: field, code: 'above_max', message: field + ' may not exceed ' + max + '; got ' + n + '.' });
      return null;
    }
    return n;
  }

  function _parseMinutes(value, field, errors, max, allowZero) {
    var n = value;
    if (typeof n === 'string') {
      if (!/^\d+(\.\d+)?$/.test(n)) {
        errors.push({ field: field, code: 'not_a_number', message: field + ' must be a number of minutes; got "' + n + '".' });
        return null;
      }
      n = Number(n);
    }
    if (typeof n !== 'number') {
      errors.push({ field: field, code: 'not_a_number', message: field + ' must be a number of minutes.' });
      return null;
    }
    if (!isFinite(n)) {
      errors.push({ field: field, code: 'not_finite', message: field + ' must be a finite number of minutes (NaN and Infinity are rejected).' });
      return null;
    }
    if (allowZero ? (n < 0) : (n <= 0)) {
      errors.push({
        field: field,
        code: allowZero ? 'negative' : 'not_positive',
        message: field + ' must be ' + (allowZero ? 'zero or more' : 'greater than zero') + '; got ' + n + '.'
      });
      return null;
    }
    if (isFiniteNumber(max) && n > max) {
      errors.push({ field: field, code: 'above_max', message: field + ' may not exceed ' + max + ' minutes; got ' + n + '.' });
      return null;
    }
    return n;
  }

  /**
   * Free-text taxonomy list (domains / skills).
   *
   * NEVER split on commas: real bank labels contain them — "Lines, angles, and
   * triangles", "Form, Structure, and Sense", "Ratios, rates, proportional
   * relationships, and units". A share link must carry repeated parameters or a
   * structured encoding; this function takes an array and only an array.
   */
  function _parseLabels(value, field, errors, max) {
    if (_absent(value)) return [];
    if (!Array.isArray(value)) {
      errors.push({
        field: field,
        code: 'not_an_array',
        message: field + ' must be an array of labels. Do not comma-split: real skill labels contain commas.'
      });
      return [];
    }
    var out = [];
    for (var i = 0; i < value.length; i++) {
      var v = value[i];
      if (typeof v !== 'string' || v.trim() === '') {
        errors.push({ field: field, code: 'invalid_label', message: field + '[' + i + '] must be a non-empty string.' });
        return [];
      }
      out.push(v.trim());
    }
    out = uniqueStrings(out);
    if (out.length > max) {
      errors.push({ field: field, code: 'too_many', message: field + ' may not select more than ' + max + ' values.' });
      return [];
    }
    return out;
  }

  function _parseEnumList(value, field, allowed, errors) {
    var labels = _parseLabels(value, field, errors, allowed.length);
    for (var i = 0; i < labels.length; i++) {
      if (allowed.indexOf(labels[i]) === -1) {
        errors.push({
          field: field,
          code: 'unknown_value',
          message: field + ' contains an unknown value "' + labels[i] + '". Allowed: ' + allowed.join(', ') + '.'
        });
        return [];
      }
    }
    return labels;
  }

  function normalizePlanRequest(raw) {
    var r = raw || {};
    var errors = [];
    var warnings = [];

    if (!_absent(r.schemaVersion) && r.schemaVersion !== PLANNER_SCHEMA_VERSION) {
      errors.push({
        field: 'schemaVersion',
        code: 'unsupported_schema_version',
        message: 'schemaVersion ' + r.schemaVersion + ' is not supported; this planner speaks version ' + PLANNER_SCHEMA_VERSION + '.'
      });
    }

    var subjects = _parseEnumList(r.subjects, 'subjects', SUBJECT_VALUES, errors);
    var domains = _parseLabels(r.domains, 'domains', errors, PLANNER_ASSUMPTIONS.MAX_SELECTED_VALUES);
    var skills = _parseLabels(r.skills, 'skills', errors, PLANNER_ASSUMPTIONS.MAX_SELECTED_VALUES);
    var difficulties = _parseEnumList(r.difficulties, 'difficulties', DIFFICULTY_VALUES, errors);

    var questionType = null;
    if (!_absent(r.questionType)) {
      if (QUESTION_TYPE_VALUES.indexOf(r.questionType) === -1) {
        errors.push({
          field: 'questionType',
          code: 'unknown_value',
          message: 'questionType must be one of ' + QUESTION_TYPE_VALUES.join(', ') + '; got "' + r.questionType + '".'
        });
      } else if (r.questionType !== 'any') {
        questionType = r.questionType;
      }
    }

    var selectionPreference = 'unseen_first';
    if (!_absent(r.selectionPreference)) {
      if (SELECTION_PREFERENCES.indexOf(r.selectionPreference) === -1) {
        errors.push({
          field: 'selectionPreference',
          code: 'unknown_value',
          message: 'selectionPreference must be one of ' + SELECTION_PREFERENCES.join(', ') + '; got "' + r.selectionPreference + '".'
        });
      } else {
        selectionPreference = r.selectionPreference;
      }
    }

    var timingMode = 'timed';
    if (!_absent(r.timingMode)) {
      if (TIMING_MODES.indexOf(r.timingMode) === -1) {
        errors.push({
          field: 'timingMode',
          code: 'unknown_value',
          message: 'timingMode must be one of ' + TIMING_MODES.join(', ') + '; got "' + r.timingMode + '".'
        });
      } else {
        timingMode = r.timingMode;
      }
    }

    var sizeMode = null;
    if (_absent(r.sizeMode)) {
      errors.push({
        field: 'sizeMode',
        code: 'required',
        message: 'sizeMode is required and must be "' + SIZE_MODES.COUNT + '" or "' + SIZE_MODES.TIME + '". ' +
          'Count mode and time mode are never silently reinterpreted as each other.'
      });
    } else if (r.sizeMode !== SIZE_MODES.COUNT && r.sizeMode !== SIZE_MODES.TIME) {
      errors.push({
        field: 'sizeMode',
        code: 'unknown_value',
        message: 'sizeMode must be "' + SIZE_MODES.COUNT + '" or "' + SIZE_MODES.TIME + '"; got "' + r.sizeMode + '".'
      });
    } else {
      sizeMode = r.sizeMode;
    }

    var requestedCount = null;
    var availableMinutes = null;
    var reviewMinutes = 0;
    var timeLimitMinutes = null;

    if (sizeMode === SIZE_MODES.COUNT) {
      if (_absent(r.requestedCount)) {
        errors.push({ field: 'requestedCount', code: 'required', message: 'requestedCount is required in count mode.' });
      } else {
        requestedCount = _parseCount(r.requestedCount, 'requestedCount', errors, PLANNER_ASSUMPTIONS.MAX_REQUESTED_COUNT);
      }
      if (!_absent(r.availableMinutes)) {
        errors.push({
          field: 'availableMinutes',
          code: 'not_allowed_in_count_mode',
          message: 'availableMinutes belongs to time mode. In count mode set an explicit timeLimitMinutes instead; ' +
            'the planner will report a conflict rather than lowering the count.'
        });
      }
      if (!_absent(r.timeLimitMinutes)) {
        timeLimitMinutes = _parseMinutes(r.timeLimitMinutes, 'timeLimitMinutes', errors, PLANNER_ASSUMPTIONS.MAX_AVAILABLE_MINUTES, false);
      }
      if (!_absent(r.reviewMinutes)) {
        reviewMinutes = _parseMinutes(r.reviewMinutes, 'reviewMinutes', errors, PLANNER_ASSUMPTIONS.MAX_AVAILABLE_MINUTES, true);
        if (reviewMinutes === null) reviewMinutes = 0;
      }
    } else if (sizeMode === SIZE_MODES.TIME) {
      if (!_absent(r.requestedCount)) {
        errors.push({
          field: 'requestedCount',
          code: 'not_allowed_in_time_mode',
          message: 'requestedCount belongs to count mode. Time mode RECOMMENDS a count; editing the count switches the request to count mode.'
        });
      }
      if (!_absent(r.timeLimitMinutes)) {
        errors.push({
          field: 'timeLimitMinutes',
          code: 'not_allowed_in_time_mode',
          message: 'timeLimitMinutes is derived in time mode (availableMinutes minus reviewMinutes); do not set it explicitly.'
        });
      }
      if (_absent(r.availableMinutes)) {
        errors.push({ field: 'availableMinutes', code: 'required', message: 'availableMinutes is required in time mode.' });
      } else {
        availableMinutes = _parseMinutes(r.availableMinutes, 'availableMinutes', errors, PLANNER_ASSUMPTIONS.MAX_AVAILABLE_MINUTES, false);
      }
      if (!_absent(r.reviewMinutes)) {
        var rm = _parseMinutes(r.reviewMinutes, 'reviewMinutes', errors, PLANNER_ASSUMPTIONS.MAX_AVAILABLE_MINUTES, true);
        reviewMinutes = (rm === null) ? 0 : rm;
      }
      if (availableMinutes !== null && reviewMinutes !== null && reviewMinutes >= availableMinutes) {
        errors.push({
          field: 'reviewMinutes',
          code: 'review_consumes_budget',
          message: 'reviewMinutes (' + reviewMinutes + ') must be less than availableMinutes (' + availableMinutes +
            '); a review allowance may not consume the whole budget.'
        });
      }
    }

    var request = {
      schemaVersion: PLANNER_SCHEMA_VERSION,
      subjects: subjects,
      domains: domains,
      skills: skills,
      difficulties: difficulties,
      questionType: questionType,
      selectionPreference: selectionPreference,
      sizeMode: sizeMode,
      requestedCount: requestedCount,
      availableMinutes: availableMinutes,
      reviewMinutes: reviewMinutes === null ? 0 : reviewMinutes,
      timingMode: timingMode,
      timeLimitMinutes: timeLimitMinutes
    };

    return { ok: errors.length === 0, request: request, errors: errors, warnings: warnings };
  }

  // ---------------------------------------------------------------------------
  // buildTimingStats — the student's OWN reliable, independent first attempts.
  //
  // Read-only over `progressMap` (the stored `psat_progress` shape built by
  // storage.buildProgressEntry). An observation is kept only when ALL hold:
  //   • entry.answered === true
  //   • entry.timingReliable === true and entry.timeSpentMs is finite and > 0
  //     (the engine already writes null/false rather than a substituted default)
  //   • entry.timesSeen === 1 — the stored duration describes the LATEST
  //     attempt, so on a repeat it is an answer-known retry, not independent work
  //   • MIN_PLAUSIBLE_SECONDS <= seconds <= MAX_PLAUSIBLE_SECONDS — discards
  //     mis-clicks and inactive-tab inflation rather than clamping them
  //   • the id resolves to a question in the bank (we need its skill/difficulty)
  // Every rejection is counted and reported, so "we have no timing for this
  // student" is a visible number rather than an empty object.
  // ---------------------------------------------------------------------------
  function buildTimingStats(progressMap, questions, assumptions) {
    var a = assumptions || PLANNER_ASSUMPTIONS;
    var progress = progressMap || {};
    var bank = Array.isArray(questions) ? questions : [];

    var byId = bare();
    bank.forEach(function (q) { if (q && q.id != null) byId[q.id] = q; });

    var excluded = { notAnswered: 0, unreliableTiming: 0, repeatAttempt: 0, implausibleDuration: 0, unknownQuestion: 0 };
    var skillBuckets = bare();   // skill -> { all: [], byDifficulty: { d: [] } }
    var subjectBuckets = bare(); // test  -> { all: [], byDifficulty: { d: [] } }
    var observationCount = 0;

    function bucket(store, key) {
      if (!own(store, key)) store[key] = { all: [], byDifficulty: bare() };
      return store[key];
    }

    Object.keys(progress).forEach(function (id) {
      var e = progress[id];
      if (!e || typeof e !== 'object') return;
      if (e.answered !== true) { excluded.notAnswered++; return; }
      if (e.timingReliable !== true || !isFiniteNumber(e.timeSpentMs) || e.timeSpentMs <= 0) { excluded.unreliableTiming++; return; }
      var seen = e.timesSeen;
      if (seen !== 1) { excluded.repeatAttempt++; return; }
      var seconds = e.timeSpentMs / 1000;
      if (seconds < a.MIN_PLAUSIBLE_SECONDS || seconds > a.MAX_PLAUSIBLE_SECONDS) { excluded.implausibleDuration++; return; }
      var q = get(byId, id);
      if (!q) { excluded.unknownQuestion++; return; }

      observationCount++;
      var diff = q.difficulty || 'Unknown';
      if (q.skill) {
        var sb = bucket(skillBuckets, q.skill);
        sb.all.push(seconds);
        if (!own(sb.byDifficulty, diff)) sb.byDifficulty[diff] = [];
        sb.byDifficulty[diff].push(seconds);
      }
      if (q.test) {
        var tb = bucket(subjectBuckets, q.test);
        tb.all.push(seconds);
        if (!own(tb.byDifficulty, diff)) tb.byDifficulty[diff] = [];
        tb.byDifficulty[diff].push(seconds);
      }
    });

    function summarise(store) {
      var out = bare();
      Object.keys(store).forEach(function (k) {
        var b = store[k];
        var byDifficulty = bare();
        Object.keys(b.byDifficulty).forEach(function (d) {
          byDifficulty[d] = { n: b.byDifficulty[d].length, medianSeconds: median(b.byDifficulty[d]) };
        });
        out[k] = { all: { n: b.all.length, medianSeconds: median(b.all) }, byDifficulty: byDifficulty };
      });
      return out;
    }

    return {
      schemaVersion: PLANNER_SCHEMA_VERSION,
      assumptionsVersion: a.version,
      estimator: a.ESTIMATOR,
      observationCount: observationCount,
      excluded: excluded,
      bySkill: summarise(skillBuckets),
      bySubject: summarise(subjectBuckets)
    };
  }

  // ---------------------------------------------------------------------------
  // estimateQuestionSeconds — one question, one honest number, always labelled.
  //
  // Tiers, most specific first; the first tier meeting its minimum sample wins:
  //   measured_skill_difficulty -> measured_skill -> measured_subject_difficulty
  //   -> assumed_official_pacing (labelled planning assumption)
  //
  // `assumptions.modeMultiplier` (set by planTest for untimed practice) is applied
  // last and reported in `adjustment`; a measured base that has been adjusted keeps
  // `measured:true` but gains `adjusted:true`, and describePlan says so out loud.
  // ---------------------------------------------------------------------------
  function estimateQuestionSeconds(question, timingStats, assumptions) {
    var a = assumptions || PLANNER_ASSUMPTIONS;
    var q = question || {};
    var stats = timingStats || null;

    var baseSeconds = null;
    var basis = null;
    var sampleSize = 0;
    var label = '';

    var skillEntry = (stats && stats.bySkill) ? get(stats.bySkill, q.skill) : undefined;
    var subjectEntry = (stats && stats.bySubject) ? get(stats.bySubject, q.test) : undefined;
    var diff = q.difficulty || 'Unknown';

    var sd = skillEntry ? get(skillEntry.byDifficulty, diff) : undefined;
    var td = subjectEntry ? get(subjectEntry.byDifficulty, diff) : undefined;

    if (sd && sd.n >= a.MIN_OBSERVATIONS_SKILL_DIFFICULTY && isFiniteNumber(sd.medianSeconds)) {
      baseSeconds = sd.medianSeconds; basis = 'measured_skill_difficulty'; sampleSize = sd.n;
      label = 'median of ' + sd.n + " of the student's own reliable first attempts on " + q.skill + ' (' + diff + ')';
    } else if (skillEntry && skillEntry.all.n >= a.MIN_OBSERVATIONS_SKILL && isFiniteNumber(skillEntry.all.medianSeconds)) {
      baseSeconds = skillEntry.all.medianSeconds; basis = 'measured_skill'; sampleSize = skillEntry.all.n;
      label = 'median of ' + skillEntry.all.n + " of the student's own reliable first attempts on " + q.skill;
    } else if (td && td.n >= a.MIN_OBSERVATIONS_SUBJECT_DIFFICULTY && isFiniteNumber(td.medianSeconds)) {
      baseSeconds = td.medianSeconds; basis = 'measured_subject_difficulty'; sampleSize = td.n;
      label = 'median of ' + td.n + " of the student's own reliable first attempts in " + q.test + ' (' + diff + ')';
    }

    var measured = baseSeconds !== null;

    if (!measured) {
      var perSubject = get(a.DEFAULT_SECONDS_BY_SUBJECT, q.test);
      baseSeconds = isFiniteNumber(perSubject) ? perSubject : a.DEFAULT_SECONDS_FALLBACK;
      basis = 'assumed_official_pacing';
      sampleSize = 0;
      if (q.type === 'free_response') baseSeconds = baseSeconds * a.FREE_RESPONSE_MULTIPLIER;
      label = 'planning assumption (published PSAT 8/9 pacing' +
        (isFiniteNumber(perSubject) ? ' for ' + q.test : '') +
        (q.type === 'free_response' ? ', x' + a.FREE_RESPONSE_MULTIPLIER + ' for free response' : '') +
        ') — not measured student performance';
    }

    var adjustment = null;
    var multiplier = isFiniteNumber(a.modeMultiplier) ? a.modeMultiplier : 1;
    if (multiplier !== 1) {
      adjustment = {
        reason: a.modeMultiplierReason || 'mode_adjustment',
        multiplier: multiplier,
        labelled: true,
        note: 'unvalidated planning assumption applied on top of the base estimate'
      };
      baseSeconds = baseSeconds * multiplier;
    }

    return {
      questionId: q.id != null ? q.id : null,
      seconds: Math.round(baseSeconds),
      basis: basis,
      measured: measured,
      adjusted: adjustment !== null,
      adjustment: adjustment,
      sampleSize: sampleSize,
      label: label,
      assumptionsVersion: a.version
    };
  }

  function _assumptionsForMode(assumptions, timingMode) {
    var a = assumptions || PLANNER_ASSUMPTIONS;
    if (timingMode !== 'untimed') return a;
    var copy = {};
    Object.keys(a).forEach(function (k) { copy[k] = a[k]; });
    copy.modeMultiplier = a.UNTIMED_PRACTICE_MULTIPLIER;
    copy.modeMultiplierReason = 'untimed_practice';
    return copy;
  }

  // ---------------------------------------------------------------------------
  // Eligibility (STRICT, never relaxed) and ranking (reorders only).
  // ---------------------------------------------------------------------------
  function _typeOf(q) { return q && q.type ? q.type : 'multiple_choice'; }

  function _applyStrictFilters(bank, request) {
    var trace = [{ step: 'bank', remaining: bank.length }];
    var pool = bank;

    function step(name, pred, detail) {
      pool = pool.filter(pred);
      trace.push({ step: name, remaining: pool.length, detail: detail || null });
    }

    if (request.subjects.length > 0) {
      step('subjects', function (q) { return request.subjects.indexOf(q.test) !== -1; }, request.subjects.slice());
    }
    if (request.domains.length > 0) {
      step('domains', function (q) { return request.domains.indexOf(q.domain) !== -1; }, request.domains.slice());
    }
    if (request.skills.length > 0) {
      step('skills', function (q) { return request.skills.indexOf(q.skill) !== -1; }, request.skills.slice());
    }
    if (request.difficulties.length > 0) {
      step('difficulties', function (q) { return request.difficulties.indexOf(q.difficulty) !== -1; }, request.difficulties.slice());
    }
    if (request.questionType === 'mcq') {
      step('questionType', function (q) { return _typeOf(q) !== 'free_response'; }, 'mcq');
    } else if (request.questionType === 'spr') {
      step('questionType', function (q) { return _typeOf(q) === 'free_response'; }, 'spr');
    }

    return { pool: pool, trace: trace };
  }

  function _applyPreferenceNarrowing(pool, request, progressMap, srsMap, now) {
    var pref = request.selectionPreference;
    if (pref === 'unseen_only') {
      return pool.filter(function (q) {
        var p = get(progressMap, q.id);
        return !p || (!p.answered && !(p.timesSeen > 0));
      });
    }
    if (pref === 'mistakes') {
      return pool.filter(function (q) {
        var p = get(progressMap, q.id);
        if (!p) return false;
        if (isFiniteNumber(p.timesIncorrect) && p.timesIncorrect > 0) return true;
        return p.answered === true && p.isCorrect === false;
      });
    }
    if (pref === 'due_reviews') {
      return pool.filter(function (q) {
        var c = get(srsMap, q.id);
        return !!c && isFiniteNumber(c.dueAt) && c.dueAt <= now;
      });
    }
    return pool;
  }

  function _rank(pool, request, progressMap, srsMap, rng) {
    var pref = request.selectionPreference;

    if (pref === 'due_reviews') {
      return pool.slice().sort(function (x, y) {
        var cx = get(srsMap, x.id), cy = get(srsMap, y.id);
        var dx = (cx && isFiniteNumber(cx.dueAt)) ? cx.dueAt : Infinity;
        var dy = (cy && isFiniteNumber(cy.dueAt)) ? cy.dueAt : Infinity;
        if (dx !== dy) return dx - dy;
        return String(x.id) < String(y.id) ? -1 : 1;
      });
    }

    if (pref === 'mistakes') {
      return pool.slice().sort(function (x, y) {
        var px = get(progressMap, x.id) || {}, py = get(progressMap, y.id) || {};
        var ix = isFiniteNumber(px.timesIncorrect) ? px.timesIncorrect : 0;
        var iy = isFiniteNumber(py.timesIncorrect) ? py.timesIncorrect : 0;
        if (ix !== iy) return iy - ix;
        var tx = isFiniteNumber(px.timestamp) ? px.timestamp : 0;
        var ty = isFiniteNumber(py.timestamp) ? py.timestamp : 0;
        if (tx !== ty) return tx - ty;
        return String(x.id) < String(y.id) ? -1 : 1;
      });
    }

    if (pref === 'all') return shuffleWith(pool, rng);

    // 'unseen_first' and 'unseen_only' — same policy as examgen._prioritizeUnseen
    // (unseen shuffled first; then seen by fewest views, then oldest attempt),
    // but through an injected rng so preview and launch are reproducible.
    var unseen = [], seen = [];
    pool.forEach(function (q) {
      var p = get(progressMap, q.id);
      var n = p ? (isFiniteNumber(p.timesSeen) ? p.timesSeen : (p.answered ? 1 : 0)) : 0;
      if (n === 0) unseen.push(q);
      else seen.push({ q: q, n: n, at: isFiniteNumber(p.timestamp) ? p.timestamp : 0 });
    });
    seen.sort(function (a, b) { return (a.n !== b.n) ? (a.n - b.n) : (a.at - b.at); });
    return shuffleWith(unseen, rng).concat(seen.map(function (s) { return s.q; }));
  }

  /**
   * Spread across explicitly selected topics: round-robin over the selected skill
   * groups (or domain groups when only domains were selected) so thirteen
   * questions across two skills come out 7/6, not 13/0. Groups that run dry are
   * skipped; the allocation is reported so the UI can never imply full coverage
   * it did not deliver.
   */
  function _interleave(rankedPool, request) {
    var groupBy = null;
    var groupKeys = [];
    if (request.skills.length > 1) { groupBy = 'skill'; groupKeys = request.skills.slice(); }
    else if (request.skills.length === 0 && request.domains.length > 1) { groupBy = 'domain'; groupKeys = request.domains.slice(); }

    if (!groupBy) {
      return { groupBy: 'none', groupKeys: [], ordered: rankedPool.slice() };
    }

    var buckets = bare();
    groupKeys.forEach(function (k) { buckets[k] = []; });
    var strays = [];
    rankedPool.forEach(function (q) {
      var k = (groupBy === 'skill') ? q.skill : q.domain;
      if (own(buckets, k)) buckets[k].push(q); else strays.push(q);
    });

    var ordered = [];
    var exhausted = false;
    var idx = 0;
    while (!exhausted) {
      exhausted = true;
      for (var g = 0; g < groupKeys.length; g++) {
        var b = buckets[groupKeys[g]];
        if (idx < b.length) { ordered.push(b[idx]); exhausted = false; }
      }
      idx++;
    }
    // Strays cannot occur while the strict filters are on, but if a caller ever
    // pre-filters differently they are appended rather than dropped silently.
    ordered = ordered.concat(strays);
    return { groupBy: groupBy, groupKeys: groupKeys, ordered: ordered };
  }

  // ---------------------------------------------------------------------------
  // planTest
  // ---------------------------------------------------------------------------
  function _invalidPlan(request, errors, reasons) {
    return {
      schemaVersion: PLANNER_SCHEMA_VERSION,
      ok: false,
      status: 'invalid',
      category: PLAN_CATEGORY,
      isAdaptive: false,
      scoreEligible: false,
      excludeFromExamTrends: true,
      request: request,
      questionIds: [],
      questions: [],
      actualCount: 0,
      eligibleCount: 0,
      unseenEligibleCount: 0,
      requestedCount: request ? request.requestedCount : null,
      recommendedCount: null,
      allocation: [],
      coverage: null,
      shortage: null,
      requiresAcceptance: false,
      filterTrace: [],
      timing: null,
      timeLimitMinutes: null,
      isUntimed: false,
      plannedAt: null,
      errors: errors || [],
      reasons: reasons || []
    };
  }

  function planTest(allQuestions, rawRequest, context) {
    var ctx = context || {};
    var norm = normalizePlanRequest(rawRequest);
    var request = norm.request;
    var errors = norm.errors.slice();

    if (!isFiniteNumber(ctx.now)) {
      errors.push({
        field: 'context.now',
        code: 'now_required',
        message: 'planTest is clock-free: context.now must be a finite timestamp supplied by the caller.'
      });
    }
    if (!Array.isArray(allQuestions) || allQuestions.length === 0) {
      errors.push({ field: 'questions', code: 'empty_bank', message: 'planTest needs a non-empty question bank.' });
    }
    if (errors.length > 0) {
      return _invalidPlan(request, errors, [{ code: 'invalid_request', message: 'The plan request is not valid; nothing was generated.' }]);
    }

    var now = ctx.now;
    var rng = (typeof ctx.random === 'function') ? ctx.random : Math.random;
    var progressMap = ctx.progressMap || {};
    var srsMap = ctx.srsMap || {};
    var baseAssumptions = ctx.assumptions || PLANNER_ASSUMPTIONS;
    var assumptions = _assumptionsForMode(baseAssumptions, request.timingMode);
    var timingStats = ctx.timingStats || buildTimingStats(progressMap, allQuestions, baseAssumptions);

    var reasons = [];

    // 1. Strict eligibility. Never relaxed, never reverted to a previous pool.
    var filtered = _applyStrictFilters(allQuestions, request);
    var pool = filtered.pool;
    var trace = filtered.trace;

    // De-duplicate by id so a bank with a repeated record can never produce a
    // duplicate question in a plan.
    var seenIds = bare();
    var duplicatesDropped = 0;
    pool = pool.filter(function (q) {
      if (q == null || q.id == null) return false;
      if (own(seenIds, q.id)) { duplicatesDropped++; return false; }
      seenIds[q.id] = true;
      return true;
    });

    var strictEligibleCount = pool.length;

    // 2. Preference narrowing — still eligibility, still strict; it only ever
    //    removes. Recorded in the trace so "nothing is due" names itself.
    var beforePref = pool.length;
    pool = _applyPreferenceNarrowing(pool, request, progressMap, srsMap, now);
    if (pool.length !== beforePref || request.selectionPreference !== 'unseen_first') {
      trace.push({ step: 'selectionPreference', remaining: pool.length, detail: request.selectionPreference });
    }

    var eligibleCount = pool.length;
    var unseenEligibleCount = pool.filter(function (q) {
      var p = get(progressMap, q.id);
      return !p || (!p.answered && !(p.timesSeen > 0));
    }).length;

    function emptyReason() {
      for (var i = trace.length - 1; i >= 0; i--) {
        if (trace[i].remaining === 0 && i > 0 && trace[i - 1].remaining > 0) return trace[i];
      }
      return trace[trace.length - 1];
    }

    if (eligibleCount === 0) {
      var culprit = emptyReason();
      var msg = 'No question in the bank matches this combination. The "' + culprit.step +
        '" filter removed the last candidates' +
        (culprit.detail ? ' (' + (Array.isArray(culprit.detail) ? culprit.detail.join(', ') : culprit.detail) + ')' : '') +
        '. Change a filter — the planner will not substitute off-topic questions.';
      var emptyPlan = _invalidPlan(request, [], [{ code: 'no_match_after_' + culprit.step, message: msg }]);
      emptyPlan.status = 'no_match';
      emptyPlan.filterTrace = trace;
      emptyPlan.plannedAt = now;
      emptyPlan.eligibleCount = 0;
      return emptyPlan;
    }

    // 3. Ranking (reorders inside the eligible pool only) and topic spreading.
    var ranked = _rank(pool, request, progressMap, srsMap, rng);
    var spread = _interleave(ranked, request);
    var ordered = spread.ordered;

    // 4. Sizing.
    var reviewSeconds = Math.round(request.reviewMinutes * 60);
    var perQuestion = [];
    var selected = [];
    var status = 'ok';
    var shortage = null;
    var recommendedCount = null;
    var budgetSeconds = null;

    if (request.sizeMode === SIZE_MODES.COUNT) {
      var target = request.requestedCount;
      var take = Math.min(target, ordered.length);
      selected = ordered.slice(0, take);
      selected.forEach(function (q) { perQuestion.push(estimateQuestionSeconds(q, timingStats, assumptions)); });
      if (take < target) {
        status = 'shortage';
        shortage = {
          requestedCount: target,
          availableCount: take,
          shortfall: target - take,
          requiresAcceptance: true
        };
        reasons.push({
          code: 'shortage',
          message: 'Only ' + take + ' of the ' + target + ' requested questions match these topics and filters. ' +
            'The plan has not been silently shrunk: accept the smaller set explicitly, or widen the selection.'
        });
      }
      if (request.timeLimitMinutes !== null) budgetSeconds = Math.round(request.timeLimitMinutes * 60);
    } else {
      budgetSeconds = Math.round((request.availableMinutes - request.reviewMinutes) * 60);
      var used = 0;
      for (var i = 0; i < ordered.length; i++) {
        var est = estimateQuestionSeconds(ordered[i], timingStats, assumptions);
        if (used + est.seconds > budgetSeconds) continue;
        used += est.seconds;
        perQuestion.push(est);
        selected.push(ordered[i]);
      }
      recommendedCount = selected.length;

      if (selected.length === 0) {
        var cheapest = null;
        for (var j = 0; j < ordered.length; j++) {
          var e2 = estimateQuestionSeconds(ordered[j], timingStats, assumptions);
          if (cheapest === null || e2.seconds < cheapest) cheapest = e2.seconds;
        }
        var noFit = _invalidPlan(request, [], [{
          code: 'no_fit',
          message: 'No question fits the budget. After reserving ' + request.reviewMinutes + ' review minute(s), ' +
            Math.round(budgetSeconds / 60 * 10) / 10 + ' minute(s) remain for answering, and the quickest matching ' +
            'question is estimated at about ' + Math.round((cheapest || 0) / 60 * 10) / 10 + ' minute(s). ' +
            'Allow more time, reduce the review reservation, or run this as untimed practice.'
        }]);
        noFit.status = 'no_fit';
        noFit.filterTrace = trace;
        noFit.plannedAt = now;
        noFit.eligibleCount = eligibleCount;
        noFit.unseenEligibleCount = unseenEligibleCount;
        noFit.recommendedCount = 0;
        noFit.timing = {
          assumptionsVersion: assumptions.version,
          timingMode: request.timingMode,
          budgetSeconds: budgetSeconds,
          reviewSeconds: reviewSeconds,
          minimumItemSeconds: cheapest,
          estimatedAnsweringSeconds: 0,
          totalPlannedSeconds: reviewSeconds,
          perQuestion: [],
          measuredCount: 0,
          assumedCount: 0,
          allMeasured: false,
          anyMeasured: false,
          basisCounts: {},
          uncertainty: 'unknown',
          overBudget: false,
          overBudgetSeconds: 0
        };
        noFit.suggestions = ['increase_available_minutes', 'reduce_review_minutes', 'untimed_practice'];
        return noFit;
      }
      if (selected.length < ordered.length) {
        reasons.push({
          code: 'sized_to_budget',
          message: 'Sized to the available time: ' + selected.length + ' of ' + ordered.length +
            ' matching questions fit the answering budget.'
        });
      }
    }

    // 5. Allocation and coverage across explicitly selected topics.
    var allocation = [];
    var coverage = null;
    if (spread.groupBy !== 'none') {
      var counts = bare();
      spread.groupKeys.forEach(function (k) { counts[k] = 0; });
      var availableByGroup = bare();
      spread.groupKeys.forEach(function (k) { availableByGroup[k] = 0; });
      ordered.forEach(function (q) {
        var k = (spread.groupBy === 'skill') ? q.skill : q.domain;
        if (own(availableByGroup, k)) availableByGroup[k]++;
      });
      selected.forEach(function (q) {
        var k = (spread.groupBy === 'skill') ? q.skill : q.domain;
        if (own(counts, k)) counts[k]++;
      });
      allocation = spread.groupKeys.map(function (k) {
        return { groupBy: spread.groupBy, topic: k, selected: counts[k], eligible: availableByGroup[k] };
      });
      var withEligible = allocation.filter(function (r) { return r.eligible > 0; });
      var covered = allocation.filter(function (r) { return r.selected > 0; });
      var unavailable = allocation.filter(function (r) { return r.eligible === 0; }).map(function (r) { return r.topic; });
      var missing = allocation.filter(function (r) { return r.eligible > 0 && r.selected === 0; }).map(function (r) { return r.topic; });
      var complete = (unavailable.length === 0 && missing.length === 0);
      coverage = {
        groupBy: spread.groupBy,
        selectedTopics: spread.groupKeys.slice(),
        topicsWithEligibleQuestions: withEligible.length,
        topicsCovered: covered.length,
        complete: complete,
        missingTopics: missing,
        unavailableTopics: unavailable,
        reason: complete ? null
          : (missing.length > 0 && selected.length < spread.groupKeys.length ? 'count_smaller_than_selected_topics'
            : (unavailable.length > 0 ? 'some_topics_have_no_eligible_questions' : 'not_every_topic_reached'))
      };
      if (!complete) {
        reasons.push({
          code: 'incomplete_topic_coverage',
          message: 'This set covers ' + covered.length + ' of the ' + spread.groupKeys.length +
            ' selected topics' +
            (missing.length ? '; not reached: ' + missing.join('; ') : '') +
            (unavailable.length ? '; no matching questions for: ' + unavailable.join('; ') : '') +
            '. It does not cover every selected topic.'
        });
      }
    } else if (spread.groupKeys.length === 0 && request.skills.length === 1) {
      allocation = [{ groupBy: 'skill', topic: request.skills[0], selected: selected.length, eligible: ordered.length }];
      coverage = {
        groupBy: 'skill',
        selectedTopics: request.skills.slice(),
        topicsWithEligibleQuestions: 1,
        topicsCovered: selected.length > 0 ? 1 : 0,
        complete: selected.length > 0,
        missingTopics: [],
        unavailableTopics: [],
        reason: null
      };
    }

    // 6. Timing summary. Every number here carries its basis.
    var answeringSeconds = perQuestion.reduce(function (s, e) { return s + e.seconds; }, 0);
    var measuredCount = perQuestion.filter(function (e) { return e.measured; }).length;
    var assumedCount = perQuestion.length - measuredCount;
    var basisCounts = {};
    perQuestion.forEach(function (e) { basisCounts[e.basis] = (basisCounts[e.basis] || 0) + 1; });
    var totalPlannedSeconds = answeringSeconds + reviewSeconds;

    var overBudget = false;
    var overBudgetSeconds = 0;
    if (budgetSeconds !== null && answeringSeconds > budgetSeconds) {
      overBudget = true;
      overBudgetSeconds = answeringSeconds - budgetSeconds;
      reasons.push({
        code: 'estimate_exceeds_budget',
        message: 'The requested ' + selected.length + ' questions are estimated at about ' +
          Math.round(answeringSeconds / 60) + ' minutes of answering time, which exceeds the ' +
          Math.round(budgetSeconds / 60) + '-minute limit by about ' + Math.round(overBudgetSeconds / 60) +
          ' minute(s). The count has NOT been lowered — change the count or the time limit.'
      });
    }

    var uncertainty = (measuredCount === perQuestion.length) ? 'measured'
      : (measuredCount === 0 ? 'assumed' : 'mixed');

    var timeLimitMinutes = null;
    var isUntimed = (request.timingMode === 'untimed');
    if (!isUntimed) {
      if (request.sizeMode === SIZE_MODES.TIME) timeLimitMinutes = request.availableMinutes - request.reviewMinutes;
      else timeLimitMinutes = request.timeLimitMinutes;
    }

    if (uncertainty !== 'measured') {
      reasons.push({
        code: 'timing_partly_assumed',
        message: (assumedCount === perQuestion.length
          ? 'Every time estimate here is a labelled planning assumption, not measured student performance.'
          : assumedCount + ' of ' + perQuestion.length + ' time estimates are labelled planning assumptions, not measured student performance.')
      });
    }

    return {
      schemaVersion: PLANNER_SCHEMA_VERSION,
      ok: true,
      status: status,
      // Category marker: a focused custom test is a NONADAPTIVE practice set. It
      // must never be rendered as a composite PSAT score or folded into full-exam
      // trends, however many questions it has.
      category: PLAN_CATEGORY,
      isAdaptive: false,
      scoreEligible: false,
      excludeFromExamTrends: true,
      scoreDisplayPolicy: 'no_composite_score',

      request: request,
      plannedAt: now,

      questionIds: selected.map(function (q) { return q.id; }),
      questions: selected.slice(),

      requestedCount: request.requestedCount,
      recommendedCount: recommendedCount,
      actualCount: selected.length,
      strictEligibleCount: strictEligibleCount,
      eligibleCount: eligibleCount,
      unseenEligibleCount: unseenEligibleCount,
      duplicatesDropped: duplicatesDropped,

      allocation: allocation,
      coverage: coverage,
      shortage: shortage,
      requiresAcceptance: shortage !== null,
      filterTrace: trace,

      timing: {
        assumptionsVersion: assumptions.version,
        timingMode: request.timingMode,
        modeMultiplier: isFiniteNumber(assumptions.modeMultiplier) ? assumptions.modeMultiplier : 1,
        estimatedAnsweringSeconds: answeringSeconds,
        reviewSeconds: reviewSeconds,
        totalPlannedSeconds: totalPlannedSeconds,
        budgetSeconds: budgetSeconds,
        overBudget: overBudget,
        overBudgetSeconds: overBudgetSeconds,
        perQuestion: perQuestion,
        measuredCount: measuredCount,
        assumedCount: assumedCount,
        allMeasured: measuredCount === perQuestion.length,
        anyMeasured: measuredCount > 0,
        basisCounts: basisCounts,
        uncertainty: uncertainty,
        observationCount: timingStats ? timingStats.observationCount : 0
      },

      timeLimitMinutes: timeLimitMinutes,
      isUntimed: isUntimed,

      errors: [],
      reasons: reasons
    };
  }

  // ---------------------------------------------------------------------------
  // describePlan — the words the parent reads. Uncertainty is not optional here:
  // an assumed estimate always says it is an assumption (CLAUDE.md mode 1).
  // ---------------------------------------------------------------------------
  function _mins(seconds) {
    var m = seconds / 60;
    return (m >= 10) ? String(Math.round(m)) : String(Math.round(m * 10) / 10);
  }

  function describePlan(plan) {
    if (!plan) {
      return { ok: false, headline: 'No plan.', lines: [], warnings: [] };
    }

    var lines = [];
    var warnings = [];
    var reasonText = (plan.reasons || []).map(function (r) { return r.message; });

    if (plan.status === 'invalid') {
      var errText = (plan.errors || []).map(function (e) { return e.message; });
      return {
        ok: false,
        status: plan.status,
        headline: 'This test cannot be built yet.',
        sizing: '',
        topics: '',
        timing: '',
        uncertainty: '',
        coverage: '',
        shortage: '',
        timer: '',
        category: 'Custom focused practice — not an official adaptive PSAT exam.',
        lines: errText.concat(reasonText),
        warnings: errText.concat(reasonText)
      };
    }

    if (plan.status === 'no_match' || plan.status === 'no_fit') {
      return {
        ok: false,
        status: plan.status,
        headline: plan.status === 'no_match' ? 'No questions match this selection.' : 'Nothing fits this time budget.',
        sizing: '',
        topics: '',
        timing: '',
        uncertainty: '',
        coverage: '',
        shortage: '',
        timer: '',
        category: 'Custom focused practice — not an official adaptive PSAT exam.',
        lines: reasonText,
        warnings: reasonText
      };
    }

    var req = plan.request;
    var t = plan.timing;

    var headline = plan.actualCount + ' question' + (plan.actualCount === 1 ? '' : 's') +
      (req.sizeMode === SIZE_MODES.TIME ? ' recommended for the time available' : plan.requiresAcceptance ? ' available — smaller set requires acceptance' : ' as requested');
    lines.push(headline);

    var sizing = (req.sizeMode === SIZE_MODES.COUNT)
      ? 'Sized by question count: ' + req.requestedCount + ' requested, ' + plan.actualCount + ' selected.'
      : 'Sized by available time: ' + req.availableMinutes + ' minute(s) available, ' +
        req.reviewMinutes + ' reserved for reviewing explanations, so ' +
        _mins((req.availableMinutes - req.reviewMinutes) * 60) + ' minute(s) for answering.';
    lines.push(sizing);

    var topicBits = [];
    if (req.subjects.length) topicBits.push(req.subjects.join(' + '));
    if (req.domains.length) topicBits.push(req.domains.join('; '));
    if (req.skills.length) topicBits.push(req.skills.join('; '));
    if (req.difficulties.length) topicBits.push(req.difficulties.join('/') + ' difficulty');
    if (req.questionType) topicBits.push(req.questionType === 'spr' ? 'free-response only' : 'multiple-choice only');
    var topics = topicBits.length ? ('Topics: ' + topicBits.join(' → ')) : 'Topics: any (whole question bank)';
    topics += ' · ' + plan.eligibleCount + ' eligible question(s), ' + plan.unseenEligibleCount + ' not yet seen.';
    lines.push(topics);

    var timingText = 'Estimated answering time: about ' + _mins(t.estimatedAnsweringSeconds) + ' minute(s)' +
      (t.reviewSeconds > 0 ? ', plus ' + _mins(t.reviewSeconds) + ' minute(s) reserved for review — about ' +
        _mins(t.totalPlannedSeconds) + ' minute(s) planned in total' : '') + '.';
    lines.push(timingText);

    var uncertainty;
    if (t.uncertainty === 'measured') {
      uncertainty = 'Based on the student\'s own reliable, independent first attempts (' + t.observationCount +
        ' timed observation(s) available; median per topic). Estimates are approximate.';
    } else if (t.uncertainty === 'assumed') {
      uncertainty = 'This is a PLANNING ASSUMPTION, not measured student performance: there is not enough reliable ' +
        'timing data yet, so published PSAT 8/9 pacing is used. Real time taken may differ substantially.';
    } else {
      uncertainty = t.measuredCount + ' of ' + t.perQuestion.length + ' estimates use the student\'s own measured timing; ' +
        'the other ' + t.assumedCount + ' are labelled planning assumptions based on published PSAT 8/9 pacing, ' +
        'not measured student performance.';
    }
    if (t.modeMultiplier !== 1) {
      uncertainty += ' Untimed practice is additionally scaled by an unvalidated planning assumption (x' + t.modeMultiplier + ').';
    }
    lines.push(uncertainty);
    if (t.uncertainty !== 'measured') warnings.push(uncertainty);

    var coverageText = '';
    if (plan.coverage) {
      coverageText = plan.coverage.complete
        ? 'Covers all ' + plan.coverage.selectedTopics.length + ' selected topic(s): ' +
          plan.allocation.map(function (a) { return a.topic + ' ' + a.selected; }).join(', ') + '.'
        : 'Incomplete topic coverage — ' + plan.coverage.topicsCovered + ' of ' +
          plan.coverage.selectedTopics.length + ' selected topic(s) appear in this set' +
          (plan.coverage.missingTopics.length ? '; not reached: ' + plan.coverage.missingTopics.join('; ') : '') +
          (plan.coverage.unavailableTopics.length ? '; no matching questions for: ' + plan.coverage.unavailableTopics.join('; ') : '') + '.';
      lines.push(coverageText);
      if (!plan.coverage.complete) warnings.push(coverageText);
    }

    var shortageText = '';
    if (plan.shortage) {
      shortageText = 'Only ' + plan.shortage.availableCount + ' of the ' + plan.shortage.requestedCount +
        ' requested questions are available with these filters (' + plan.shortage.shortfall +
        ' short). Accept the smaller set explicitly or widen the selection — the count was not lowered silently.';
      lines.push(shortageText);
      warnings.push(shortageText);
    }

    var timer = plan.isUntimed
      ? 'Untimed practice: no deadline is imposed; the estimate above is for planning only.'
      : (plan.timeLimitMinutes === null
        ? 'No timer set for this test.'
        : 'Timer: ' + plan.timeLimitMinutes + ' minute(s) of answering time. The timer is separate from the estimate above.');
    lines.push(timer);

    if (t.overBudget) {
      var conflict = 'Conflict: the estimate (about ' + _mins(t.estimatedAnsweringSeconds) + ' min) exceeds the ' +
        _mins(t.budgetSeconds) + '-minute limit by about ' + _mins(t.overBudgetSeconds) +
        ' min. The question count was kept as requested.';
      lines.push(conflict);
      warnings.push(conflict);
    }

    var category = 'Custom focused practice — a nonadaptive practice set. It does not produce a PSAT score ' +
      'and is not included in full-test score trends.';
    lines.push(category);

    return {
      ok: true,
      status: plan.status,
      headline: headline,
      sizing: sizing,
      topics: topics,
      timing: timingText,
      uncertainty: uncertainty,
      coverage: coverageText,
      shortage: shortageText,
      timer: timer,
      category: category,
      lines: lines,
      warnings: warnings
    };
  }

  return {
    PLANNER_SCHEMA_VERSION: PLANNER_SCHEMA_VERSION,
    PLANNER_ASSUMPTIONS: PLANNER_ASSUMPTIONS,
    SIZE_MODES: SIZE_MODES,
    SUBJECT_VALUES: SUBJECT_VALUES,
    DIFFICULTY_VALUES: DIFFICULTY_VALUES,
    QUESTION_TYPE_VALUES: QUESTION_TYPE_VALUES,
    SELECTION_PREFERENCES: SELECTION_PREFERENCES,
    TIMING_MODES: TIMING_MODES,
    PLAN_CATEGORY: PLAN_CATEGORY,
    normalizePlanRequest: normalizePlanRequest,
    estimateQuestionSeconds: estimateQuestionSeconds,
    buildTimingStats: buildTimingStats,
    planTest: planTest,
    describePlan: describePlan
  };
});
