/**
 * js/engine/scheduler.js — SM-2 spaced repetition: card scheduling, SRS-state compaction, the daily
 * session ledger and the study streak. localDateKey lives here because every
 * consumer of it is a calendar-day question (sessions, streaks, sync).
 *
 * Part of the engine that was one 3,458-line srs.js until REFACTOR_PLAN.md
 * WI-10. The code below is the SAME code, moved verbatim; `srs.js` is now a
 * facade that recomposes these parts into the unchanged `PSAT_ENGINE` object.
 *
 * Loading: same UMD shape as srs.js always had — `module.exports` under Node,
 * `window.__PSAT_ENGINE_PARTS.scheduler` in the browser. There is no build step,
 * so the pages load the parts as ordinary <script> tags in dependency order
 * (grading -> scheduler -> scoring -> storage -> examgen -> sync) before srs.js.
 * Dependencies: none.
 * A missing dependency throws immediately rather than yielding a half-built
 * part whose functions ReferenceError at call time (CLAUDE.md failure mode 5).
 */
(function (root, factory) {
  var DEPS = [];
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory.apply(null, DEPS.map(function (d) { return require('./' + d + '.js'); }));
  } else {
    var parts = root.__PSAT_ENGINE_PARTS = root.__PSAT_ENGINE_PARTS || {};
    parts.scheduler = factory.apply(null, DEPS.map(function (d) {
      if (!parts[d]) {
        throw new Error(
          'js/engine/scheduler.js requires js/engine/' + d + '.js, which has not loaded yet. ' +
          'Load the engine parts in this order before srs.js: grading, scheduler, scoring, storage, examgen, sync.'
        );
      }
      return parts[d];
    }));
  }
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Formats a Date object as a local calendar date key 'YYYY-MM-DD' (avoids UTC rollover shifts).
   */
  function localDateKey(d) {
    var dateObj = d || new Date();
    if (typeof dateObj === 'string' || typeof dateObj === 'number') {
      dateObj = new Date(dateObj);
    }
    var y = dateObj.getFullYear();
    var m = String(dateObj.getMonth() + 1).padStart(2, '0');
    var day = String(dateObj.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }


  /**
   * Schedules next review using SuperMemo SM-2 algorithm.
   */
  function scheduleNext(existingCard, grade, nowMs, responseTimeMs) {
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    var card = existingCard || {};
    var ef = typeof card.easeFactor === 'number' ? card.easeFactor : 2.5;
    var reps = typeof card.repetitions === 'number' ? card.repetitions : 0;
    var interval = typeof card.intervalDays === 'number' ? card.intervalDays : 1;
    var history = Array.isArray(card.history) ? card.history.slice() : [];
    var totalReviews = (typeof card.totalReviews === 'number' ? card.totalReviews : (card.lastReviewedAt ? 1 : 0)) + 1;
    var totalLapses = (typeof card.totalLapses === 'number' ? card.totalLapses : 0) + (grade < 3 ? 1 : 0);
    var firstReviewedAt = card.firstReviewedAt || card.lastReviewedAt || now;

    // Calculate new Ease Factor: EF' = max(1.3, EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
    var q = Math.max(1, Math.min(5, grade));
    var newEf = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    if (newEf < 1.3) newEf = 1.3;

    var newInterval;
    var newReps;

    if (q < 3) {
      // Failed: reset ladder
      newReps = 0;
      newInterval = 1;
    } else {
      if (reps === 0) {
        newInterval = 1;
      } else if (reps === 1) {
        newInterval = 3;
      } else if (reps === 2) {
        newInterval = 7;
      } else {
        newInterval = Math.max(1, Math.round(interval * newEf));
      }
      newReps = reps + 1;
    }

    var dueAt = now + (newInterval * 86400000);

    // Track review event in bounded history (capped to newest 20 events)
    history.push({
      reviewedAt: now,
      grade: q,
      intervalDays: newInterval,
      responseTimeMs: typeof responseTimeMs === 'number' ? responseTimeMs : null
    });
    if (history.length > 20) {
      history = history.slice(-20);
    }

    // Compute rolling average response time
    var times = history.map(function(h) { return h.responseTimeMs; }).filter(function(t) { return typeof t === 'number' && t > 0; });
    var avgResponseTimeMs = times.length > 0 ? Math.round(times.reduce(function(a, b) { return a + b; }, 0) / times.length) : (card.avgResponseTimeMs || null);

    return {
      questionId: card.questionId || '',
      repetitions: newReps,
      intervalDays: newInterval,
      easeFactor: Math.round(newEf * 100) / 100,
      lastReviewedAt: now,
      firstReviewedAt: firstReviewedAt,
      totalReviews: totalReviews,
      totalLapses: totalLapses,
      avgResponseTimeMs: avgResponseTimeMs,
      dueAt: dueAt,
      lastGrade: q,
      history: history
    };
  }


  /**
   * Enforces compact state budget across long-term SRS cards (max 20 detailed events per card).
   */
  function compactSrsState(srsState) {
    if (!srsState || typeof srsState !== 'object') return {};
    var compacted = {};
    Object.keys(srsState).forEach(function(qid) {
      var card = srsState[qid];
      if (!card) return;
      var hist = Array.isArray(card.history) ? card.history.slice(-20) : [];
      compacted[qid] = {
        questionId: card.questionId || qid,
        repetitions: typeof card.repetitions === 'number' ? card.repetitions : 0,
        intervalDays: typeof card.intervalDays === 'number' ? card.intervalDays : 1,
        easeFactor: typeof card.easeFactor === 'number' ? card.easeFactor : 2.5,
        lastReviewedAt: card.lastReviewedAt || null,
        firstReviewedAt: card.firstReviewedAt || card.lastReviewedAt || null,
        totalReviews: typeof card.totalReviews === 'number' ? card.totalReviews : (card.lastReviewedAt ? 1 : 0),
        totalLapses: typeof card.totalLapses === 'number' ? card.totalLapses : 0,
        avgResponseTimeMs: typeof card.avgResponseTimeMs === 'number' ? card.avgResponseTimeMs : null,
        dueAt: typeof card.dueAt === 'number' ? card.dueAt : null,
        lastGrade: typeof card.lastGrade === 'number' ? card.lastGrade : null,
        history: hist
      };
    });
    return compacted;
  }

  // ============================================================================
  // UNVALIDATED SCALING ASSUMPTIONS & MST ROUTING CONSTANTS
  // ----------------------------------------------------------------------------
  // NOTE: College Board does not publish raw-to-scale conversion tables or IRT
  // item parameters for the digital adaptive PSAT 8/9. The digital suite is scored
  // using Item Response Theory (IRT) where the scaled score depends on the
  // specific item parameters and adaptive routing stage, not a simple raw percentage.
  // No client-side function can reproduce official College Board scores.
  //
  // The curves, track exponents (0.85 Hard, 1.1 Easy), lower-track cap (580), and
  // routing threshold (0.58) below are empirical approximations and unvalidated
  // assumptions that do not represent official College Board psychometrics.
  // ============================================================================


  /**
   * Appends or updates a daily practice session log in localStorage using local calendar date.
   */
  function recordDailySession(sessionsMap, isCorrect, timeSpentMs, dateStr, timingReliable) {
    var today = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) ? dateStr : localDateKey();
    var map = sessionsMap || {};
    var entry = map[today] || { date: today, questionsAnswered: 0, correct: 0, totalTimeMs: 0 };

    entry.questionsAnswered += 1;
    if (isCorrect) entry.correct += 1;
    
    // Only accumulate time if timing was reliable
    if (timingReliable !== false && typeof timeSpentMs === 'number') {
      entry.totalTimeMs += Math.min(600000, Math.max(1000, timeSpentMs));
    }

    map[today] = entry;
    return map;
  }


  /**
   * Calculates consecutive active streak days ending today or yesterday using local calendar dates.
   * @param {Object} sessionsMap - Map of 'YYYY-MM-DD' -> session object.
   * @param {string} [todayKey] - Optional reference date 'YYYY-MM-DD' (defaults to localDateKey()).
   */
  function calculateStreak(sessionsMap, todayKey) {
    if (!sessionsMap) return 0;
    var refDate = (typeof todayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(todayKey)) ? todayKey : localDateKey();

    function parseLocalDayNumber(dStr) {
      var parts = dStr.split('-').map(Number);
      return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000);
    }

    var todayDayNum = parseLocalDayNumber(refDate);

    // Filter to valid past/present dates with answered questions (ignore future-dated and invalid entries)
    var dates = Object.keys(sessionsMap).filter(function (d) {
      return /^\d{4}-\d{2}-\d{2}$/.test(d) && sessionsMap[d] && sessionsMap[d].questionsAnswered > 0 && parseLocalDayNumber(d) <= todayDayNum;
    }).sort();

    if (dates.length === 0) return 0;

    var lastDayNum = parseLocalDayNumber(dates[dates.length - 1]);
    var diffDays = todayDayNum - lastDayNum;

    // If latest session is older than yesterday or in the future, streak is 0
    if (diffDays > 1 || diffDays < 0) return 0;

    var streak = 1;
    for (var i = dates.length - 1; i > 0; i--) {
      var currDay = parseLocalDayNumber(dates[i]);
      var prevDay = parseLocalDayNumber(dates[i - 1]);
      if (currDay - prevDay === 1) {
        streak++;
      } else if (currDay === prevDay) {
        continue;
      } else {
        break;
      }
    }
    return streak;
  }

  return {
    localDateKey: localDateKey,
    scheduleNext: scheduleNext,
    compactSrsState: compactSrsState,
    recordDailySession: recordDailySession,
    calculateStreak: calculateStreak
  };
});
