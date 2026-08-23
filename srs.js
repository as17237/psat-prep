/**
 * srs.js - Core Algorithms for Free-Response Grading, Spaced Repetition (SM-2), and Score Modeling
 * Dependency-free: runs in both browser and Node.js.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.PSAT_ENGINE = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Parses string numeric values including decimals, fractions (e.g. 5/2, -49/150), and formatted text.
   */
  function parseNumeric(s) {
    if (s === null || s === undefined) return null;
    var cleaned = String(s).trim().replace(/[$,%\s]/g, '');
    if (!cleaned) return null;

    // Check fraction format: numerator / denominator
    var fracMatch = cleaned.match(/^(-?\d*\.?\d+)\/(-?\d*\.?\d+)$/);
    if (fracMatch) {
      var num = parseFloat(fracMatch[1]);
      var den = parseFloat(fracMatch[2]);
      if (den === 0 || isNaN(num) || isNaN(den)) return null;
      return num / den;
    }

    var n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Grades free-response (Student-Produced Response) input against one or multiple accepted keys.
   */
  function gradeFreeResponse(input, key) {
    if (input === null || input === undefined || key === null || key === undefined) return false;
    var rawInput = String(input).trim();
    if (!rawInput) return false;

    var acceptedForms = String(key).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var userNum = parseNumeric(rawInput);

    return acceptedForms.some(function (accepted) {
      if (userNum !== null) {
        var keyNum = parseNumeric(accepted);
        if (keyNum !== null) {
          // Allow absolute tolerance of 1e-4 or relative tolerance of 1e-3 (handles rounding of repeating decimals like 14.66 vs 44/3)
          var diff = Math.abs(userNum - keyNum);
          var tol = Math.max(1e-4, Math.abs(keyNum) * 1e-3);
          if (diff <= tol) return true;
        }
      }
      return rawInput.toLowerCase() === accepted.toLowerCase();
    });
  }

  /**
   * Formats a comma-separated key into human-friendly text (e.g. ".2, 1/5" -> ".2 or 1/5")
   */
  function formatAcceptedAnswers(key) {
    if (!key) return '';
    var forms = String(key).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (forms.length <= 1) return forms[0] || '';
    if (forms.length === 2) return forms[0] + ' or ' + forms[1];
    return forms.slice(0, -1).join(', ') + ', or ' + forms[forms.length - 1];
  }

  /**
   * Computes SM-2 response grade (1 to 5) based on correctness and response time.
   */
  function gradeAttempt(isCorrect, timeMs) {
    if (!isCorrect) return 1;
    var ms = typeof timeMs === 'number' && timeMs > 0 ? timeMs : 60000;
    if (ms < 45000) return 5; // Fast / Mastered (<45s)
    if (ms <= 90000) return 4; // Proficient (45s-90s)
    return 3; // Hesitant (>90s)
  }

  /**
   * Schedules next review using SuperMemo SM-2 algorithm.
   */
  function scheduleNext(existingCard, grade, nowMs) {
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    var card = existingCard || {};
    var ef = typeof card.easeFactor === 'number' ? card.easeFactor : 2.5;
    var reps = typeof card.repetitions === 'number' ? card.repetitions : 0;
    var interval = typeof card.intervalDays === 'number' ? card.intervalDays : 1;
    var history = Array.isArray(card.history) ? card.history.slice() : [];

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

    return {
      questionId: card.questionId || '',
      repetitions: newReps,
      intervalDays: newInterval,
      easeFactor: Math.round(newEf * 100) / 100,
      lastReviewedAt: now,
      dueAt: dueAt,
      lastGrade: q,
      history: history
    };
  }

  /**
   * Computes an empirical PSAT 8/9 scaled score estimate (240–1440).
   * 120–720 for Reading and Writing, 120–720 for Math.
   */
  function calculateScaledScore(questions, progress) {
    var rwAttempted = 0;
    var rwCorrect = 0;
    var mathAttempted = 0;
    var mathCorrect = 0;

    questions.forEach(function (q) {
      var p = progress[q.id];
      if (p && p.answered) {
        if (q.test === 'Reading and Writing') {
          rwAttempted++;
          if (p.isCorrect) rwCorrect++;
        } else if (q.test === 'Math') {
          mathAttempted++;
          if (p.isCorrect) mathCorrect++;
        }
      }
    });

    var MIN_PER_SECTION = 15;
    var isReady = (rwAttempted >= MIN_PER_SECTION && mathAttempted >= MIN_PER_SECTION);

    var rwAcc = rwAttempted > 0 ? (rwCorrect / rwAttempted) : 0;
    var mathAcc = mathAttempted > 0 ? (mathCorrect / mathAttempted) : 0;

    // Mapping: 120 floor + accuracy * 600 points = 120 to 720
    var rwScore = rwAttempted > 0 ? Math.min(720, Math.max(120, Math.round(120 + rwAcc * 600))) : null;
    var mathScore = mathAttempted > 0 ? Math.min(720, Math.max(120, Math.round(120 + mathAcc * 600))) : null;
    var totalScore = (rwScore !== null && mathScore !== null) ? (rwScore + mathScore) : null;

    return {
      isReady: isReady,
      rwAttempted: rwAttempted,
      rwCorrect: rwCorrect,
      rwScore: rwScore,
      mathAttempted: mathAttempted,
      mathCorrect: mathCorrect,
      mathScore: mathScore,
      totalScore: isReady ? totalScore : null,
      totalAttempted: rwAttempted + mathAttempted,
      minRequiredPerSection: MIN_PER_SECTION
    };
  }

  /**
   * Appends or updates a daily practice session log in localStorage.
   */
  function recordDailySession(sessionsMap, isCorrect, timeSpentMs, dateStr) {
    var today = dateStr || (new Date()).toISOString().split('T')[0];
    var map = sessionsMap || {};
    var entry = map[today] || { date: today, questionsAnswered: 0, correct: 0, totalTimeMs: 0 };

    entry.questionsAnswered += 1;
    if (isCorrect) entry.correct += 1;
    entry.totalTimeMs += Math.min(600000, Math.max(1000, timeSpentMs || 30000)); // Cap at 10 mins

    map[today] = entry;
    return map;
  }

  /**
   * Calculates consecutive active streak days ending today or yesterday.
   */
  function calculateStreak(sessionsMap) {
    if (!sessionsMap) return 0;
    var dates = Object.keys(sessionsMap).filter(function (d) {
      return sessionsMap[d] && sessionsMap[d].questionsAnswered > 0;
    }).sort();

    if (dates.length === 0) return 0;

    var today = (new Date()).toISOString().split('T')[0];
    var lastDate = dates[dates.length - 1];

    // If last practice was before yesterday, streak is broken
    var dToday = new Date(today);
    var dLast = new Date(lastDate);
    var diffDays = Math.round((dToday - dLast) / (1000 * 60 * 60 * 24));

    if (diffDays > 1) return 0;

    var streak = 1;
    for (var i = dates.length - 1; i > 0; i--) {
      var curr = new Date(dates[i]);
      var prev = new Date(dates[i - 1]);
      var diff = Math.round((curr - prev) / (1000 * 60 * 60 * 24));
      if (diff === 1) {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }

  return {
    parseNumeric: parseNumeric,
    gradeFreeResponse: gradeFreeResponse,
    formatAcceptedAnswers: formatAcceptedAnswers,
    gradeAttempt: gradeAttempt,
    scheduleNext: scheduleNext,
    calculateScaledScore: calculateScaledScore,
    recordDailySession: recordDailySession,
    calculateStreak: calculateStreak
  };
});
