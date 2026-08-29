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
   * Extracts all accepted forms from a free-response answer key (handles comma separation, prose 'either X or Y').
   */
  function extractAcceptedForms(key) {
    if (key === null || key === undefined) return [];
    var raw = String(key).trim();
    if (!raw) return [];

    // Strip leading 'either ' (e.g., 'either 8 or 9')
    raw = raw.replace(/^either\s+/i, '');

    // Split on commas or word-bounded 'or'
    var parts = raw.split(/\s*(?:,|\bor\b)\s*/i).map(function (s) {
      return s.trim();
    }).filter(Boolean);

    return parts;
  }

  /**
   * Grades free-response (Student-Produced Response) input against one or multiple accepted keys.
   */
  function gradeFreeResponse(input, key) {
    if (input === null || input === undefined || key === null || key === undefined) return false;
    var rawInput = String(input).trim();
    if (!rawInput) return false;

    var acceptedForms = extractAcceptedForms(key);
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
   * Formats a key into human-friendly text (e.g. ".2, 1/5" -> ".2 or 1/5", "either 8 or 9" -> "8 or 9")
   */
  function formatAcceptedAnswers(key) {
    if (!key) return '';
    var forms = extractAcceptedForms(key);
    if (forms.length <= 1) return forms[0] || '';
    if (forms.length === 2) return forms[0] + ' or ' + forms[1];
    return forms.slice(0, -1).join(', ') + ', or ' + forms[forms.length - 1];
  }

  /**
   * Computes SM-2 response grade (1 to 5) based on correctness and response time.
   * If timing is missing or unreliable, falls back conservatively to grade 3 (Hesitant).
   */
  function gradeAttempt(isCorrect, timeMs, timingReliable) {
    if (!isCorrect) return 1;
    if (timingReliable === false || typeof timeMs !== 'number' || isNaN(timeMs) || timeMs <= 0) {
      return 3; // Conservative fallback: Hesitant
    }
    if (timeMs < 45000) return 5; // Fast / Mastered (<45s)
    if (timeMs <= 90000) return 4; // Proficient (45s-90s)
    return 3; // Hesitant (>90s)
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
  var SCALING_ASSUMPTIONS = {
    SECTION_FLOOR: 120,
    SECTION_CEILING: 720,
    TOTAL_FLOOR: 240,
    TOTAL_CEILING: 1440,
    MIN_PER_SECTION: 15,
    LOW_SAMPLE_THRESHOLD: 30, // Sample sizes < 30 per section indicate high variance
    HARD_TRACK_EXPONENT: 0.85, // Upper difficulty track power curve (unvalidated)
    EASY_TRACK_EXPONENT: 1.1,  // Lower difficulty track power curve (unvalidated)
    EASY_TRACK_MAX: 580,       // Maximum score cap for lower difficulty track (unvalidated)
    ROUTING_THRESHOLD: 0.58,   // Cutoff proportion to route into upper track (>= 16/27, >= 13/22)
    ALLOWED_TRACKS: ['Standard', 'Hard', 'Easy', 'Baseline'],
    // 90% Confidence Interval z-value for two-tailed normal distribution (alpha = 0.10)
    CONFIDENCE_Z_90: 1.6448536269514722
  };

  /**
   * Evaluates section scaled score (120–720) from raw accuracy ratio [0, 1].
   * Explicitly checks track against SCALING_ASSUMPTIONS.ALLOWED_TRACKS.
   * Returns null if track is invalid or unallowed.
   *
   * @param {number} rawRatio - Accuracy proportion (0.0 to 1.0)
   * @param {string} [track] - 'Standard' | 'Hard' | 'Easy' | 'Baseline'
   * @param {boolean} [isAdaptive] - Whether adaptive routing applies
   * @returns {number|null} Scaled section score (120–720) or null if track is invalid
   */
  function scaleSectionRawScore(rawRatio, track, isAdaptive) {
    if (typeof rawRatio !== 'number' || isNaN(rawRatio)) return null;
    var clampedRatio = Math.max(0, Math.min(1, rawRatio));

    var effectiveTrack = track;
    if (!isAdaptive) {
      if (effectiveTrack === undefined || effectiveTrack === null || effectiveTrack === '') {
        effectiveTrack = 'Standard';
      }
    }

    if (typeof effectiveTrack !== 'string' || SCALING_ASSUMPTIONS.ALLOWED_TRACKS.indexOf(effectiveTrack) === -1) {
      return null;
    }

    if (!isAdaptive || effectiveTrack === 'Standard' || effectiveTrack === 'Baseline') {
      return Math.min(
        SCALING_ASSUMPTIONS.SECTION_CEILING,
        Math.max(
          SCALING_ASSUMPTIONS.SECTION_FLOOR,
          Math.round(SCALING_ASSUMPTIONS.SECTION_FLOOR + clampedRatio * (SCALING_ASSUMPTIONS.SECTION_CEILING - SCALING_ASSUMPTIONS.SECTION_FLOOR))
        )
      );
    }

    if (effectiveTrack === 'Hard') {
      var curvedHard = Math.pow(clampedRatio, SCALING_ASSUMPTIONS.HARD_TRACK_EXPONENT);
      return Math.min(
        SCALING_ASSUMPTIONS.SECTION_CEILING,
        Math.max(
          SCALING_ASSUMPTIONS.SECTION_FLOOR,
          Math.round(SCALING_ASSUMPTIONS.SECTION_FLOOR + curvedHard * (SCALING_ASSUMPTIONS.SECTION_CEILING - SCALING_ASSUMPTIONS.SECTION_FLOOR))
        )
      );
    }

    if (effectiveTrack === 'Easy') {
      var curvedEasy = Math.pow(clampedRatio, SCALING_ASSUMPTIONS.EASY_TRACK_EXPONENT);
      return Math.min(
        SCALING_ASSUMPTIONS.EASY_TRACK_MAX,
        Math.max(
          SCALING_ASSUMPTIONS.SECTION_FLOOR,
          Math.round(SCALING_ASSUMPTIONS.SECTION_FLOOR + curvedEasy * (SCALING_ASSUMPTIONS.EASY_TRACK_MAX - SCALING_ASSUMPTIONS.SECTION_FLOOR))
        )
      );
    }

    return null;
  }

  /**
   * Calculates the Wilson score interval for binomial proportion.
   *
   * @param {number} k - Number of correct responses
   * @param {number} n - Total number of attempts (n > 0)
   * @param {number} [z] - Standard normal quantile (defaults to 1.6448536269514722 for 90% CI)
   * @returns {{ center: number, lower: number, upper: number, margin: number }}
   */
  function calculateWilsonScoreInterval(k, n, z) {
    if (!n || n <= 0) return { center: 0, lower: 0, upper: 0, margin: 0 };
    var zVal = (typeof z === 'number' && z > 0) ? z : SCALING_ASSUMPTIONS.CONFIDENCE_Z_90;
    var p = Math.max(0, Math.min(1, k / n));
    var z2 = zVal * zVal;
    var denom = 1 + z2 / n;
    var center = (p + z2 / (2 * n)) / denom;
    var margin = (zVal / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
    var lower = Math.max(0, center - margin);
    var upper = Math.min(1, center + margin);
    return {
      center: center,
      lower: lower,
      upper: upper,
      margin: margin
    };
  }

  /**
   * Computes an empirical PSAT 8/9 scaled score estimate (240–1440) using unified section scaling
   * and Wilson score confidence intervals added in quadrature.
   * 120–720 for Reading and Writing, 120–720 for Math.
   * Gates section and total scores on minimum 15 attempts.
   */
  function calculateScaledScore(questions, progress) {
    var qs = Array.isArray(questions) ? questions : [];
    var prog = progress || {};

    var rwAttempted = 0;
    var rwCorrect = 0;
    var mathAttempted = 0;
    var mathCorrect = 0;

    qs.forEach(function (q) {
      if (!q || !q.id) return;
      var p = prog[q.id];
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

    var MIN_PER_SECTION = SCALING_ASSUMPTIONS.MIN_PER_SECTION;
    var rwReady = rwAttempted >= MIN_PER_SECTION;
    var mathReady = mathAttempted >= MIN_PER_SECTION;
    var isReady = rwReady && mathReady;

    var rwAcc = rwAttempted > 0 ? (rwCorrect / rwAttempted) : 0;
    var mathAcc = mathAttempted > 0 ? (mathCorrect / mathAttempted) : 0;

    var rwScore = rwReady ? scaleSectionRawScore(rwAcc, 'Standard', false) : null;
    var mathScore = mathReady ? scaleSectionRawScore(mathAcc, 'Standard', false) : null;
    var totalScore = (rwScore !== null && mathScore !== null) ? (rwScore + mathScore) : null;

    var rwRange = null;
    var mathRange = null;
    var totalRange = null;

    if (rwReady) {
      var rwWilson = calculateWilsonScoreInterval(rwCorrect, rwAttempted, SCALING_ASSUMPTIONS.CONFIDENCE_Z_90);
      var rwLower = Math.max(SCALING_ASSUMPTIONS.SECTION_FLOOR, scaleSectionRawScore(rwWilson.lower, 'Standard', false));
      var rwUpper = Math.min(SCALING_ASSUMPTIONS.SECTION_CEILING, scaleSectionRawScore(rwWilson.upper, 'Standard', false));
      rwRange = [rwLower, rwUpper];
    }

    if (mathReady) {
      var mathWilson = calculateWilsonScoreInterval(mathCorrect, mathAttempted, SCALING_ASSUMPTIONS.CONFIDENCE_Z_90);
      var mathLower = Math.max(SCALING_ASSUMPTIONS.SECTION_FLOOR, scaleSectionRawScore(mathWilson.lower, 'Standard', false));
      var mathUpper = Math.min(SCALING_ASSUMPTIONS.SECTION_CEILING, scaleSectionRawScore(mathWilson.upper, 'Standard', false));
      mathRange = [mathLower, mathUpper];
    }

    if (isReady && rwRange && mathRange && totalScore !== null && rwScore !== null && mathScore !== null) {
      var rwDeltaLower = Math.max(0, rwScore - rwRange[0]);
      var rwDeltaUpper = Math.max(0, rwRange[1] - rwScore);
      var mathDeltaLower = Math.max(0, mathScore - mathRange[0]);
      var mathDeltaUpper = Math.max(0, mathRange[1] - mathScore);

      var totalDeltaLower = Math.sqrt(rwDeltaLower * rwDeltaLower + mathDeltaLower * mathDeltaLower);
      var totalDeltaUpper = Math.sqrt(rwDeltaUpper * rwDeltaUpper + mathDeltaUpper * mathDeltaUpper);

      var totalLower = Math.max(SCALING_ASSUMPTIONS.TOTAL_FLOOR, Math.round(totalScore - totalDeltaLower));
      var totalUpper = Math.min(SCALING_ASSUMPTIONS.TOTAL_CEILING, Math.round(totalScore + totalDeltaUpper));
      totalRange = [totalLower, totalUpper];
    }

    var totalAttempted = rwAttempted + mathAttempted;
    var isLowSample = isReady && (rwAttempted < SCALING_ASSUMPTIONS.LOW_SAMPLE_THRESHOLD || mathAttempted < SCALING_ASSUMPTIONS.LOW_SAMPLE_THRESHOLD);

    return {
      isReady: isReady,
      rwReady: rwReady,
      mathReady: mathReady,
      isLowSample: isLowSample,
      rwAttempted: rwAttempted,
      rwCorrect: rwCorrect,
      rwScore: rwScore,
      rwRange: rwRange,
      rwRangeFormatted: rwRange ? (rwRange[0] + '–' + rwRange[1]) : null,
      mathAttempted: mathAttempted,
      mathCorrect: mathCorrect,
      mathScore: mathScore,
      mathRange: mathRange,
      mathRangeFormatted: mathRange ? (mathRange[0] + '–' + mathRange[1]) : null,
      totalScore: totalScore,
      totalRange: totalRange,
      totalRangeFormatted: totalRange ? (totalRange[0] + '–' + totalRange[1]) : null,
      confidenceInterval: isReady ? '90% Confidence Interval' : null,
      dataBasis: 'Practice Bank Performance (' + totalAttempted + ' Attempts)',
      difficultyDisclosure: 'Estimated from practice mix, which is harder than a real test form (~60% Hard items vs standard blueprint).',
      totalAttempted: totalAttempted,
      overallAccuracyPercent: totalAttempted > 0 ? Math.round(((rwCorrect + mathCorrect) / totalAttempted) * 100) : 0,
      minRequiredPerSection: MIN_PER_SECTION,
      lowSampleThreshold: SCALING_ASSUMPTIONS.LOW_SAMPLE_THRESHOLD
    };
  }

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

  /**
   * Official PSAT 8/9 Exam Specifications & Detailed Module Blueprints
   */
  var OFFICIAL_BLUEPRINTS = {
    standard_psat89: {
      version: 'PSAT89_2026_V1',
      sections: {
        'Reading and Writing': {
          moduleCount: 2,
          questionsPerModule: 27,
          timeLimitMinutes: 32,
          domains: {
            'Craft and Structure': { target: 7, min: 6, max: 8 },
            'Information and Ideas': { target: 7, min: 6, max: 8 },
            'Standard English Conventions': { target: 7, min: 6, max: 8 },
            'Expression of Ideas': { target: 6, min: 5, max: 7 }
          }
        },
        'Math': {
          moduleCount: 2,
          questionsPerModule: 22,
          timeLimitMinutes: 35,
          domains: {
            'Algebra': { target: 8, min: 7, max: 9 },
            'Advanced Math': { target: 6, min: 5, max: 7 },
            'Problem Solving and Data Analysis': { target: 5, min: 4, max: 6 },
            'Geometry and Trigonometry': { target: 3, min: 2, max: 4 }
          },
          typeDistribution: {
            multiple_choice: 17,
            free_response: 5
          }
        }
      }
    },
    mini_psat89: {
      version: 'PSAT89_MINI_2026_V1',
      sections: {
        'Reading and Writing': {
          questionsPerModule: 4,
          timeLimitMinutes: 5,
          domains: {
            'Craft and Structure': 1,
            'Information and Ideas': 1,
            'Standard English Conventions': 1,
            'Expression of Ideas': 1
          }
        },
        'Math': {
          questionsPerModule: 4,
          timeLimitMinutes: 5,
          domains: {
            'Algebra': 1,
            'Advanced Math': 1,
            'Problem Solving and Data Analysis': 1,
            'Geometry and Trigonometry': 1
          },
          typeDistribution: {
            multiple_choice: 3,
            free_response: 1
          }
        }
      }
    }
  };

  var PSAT_89_SPECS = {
    totalQuestions: 98,
    totalTimeMinutes: 134, // 2 hours 14 minutes
    breakMinutes: 10,
    sections: {
      readingAndWriting: {
        name: 'Reading and Writing',
        totalQuestions: 54,
        totalMinutes: 64,
        modules: [
          { id: 'rw_m1', name: 'Reading and Writing — Module 1', questionsCount: 27, timeLimitSeconds: 32 * 60 },
          { id: 'rw_m2', name: 'Reading and Writing — Module 2', questionsCount: 27, timeLimitSeconds: 32 * 60 }
        ]
      },
      math: {
        name: 'Math',
        totalQuestions: 44,
        totalMinutes: 70,
        modules: [
          { id: 'math_m1', name: 'Math — Module 1', questionsCount: 22, timeLimitSeconds: 35 * 60 },
          { id: 'math_m2', name: 'Math — Module 2', questionsCount: 22, timeLimitSeconds: 35 * 60 }
        ]
      }
    }
  };

  /**
   * Helper to shuffle an array deterministically or randomly.
   */
  function _shuffle(arr) {
    var copy = arr.slice();
    for (var i = copy.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var temp = copy[i];
      copy[i] = copy[j];
      copy[j] = temp;
    }
    return copy;
  }

  /**
   * Partitions and shuffles a pool prioritizing unseen questions first (Bank Coverage Guarantee).
   * If isHighYield is enabled, prioritizes Hard/Medium difficulty and high-weight College Board domains first.
   */
  function _prioritizeUnseen(pool, progressMap, options) {
    var progress = progressMap || {};
    var opts = options || {};
    var isHighYield = (opts.isHighYield === true || opts.highYield === true);

    var unseenHighYield = [];
    var unseenStandard = [];
    var seen = [];

    var HIGH_YIELD_DOMAINS = {
      'Algebra': true,
      'Advanced Math': true,
      'Information and Ideas': true,
      'Craft and Structure': true
    };

    pool.forEach(function(q) {
      var p = progress[q.id];
      var seenCount = p ? (p.timesSeen || (p.answered ? 1 : 0)) : 0;
      if (seenCount === 0) {
        var isHy = (q.difficulty === 'Hard' || q.difficulty === 'Medium') || (HIGH_YIELD_DOMAINS[q.domain] === true);
        if (isHighYield && isHy) {
          unseenHighYield.push(q);
        } else {
          unseenStandard.push(q);
        }
      } else {
        seen.push({ question: q, timesSeen: seenCount, lastAttemptTime: p.timestamp || 0 });
      }
    });

    var result = _shuffle(unseenHighYield).concat(_shuffle(unseenStandard));

    if (seen.length > 0) {
      seen.sort(function(a, b) {
        if (a.timesSeen !== b.timesSeen) return a.timesSeen - b.timesSeen;
        return a.lastAttemptTime - b.lastAttemptTime;
      });
      result = result.concat(seen.map(function(item) { return item.question; }));
    }

    return result;
  }

  function _normalizeDomain(d) {
    if (!d) return '';
    return String(d).replace(/[-\s]+/g, ' ').trim().toLowerCase();
  }

  /**
   * Assembles a module of questions strictly conforming to the official College Board domain and difficulty blueprint.
   */
  function _assembleModuleByBlueprint(pool, sectionName, moduleTrack, progressMap, options, usedIdsMap) {
    var opts = options || {};
    var isHighYield = (opts.isHighYield === true || opts.highYield === true);
    var usedIds = usedIdsMap || {};
    var blueprint = OFFICIAL_BLUEPRINTS.standard_psat89.sections[sectionName];
    if (!blueprint) return [];

    var targetCount = blueprint.questionsPerModule;
    var isMath = (sectionName === 'Math');
    var selected = [];

    // Filter candidate pool to this section and unused items
    var available = pool.filter(function(q) {
      return (q.test === sectionName || q.section === sectionName) && !usedIds[q.id];
    });

    if (isMath) {
      var targetSpr = (blueprint.typeDistribution && blueprint.typeDistribution.free_response) || 5;
      var targetMcq = targetCount - targetSpr;

      var mathMcqs = available.filter(function(q) { return (q.type || q.question_type) !== 'free_response'; });
      var mathSprs = available.filter(function(q) { return (q.type || q.question_type) === 'free_response'; });

      // Group MCQs & SPRs by domain
      var mcqsByDomain = {};
      var sprsByDomain = {};
      Object.keys(blueprint.domains).forEach(function(d) {
        mcqsByDomain[d] = [];
        sprsByDomain[d] = [];
      });

      mathMcqs.forEach(function(q) {
        var normD = _normalizeDomain(q.domain);
        var matched = Object.keys(blueprint.domains).find(function(k) { return _normalizeDomain(k) === normD; });
        if (matched) mcqsByDomain[matched].push(q);
        else mcqsByDomain['Algebra'].push(q);
      });

      mathSprs.forEach(function(q) {
        var normD = _normalizeDomain(q.domain);
        var matched = Object.keys(blueprint.domains).find(function(k) { return _normalizeDomain(k) === normD; });
        if (matched) sprsByDomain[matched].push(q);
        else sprsByDomain['Algebra'].push(q);
      });

      // Domain targets for MCQs (Algebra: 6, Adv Math: 5, PSDA: 4, Geom: 2 = 17)
      var mcqDomainTargets = {
        'Algebra': 6,
        'Advanced Math': 5,
        'Problem Solving and Data Analysis': 4,
        'Geometry and Trigonometry': 2
      };

      // Domain targets for SPRs (Algebra: 2, Adv Math: 1, PSDA: 1, Geom: 1 = 5)
      var sprDomainTargets = {
        'Algebra': 2,
        'Advanced Math': 1,
        'Problem Solving and Data Analysis': 1,
        'Geometry and Trigonometry': 1
      };

      // 1. Pick SPRs
      Object.keys(blueprint.domains).forEach(function(dName) {
        var target = sprDomainTargets[dName] || 1;
        var sprPool = sprsByDomain[dName] || [];
        if (moduleTrack === 'Hard') {
          var hardSpr = sprPool.filter(function(q) { return q.difficulty === 'Hard' || q.difficulty === 'Medium'; });
          if (hardSpr.length >= target) sprPool = hardSpr;
        } else if (moduleTrack === 'Easy') {
          var easySpr = sprPool.filter(function(q) { return q.difficulty === 'Easy' || q.difficulty === 'Medium'; });
          if (easySpr.length >= target) sprPool = easySpr;
        }
        var prioritized = _prioritizeUnseen(sprPool, progressMap, { isHighYield: isHighYield });
        var count = 0;
        for (var i = 0; i < prioritized.length && count < target && selected.filter(function(q) { return (q.type || q.question_type) === 'free_response'; }).length < targetSpr; i++) {
          var q = prioritized[i];
          if (!usedIds[q.id]) {
            usedIds[q.id] = true;
            selected.push(q);
            count++;
          }
        }
      });

      // If under targetSpr, pad SPRs from any domain
      var curSprs = selected.filter(function(q) { return (q.type || q.question_type) === 'free_response'; }).length;
      if (curSprs < targetSpr) {
        var remSprPool = _prioritizeUnseen(mathSprs.filter(function(q) { return !usedIds[q.id]; }), progressMap, { isHighYield: isHighYield });
        for (var s = 0; s < remSprPool.length && curSprs < targetSpr; s++) {
          if (!usedIds[remSprPool[s].id]) {
            usedIds[remSprPool[s].id] = true;
            selected.push(remSprPool[s]);
            curSprs++;
          }
        }
      }

      // 2. Pick MCQs
      Object.keys(blueprint.domains).forEach(function(dName) {
        var target = mcqDomainTargets[dName] || 4;
        var mcqPool = mcqsByDomain[dName] || [];
        if (moduleTrack === 'Hard') {
          var hardMcq = mcqPool.filter(function(q) { return q.difficulty === 'Hard' || q.difficulty === 'Medium'; });
          if (hardMcq.length >= target) mcqPool = hardMcq;
        } else if (moduleTrack === 'Easy') {
          var easyMcq = mcqPool.filter(function(q) { return q.difficulty === 'Easy' || q.difficulty === 'Medium'; });
          if (easyMcq.length >= target) mcqPool = easyMcq;
        }
        var prioritized = _prioritizeUnseen(mcqPool, progressMap, { isHighYield: isHighYield });
        var count = 0;
        for (var i = 0; i < prioritized.length && count < target && (selected.length - curSprs) < targetMcq; i++) {
          var q = prioritized[i];
          if (!usedIds[q.id]) {
            usedIds[q.id] = true;
            selected.push(q);
            count++;
          }
        }
      });

      // If under targetCount, pad MCQs from any domain
      if (selected.length < targetCount) {
        var remMcqPool = _prioritizeUnseen(mathMcqs.filter(function(q) { return !usedIds[q.id]; }), progressMap, { isHighYield: isHighYield });
        for (var m = 0; m < remMcqPool.length && selected.length < targetCount; m++) {
          if (!usedIds[remMcqPool[m].id]) {
            usedIds[remMcqPool[m].id] = true;
            selected.push(remMcqPool[m]);
          }
        }
      }

      return _shuffle(selected);
    }

    // Reading and Writing Section (All MCQ)
    var byDomain = {};
    Object.keys(blueprint.domains).forEach(function(d) { byDomain[d] = []; });
    available.forEach(function(q) {
      var normD = _normalizeDomain(q.domain);
      var matched = Object.keys(blueprint.domains).find(function(k) { return _normalizeDomain(k) === normD; });
      if (matched) byDomain[matched].push(q);
      else byDomain['Craft and Structure'].push(q);
    });

    Object.keys(blueprint.domains).forEach(function(domainName) {
      var domainTarget = blueprint.domains[domainName].target;
      var domainPool = byDomain[domainName] || [];

      var preferredPool = domainPool;
      if (moduleTrack === 'Hard') {
        var hardPool = domainPool.filter(function(q) { return q.difficulty === 'Hard' || q.difficulty === 'Medium'; });
        if (hardPool.length >= domainTarget) preferredPool = hardPool;
      } else if (moduleTrack === 'Easy') {
        var easyPool = domainPool.filter(function(q) { return q.difficulty === 'Easy' || q.difficulty === 'Medium'; });
        if (easyPool.length >= domainTarget) preferredPool = easyPool;
      }

      var prioritized = _prioritizeUnseen(preferredPool, progressMap, { isHighYield: isHighYield });
      var countFromDomain = 0;
      for (var i = 0; i < prioritized.length && countFromDomain < domainTarget && selected.length < targetCount; i++) {
        var q = prioritized[i];
        if (!usedIds[q.id]) {
          usedIds[q.id] = true;
          selected.push(q);
          countFromDomain++;
        }
      }
    });

    if (selected.length < targetCount) {
      var remRwPool = _prioritizeUnseen(available.filter(function(q) { return !usedIds[q.id]; }), progressMap, { isHighYield: isHighYield });
      for (var r = 0; r < remRwPool.length && selected.length < targetCount; r++) {
        if (!usedIds[remRwPool[r].id]) {
          usedIds[remRwPool[r].id] = true;
          selected.push(remRwPool[r]);
        }
      }
    }

    return _shuffle(selected);
  }

  /**
   * Assembles a standard 98-question PSAT 8/9 exam.
   * Supports both Official Multi-Stage Adaptive (MST) mode and Linear Mode.
   * Prioritizes unseen questions from the 3,059 question bank to guarantee full bank coverage.
   * Section 1: 54 Reading & Writing (two 32-min modules of 27 Qs each)
   * Break: 10 minutes
   * Section 2: 44 Math (two 35-min modules of 22 Qs each, with realistic MCQ & SPR mix)
   */
  function generateStandardPSAT89Exam(allQuestions, options) {
    var opts = options || {};
    var isAdaptive = (opts.isAdaptive !== false);
    var isHighYield = (opts.isHighYield === true || opts.highYield === true);
    var progressMap = opts.progressMap || opts.progress || {};

    var usedIds = {};

    // 1. Reading and Writing Module 1 (Baseline / Routing Stage)
    var rwM1Qs = _assembleModuleByBlueprint(allQuestions, 'Reading and Writing', 'Baseline', progressMap, { isHighYield: isHighYield }, usedIds);

    // 2. Reading and Writing Module 2 (Adaptive Pools)
    var rwM2Hard = _assembleModuleByBlueprint(allQuestions, 'Reading and Writing', 'Hard', progressMap, { isHighYield: isHighYield }, Object.assign({}, usedIds));
    var rwM2Easy = _assembleModuleByBlueprint(allQuestions, 'Reading and Writing', 'Easy', progressMap, { isHighYield: isHighYield }, Object.assign({}, usedIds));

    // Linear fallback RW M2
    var rwM2Linear = isAdaptive ? rwM2Hard : _assembleModuleByBlueprint(allQuestions, 'Reading and Writing', 'Standard', progressMap, { isHighYield: isHighYield }, usedIds);

    // 3. Math Module 1 (Baseline / Routing Stage)
    var mathM1Qs = _assembleModuleByBlueprint(allQuestions, 'Math', 'Baseline', progressMap, { isHighYield: isHighYield }, usedIds);

    // 4. Math Module 2 (Adaptive Pools)
    var mathM2Hard = _assembleModuleByBlueprint(allQuestions, 'Math', 'Hard', progressMap, { isHighYield: isHighYield }, Object.assign({}, usedIds));
    var mathM2Easy = _assembleModuleByBlueprint(allQuestions, 'Math', 'Easy', progressMap, { isHighYield: isHighYield }, Object.assign({}, usedIds));

    // Linear fallback Math M2
    var mathM2Linear = isAdaptive ? mathM2Hard : _assembleModuleByBlueprint(allQuestions, 'Math', 'Standard', progressMap, { isHighYield: isHighYield }, usedIds);

    return {
      id: 'exam_psat89_' + Date.now(),
      title: isAdaptive ? 'Standard PSAT 8/9 Exam (2-Stage Adaptive MST)' : 'Standard PSAT 8/9 Full-Length Exam (Linear)',
      type: 'standard_psat89',
      isAdaptive: isAdaptive,
      isHighYield: isHighYield,
      blueprintVersion: OFFICIAL_BLUEPRINTS.standard_psat89.version,
      adaptivePools: isAdaptive ? {
        rwM2Hard: rwM2Hard,
        rwM2Easy: rwM2Easy,
        mathM2Hard: mathM2Hard,
        mathM2Easy: mathM2Easy
      } : null,
      routingTracks: { rw: 'Baseline', math: 'Baseline' },
      totalQuestions: 98,
      totalTimeMinutes: 134,
      breakMinutes: 10,
      createdAt: Date.now(),
      modules: [
        {
          id: 'rw_m1',
          section: 'Reading and Writing',
          moduleNumber: 1,
          name: isAdaptive ? 'Reading and Writing — Module 1 (Routing Stage)' : 'Reading and Writing — Module 1',
          track: 'Routing',
          questionsCount: rwM1Qs.length,
          timeLimitSeconds: 32 * 60,
          questions: rwM1Qs
        },
        {
          id: 'rw_m2',
          section: 'Reading and Writing',
          moduleNumber: 2,
          name: isAdaptive ? 'Reading and Writing — Module 2 (Adaptive Stage)' : 'Reading and Writing — Module 2',
          track: isAdaptive ? 'Pending Routing' : 'Standard',
          questionsCount: rwM2Linear.length,
          timeLimitSeconds: 32 * 60,
          questions: rwM2Linear
        },
        {
          id: 'math_m1',
          section: 'Math',
          moduleNumber: 1,
          name: isAdaptive ? 'Math — Module 1 (Routing Stage)' : 'Math — Module 1',
          track: 'Routing',
          questionsCount: mathM1Qs.length,
          timeLimitSeconds: 35 * 60,
          questions: mathM1Qs
        },
        {
          id: 'math_m2',
          section: 'Math',
          moduleNumber: 2,
          name: isAdaptive ? 'Math — Module 2 (Adaptive Stage)' : 'Math — Module 2',
          track: isAdaptive ? 'Pending Routing' : 'Standard',
          questionsCount: mathM2Linear.length,
          timeLimitSeconds: 35 * 60,
          questions: mathM2Linear
        }
      ]
    };
  }

  /**
   * Generates an 8-question Mini PSAT 8/9 Simulation with balanced domain coverage.
   * Supports optional adaptive routing on Math Section 2.
   * Section 1: Reading & Writing (4 Qs, 5 min, 1 per domain)
   * Break: 1 minute quick pause (with early resume)
   * Section 2: Math (4 Qs: 3 MCQs + 1 Grid-In, 5 min)
   */
  function generateMiniPSAT89Exam(allQuestions, options) {
    var opts = options || {};
    var isAdaptive = (opts.isAdaptive !== false);
    var isHighYield = (opts.isHighYield === true || opts.highYield === true);
    var progressMap = opts.progressMap || opts.progress || {};

    var usedIds = {};
    var rwDomains = ['Craft and Structure', 'Information and Ideas', 'Standard English Conventions', 'Expression of Ideas'];
    var rwM1Qs = [];

    rwDomains.forEach(function(dName) {
      var pool = allQuestions.filter(function(q) {
        return q.test === 'Reading and Writing' && q.domain === dName && !usedIds[q.id];
      });
      var prioritized = _prioritizeUnseen(pool, progressMap, { isHighYield: isHighYield });
      if (prioritized.length > 0) {
        usedIds[prioritized[0].id] = true;
        rwM1Qs.push(prioritized[0]);
      }
    });

    if (rwM1Qs.length < 4) {
      var remRw = allQuestions.filter(function(q) { return q.test === 'Reading and Writing' && !usedIds[q.id]; });
      var padRw = _prioritizeUnseen(remRw, progressMap, { isHighYield: isHighYield });
      for (var i = 0; i < padRw.length && rwM1Qs.length < 4; i++) {
        usedIds[padRw[i].id] = true;
        rwM1Qs.push(padRw[i]);
      }
    }

    var mathMcqs = _prioritizeUnseen(allQuestions.filter(function (q) { return q.test === 'Math' && (q.type || q.question_type) !== 'free_response' && !usedIds[q.id]; }), progressMap, { isHighYield: isHighYield });
    var mathSprs = _prioritizeUnseen(allQuestions.filter(function (q) { return q.test === 'Math' && (q.type || q.question_type) === 'free_response' && !usedIds[q.id]; }), progressMap, { isHighYield: isHighYield });

    var mathHardPool = mathMcqs.filter(function(q) { return q.difficulty === 'Hard' || q.difficulty === 'Medium'; });
    var mathEasyPool = mathMcqs.filter(function(q) { return q.difficulty === 'Easy' || q.difficulty === 'Medium'; });

    var mathM1Qs = _shuffle(mathMcqs.slice(0, 3).concat(mathSprs.slice(0, 1)));
    mathM1Qs.forEach(function(q) { usedIds[q.id] = true; });

    var mathM2Hard = _shuffle(mathHardPool.slice(0, 3).concat(mathSprs.slice(1, 2)));
    var mathM2Easy = _shuffle(mathEasyPool.slice(0, 3).concat(mathSprs.slice(1, 2)));

    return {
      id: 'exam_mini_' + Date.now(),
      title: isAdaptive ? 'Mini PSAT 8/9 Quick Simulation (Adaptive)' : 'Mini PSAT 8/9 Quick Simulation (8 Qs)',
      type: 'mini_psat89',
      isAdaptive: isAdaptive,
      isHighYield: isHighYield,
      blueprintVersion: OFFICIAL_BLUEPRINTS.mini_psat89.version,
      adaptivePools: isAdaptive ? {
        mathM2Hard: mathM2Hard,
        mathM2Easy: mathM2Easy
      } : null,
      routingTracks: { rw: 'Standard', math: 'Pending Routing' },
      totalQuestions: 8,
      totalTimeMinutes: 10,
      breakMinutes: 1,
      createdAt: Date.now(),
      modules: [
        {
          id: 'mini_rw_m1',
          section: 'Reading and Writing',
          moduleNumber: 1,
          name: 'Section 1: Reading and Writing',
          track: 'Standard',
          questionsCount: 4,
          timeLimitSeconds: 5 * 60,
          questions: rwM1Qs
        },
        {
          id: 'mini_math_m1',
          section: 'Math',
          moduleNumber: 2,
          name: isAdaptive ? 'Section 2: Math (Adaptive Track)' : 'Section 2: Math',
          track: isAdaptive ? 'Pending Routing' : 'Standard',
          questionsCount: 4,
          timeLimitSeconds: 5 * 60,
          questions: mathM1Qs
        }
      ]
    };
  }

  /**
   * Generates an AI/Spaced-Repetition Gap-Targeted Practice Drill.
   * Prioritizes:
   * 1. Due / Overdue Spaced Repetition cards (memory decay)
   * 2. Identified skill weaknesses (accuracy < 75% or missed questions)
   * 3. Coverage gaps in low-attempt skills
   * 4. Hard mastery challenges in high-performing skills
   */
  function generateGapTargetedDrill(allQuestions, progressMap, srsMap, options) {
    var opts = options || {};
    var count = Math.max(5, Math.min(60, opts.count || 20));
    var progress = progressMap || {};
    var srs = srsMap || {};
    var now = Date.now();

    var pool = allQuestions;
    if (opts.focus === 'math_only') {
      pool = allQuestions.filter(function (q) { return q.test === 'Math'; });
    } else if (opts.focus === 'rw_only') {
      pool = allQuestions.filter(function (q) { return q.test === 'Reading and Writing'; });
    } else if (opts.focus === 'srs_only') {
      var srsPool = allQuestions.filter(function (q) {
        return srs[q.id] && srs[q.id].dueAt && srs[q.id].dueAt <= now;
      });
      if (srsPool.length > 0) pool = srsPool;
    }

    if (opts.difficulty && opts.difficulty !== 'All') {
      var diffPool = pool.filter(function (q) { return q.difficulty === opts.difficulty; });
      if (diffPool.length > 0) pool = diffPool;
    }
    if (opts.questionType && opts.questionType !== 'all') {
      var typePool = pool.filter(function (q) {
        var qType = q.type || q.question_type || 'multiple_choice';
        if (opts.questionType === 'mcq') return qType !== 'free_response';
        if (opts.questionType === 'spr') return qType === 'free_response';
        return true;
      });
      if (typePool.length > 0) pool = typePool;
    }

    // 1. Calculate Skill Accuracy Profile
    var skillStats = {};
    allQuestions.forEach(function (q) {
      if (!skillStats[q.skill]) {
        skillStats[q.skill] = { attempted: 0, correct: 0, total: 0, domain: q.domain, test: q.test };
      }
      skillStats[q.skill].total++;
      var p = progress[q.id];
      if (p && p.answered) {
        skillStats[q.skill].attempted++;
        if (p.isCorrect) skillStats[q.skill].correct++;
      }
    });

    var weakSkills = new Set();
    Object.entries(skillStats).forEach(function (entry) {
      var skill = entry[0];
      var data = entry[1];
      if (data.attempted >= 2 && (data.correct / data.attempted) < 0.75) {
        weakSkills.add(skill);
      }
    });

    if (opts.focus === 'weak_only') {
      var weakPool = allQuestions.filter(function (q) {
        var p = progress[q.id];
        return weakSkills.has(q.skill) || (p && p.answered && !p.isCorrect);
      });
      if (weakPool.length > 0) pool = weakPool;
    }

    // 2. Score questions into Gap Priority Buckets
    var scoredQuestions = pool.map(function (q) {
      var p = progress[q.id];
      var s = srs[q.id];
      var priorityScore = 0;
      var reason = 'General Practice';

      if (s && s.dueAt && s.dueAt <= now) {
        priorityScore = 100 + Math.min(50, Math.floor((now - s.dueAt) / 86400000));
        reason = '⏰ Spaced Repetition Due (Memory Retention)';
      } else if (p && p.answered && !p.isCorrect) {
        priorityScore = 80;
        reason = '❌ Previously Missed Question';
      } else if (weakSkills.has(q.skill)) {
        priorityScore = 65;
        reason = '⚠️ Skill Weakness: ' + q.skill;
      } else if (!p || !p.answered) {
        priorityScore = 40;
        reason = '🆕 Unpracticed Skill Coverage: ' + q.skill;
      } else if (q.difficulty === 'Hard') {
        priorityScore = 25;
        reason = '⭐ Mastery Challenge (Hard)';
      } else {
        priorityScore = 10;
        reason = 'Reinforcement Review';
      }

      // Add a small jitter to rotate questions with equal priority
      priorityScore += Math.random() * 5;

      return {
        question: q,
        score: priorityScore,
        gapReason: reason
      };
    });

    // Sort by priority descending
    scoredQuestions.sort(function (a, b) { return b.score - a.score; });

    var selected = scoredQuestions.slice(0, count).map(function (item) {
      var qCopy = Object.assign({}, item.question);
      qCopy.gapReason = item.gapReason;
      return qCopy;
    });

    return {
      id: 'drill_gap_' + Date.now(),
      title: 'Adaptive Spaced Repetition Gap-Targeted Drill',
      type: 'gap_targeted_drill',
      totalQuestions: selected.length,
      timeLimitMinutes: Math.round(selected.length * 1.5), // ~1.5 mins per question
      createdAt: Date.now(),
      questions: selected
    };
  }

  /**
   * Computes dynamic reactive stats and focus metrics for the Gap Drill builder.
   */
  function calculateGapFocusMetrics(allQuestions, progressMap, srsMap, focusType) {
    allQuestions = allQuestions || [];
    progressMap = progressMap || {};
    srsMap = srsMap || {};
    focusType = focusType || 'all';
    var now = Date.now();

    // 1. Calculate Skill Accuracy Profile
    var skillStats = {};
    allQuestions.forEach(function (q) {
      if (!skillStats[q.skill]) {
        skillStats[q.skill] = { attempted: 0, correct: 0, total: 0, domain: q.domain, test: q.test };
      }
      skillStats[q.skill].total++;
      var p = progressMap[q.id];
      if (p && p.answered) {
        skillStats[q.skill].attempted++;
        if (p.isCorrect) skillStats[q.skill].correct++;
      }
    });

    var weakSkills = new Set();
    var weakSkillsMath = new Set();
    var weakSkillsRW = new Set();
    Object.entries(skillStats).forEach(function (entry) {
      var skill = entry[0];
      var data = entry[1];
      if (data.attempted >= 2 && (data.correct / data.attempted) < 0.75) {
        weakSkills.add(skill);
        if (data.test === 'Math') weakSkillsMath.add(skill);
        else if (data.test === 'Reading and Writing') weakSkillsRW.add(skill);
      }
    });

    // 2. SRS Due counts
    var dueCardsAll = 0, dueCardsMath = 0, dueCardsRW = 0, totalSrsCards = 0;
    allQuestions.forEach(function (q) {
      var s = srsMap[q.id];
      if (s && (s.repetitions > 0 || s.interval > 0 || (s.dueAt && s.dueAt <= now))) {
        totalSrsCards++;
        if (s.dueAt && s.dueAt <= now) {
          dueCardsAll++;
          if (q.test === 'Math') dueCardsMath++;
          else if (q.test === 'Reading and Writing') dueCardsRW++;
        }
      }
    });

    var matchingPool = allQuestions;
    var focusShortName = 'Gap Drill';
    var focusDescription = 'Comprehensive Drill: Prioritizes due SRS reviews, <75% accuracy weaknesses, and unpracticed coverage across all domains.';
    var statLabel1 = 'Due SRS Cards';
    var statValue1 = dueCardsAll;
    var statLabel2 = 'Weak Skills';
    var statValue2 = weakSkills.size;

    if (focusType === 'math_only') {
      matchingPool = allQuestions.filter(function (q) { return q.test === 'Math'; });
      focusShortName = 'Math Drill';
      focusDescription = 'Math Mastery Focus: Targets due math reviews, weak math skills (<75%), and high-yield math coverage.';
      statLabel1 = 'Due Math Cards';
      statValue1 = dueCardsMath;
      statLabel2 = 'Weak Math Skills';
      statValue2 = weakSkillsMath.size;
    } else if (focusType === 'rw_only') {
      matchingPool = allQuestions.filter(function (q) { return q.test === 'Reading and Writing'; });
      focusShortName = 'R&W Drill';
      focusDescription = 'Reading & Writing Focus: Targets due ELA reviews, weak verbal skills (<75%), and vocabulary/grammar gaps.';
      statLabel1 = 'Due R&W Cards';
      statValue1 = dueCardsRW;
      statLabel2 = 'Weak R&W Skills';
      statValue2 = weakSkillsRW.size;
    } else if (focusType === 'srs_only') {
      matchingPool = allQuestions.filter(function (q) {
        return srsMap[q.id] && srsMap[q.id].dueAt && srsMap[q.id].dueAt <= now;
      });
      if (matchingPool.length === 0) matchingPool = allQuestions.filter(function (q) { return srsMap[q.id] && srsMap[q.id].repetitions > 0; });
      focusShortName = 'SRS Review';
      focusDescription = 'Spaced Repetition Review: Exclusively tests cards scheduled for memory decay retention by the SM-2 algorithm.';
      statLabel1 = 'Due SRS Cards';
      statValue1 = dueCardsAll;
      statLabel2 = 'Total SRS Cards';
      statValue2 = totalSrsCards;
    } else if (focusType === 'weak_only') {
      matchingPool = allQuestions.filter(function (q) {
        var p = progressMap[q.id];
        return weakSkills.has(q.skill) || (p && p.answered && !p.isCorrect);
      });
      focusShortName = 'Weakness Drill';
      focusDescription = 'Weakness Remediation Focus: Targets only questions with <75% accuracy and previously missed items.';
      statLabel1 = 'Weak Skills (<75%)';
      statValue1 = weakSkills.size;
      statLabel2 = 'Missed & Weak Qs';
      statValue2 = matchingPool.length;
    }

    return {
      focusType: focusType,
      focusShortName: focusShortName,
      focusDescription: focusDescription,
      matchingPoolCount: matchingPool.length,
      statLabel1: statLabel1,
      statValue1: statValue1,
      statLabel2: statLabel2,
      statValue2: statValue2,
      dueCardsCount: dueCardsAll,
      weakSkillsCount: weakSkills.size
    };
  }

  /**
   * Generates a fully customized test based on parent/teacher filter criteria.
   */
  function generateCustomTest(allQuestions, filters) {
    var f = filters || {};
    var filtered = allQuestions.filter(function (q) {
      var qType = q.type || q.question_type || 'multiple_choice';
      if (f.test && f.test !== 'Both' && q.test !== f.test) return false;
      if (Array.isArray(f.domains) && f.domains.length > 0 && !f.domains.includes(q.domain)) return false;
      if (Array.isArray(f.skills) && f.skills.length > 0 && !f.skills.includes(q.skill)) return false;
      if (Array.isArray(f.difficulties) && f.difficulties.length > 0 && !f.difficulties.includes(q.difficulty)) return false;
      if (f.questionType === 'mcq' && qType === 'free_response') return false;
      if (f.questionType === 'spr' && qType !== 'free_response') return false;
      return true;
    });

    var progressMap = f.progressMap || f.progress || {};
    var count = Math.min(filtered.length, Math.max(1, f.count || 20));
    var prioritized = _prioritizeUnseen(filtered, progressMap);
    var selected = prioritized.slice(0, count);

    var timeLimitMinutes = f.timeLimitMinutes ? parseInt(f.timeLimitMinutes, 10) : Math.round(count * 1.5);

    return {
      id: 'custom_test_' + Date.now(),
      title: f.title || 'Custom Practice Test',
      type: 'custom_test',
      totalQuestions: selected.length,
      timeLimitMinutes: timeLimitMinutes,
      isUntimed: f.isUntimed === true,
      filters: f,
      createdAt: Date.now(),
      questions: selected
    };
  }

  /**
   * Generates a targeted 10-Question Post-Exam Recovery Drill:
   * 1. Collects missed questions from the exam report (up to 5 questions).
   * 2. Finds fresh sibling questions from the exact same skill / domain for transfer testing (up to 5 questions).
   * 3. If fewer than 5 were missed, pads with high-yield domain reinforcement.
   */
  function generatePostExamRecoveryPlan(examReport, allQuestions, progressMap, options) {
    if (!examReport || !Array.isArray(allQuestions)) {
      return null;
    }
    var opts = options || {};
    var targetCount = opts.count || 10;
    var progress = progressMap || {};

    var qMap = {};
    allQuestions.forEach(function(q) { if (q && q.id) qMap[q.id] = q; });

    // 1. Collect missed questions from exam report
    var missedQuestions = [];
    var seenMissedIds = {};

    if (Array.isArray(examReport.moduleReports)) {
      examReport.moduleReports.forEach(function(mod) {
        if (Array.isArray(mod.questions)) {
          mod.questions.forEach(function(mq) {
            var qId = mq.questionId || mq.id;
            // Use mq.isCorrect directly as the authoritative source of truth from scoreStandardExam
            var isCorrect = (mq.isCorrect === true);
            if (!isCorrect && qMap[qId] && !seenMissedIds[qId]) {
              seenMissedIds[qId] = true;
              missedQuestions.push(Object.assign({}, qMap[qId], {
                _recoveryRole: 'missed_review',
                _recoveryReason: 'Direct Exam Miss'
              }));
            }
          });
        }
      });
    }

    var maxDirectMisses = Math.min(missedQuestions.length, Math.floor(targetCount / 2));
    var directMisses = missedQuestions.slice(0, maxDirectMisses);

    // 2. Find skill transfer sibling questions for each missed item
    var transferQuestions = [];
    var usedIds = {};
    Object.keys(seenMissedIds).forEach(function(id) { usedIds[id] = true; });

    directMisses.forEach(function(mq) {
      var siblings = allQuestions.filter(function(q) {
        if (usedIds[q.id]) return false;
        return q.test === mq.test && q.skill === mq.skill;
      });

      if (siblings.length === 0) {
        siblings = allQuestions.filter(function(q) {
          if (usedIds[q.id]) return false;
          return q.test === mq.test && q.domain === mq.domain && q.difficulty === mq.difficulty;
        });
      }

      var prioritizedSiblings = _prioritizeUnseen(siblings, progress, { isHighYield: true });
      if (prioritizedSiblings.length > 0) {
        var chosen = prioritizedSiblings[0];
        usedIds[chosen.id] = true;
        transferQuestions.push(Object.assign({}, chosen, {
          _recoveryRole: 'transfer_sibling',
          _recoveryReason: 'Concept Transfer: ' + (mq.skill || mq.domain)
        }));
      }
    });

    var selected = directMisses.concat(transferQuestions);

    // 3. If under target count, pad with remaining direct misses
    if (selected.length < targetCount) {
      var remainingMisses = missedQuestions.slice(maxDirectMisses);
      remainingMisses.forEach(function(rm) {
        if (selected.length < targetCount && !usedIds[rm.id]) {
          usedIds[rm.id] = true;
          selected.push(rm);
        }
      });
    }

    // 4. If still under target count (e.g. high-scoring exam with 1-2 misses), pad with high-yield reinforcement
    if (selected.length < targetCount) {
      var padPool = allQuestions.filter(function(q) { return !usedIds[q.id]; });
      var padPrioritized = _prioritizeUnseen(padPool, progress, { isHighYield: true });
      var padSlice = padPrioritized.slice(0, targetCount - selected.length);
      padSlice.forEach(function(pq) {
        selected.push(Object.assign({}, pq, {
          _recoveryRole: 'reinforcement',
          _recoveryReason: 'High-Yield Reinforcement: ' + (pq.skill || pq.domain)
        }));
      });
    }

    return {
      id: 'recovery_' + Date.now(),
      title: 'Post-Exam Targeted Recovery Plan (' + selected.length + ' Questions)',
      type: 'custom_test',
      totalQuestions: selected.length,
      timeLimitMinutes: Math.round(selected.length * 1.5),
      isUntimed: false,
      directMissesCount: directMisses.length,
      transferCount: transferQuestions.length,
      createdAt: Date.now(),
      questions: selected
    };
  }

  var ERROR_TAGS = {
    'concept_gap': {
      id: 'concept_gap',
      label: 'Concept Gap',
      icon: 'book-open',
      color: 'rose',
      description: 'Did not know the mathematical rule or grammatical principle',
      coachingStrategy: 'Concept Mastery & Sibling Application',
      actionPrompt: 'Review foundational rules and practice untackled sibling variations in this skill.'
    },
    'misread': {
      id: 'misread',
      label: 'Misread Question / Trap',
      icon: 'alert-triangle',
      color: 'amber',
      description: 'Understood concept but misread the prompt or fell for a trap choice',
      coachingStrategy: 'Prompt Dissection & Distractor Elimination',
      actionPrompt: 'Highlight prompt constraints and actively eliminate tempting trap answer choices.'
    },
    'calc_error': {
      id: 'calc_error',
      label: 'Calculation Slip',
      icon: 'calculator',
      color: 'blue',
      description: 'Simple arithmetic or algebraic computation error',
      coachingStrategy: 'Desmos Verification & Sign Checks',
      actionPrompt: 'Double check arithmetic signs and verify multi-step algebraic operations in Desmos.'
    },
    'time_pressure': {
      id: 'time_pressure',
      label: 'Rushed / Time Pressure',
      icon: 'clock',
      color: 'indigo',
      description: 'Had to rush or ran out of time',
      coachingStrategy: '45-Second Pacing Speed Round',
      actionPrompt: 'Condition rapid pattern recognition with fast-paced 45-second practice sets.'
    },
    'vocab_trap': {
      id: 'vocab_trap',
      label: 'Vocabulary / Wording',
      icon: 'type',
      color: 'purple',
      description: 'Unfamiliar word or nuanced context clue',
      coachingStrategy: 'Context Clue & Tone Decoding',
      actionPrompt: 'Decode tone and sentence contrast indicators before evaluating vocabulary in context.'
    }
  };

  /**
   * Aggregates student error tags across trouble spot items.
   */
  function aggregateErrorTags(troubleSpots) {
    var counts = {
      concept_gap: 0,
      misread: 0,
      calc_error: 0,
      time_pressure: 0,
      vocab_trap: 0,
      untagged: 0
    };
    var total = 0;
    (troubleSpots || []).forEach(function(ts) {
      total++;
      if (ts.errorTag && counts[ts.errorTag] !== undefined) {
        counts[ts.errorTag]++;
      } else {
        counts.untagged++;
      }
    });
    return { counts: counts, total: total };
  }

  /**
   * Generates an adaptive practice drill specifically tailored to an error tag root cause.
   */
  function generateTagCoachingDrill(allQuestions, progressMap, tagId, options) {
    var opts = options || {};
    var count = Math.max(4, Math.min(30, opts.count || 10));
    var progress = progressMap || {};
    var tagInfo = ERROR_TAGS[tagId] || ERROR_TAGS.concept_gap;

    var missedWithTag = [];
    var taggedSkills = {};
    var taggedDomains = {};

    allQuestions.forEach(function(q) {
      var p = progress[q.id];
      if (!p) return;
      var hasTag = (p.errorTag === tagId) || 
                   (Array.isArray(p.historicalErrorTags) && p.historicalErrorTags.some(function(h) { return h.tag === tagId; }));
      if (hasTag || (!p.isCorrect && p.answered)) {
        if (p.errorTag === tagId) {
          missedWithTag.push(q);
          if (q.skill) taggedSkills[q.skill] = true;
          if (q.domain) taggedDomains[q.domain] = true;
        }
      }
    });

    var selected = [];
    var usedIds = {};

    // 1. Direct review of tagged questions
    missedWithTag.forEach(function(q) {
      if (selected.length < Math.floor(count / 2) && !usedIds[q.id]) {
        usedIds[q.id] = true;
        var qCopy = Object.assign({}, q, {
          _coachingRole: 'direct_review',
          _coachingPrompt: tagInfo.actionPrompt,
          _errorTag: tagId
        });
        selected.push(qCopy);
      }
    });

    // 2. Transfer sibling questions from the exact skills with concept gaps or mistakes
    var siblingPool = allQuestions.filter(function(q) {
      return !usedIds[q.id] && (taggedSkills[q.skill] || taggedDomains[q.domain]);
    });
    var prioritizedSiblings = _prioritizeUnseen(siblingPool, progress);

    for (var i = 0; i < prioritizedSiblings.length && selected.length < count; i++) {
      var sq = prioritizedSiblings[i];
      if (!usedIds[sq.id]) {
        usedIds[sq.id] = true;
        selected.push(Object.assign({}, sq, {
          _coachingRole: 'transfer_reinforcement',
          _coachingPrompt: tagInfo.coachingStrategy + ': Sibling Concept Application',
          _errorTag: tagId
        }));
      }
    }

    // 3. Fallback padding if needed
    if (selected.length < count) {
      var remainingPool = _prioritizeUnseen(allQuestions.filter(function(q) { return !usedIds[q.id]; }), progress);
      for (var j = 0; j < remainingPool.length && selected.length < count; j++) {
        var rq = remainingPool[j];
        if (!usedIds[rq.id]) {
          usedIds[rq.id] = true;
          selected.push(Object.assign({}, rq, {
            _coachingRole: 'reinforcement',
            _coachingPrompt: 'Skill Reinforcement: ' + (rq.skill || rq.domain)
          }));
        }
      }
    }

    // Timing customization: Time Pressure drills use speed pacing (45 seconds per question)
    var isTimePressure = (tagId === 'time_pressure');
    var timeLimitMinutes = isTimePressure ? Math.max(2, Math.round(selected.length * 0.75)) : Math.round(selected.length * 1.5);

    return {
      id: 'coaching_' + tagId + '_' + Date.now(),
      title: 'Targeted Coaching: ' + tagInfo.label + ' (' + selected.length + ' Qs)',
      type: 'tag_coaching_drill',
      tagId: tagId,
      tagInfo: tagInfo,
      totalQuestions: selected.length,
      timeLimitMinutes: timeLimitMinutes,
      isSpeedRound: isTimePressure,
      timeLimitPerQuestionSeconds: isTimePressure ? 45 : 90,
      createdAt: Date.now(),
      questions: selected
    };
  }

  /**
   * Aggregates error tag distributions longitudinally across weekly windows.
   */
  function calculateErrorTagTrends(progressMap, examHistory) {
    var progress = progressMap || {};
    var now = Date.now();
    var ONE_WEEK_MS = 7 * 86400000;

    var currentWeekCounts = { concept_gap: 0, misread: 0, calc_error: 0, time_pressure: 0, vocab_trap: 0, untagged: 0 };
    var priorWeekCounts = { concept_gap: 0, misread: 0, calc_error: 0, time_pressure: 0, vocab_trap: 0, untagged: 0 };
    var lifetimeCounts = { concept_gap: 0, misread: 0, calc_error: 0, time_pressure: 0, vocab_trap: 0, untagged: 0 };

    Object.keys(progress).forEach(function(qid) {
      var p = progress[qid];
      if (!p || !p.answered) return;
      var tag = p.errorTag;
      var isWrong = !p.isCorrect;
      var ts = p.timestamp || now;
      var isCurrentWeek = (now - ts) <= ONE_WEEK_MS;
      var isPriorWeek = (now - ts) > ONE_WEEK_MS && (now - ts) <= (2 * ONE_WEEK_MS);

      if (tag && lifetimeCounts[tag] !== undefined) {
        lifetimeCounts[tag]++;
        if (isCurrentWeek) currentWeekCounts[tag]++;
        else if (isPriorWeek) priorWeekCounts[tag]++;
      } else if (isWrong) {
        lifetimeCounts.untagged++;
        if (isCurrentWeek) currentWeekCounts.untagged++;
        else if (isPriorWeek) priorWeekCounts.untagged++;
      }
    });

    return {
      currentWeek: currentWeekCounts,
      priorWeek: priorWeekCounts,
      lifetime: lifetimeCounts,
      totalLifetimeTagged: Object.keys(lifetimeCounts).reduce(function(acc, k) { return k !== 'untagged' ? acc + lifetimeCounts[k] : acc; }, 0)
    };
  }

  /**
   * Calculates an empirical practice scaled score estimate for a section (120–720 scale).
   * Monotonic Guarantee: Score is strictly non-decreasing with raw correct answers across all tracks.
   * Zero raw correct always yields the baseline floor (120).
   * Upper Track scales up to 720; Lower Track is capped at 580 maximum.
   * Validates track against SCALING_ASSUMPTIONS.ALLOWED_TRACKS; returns null for unrecognized tracks.
   */
  function calculateSectionScaledScore(correct, total, track, isAdaptive) {
    if (typeof total !== 'number' || total <= 0 || typeof correct !== 'number' || correct < 0) {
      if (typeof total === 'number' && total > 0 && correct === 0) {
        return scaleSectionRawScore(0, track, isAdaptive);
      }
      return null;
    }
    var rawRatio = Math.max(0, Math.min(1, correct / total));
    return scaleSectionRawScore(rawRatio, track, isAdaptive);
  }

  /**
   * Aggregates student error trouble spots across individual question progress and exam history.
   * Accurately sums cumulative error frequencies and returns a unified list sorted by frequency.
   */
  function buildTroubleSpots(progress, examHistory, questionsData) {
    var prog = progress || {};
    var hist = Array.isArray(examHistory) ? examHistory : [];
    var allQs = Array.isArray(questionsData) ? questionsData : [];
    var qMap = {};
    allQs.forEach(function(q) { if (q && q.id) qMap[q.id] = q; });

    var troubleMap = {};

    // 1. Process from progress attempts and counters
    Object.keys(prog).forEach(function(qid) {
      var p = prog[qid];
      if (!p || !p.answered) return;

      var incorrectCount = (typeof p.timesIncorrect === 'number') ? p.timesIncorrect : (p.isCorrect ? 0 : 1);
      if (incorrectCount > 0 || !p.isCorrect) {
        var qMeta = qMap[qid] || {};
        troubleMap[qid] = {
          questionId: qid,
          question: qMeta,
          timesWrong: Math.max(1, incorrectCount),
          timesCorrect: p.timesCorrect || (p.isCorrect ? 1 : 0),
          timesSeen: p.timesSeen || (incorrectCount + (p.isCorrect ? 1 : 0)),
          lastUserAnswer: p.selectedAnswer || 'Unanswered',
          lastAttemptTime: p.timestamp || Date.now(),
          lastTimeSpentMs: p.timeSpentMs || 0,
          errorTag: p.errorTag || null
        };
      }
    });

    // 2. Process all exam reports from exam history to aggregate any additional occurrences
    hist.forEach(function(ex) {
      if (!ex || !Array.isArray(ex.moduleReports)) return;
      ex.moduleReports.forEach(function(m) {
        if (!m || !Array.isArray(m.questions)) return;
        m.questions.forEach(function(q) {
          if (q && q.answered && !q.isCorrect) {
            var qid = q.questionId || q.id;
            var qMeta = qMap[qid] || q;
            if (!troubleMap[qid]) {
              troubleMap[qid] = {
                questionId: qid,
                question: qMeta,
                timesWrong: 0,
                timesCorrect: 0,
                timesSeen: 0,
                lastUserAnswer: q.userAnswer || 'Unanswered',
                lastAttemptTime: ex.completedAt || Date.now(),
                lastTimeSpentMs: q.timeSpentMs || 0
              };
            }
            if (!prog[qid]) {
              troubleMap[qid].timesWrong++;
              troubleMap[qid].timesSeen++;
            }
            if (ex.completedAt && (!troubleMap[qid].lastAttemptTime || ex.completedAt > troubleMap[qid].lastAttemptTime)) {
              troubleMap[qid].lastAttemptTime = ex.completedAt;
              troubleMap[qid].lastUserAnswer = q.userAnswer || troubleMap[qid].lastUserAnswer;
              troubleMap[qid].lastTimeSpentMs = q.timeSpentMs || troubleMap[qid].lastTimeSpentMs;
            }
          }
        });
      });
    });

    return Object.values(troubleMap).sort(function(a, b) {
      if (b.timesWrong !== a.timesWrong) return b.timesWrong - a.timesWrong;
      return (b.lastAttemptTime || 0) - (a.lastAttemptTime || 0);
    });
  }

  /**
   * Evaluates a full standard PSAT 8/9 exam submission.
   */
  function scoreStandardExam(exam, userAnswersMap, questionTimesMap) {
    var answers = userAnswersMap || {};
    var times = questionTimesMap || {};

    var rwTotal = 0;
    var mathTotal = 0;
    var rwCorrect = 0;
    var mathCorrect = 0;
    var totalTimeSpentMs = 0;

    exam.modules.forEach(function (mod) {
      mod.questions.forEach(function (q) {
        var qSec = q.test || q.section || mod.section || 'Reading and Writing';
        if (qSec.indexOf('Math') !== -1) {
          mathTotal++;
        } else {
          rwTotal++;
        }
      });
    });
    var totalQuestionsCount = rwTotal + mathTotal;

    var moduleReports = [];

    exam.modules.forEach(function (mod) {
      var modCorrect = 0;
      var modAttempted = 0;
      var questionReviews = [];

      mod.questions.forEach(function (q) {
        var userAns = answers[q.id];
        var timeMs = times[q.id] || 0;
        totalTimeSpentMs += timeMs;

        var isCorrect = false;
        var answered = (userAns !== undefined && userAns !== null && String(userAns).trim() !== '' && String(userAns).trim() !== 'Unanswered');
        var qType = q.type || q.question_type || 'multiple_choice';

        if (answered) {
          modAttempted++;
          if (qType === 'free_response') {
            isCorrect = gradeFreeResponse(userAns, q.correct_answer);
          } else {
            isCorrect = String(userAns).trim().toUpperCase() === String(q.correct_answer).trim().toUpperCase();
          }
        }

        var qSec = q.test || q.section || mod.section || 'Reading and Writing';
        var isMath = qSec.indexOf('Math') !== -1;

        if (isCorrect) {
          modCorrect++;
          if (isMath) mathCorrect++;
          else rwCorrect++;
        }

        questionReviews.push({
          questionId: q.id,
          prompt: q.question_text || q.prompt || '',
          question_text: q.question_text || q.prompt || '',
          section: mod.section,
          domain: q.domain,
          skill: q.skill,
          difficulty: q.difficulty,
          type: qType,
          questionType: qType,
          userAnswer: answered ? userAns : 'Unanswered',
          correctAnswer: q.correct_answer,
          isCorrect: isCorrect,
          answered: answered,
          timeSpentMs: timeMs,
          rationale: q.rationale,
          image_url: q.image_url || (q.question_image ? 'data/' + q.question_image : '')
        });
      });

      moduleReports.push({
        id: mod.id,
        name: mod.name,
        section: mod.section,
        totalQuestions: mod.questions.length,
        attempted: modAttempted,
        correct: modCorrect,
        accuracyPercent: mod.questions.length > 0 ? Math.round((modCorrect / mod.questions.length) * 100) : 0,
        questions: questionReviews
      });
    });

    // Practice-based scaled score projection (requires >=15 questions per section for reliable scaling)
    var MIN_PER_SECTION = SCALING_ASSUMPTIONS.MIN_PER_SECTION;
    var rwReady = rwTotal >= MIN_PER_SECTION;
    var mathReady = mathTotal >= MIN_PER_SECTION;
    var isScaledReady = rwReady && mathReady;

    var rwTrack = (exam.routingTracks && exam.routingTracks.rw) ? exam.routingTracks.rw : (exam.isAdaptive ? null : 'Standard');
    var mathTrack = (exam.routingTracks && exam.routingTracks.math) ? exam.routingTracks.math : (exam.isAdaptive ? null : 'Standard');

    var rwScaled = rwReady ? calculateSectionScaledScore(rwCorrect, rwTotal, rwTrack, exam.isAdaptive) : null;
    var mathScaled = mathReady ? calculateSectionScaledScore(mathCorrect, mathTotal, mathTrack, exam.isAdaptive) : null;

    var scoreReliable = (rwScaled !== null && mathScaled !== null && (!exam.isAdaptive || (rwTrack !== null && mathTrack !== null)));
    if (!scoreReliable) {
      isScaledReady = false;
    }

    var totalScaled = (isScaledReady && rwScaled !== null && mathScaled !== null) ? (rwScaled + mathScaled) : null;
    var overallAcc = totalQuestionsCount > 0 ? Math.round(((rwCorrect + mathCorrect) / totalQuestionsCount) * 100) : 0;

    var allExamQIds = {};
    exam.modules.forEach(function(mod) {
      mod.questions.forEach(function(q) { allExamQIds[q.id] = true; });
    });
    var totalExamAttempted = Object.keys(answers).filter(function(k) {
      return allExamQIds[k] && answers[k] !== undefined && answers[k] !== null && String(answers[k]).trim() !== '' && String(answers[k]).trim() !== 'Unanswered';
    }).length;

    var isMini = (exam.type === 'mini_psat89' || totalQuestionsCount <= 12);
    var isFullExam = (totalQuestionsCount >= 90);

    var rwRange = null;
    var mathRange = null;
    var totalRange = null;

    if (rwReady && rwScaled !== null && rwTrack) {
      var rwWilson = calculateWilsonScoreInterval(rwCorrect, rwTotal, SCALING_ASSUMPTIONS.CONFIDENCE_Z_90);
      var rwLower = scaleSectionRawScore(rwWilson.lower, rwTrack, exam.isAdaptive);
      var rwUpper = scaleSectionRawScore(rwWilson.upper, rwTrack, exam.isAdaptive);
      if (rwLower !== null && rwUpper !== null) {
        rwRange = [Math.max(SCALING_ASSUMPTIONS.SECTION_FLOOR, rwLower), Math.min(SCALING_ASSUMPTIONS.SECTION_CEILING, rwUpper)];
      }
    }

    if (mathReady && mathScaled !== null && mathTrack) {
      var mathWilson = calculateWilsonScoreInterval(mathCorrect, mathTotal, SCALING_ASSUMPTIONS.CONFIDENCE_Z_90);
      var mathLower = scaleSectionRawScore(mathWilson.lower, mathTrack, exam.isAdaptive);
      var mathUpper = scaleSectionRawScore(mathWilson.upper, mathTrack, exam.isAdaptive);
      if (mathLower !== null && mathUpper !== null) {
        mathRange = [Math.max(SCALING_ASSUMPTIONS.SECTION_FLOOR, mathLower), Math.min(SCALING_ASSUMPTIONS.SECTION_CEILING, mathUpper)];
      }
    }

    if (isScaledReady && totalScaled !== null && rwRange && mathRange && rwScaled !== null && mathScaled !== null) {
      var rwDeltaLower = Math.max(0, rwScaled - rwRange[0]);
      var rwDeltaUpper = Math.max(0, rwRange[1] - rwScaled);
      var mathDeltaLower = Math.max(0, mathScaled - mathRange[0]);
      var mathDeltaUpper = Math.max(0, mathRange[1] - mathScaled);

      var totalDeltaLower = Math.sqrt(rwDeltaLower * rwDeltaLower + mathDeltaLower * mathDeltaLower);
      var totalDeltaUpper = Math.sqrt(rwDeltaUpper * rwDeltaUpper + mathDeltaUpper * mathDeltaUpper);

      var totalLower = Math.max(SCALING_ASSUMPTIONS.TOTAL_FLOOR, Math.round(totalScaled - totalDeltaLower));
      var totalUpper = Math.min(SCALING_ASSUMPTIONS.TOTAL_CEILING, Math.round(totalScaled + totalDeltaUpper));
      totalRange = [totalLower, totalUpper];
    }

    var confidenceStr = '90% Confidence Interval';
    var dataBasisStr = isFullExam ? '98-Question Standard PSAT 8/9 Benchmark' : (isMini ? '8-Question Quick Simulation' : (totalQuestionsCount + '-Question Custom Drill'));
    var examCat = isMini ? 'mini_exam' : (exam.isHighYield ? 'high_yield_sprint' : (isFullExam ? 'standard_benchmark' : 'custom_drill'));

    return {
      examId: exam.id,
      completedAt: Date.now(),
      isAdaptive: exam.isAdaptive === true,
      isHighYield: exam.isHighYield === true,
      examCategory: examCat,
      blueprintVersion: exam.blueprintVersion || (isMini ? OFFICIAL_BLUEPRINTS.mini_psat89.version : OFFICIAL_BLUEPRINTS.standard_psat89.version),
      routingTracks: { rw: rwTrack, math: mathTrack },
      totalQuestions: totalQuestionsCount,
      totalCorrect: rwCorrect + mathCorrect,
      totalAttempted: totalExamAttempted,
      overallAccuracyPercent: overallAcc,
      scores: {
        scoreReliable: scoreReliable,
        isScaledReady: isScaledReady,
        totalScaled: isScaledReady ? totalScaled : null,
        totalRange: isScaledReady ? totalRange : null,
        totalRangeFormatted: (isScaledReady && totalRange) ? (totalRange[0] + '–' + totalRange[1]) : null,
        confidenceInterval: isScaledReady ? confidenceStr : null,
        dataBasis: dataBasisStr,
        examCategory: examCat,
        blueprintVersion: exam.blueprintVersion || (isMini ? OFFICIAL_BLUEPRINTS.mini_psat89.version : OFFICIAL_BLUEPRINTS.standard_psat89.version),
        rwScaled: (rwReady && rwScaled !== null) ? rwScaled : null,
        rwRange: (rwReady && rwRange) ? rwRange : null,
        rwRangeFormatted: (rwReady && rwRange) ? (rwRange[0] + '–' + rwRange[1]) : null,
        mathScaled: (mathReady && mathScaled !== null) ? mathScaled : null,
        mathRange: (mathReady && mathRange) ? mathRange : null,
        mathRangeFormatted: (mathReady && mathRange) ? (mathRange[0] + '–' + mathRange[1]) : null,
        rwCorrect: rwCorrect,
        rwTotal: rwTotal,
        mathCorrect: mathCorrect,
        mathTotal: mathTotal,
        rwTrack: rwTrack,
        mathTrack: mathTrack,
        minRequiredPerSection: MIN_PER_SECTION
      },
      totalTimeSpentMs: totalTimeSpentMs,
      moduleReports: moduleReports
    };
  }

  /**
   * Generates a realistic sample diagnostic data payload (24 practice attempts + 1 completed mini exam report)
   * with isSample: true markers and non-colliding wrong answers.
   */
  function generateSampleDiagnosticPayload(questions, todayDateKey) {
    if (!questions || !questions.length) {
      return { progress: {}, srsState: {}, sessionsState: {}, examHistory: [] };
    }

    var sampleProgress = {};
    var sampleSrs = {};
    var sampleSessions = {};
    var todayKey = todayDateKey || localDateKey();

    var shuffled = _shuffle(questions);
    var rwCount = 0;
    var mathCount = 0;

    for (var i = 0; i < shuffled.length && (rwCount < 12 || mathCount < 12); i++) {
      var q = shuffled[i];
      var isFreeResponse = ((q.type || q.question_type) === 'free_response');

      if (q.test === 'Reading and Writing' && rwCount < 12) {
        rwCount++;
        var isCorrect = (rwCount % 4 !== 0); // 75% accuracy
        var time = isCorrect ? 42000 : 75000;
        var chosenAnswer = q.correct_answer;
        if (!isCorrect) {
          var wrongMcq = ['A', 'B', 'C', 'D'].filter(function(l) {
            return l !== String(q.correct_answer).trim().toUpperCase();
          })[0] || 'A';
          chosenAnswer = wrongMcq;
        }

        sampleProgress[q.id] = {
          answered: true,
          selectedAnswer: chosenAnswer,
          isCorrect: isCorrect,
          timeSpentMs: time,
          timingReliable: true,
          isSample: true,
          timestamp: Date.now() - (12 - rwCount) * 3600000
        };
        var grade = gradeAttempt(isCorrect, time, true);
        sampleSrs[q.id] = scheduleNext(null, grade, Date.now() - 3600000);
        sampleSessions[todayKey] = recordDailySession(sampleSessions, isCorrect, time, todayKey, true)[todayKey];
      } else if (q.test === 'Math' && mathCount < 12) {
        mathCount++;
        var isCorrectMath = (mathCount % 3 !== 0); // ~67% accuracy
        var timeMath = isCorrectMath ? 55000 : 90000;
        var chosenAnswerMath = q.correct_answer;
        if (!isCorrectMath) {
          if (isFreeResponse) {
            chosenAnswerMath = '999999';
          } else {
            var wrongMcqMath = ['A', 'B', 'C', 'D'].filter(function(l) {
              return l !== String(q.correct_answer).trim().toUpperCase();
            })[0] || 'A';
            chosenAnswerMath = wrongMcqMath;
          }
        }

        sampleProgress[q.id] = {
          answered: true,
          selectedAnswer: chosenAnswerMath,
          isCorrect: isCorrectMath,
          timeSpentMs: timeMath,
          timingReliable: true,
          isSample: true,
          timestamp: Date.now() - (12 - mathCount) * 3600000
        };
        var gradeMath = gradeAttempt(isCorrectMath, timeMath, true);
        sampleSrs[q.id] = scheduleNext(null, gradeMath, Date.now() - 3600000);
        sampleSessions[todayKey] = recordDailySession(sampleSessions, isCorrectMath, timeMath, todayKey, true)[todayKey];
      }
    }

    var miniExam = generateMiniPSAT89Exam(questions);
    var mockAnswers = {};
    var mockTimes = {};
    miniExam.modules.forEach(function(mod, mIdx) {
      mod.questions.forEach(function(q, qIdx) {
        mockTimes[q.id] = 48000;
        if (qIdx === 0 && mIdx === 1) {
          var isSpr = ((q.type || q.question_type) === 'free_response');
          mockAnswers[q.id] = isSpr ? '999999' : (['A', 'B', 'C', 'D'].filter(function(l) {
            return l !== String(q.correct_answer).trim().toUpperCase();
          })[0] || 'A');
        } else {
          var forms = extractAcceptedForms(q.correct_answer);
          mockAnswers[q.id] = forms.length > 0 ? forms[0] : q.correct_answer;
        }
      });
    });

    var examReport = scoreStandardExam(miniExam, mockAnswers, mockTimes);
    examReport.title = 'Mini PSAT 8/9 Quick Simulation (Sample Test)';
    examReport.type = 'mini_psat89';
    examReport.formattedDate = new Date().toLocaleString();
    examReport.isSample = true;

    var leanReport = toLeanReport(examReport);

    return {
      progress: sampleProgress,
      srsState: sampleSrs,
      sessionsState: sampleSessions,
      examHistory: [leanReport]
    };
  }

  /**
   * Demo Mode State & Data Protection Manager
   * Handles safe archival of real student data before sample loading and lossless recovery.
   */
  /**
   * Checks whether synthetic sample diagnostic data is currently loaded.
   */
  function isDemoModeActive(storage, loc) {
    var store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return false;
    var env = getEnvironmentConfig(loc);
    try {
      var flag = store.getItem(env.storagePrefix + 'psat_sample_data_active') === 'true';
      if (!flag) return false;
      var progRaw = store.getItem(env.storagePrefix + 'psat_progress');
      var prog = progRaw ? JSON.parse(progRaw) : {};
      if (!prog || Object.keys(prog).length === 0) {
        try { store.removeItem(env.storagePrefix + 'psat_sample_data_active'); } catch(e) {}
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function backupRealData(storage, safeGetFn, safeSetFn, loc) {
    var store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return false;
    var env = getEnvironmentConfig(loc);
    var prefix = env.storagePrefix;

    // CRITICAL: Only write backup if demo mode is NOT already active in this environment
    if (isDemoModeActive(store, loc)) {
      return false; // Backup already contains real data; do not overwrite with sample data!
    }

    var getFn = safeGetFn || function(key, def) {
      try {
        var v = store.getItem(prefix + key);
        return v ? JSON.parse(v) : def;
      } catch (e) { return def; }
    };
    var setFn = safeSetFn || function(key, val) {
      try {
        store.setItem(prefix + key, JSON.stringify(val));
        return true;
      } catch (e) { return false; }
    };

    var backup = {
      progress: getFn('psat_progress', {}),
      srsState: getFn('psat_srs', {}),
      sessionsState: getFn('psat_sessions', {}),
      examHistory: getFn('psat_exam_history', [])
    };

    return setFn('psat_pre_sample_backup', backup);
  }

  function restoreRealData(storage, safeGetFn, safeSetFn, loc) {
    var store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return false;
    var env = getEnvironmentConfig(loc);
    var prefix = env.storagePrefix;

    var getFn = safeGetFn || function(key, def) {
      try {
        var v = store.getItem(prefix + key);
        return v ? JSON.parse(v) : def;
      } catch (e) { return def; }
    };
    var setFn = safeSetFn || function(key, val) {
      try {
        store.setItem(prefix + key, JSON.stringify(val));
        return true;
      } catch (e) { return false; }
    };
    var removeFn = function(key) {
      try { store.removeItem(prefix + key); } catch (e) {}
    };

    var backup = getFn('psat_pre_sample_backup', null);
    if (backup) {
      if (backup.progress) setFn('psat_progress', backup.progress);
      else removeFn('psat_progress');

      if (backup.srsState) setFn('psat_srs', backup.srsState);
      else removeFn('psat_srs');

      if (backup.sessionsState) setFn('psat_sessions', backup.sessionsState);
      else removeFn('psat_sessions');

      if (backup.examHistory) setFn('psat_exam_history', backup.examHistory);
      else removeFn('psat_exam_history');
    } else {
      removeFn('psat_progress');
      removeFn('psat_srs');
      removeFn('psat_sessions');
      removeFn('psat_exam_history');
    }

    removeFn('psat_sample_data_active');
    removeFn('psat_pre_sample_backup');
    return true;
  }

  /**
   * Strips redundant question payloads (text, rationales, images) to store lean records in localStorage.
   * Compresses ~200KB full reports to ~8KB per exam (~96% storage reduction).
   */
  function toLeanReport(report) {
    if (!report) return report;
    var leanModules = (report.moduleReports || []).map(function (m) {
      var leanQuestions = (m.questions || []).map(function (q) {
        return {
          questionId: q.questionId,
          userAnswer: q.userAnswer,
          isCorrect: q.isCorrect,
          answered: q.answered,
          timeSpentMs: q.timeSpentMs
        };
      });

      return {
        id: m.id,
        name: m.name,
        section: m.section,
        totalQuestions: m.totalQuestions,
        attempted: m.attempted,
        correct: m.correct,
        accuracyPercent: m.accuracyPercent,
        questions: leanQuestions
      };
    });

    return {
      examId: report.examId,
      title: report.title,
      type: report.type,
      isSample: report.isSample || false,
      completedAt: report.completedAt,
      formattedDate: report.formattedDate,
      totalQuestions: report.totalQuestions,
      totalCorrect: report.totalCorrect,
      totalAttempted: report.totalAttempted,
      overallAccuracyPercent: report.overallAccuracyPercent,
      scores: report.scores,
      totalTimeSpentMs: report.totalTimeSpentMs,
      moduleReports: leanModules
    };
  }

  /**
   * Rehydrates a lean exam report with full question text, options, image URLs, and rationales from QUESTIONS_DATA.
   */
  function rehydrateReport(leanReport, questionsData) {
    if (!leanReport) return leanReport;
    var qMap = {};
    if (Array.isArray(questionsData)) {
      questionsData.forEach(function(q) { qMap[q.id] = q; });
    }
    var rehydrated = JSON.parse(JSON.stringify(leanReport));
    if (Array.isArray(rehydrated.moduleReports)) {
      rehydrated.moduleReports.forEach(function(m) {
        if (Array.isArray(m.questions)) {
          m.questions.forEach(function(q) {
            var original = qMap[q.questionId] || {};
            q.question_text = original.question_text || original.prompt || q.question_text || '';
            q.prompt = q.question_text;
            q.rationale = original.rationale || q.rationale || '';
            q.image_url = original.image_url || (original.question_image ? 'data/' + original.question_image : '') || q.image_url || '';
            q.options = original.options || q.options || [];
            q.correctAnswer = original.correct_answer || q.correctAnswer || '';
            q.domain = original.domain || q.domain || '';
            q.skill = original.skill || q.skill || '';
            q.difficulty = original.difficulty || q.difficulty || '';
            q.section = original.test || m.section || q.section || '';
            q.type = original.type || original.question_type || q.type || 'multiple_choice';
            q.questionType = q.type;
          });
        }
      });
    }
    return rehydrated;
  }

  var CLOUD_SYNC_ENDPOINT = 'https://psat-api-4915.azurewebsites.net/api/sync';

  /**
   * Derives daily session stats directly from progress question attempt timestamps.
   */
  function deriveSessionsFromProgress(progress) {
    var sessions = {};
    if (!progress) return sessions;
    Object.keys(progress).forEach(function(qid) {
      var p = progress[qid];
      if (p && p.answered && p.timestamp) {
        var day = localDateKey(new Date(p.timestamp));
        if (!sessions[day]) {
          sessions[day] = { date: day, questionsAnswered: 0, correct: 0, totalTimeMs: 0 };
        }
        sessions[day].questionsAnswered++;
        if (p.isCorrect) sessions[day].correct++;
        sessions[day].totalTimeMs += (p.timeSpentMs || 0);
      }
    });
    return sessions;
  }

  /**
   * Merges daily session maps idempotently using Math.max and derived progress timestamps.
   * Prevents session totals and practice time from inflating across syncs and page refreshes.
   */
  function mergeSessionsState(cloudSessions, localSessions, mergedProgress) {
    var cloud = cloudSessions || {};
    var local = localSessions || {};
    var merged = {};

    var allDays = Object.keys(cloud).concat(Object.keys(local));
    allDays.forEach(function(day) {
      if (merged[day]) return;
      var cDay = cloud[day];
      var lDay = local[day];

      if (cDay && lDay) {
        merged[day] = {
          date: day,
          questionsAnswered: Math.max(cDay.questionsAnswered || cDay.totalAnswered || 0, lDay.questionsAnswered || lDay.totalAnswered || 0),
          correct: Math.max(cDay.correct || cDay.totalCorrect || 0, lDay.correct || lDay.totalCorrect || 0),
          totalTimeMs: Math.max(cDay.totalTimeMs || cDay.totalTimeSpentMs || 0, lDay.totalTimeMs || lDay.totalTimeSpentMs || 0)
        };
      } else if (cDay) {
        merged[day] = Object.assign({}, cDay);
      } else if (lDay) {
        merged[day] = Object.assign({}, lDay);
      }
    });

    if (mergedProgress && typeof mergedProgress === 'object') {
      var derived = deriveSessionsFromProgress(mergedProgress);
      Object.keys(derived).forEach(function(day) {
        var d = derived[day];
        if (!merged[day]) {
          merged[day] = d;
        } else {
          merged[day].questionsAnswered = Math.max(merged[day].questionsAnswered || 0, d.questionsAnswered);
          merged[day].correct = Math.max(merged[day].correct || 0, d.correct);
          merged[day].totalTimeMs = Math.max(merged[day].totalTimeMs || 0, d.totalTimeMs);
        }
      });
    }

    return merged;
  }

  /**
   * Merges progress maps by choosing the newer record timestamp per question.
   */
  function mergeProgress(cloudProgress, localProgress) {
    var cloud = cloudProgress || {};
    var local = localProgress || {};
    var merged = {};

    var allQids = Object.keys(cloud).concat(Object.keys(local));
    allQids.forEach(function(qid) {
      if (merged[qid]) return;
      var c = cloud[qid];
      var l = local[qid];

      if (c && l) {
        var cTime = c.timestamp || c.lastAttemptTime || 0;
        var lTime = l.timestamp || l.lastAttemptTime || 0;
        var chosen = (lTime >= cTime) ? Object.assign({}, l) : Object.assign({}, c);

        var cSeen = c.timesSeen || (c.answered ? 1 : 0);
        var lSeen = l.timesSeen || (l.answered ? 1 : 0);
        var cCorrect = c.timesCorrect || (c.answered && c.isCorrect ? 1 : 0);
        var lCorrect = l.timesCorrect || (l.answered && l.isCorrect ? 1 : 0);
        var cIncorrect = c.timesIncorrect || (c.answered && !c.isCorrect ? 1 : 0);
        var lIncorrect = l.timesIncorrect || (l.answered && !l.isCorrect ? 1 : 0);

        var cAttempts = Array.isArray(c.attempts) ? c.attempts : [];
        var lAttempts = Array.isArray(l.attempts) ? l.attempts : [];

        var attemptMap = {};
        cAttempts.forEach(function(att) { if (att && att.at) attemptMap[att.at] = att; });
        lAttempts.forEach(function(att) { if (att && att.at) attemptMap[att.at] = att; });

        var combinedAttempts = Object.values(attemptMap).sort(function(a, b) { return a.at - b.at; });
        var derivedSeen = combinedAttempts.length;
        var derivedCorrect = combinedAttempts.filter(function(a) { return a.isCorrect; }).length;
        var derivedIncorrect = derivedSeen - derivedCorrect;

        // Authoritative accumulation: Stored counters must never decay when attempt logs are capped
        var finalSeen = Math.max(cSeen, lSeen, derivedSeen);
        var finalCorrect = Math.max(cCorrect, lCorrect, derivedCorrect);
        var finalIncorrect = Math.max(cIncorrect, lIncorrect, derivedIncorrect);

        chosen.timesSeen = finalSeen;
        chosen.timesCorrect = finalCorrect;
        chosen.timesIncorrect = finalIncorrect;
        if (finalSeen > 0) {
          chosen.accuracyPercent = Math.round((finalCorrect / finalSeen) * 100);
        }
        chosen.attempts = (combinedAttempts.length > 0 ? combinedAttempts : (cAttempts.length > 0 ? cAttempts : lAttempts)).slice(-3);
        merged[qid] = chosen;
      } else if (c) {
        merged[qid] = Object.assign({}, c);
      } else if (l) {
        merged[qid] = Object.assign({}, l);
      }
    });

    return merged;
  }

  /**
   * Merges SRS card states by choosing the newer review record per question while preserving cumulative counters.
   */
  function mergeSrsState(cloudSrs, localSrs) {
    var cloud = cloudSrs || {};
    var local = localSrs || {};
    var merged = {};

    var allQids = Object.keys(cloud).concat(Object.keys(local));
    allQids.forEach(function(qid) {
      if (merged[qid]) return;
      var c = cloud[qid];
      var l = local[qid];

      if (c && l) {
        var cTime = (typeof c.lastReviewedAt === 'number') ? c.lastReviewedAt : (c.timestamp || 0);
        var lTime = (typeof l.lastReviewedAt === 'number') ? l.lastReviewedAt : (l.timestamp || 0);
        var chosen = (lTime >= cTime) ? Object.assign({}, l) : Object.assign({}, c);

        // Preserve cumulative counters across sync
        var cRev = typeof c.totalReviews === 'number' ? c.totalReviews : (c.lastReviewedAt ? 1 : 0);
        var lRev = typeof l.totalReviews === 'number' ? l.totalReviews : (l.lastReviewedAt ? 1 : 0);
        chosen.totalReviews = Math.max(cRev, lRev, chosen.totalReviews || 0);

        var cLapses = typeof c.totalLapses === 'number' ? c.totalLapses : 0;
        var lLapses = typeof l.totalLapses === 'number' ? l.totalLapses : 0;
        chosen.totalLapses = Math.max(cLapses, lLapses, chosen.totalLapses || 0);

        var cFirst = c.firstReviewedAt || c.lastReviewedAt || null;
        var lFirst = l.firstReviewedAt || l.lastReviewedAt || null;
        if (cFirst && lFirst) chosen.firstReviewedAt = Math.min(cFirst, lFirst);
        else chosen.firstReviewedAt = cFirst || lFirst || chosen.lastReviewedAt || null;

        // Merge and deduplicate review history array, capped at 20 newest events
        var cHist = Array.isArray(c.history) ? c.history : [];
        var lHist = Array.isArray(l.history) ? l.history : [];
        var histMap = {};
        cHist.concat(lHist).forEach(function(ev) {
          if (ev && ev.reviewedAt) histMap[ev.reviewedAt] = ev;
        });
        var combinedHist = Object.keys(histMap).map(function(k) { return histMap[k]; }).sort(function(a, b) { return a.reviewedAt - b.reviewedAt; }).slice(-20);
        chosen.history = combinedHist;

        if (combinedHist.length > 0) {
          var times = combinedHist.map(function(h) { return h.responseTimeMs; }).filter(function(t) { return typeof t === 'number' && t > 0; });
          if (times.length > 0) {
            chosen.avgResponseTimeMs = Math.round(times.reduce(function(a, b) { return a + b; }, 0) / times.length);
          }
        }

        merged[qid] = chosen;
      } else if (c) {
        merged[qid] = Object.assign({}, c);
        if (Array.isArray(c.history) && c.history.length > 20) merged[qid].history = c.history.slice(-20);
      } else if (l) {
        merged[qid] = Object.assign({}, l);
        if (Array.isArray(l.history) && l.history.length > 20) merged[qid].history = l.history.slice(-20);
      }
    });

    return merged;
  }

  /**
   * Merges exam histories, deduplicating by examId and capping at maxCap (default 15).
   */
  function mergeExamHistory(cloudHistory, localHistory, maxCap) {
    var cap = (typeof maxCap === 'number') ? maxCap : 15;
    var histMap = {};
    (cloudHistory || []).forEach(function(h) {
      if (h && (h.examId || h.completedAt)) {
        histMap[h.examId || h.completedAt] = h;
      }
    });
    (localHistory || []).forEach(function(h) {
      if (h && (h.examId || h.completedAt)) {
        histMap[h.examId || h.completedAt] = h;
      }
    });

    var merged = Object.values(histMap).sort(function(a, b) {
      return (b.completedAt || 0) - (a.completedAt || 0);
    });

    return merged.slice(0, cap);
  }

  /**
   * Resolves runtime environment configuration for beta vs production isolation.
   */
  function getEnvironmentConfig(loc) {
    var l = loc || (typeof window !== 'undefined' ? window.location : null);
    var isBeta = false;
    if (l) {
      var path = l.pathname || '';
      var search = l.search || '';
      isBeta = (path.indexOf('/beta') !== -1 || search.indexOf('env=beta') !== -1 || (typeof window !== 'undefined' && window.__IS_BETA__ === true));
    }
    return {
      isBeta: isBeta,
      storagePrefix: isBeta ? 'beta_' : '',
      studentName: isBeta ? 'beta_default_student' : 'default_student',
      envName: isBeta ? 'Beta Sandbox' : 'Production'
    };
  }

  /**
   * Enqueues an immutable operation to the local durable sync outbox.
   */
  function enqueueOutboxOp(store, opType, payload, loc) {
    if (!store) return null;
    var env = getEnvironmentConfig(loc);
    var outboxKey = env.storagePrefix + 'psat_sync_outbox';
    var op = {
      id: 'op_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      type: opType || 'question_attempt',
      timestamp: Date.now(),
      payload: payload || {}
    };
    try {
      var raw = store.getItem(outboxKey);
      var queue = raw ? JSON.parse(raw) : [];
      queue.push(op);
      // Cap outbox to 500 ops maximum to prevent quota issues during long offline periods
      if (queue.length > 500) {
        queue = queue.slice(-500);
      }
      store.setItem(outboxKey, JSON.stringify(queue));
      return op;
    } catch (e) {
      console.warn('Failed to enqueue outbox op:', e);
      return null;
    }
  }

  /**
   * Retrieves all pending outbox operations.
   */
  function getOutboxOps(store, loc) {
    if (!store) return [];
    var env = getEnvironmentConfig(loc);
    var outboxKey = env.storagePrefix + 'psat_sync_outbox';
    try {
      var raw = store.getItem(outboxKey);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Acknowledges and removes confirmed operations from the outbox.
   */
  function ackOutboxOps(store, ackOpIds, loc) {
    if (!store || !Array.isArray(ackOpIds) || ackOpIds.length === 0) return 0;
    var env = getEnvironmentConfig(loc);
    var outboxKey = env.storagePrefix + 'psat_sync_outbox';
    try {
      var raw = store.getItem(outboxKey);
      if (!raw) return 0;
      var queue = JSON.parse(raw);
      var ackSet = {};
      ackOpIds.forEach(function(id) { ackSet[id] = true; });
      var initialLen = queue.length;
      var filtered = queue.filter(function(op) { return !ackSet[op.id]; });
      store.setItem(outboxKey, JSON.stringify(filtered));
      return initialLen - filtered.length;
    } catch (e) {
      console.warn('Failed to ack outbox ops:', e);
      return 0;
    }
  }

  /**
   * Clears the outbox queue.
   */
  function clearOutbox(store, loc) {
    if (!store) return;
    var env = getEnvironmentConfig(loc);
    try {
      store.removeItem(env.storagePrefix + 'psat_sync_outbox');
    } catch (e) {}
  }

  /**
   * Creates a durable pre-action client snapshot in localStorage before critical state changes.
   * Capped to the last 5 snapshots to avoid storage bloat.
   */
  function createClientSnapshot(store, reason, loc) {
    if (!store) return { success: false, error: 'No storage available' };
    var env = getEnvironmentConfig(loc);
    var prefix = env.storagePrefix;
    var pKey = prefix + 'psat_progress';
    var sKey = prefix + 'psat_srs';
    var sessKey = prefix + 'psat_sessions';
    var hKey = prefix + 'psat_exam_history';
    var actKey = prefix + 'psat_active_exam_state';
    var outKey = prefix + 'psat_sync_outbox';

    var snapId = 'snap_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    var snapshot = {
      id: snapId,
      timestamp: Date.now(),
      reason: reason || 'manual_snapshot',
      env: env.envName,
      data: {
        progress: JSON.parse((store.getItem ? store.getItem(pKey) : null) || '{}'),
        srs: JSON.parse((store.getItem ? store.getItem(sKey) : null) || '{}'),
        sessions: JSON.parse((store.getItem ? store.getItem(sessKey) : null) || '{}'),
        examHistory: JSON.parse((store.getItem ? store.getItem(hKey) : null) || '[]'),
        activeExamState: JSON.parse((store.getItem ? store.getItem(actKey) : null) || 'null'),
        outbox: JSON.parse((store.getItem ? store.getItem(outKey) : null) || '[]')
      }
    };

    var snapKey = prefix + 'psat_snapshot_' + snapshot.id;
    var indexKey = prefix + 'psat_client_snapshots';

    try {
      store.setItem(snapKey, JSON.stringify(snapshot));

      var idxRaw = store.getItem(indexKey);
      var index = idxRaw ? JSON.parse(idxRaw) : [];
      index.unshift({ id: snapshot.id, timestamp: snapshot.timestamp, reason: snapshot.reason, key: snapKey });
      
      // Prune snapshots beyond 5
      if (index.length > 5) {
        var pruned = index.slice(5);
        pruned.forEach(function(item) {
          try { store.removeItem(item.key); } catch (e) {}
        });
        index = index.slice(0, 5);
      }
      store.setItem(indexKey, JSON.stringify(index));
      return { success: true, snapshotId: snapshot.id, snapshotKey: snapKey };
    } catch (err) {
      console.error('Failed to create pre-action safety snapshot:', err);
      return { success: false, error: err.message || 'Storage Quota Exceeded' };
    }
  }

  function listClientSnapshots(store, loc) {
    if (!store) return [];
    var env = getEnvironmentConfig(loc);
    var indexKey = env.storagePrefix + 'psat_client_snapshots';
    try {
      var idxRaw = store.getItem(indexKey);
      return idxRaw ? JSON.parse(idxRaw) : [];
    } catch (e) {
      return [];
    }
  }

  function restoreClientSnapshot(store, snapshotId, loc) {
    if (!store || !snapshotId) return { success: false, error: 'Invalid parameters' };
    var env = getEnvironmentConfig(loc);
    var snapKey = snapshotId.indexOf(env.storagePrefix + 'psat_snapshot_') === 0 ? 
      snapshotId : 
      (env.storagePrefix + 'psat_snapshot_' + snapshotId);
    try {
      var raw = store.getItem(snapKey);
      if (!raw) return { success: false, error: 'Snapshot not found' };
      var snap = JSON.parse(raw);
      if (!snap || !snap.data) return { success: false, error: 'Malformed snapshot data' };

      // Pre-restore snapshot of current state before rollback
      var preSnap = createClientSnapshot(store, 'pre_snapshot_rollback', loc);
      if (!preSnap || !preSnap.success) {
        return { success: false, error: 'Pre-restore safety snapshot failed: ' + ((preSnap && preSnap.error) || 'Storage error') };
      }

      var prefix = env.storagePrefix;
      store.setItem(prefix + 'psat_progress', JSON.stringify(snap.data.progress || {}));
      store.setItem(prefix + 'psat_srs', JSON.stringify(snap.data.srs || {}));
      store.setItem(prefix + 'psat_sessions', JSON.stringify(snap.data.sessions || {}));
      store.setItem(prefix + 'psat_exam_history', JSON.stringify(snap.data.examHistory || []));
      if (snap.data.activeExamState !== undefined && snap.data.activeExamState !== null) {
        store.setItem(prefix + 'psat_active_exam_state', JSON.stringify(snap.data.activeExamState));
      } else {
        try { store.removeItem(prefix + 'psat_active_exam_state'); } catch (e) {}
      }
      if (Array.isArray(snap.data.outbox)) {
        store.setItem(prefix + 'psat_sync_outbox', JSON.stringify(snap.data.outbox));
      }
      return { success: true, timestamp: snap.timestamp, reason: snap.reason };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Executes a destructive action with automated pre-action safety snapshotting and transactional rollback.
   * If snapshot creation fails, aborts immediately.
   * If mutationFn throws or returns { success: false }, automatically rolls back all storage keys to initial snapshot state.
   */
  function runTransactionalAction(store, actionName, mutationFn, loc) {
    if (!store || typeof mutationFn !== 'function') {
      return { success: false, error: 'Invalid parameters for transactional action' };
    }
    var env = getEnvironmentConfig(loc);
    
    // 1. Mandatory Pre-Action Snapshot
    var snap = createClientSnapshot(store, actionName || 'transactional_action', loc);
    if (!snap || !snap.success) {
      return {
        success: false,
        error: 'Pre-action safety snapshot creation failed: ' + ((snap && snap.error) || 'Storage error'),
        aborted: true
      };
    }

    try {
      var result = mutationFn({
        snapshotId: snap.snapshotId,
        storagePrefix: env.storagePrefix
      });

      // If mutationFn returned an explicit failure object, roll back
      if (result && result.success === false) {
        restoreClientSnapshot(store, snap.snapshotId, loc);
        return {
          success: false,
          error: result.error || 'Action failed during execution; rolled back to snapshot',
          rolledBack: true,
          snapshotId: snap.snapshotId
        };
      }

      return {
        success: true,
        snapshotId: snap.snapshotId,
        result: result
      };
    } catch (err) {
      // Automatic rollback on exception / quota error
      console.error('Transactional action failed, rolling back to snapshot ' + snap.snapshotId + ':', err);
      restoreClientSnapshot(store, snap.snapshotId, loc);
      return {
        success: false,
        error: err.message || 'Exception during execution; rolled back to snapshot',
        rolledBack: true,
        snapshotId: snap.snapshotId
      };
    }
  }

  /**
   * Pushes progress, exam history, and pending outbox operations to Cosmos DB cloud API.
   */
  function pushToCloud(store, customFetch, studentName, loc) {
    var env = getEnvironmentConfig(loc);
    var sName = studentName || env.studentName;
    var prefix = env.storagePrefix;
    var fetchFn = customFetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) return Promise.resolve({ success: false, error: 'No fetch API available' });
    if (isDemoModeActive(store, loc)) return Promise.resolve({ success: false, reason: 'demo_mode' });

    var progress = JSON.parse((store && store.getItem ? store.getItem(prefix + 'psat_progress') : null) || '{}');
    var srs = JSON.parse((store && store.getItem ? store.getItem(prefix + 'psat_srs') : null) || '{}');
    var sessions = JSON.parse((store && store.getItem ? store.getItem(prefix + 'psat_sessions') : null) || '{}');
    var history = JSON.parse((store && store.getItem ? store.getItem(prefix + 'psat_exam_history') : null) || '[]');
    var outbox = getOutboxOps(store, loc);

    var payload = {
      student_name: sName,
      progress: progress,
      srsState: srs,
      sessionsState: sessions,
      examHistory: history,
      outboxOps: outbox,
      clientTimestamp: new Date().toISOString()
    };

    return fetchFn(CLOUD_SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(res) {
      if (!res || !res.ok) {
        return { success: false, error: 'HTTP_' + (res ? res.status : 'Unknown') };
      }
      return res.json().then(function(result) {
        if (!result || !result.success || result.error) {
          return { success: false, error: (result && result.error) ? result.error : 'Server returned error' };
        }
        // Acknowledge synced outbox ops
        if (Array.isArray(result.ackOpIds) && result.ackOpIds.length > 0) {
          ackOutboxOps(store, result.ackOpIds, loc);
        } else if (outbox.length > 0) {
          ackOutboxOps(store, outbox.map(function(o) { return o.id; }), loc);
        }
        return { success: true, updatedAt: result.updatedAt, ackCount: outbox.length };
      });
    }).catch(function(err) {
      return { success: false, error: err.message };
    });
  }

  /**
   * Pulls latest progress and exam history from Cosmos DB and merges with local storage.
   */
  function pullFromCloud(store, customFetch, studentName, safeSetStorageFn, loc, forceSync) {
    var env = getEnvironmentConfig(loc);
    var sName = studentName || env.studentName;
    var prefix = env.storagePrefix;
    var fetchFn = customFetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) return Promise.resolve({ success: false, error: 'No fetch API available' });
    if (!forceSync && isDemoModeActive(store, loc)) return Promise.resolve({ success: false, reason: 'demo_mode' });
    if (forceSync && store && store.removeItem) {
      try { store.removeItem(prefix + 'psat_sample_data_active'); } catch(e) {}
    }

    var setter = safeSetStorageFn || function(key, val) {
      try {
        if (store && store.setItem) {
          store.setItem(prefix + key, JSON.stringify(val));
          return true;
        }
        return false;
      } catch (e) {
        console.error('Storage quota write error for key:', key, e);
        return false;
      }
    };

    var getter = function(key) {
      try {
        if (store && store.getItem) {
          return store.getItem(prefix + key);
        }
        return null;
      } catch (e) {
        return null;
      }
    };

    return fetchFn(CLOUD_SYNC_ENDPOINT + '?student_name=' + encodeURIComponent(sName))
      .then(function(res) {
        if (!res || !res.ok) {
          return { success: false, error: 'HTTP_' + (res ? res.status : 'Unknown') };
        }
        return res.json().then(function(result) {
          if (!result || !result.success || result.error) {
            return { success: false, error: (result && result.error) ? result.error : 'Server returned error' };
          }
          if (result.exists && result.data) {
            var cloud = result.data;
            var localProgRaw = getter('psat_progress');
            var localHistRaw = getter('psat_exam_history');
            var localSessRaw = getter('psat_sessions');
            var localSrsRaw = getter('psat_srs');

            var localProg = JSON.parse(localProgRaw || '{}');
            var localHist = JSON.parse(localHistRaw || '[]');
            var localSess = JSON.parse(localSessRaw || '{}');
            var localSrs = JSON.parse(localSrsRaw || '{}');

            var mergedProg = mergeProgress(cloud.progress, localProg);
            var mergedSrs = mergeSrsState(cloud.srsState, localSrs);
            var mergedSess = mergeSessionsState(cloud.sessionsState, localSess, mergedProg);
            var mergedHist = mergeExamHistory(cloud.examHistory, localHist, 15);

            // Pass unprefixed keys to setter (the browser storage wrapper safeSetStorage prefixes them)
            var ok1 = setter('psat_progress', mergedProg);
            var ok2 = setter('psat_srs', mergedSrs);
            var ok3 = setter('psat_sessions', mergedSess);
            var ok4 = setter('psat_exam_history', mergedHist);

            if (!ok1 || !ok2 || !ok3 || !ok4) {
              // Rollback to original uncorrupted state on partial quota write failure
              try {
                if (store) {
                  if (localProgRaw !== null && store.setItem) store.setItem(prefix + 'psat_progress', localProgRaw);
                  else if (store.removeItem) store.removeItem(prefix + 'psat_progress');

                  if (localSrsRaw !== null && store.setItem) store.setItem(prefix + 'psat_srs', localSrsRaw);
                  else if (store.removeItem) store.removeItem(prefix + 'psat_srs');

                  if (localSessRaw !== null && store.setItem) store.setItem(prefix + 'psat_sessions', localSessRaw);
                  else if (store.removeItem) store.removeItem(prefix + 'psat_sessions');

                  if (localHistRaw !== null && store.setItem) store.setItem(prefix + 'psat_exam_history', localHistRaw);
                  else if (store.removeItem) store.removeItem(prefix + 'psat_exam_history');
                }
              } catch (rollbackErr) {
                console.error('Error during storage rollback:', rollbackErr);
              }
              return { success: false, error: 'Storage quota exceeded while writing merged data', quotaExceeded: true };
            }

            return {
              success: true,
              updated: true,
              data: cloud,
              mergedHistoryCount: mergedHist.length,
              totalAttempts: Object.keys(mergedProg).length
            };
          } else if (env.isBeta && !result.exists) {
            // Beta sandbox auto-seed from production default_student if beta cloud profile is empty
            return fetchFn(CLOUD_SYNC_ENDPOINT + '?student_name=default_student')
              .then(function(prodRes) {
                if (!prodRes || !prodRes.ok) return { success: true, updated: false, empty: true };
                return prodRes.json().then(function(prodResult) {
                  if (prodResult && prodResult.exists && prodResult.data) {
                    var cloud = prodResult.data;
                    var localProgRaw = getter('psat_progress');
                    var localHistRaw = getter('psat_exam_history');
                    var localSessRaw = getter('psat_sessions');
                    var localSrsRaw = getter('psat_srs');

                    var localProg = JSON.parse(localProgRaw || '{}');
                    var localHist = JSON.parse(localHistRaw || '[]');
                    var localSess = JSON.parse(localSessRaw || '{}');
                    var localSrs = JSON.parse(localSrsRaw || '{}');

                    var mergedProg = mergeProgress(cloud.progress, localProg);
                    var mergedSrs = mergeSrsState(cloud.srsState, localSrs);
                    var mergedSess = mergeSessionsState(cloud.sessionsState, localSess, mergedProg);
                    var mergedHist = mergeExamHistory(cloud.examHistory, localHist, 15);

                    setter('psat_progress', mergedProg);
                    setter('psat_srs', mergedSrs);
                    setter('psat_sessions', mergedSess);
                    setter('psat_exam_history', mergedHist);

                    return {
                      success: true,
                      updated: true,
                      seededFromProd: true,
                      data: cloud,
                      mergedHistoryCount: mergedHist.length,
                      totalAttempts: Object.keys(mergedProg).length
                    };
                  }
                  return { success: true, updated: false, empty: true };
                });
              }).catch(function() {
                return { success: true, updated: false, empty: true };
              });
          }
          return { success: true, updated: false, empty: true };
        });
      }).catch(function(err) {
        return { success: false, error: err.message };
      });
  }
  /**
   * Renders high-fidelity, structured step-by-step rationales.
   * - Normalizes broken OCR line wraps into readable paragraphs.
   * - Splits Choice A/B/C/D into dedicated answer cards with green highlight for correct choice.
   * - Compact neutral/rose styling for incorrect traps.
   * - Detects incomplete extraction (text_complete: false) and displays notice + screenshot-first layout.
   * - HTML escaping protection against XSS.
   */
  function renderRationale(question, options) {
    options = options || {};
    var q = question || {};
    var raw = q.rationale || '';
    if (!raw.trim()) {
      return '<div class="p-4 rounded-2xl bg-amber-50/60 border border-amber-200 text-xs text-amber-800 italic">No official explanation provided for this question.</div>';
    }

    var _esc = function(s) {
      if (s === null || s === undefined) return '';
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };

    var isIncomplete = (q.text_complete === false || q.formula_complete === false || q.review_status === 'incomplete_ocr' || q.review_status === 'needs_review');
    var userAns = (options.userSelectedAnswer || options.selectedAnswer || '').trim().toUpperCase();
    var correctAns = (q.correct_answer || '').trim().toUpperCase();

    // 1. Normalize line wraps inside paragraphs while keeping real paragraph boundaries
    var normalized = raw.replace(/\r\n/g, '\n').trim();
    normalized = normalized.replace(/([^\n])\n(?!\n|[•\-\d+\.])/g, '$1 ');
    var paragraphs = normalized.split(/\n\s*\n/).map(function(p) { return p.trim(); }).filter(Boolean);

    // 2. Build Header
    var headerHtml = '';
    if (isIncomplete) {
      headerHtml = 
        '<div class="space-y-2.5 pb-2.5 border-b border-amber-200/80">' +
          '<div class="flex flex-wrap items-center justify-between gap-2 text-amber-900 font-bold text-xs uppercase tracking-wider">' +
            '<div class="flex items-center space-x-2">' +
              '<i data-lucide="alert-circle" class="w-4 h-4 text-amber-700"></i>' +
              '<span>Extracted Explanation (Partial Text)</span>' +
            '</div>' +
            (q.review_status ? '<span class="px-2 py-0.5 text-[10px] rounded font-bold uppercase ' + (q.review_status === 'verified' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800') + '">' + _esc(q.review_status) + '</span>' : '') +
          '</div>' +
          '<div class="p-3 bg-amber-100/90 border border-amber-300/90 rounded-xl text-xs text-amber-950 flex items-start space-x-2.5 shadow-2xs">' +
            '<i data-lucide="info" class="w-4 h-4 text-amber-700 shrink-0 mt-0.5"></i>' +
            '<span><strong>Notice:</strong> Some mathematical notation was lost during text extraction. Refer to the official question diagram/image above for complete formula fidelity.</span>' +
          '</div>' +
        '</div>';
    } else {
      headerHtml = 
        '<div class="flex flex-wrap items-center justify-between gap-2 text-amber-900 font-bold text-xs uppercase tracking-wider pb-2.5 border-b border-amber-200/80">' +
          '<div class="flex items-center space-x-2">' +
            '<i data-lucide="book-open" class="w-4 h-4 text-amber-700"></i>' +
            '<span>Official Step-by-Step Solution &amp; Trap Rationale</span>' +
          '</div>' +
          (q.review_status === 'verified' ? '<span class="px-2 py-0.5 text-[10px] rounded font-bold bg-emerald-100 text-emerald-800 uppercase">Verified Solution</span>' : '') +
        '</div>';
    }

    // 3. Screenshot Image for Incomplete Question (if requested)
    var imageHtml = '';
    if (options.includeScreenshot && (q.image_url || q.question_image)) {
      var imgSrc = q.image_url || ('data/' + q.question_image);
      imageHtml = 
        '<div class="p-3.5 bg-slate-50 rounded-2xl border border-slate-200 flex flex-col items-center justify-center space-y-1.5 cursor-pointer group" onclick="typeof openImageLightbox === \'function\' ? openImageLightbox(\'' + _esc(imgSrc) + '\') : window.open(\'' + _esc(imgSrc) + '\', \'_blank\')">' +
          '<img src="' + _esc(imgSrc) + '" class="max-h-64 max-w-full object-contain rounded-xl shadow-2xs transition-transform group-hover:scale-[1.01]" alt="Question Diagram">' +
          '<span class="text-[11px] text-indigo-600 font-semibold flex items-center group-hover:underline">' +
            '<i data-lucide="zoom-in" class="w-3.5 h-3.5 mr-1"></i> Click screenshot to inspect full size' +
          '</span>' +
        '</div>';
    }

    // 4. Try Choice A/B/C/D parsing for multiple choice
    var choiceRegex = /\b(Choice\s+([A-D])\b[\s\S]*?)(?=\bChoice\s+[A-D]\b|$)/gi;
    var firstChoiceMatch = /\bChoice\s+([A-D])\b/i.exec(normalized);

    var bodyHtml = '';
    if (firstChoiceMatch) {
      var firstChoiceIdx = firstChoiceMatch.index;
      var intro = normalized.substring(0, firstChoiceIdx).trim();
      var choicesText = normalized.substring(firstChoiceIdx);

      var choiceBlocks = [];
      var cMatch;
      while ((cMatch = choiceRegex.exec(choicesText)) !== null) {
        choiceBlocks.push({ letter: cMatch[2].toUpperCase(), text: cMatch[1].trim() });
      }

      var introHtml = '';
      if (intro) {
        introHtml = '<div class="text-sm text-slate-800 leading-relaxed font-serif max-w-3xl pb-1.5">' + _esc(intro) + '</div>';
      }

      var cardsHtml = choiceBlocks.map(function(c) {
        var isCorrect = (c.letter === correctAns || /is the best answer|is correct/i.test(c.text));
        var isStudentChoice = (userAns && c.letter === userAns);

        if (isCorrect) {
          return '<div class="p-4 sm:p-5 rounded-2xl border border-emerald-300 bg-emerald-50/90 text-emerald-950 shadow-2xs space-y-2">' +
            '<div class="flex items-center justify-between gap-2">' +
              '<span class="px-2.5 py-0.5 bg-emerald-600 text-white font-bold text-xs rounded-lg flex items-center shrink-0">' +
                '<i data-lucide="check" class="w-3.5 h-3.5 mr-1"></i> Choice ' + _esc(c.letter) + ' — Correct Answer ✓' +
              '</span>' +
            '</div>' +
            '<p class="text-sm sm:text-base text-emerald-950 leading-relaxed font-sans max-w-3xl">' + _esc(c.text) + '</p>' +
          '</div>';
        } else {
          return '<div class="p-3.5 sm:p-4 rounded-2xl border border-slate-200 bg-white/95 text-slate-800 shadow-2xs space-y-1.5">' +
            '<div class="flex items-center justify-between gap-2">' +
              '<span class="px-2 py-0.5 bg-slate-100 text-slate-700 font-bold text-xs rounded-lg border border-slate-200 shrink-0">' +
                'Choice ' + _esc(c.letter) + ' — Incorrect' +
              '</span>' +
              (isStudentChoice ? '<span class="px-2 py-0.5 bg-rose-100 text-rose-800 font-bold text-xs rounded-lg border border-rose-200 shrink-0">Student Selected ❌</span>' : '') +
            '</div>' +
            '<p class="text-xs sm:text-sm text-slate-600 leading-relaxed font-sans max-w-3xl">' + _esc(c.text) + '</p>' +
          '</div>';
        }
      }).join('');

      bodyHtml = introHtml + '<div class="grid grid-cols-1 gap-2.5 pt-1">' + cardsHtml + '</div>';
    } else {
      // Free response or regular prose paragraphs
      bodyHtml = '<div class="space-y-2.5 text-xs sm:text-sm text-amber-950 leading-relaxed font-sans max-w-3xl">' +
        paragraphs.map(function(p) { return '<p>' + _esc(p) + '</p>'; }).join('') +
      '</div>';
    }

    return '<div class="p-5 sm:p-6 rounded-3xl bg-amber-50/80 border border-amber-200 space-y-3.5">' +
      headerHtml +
      imageHtml +
      bodyHtml +
    '</div>';
  }

  /**
   * Scientific Expression Tokenizer & Parser
   * Deterministic mathematical evaluator supporting:
   * - Operators: +, -, *, /, %, ^ (power)
   * - Unary: +, -
   * - Parentheses: (, )
   * - Functions: sqrt, sin, cos, tan, asin, acos, atan, log (log10), ln (log_e), abs, reciprocal
   * - Constants: pi, e
   * - Memory: ans
   * - Angle Mode: DEG (default) or RAD
   */
  function evaluateScientificExpression(expr, options) {
    options = options || {};
    var angleMode = options.angleMode || 'DEG';
    var ansValue = (typeof options.ans === 'number' && !isNaN(options.ans)) ? options.ans : 0;

    if (!expr || typeof expr !== 'string') {
      return { result: null, error: 'Empty expression' };
    }

    var cleanExpr = expr.trim();
    if (cleanExpr.length > 150) {
      return { result: null, error: 'Input Too Long' };
    }

    // Tokenizer
    var tokens = [];
    var i = 0;
    var len = cleanExpr.length;

    // Normalizations for special symbols
    cleanExpr = cleanExpr
      .replace(/×/g, '*')
      .replace(/÷/g, '/')
      .replace(/−/g, '-')
      .replace(/π/g, 'pi')
      .replace(/√/g, 'sqrt')
      .replace(/sin⁻¹/g, 'asin')
      .replace(/cos⁻¹/g, 'acos')
      .replace(/tan⁻¹/g, 'atan');

    len = cleanExpr.length;

    while (i < len) {
      var ch = cleanExpr[i];

      // Whitespace
      if (/\s/.test(ch)) {
        i++;
        continue;
      }

      // Numbers: digits and decimal point
      if (/\d/.test(ch) || (ch === '.' && i + 1 < len && /\d/.test(cleanExpr[i + 1]))) {
        var numStr = '';
        while (i < len && (/\d/.test(cleanExpr[i]) || cleanExpr[i] === '.')) {
          numStr += cleanExpr[i];
          i++;
        }
        var parsedNum = parseFloat(numStr);
        if (isNaN(parsedNum)) {
          return { result: null, error: 'Invalid Number' };
        }
        tokens.push({ type: 'NUMBER', value: parsedNum });
        continue;
      }

      // Operators and Parentheses
      if ('+-*/%^()'.indexOf(ch) !== -1) {
        tokens.push({ type: 'OP', value: ch });
        i++;
        continue;
      }

      // Words / Identifiers (functions, constants, memory)
      if (/[a-zA-Z]/.test(ch)) {
        var ident = '';
        while (i < len && /[a-zA-Z0-9_]/.test(cleanExpr[i])) {
          ident += cleanExpr[i];
          i++;
        }
        var lowerIdent = ident.toLowerCase();
        if (lowerIdent === 'pi') {
          tokens.push({ type: 'NUMBER', value: Math.PI });
        } else if (lowerIdent === 'e') {
          tokens.push({ type: 'NUMBER', value: Math.E });
        } else if (lowerIdent === 'ans') {
          tokens.push({ type: 'NUMBER', value: ansValue });
        } else if (['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sqrt', 'log', 'ln', 'abs', 'reciprocal'].indexOf(lowerIdent) !== -1) {
          tokens.push({ type: 'FN', value: lowerIdent });
        } else {
          return { result: null, error: 'Unknown function: ' + ident };
        }
        continue;
      }

      return { result: null, error: 'Unexpected character: ' + ch };
    }

    if (tokens.length === 0) {
      return { result: null, error: 'Empty expression' };
    }

    // Parser state
    var pos = 0;
    var evalError = null;

    function peek() {
      return tokens[pos];
    }

    function consume(expected) {
      var tok = tokens[pos];
      if (!tok) {
        evalError = 'Unexpected end of expression';
        return null;
      }
      if (expected && (tok.value !== expected && tok.type !== expected)) {
        evalError = 'Expected ' + expected + ' but got ' + (tok.value || tok.type);
        return null;
      }
      pos++;
      return tok;
    }

    function parseExpr() {
      if (evalError) return 0;
      var left = parseTerm();
      while (!evalError && pos < tokens.length) {
        var tok = peek();
        if (tok && tok.type === 'OP' && (tok.value === '+' || tok.value === '-')) {
          consume();
          var right = parseTerm();
          if (tok.value === '+') left = left + right;
          else left = left - right;
        } else {
          break;
        }
      }
      return left;
    }

    function parseTerm() {
      if (evalError) return 0;
      var left = parsePower();
      while (!evalError && pos < tokens.length) {
        var tok = peek();
        if (tok && tok.type === 'OP' && (tok.value === '*' || tok.value === '/' || tok.value === '%')) {
          consume();
          var right = parsePower();
          if (tok.value === '*') {
            left = left * right;
          } else if (tok.value === '/') {
            if (right === 0) {
              evalError = 'Cannot divide by 0';
              return 0;
            }
            left = left / right;
          } else if (tok.value === '%') {
            if (right === 0) {
              evalError = 'Cannot divide by 0';
              return 0;
            }
            left = left % right;
          }
        } else {
          break;
        }
      }
      return left;
    }

    function parsePower() {
      if (evalError) return 0;
      var left = parseUnary();
      if (!evalError && pos < tokens.length) {
        var tok = peek();
        if (tok && tok.type === 'OP' && tok.value === '^') {
          consume();
          var right = parsePower();
          if (left < 0 && Math.floor(right) !== right) {
            evalError = 'Domain Error';
            return 0;
          }
          left = Math.pow(left, right);
        }
      }
      return left;
    }

    function parseUnary() {
      if (evalError) return 0;
      var tok = peek();
      if (tok && tok.type === 'OP' && (tok.value === '+' || tok.value === '-')) {
        consume();
        var factor = parseUnary();
        return (tok.value === '-') ? -factor : factor;
      }
      return parseFactor();
    }

    function parseFactor() {
      if (evalError) return 0;
      var tok = peek();
      if (!tok) {
        evalError = 'Unexpected end of expression';
        return 0;
      }

      if (tok.type === 'NUMBER') {
        consume();
        return tok.value;
      }

      if (tok.type === 'FN') {
        var fnName = tok.value;
        consume();
        var nextTok = peek();
        var hasParen = (nextTok && nextTok.type === 'OP' && nextTok.value === '(');
        if (hasParen) {
          consume('(');
        }
        var arg = parseExpr();
        if (hasParen) {
          if (!peek() || peek().value !== ')') {
            evalError = 'Unclosed parentheses';
            return 0;
          }
          consume(')');
        }

        if (evalError) return 0;

        if (fnName === 'sqrt') {
          if (arg < 0) {
            evalError = 'Domain Error';
            return 0;
          }
          return Math.sqrt(arg);
        } else if (fnName === 'log') {
          if (arg <= 0) {
            evalError = 'Domain Error';
            return 0;
          }
          return Math.log10(arg);
        } else if (fnName === 'ln') {
          if (arg <= 0) {
            evalError = 'Domain Error';
            return 0;
          }
          return Math.log(arg);
        } else if (fnName === 'abs') {
          return Math.abs(arg);
        } else if (fnName === 'reciprocal') {
          if (arg === 0) {
            evalError = 'Cannot divide by 0';
            return 0;
          }
          return 1 / arg;
        } else if (fnName === 'sin') {
          var rad = (angleMode === 'DEG') ? (arg * Math.PI / 180) : arg;
          var val = Math.sin(rad);
          return (Math.abs(val) < 1e-15) ? 0 : val;
        } else if (fnName === 'cos') {
          if (angleMode === 'DEG' && (Math.abs(arg % 180) === 90 || Math.abs(arg % 360) === 270)) {
            return 0;
          }
          var rad = (angleMode === 'DEG') ? (arg * Math.PI / 180) : arg;
          var val = Math.cos(rad);
          return (Math.abs(val) < 1e-15) ? 0 : val;
        } else if (fnName === 'tan') {
          if (angleMode === 'DEG') {
            var norm = Math.abs(arg) % 180;
            if (norm === 90) {
              evalError = 'Undefined';
              return 0;
            }
          }
          var rad = (angleMode === 'DEG') ? (arg * Math.PI / 180) : arg;
          var val = Math.tan(rad);
          return (Math.abs(val) < 1e-15) ? 0 : val;
        } else if (fnName === 'asin') {
          if (arg < -1 || arg > 1) {
            evalError = 'Domain Error';
            return 0;
          }
          var rad = Math.asin(arg);
          return (angleMode === 'DEG') ? (rad * 180 / Math.PI) : rad;
        } else if (fnName === 'acos') {
          if (arg < -1 || arg > 1) {
            evalError = 'Domain Error';
            return 0;
          }
          var rad = Math.acos(arg);
          return (angleMode === 'DEG') ? (rad * 180 / Math.PI) : rad;
        } else if (fnName === 'atan') {
          var rad = Math.atan(arg);
          return (angleMode === 'DEG') ? (rad * 180 / Math.PI) : rad;
        }

        evalError = 'Unknown function: ' + fnName;
        return 0;
      }

      if (tok.type === 'OP' && tok.value === '(') {
        consume('(');
        var res = parseExpr();
        if (!peek() || peek().value !== ')') {
          evalError = 'Unclosed parentheses';
          return 0;
        }
        consume(')');
        return res;
      }

      evalError = 'Syntax Error';
      return 0;
    }

    var finalResult = parseExpr();

    if (evalError) {
      return { result: null, error: evalError };
    }

    if (pos < tokens.length) {
      return { result: null, error: 'Syntax Error' };
    }

    if (typeof finalResult !== 'number' || isNaN(finalResult) || !isFinite(finalResult)) {
      return { result: null, error: 'Math Error' };
    }

    var rounded = Math.round(finalResult * 1e12) / 1e12;
    return { result: rounded, error: null };
  }

  return {
    evaluateScientificExpression: evaluateScientificExpression,
    SCALING_ASSUMPTIONS: SCALING_ASSUMPTIONS,
    scaleSectionRawScore: scaleSectionRawScore,
    calculateWilsonScoreInterval: calculateWilsonScoreInterval,
    localDateKey: localDateKey,
    parseNumeric: parseNumeric,
    extractAcceptedForms: extractAcceptedForms,
    gradeFreeResponse: gradeFreeResponse,
    formatAcceptedAnswers: formatAcceptedAnswers,
    gradeAttempt: gradeAttempt,
    scheduleNext: scheduleNext,
    calculateScaledScore: calculateScaledScore,
    recordDailySession: recordDailySession,
    calculateStreak: calculateStreak,
    PSAT_89_SPECS: PSAT_89_SPECS,
    generateStandardPSAT89Exam: generateStandardPSAT89Exam,
    generateMiniPSAT89Exam: generateMiniPSAT89Exam,
    generateGapTargetedDrill: generateGapTargetedDrill,
    generateCustomTest: generateCustomTest,
    scoreStandardExam: scoreStandardExam,
    generateSampleDiagnosticPayload: generateSampleDiagnosticPayload,
    isDemoModeActive: isDemoModeActive,
    backupRealData: backupRealData,
    restoreRealData: restoreRealData,
    toLeanReport: toLeanReport,
    rehydrateReport: rehydrateReport,
    mergeSessionsState: mergeSessionsState,
    mergeProgress: mergeProgress,
    mergeSrsState: mergeSrsState,
    mergeExamHistory: mergeExamHistory,
    calculateSectionScaledScore: calculateSectionScaledScore,
    buildTroubleSpots: buildTroubleSpots,
    generatePostExamRecoveryPlan: generatePostExamRecoveryPlan,
    ERROR_TAGS: ERROR_TAGS,
    OFFICIAL_BLUEPRINTS: OFFICIAL_BLUEPRINTS,
    aggregateErrorTags: aggregateErrorTags,
    generateTagCoachingDrill: generateTagCoachingDrill,
    calculateErrorTagTrends: calculateErrorTagTrends,
    getEnvironmentConfig: getEnvironmentConfig,
    createClientSnapshot: createClientSnapshot,
    listClientSnapshots: listClientSnapshots,
    restoreClientSnapshot: restoreClientSnapshot,
    runTransactionalAction: runTransactionalAction,
    enqueueOutboxOp: enqueueOutboxOp,
    getOutboxOps: getOutboxOps,
    ackOutboxOps: ackOutboxOps,
    clearOutbox: clearOutbox,
    compactSrsState: compactSrsState,
    _shuffle: _shuffle,
    _prioritizeUnseen: _prioritizeUnseen,
    _assembleModuleByBlueprint: _assembleModuleByBlueprint,
    pushToCloud: pushToCloud,
    pullFromCloud: pullFromCloud,
    renderRationale: renderRationale,
    calculateGapFocusMetrics: calculateGapFocusMetrics
  };
});
