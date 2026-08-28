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
   * Gates section and total scores on minimum 15 attempts.
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
    var rwReady = rwAttempted >= MIN_PER_SECTION;
    var mathReady = mathAttempted >= MIN_PER_SECTION;
    var isReady = rwReady && mathReady;

    var rwAcc = rwAttempted > 0 ? (rwCorrect / rwAttempted) : 0;
    var mathAcc = mathAttempted > 0 ? (mathCorrect / mathAttempted) : 0;

    // Mapping: 120 floor + accuracy * 600 points = 120 to 720
    var rwScore = rwReady ? Math.min(720, Math.max(120, Math.round(120 + rwAcc * 600))) : null;
    var mathScore = mathReady ? Math.min(720, Math.max(120, Math.round(120 + mathAcc * 600))) : null;
    var totalScore = (rwScore !== null && mathScore !== null) ? (rwScore + mathScore) : null;

    return {
      isReady: isReady,
      rwReady: rwReady,
      mathReady: mathReady,
      rwAttempted: rwAttempted,
      rwCorrect: rwCorrect,
      rwScore: rwScore,
      mathAttempted: mathAttempted,
      mathCorrect: mathCorrect,
      mathScore: mathScore,
      totalScore: totalScore,
      totalAttempted: rwAttempted + mathAttempted,
      minRequiredPerSection: MIN_PER_SECTION
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
   * Official PSAT 8/9 Exam Specifications
   */
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

    var rwPool = allQuestions.filter(function (q) { return q.test === 'Reading and Writing'; });
    var mathPool = allQuestions.filter(function (q) { return q.test === 'Math'; });

    var orderedRw = _prioritizeUnseen(rwPool, progressMap, { isHighYield: isHighYield });
    var orderedMath = _prioritizeUnseen(mathPool, progressMap, { isHighYield: isHighYield });

    // Module 1 (Baseline / Routing Stage): Broad mix of Easy, Medium, Hard
    var rwM1Qs = orderedRw.slice(0, 27);
    
    // For Module 2: Prepare both Harder track and Easier track pools
    var remainingRw = orderedRw.slice(27);
    var rwHardPool = remainingRw.filter(function(q) { return q.difficulty === 'Hard' || q.difficulty === 'Medium'; });
    var rwEasyPool = remainingRw.filter(function(q) { return q.difficulty === 'Easy' || q.difficulty === 'Medium'; });
    
    var rwM2Hard = _prioritizeUnseen(rwHardPool, progressMap, { isHighYield: isHighYield }).slice(0, 27);
    if (rwM2Hard.length < 27) rwM2Hard = rwM2Hard.concat(_prioritizeUnseen(remainingRw, progressMap, { isHighYield: isHighYield }).slice(0, 27 - rwM2Hard.length));
    
    var rwM2Easy = _prioritizeUnseen(rwEasyPool, progressMap, { isHighYield: isHighYield }).slice(0, 27);
    if (rwM2Easy.length < 27) rwM2Easy = rwM2Easy.concat(_prioritizeUnseen(remainingRw, progressMap, { isHighYield: isHighYield }).slice(0, 27 - rwM2Easy.length));

    // Math Section: M1 Baseline (~17 MCQs + ~5 SPRs)
    var mathMcqs = _prioritizeUnseen(orderedMath.filter(function (q) { return (q.type || q.question_type) !== 'free_response'; }), progressMap, { isHighYield: isHighYield });
    var mathSprs = _prioritizeUnseen(orderedMath.filter(function (q) { return (q.type || q.question_type) === 'free_response'; }), progressMap, { isHighYield: isHighYield });

    var mathM1Qs = _shuffle(mathMcqs.slice(0, 17).concat(mathSprs.slice(0, 5)));
    
    var remMathMcq = mathMcqs.slice(17);
    var remMathSpr = mathSprs.slice(5);

    var mathHardMcq = remMathMcq.filter(function(q) { return q.difficulty === 'Hard' || q.difficulty === 'Medium'; });
    var mathHardSpr = remMathSpr.filter(function(q) { return q.difficulty === 'Hard' || q.difficulty === 'Medium'; });
    var mathEasyMcq = remMathMcq.filter(function(q) { return q.difficulty === 'Easy' || q.difficulty === 'Medium'; });
    var mathEasySpr = remMathSpr.filter(function(q) { return q.difficulty === 'Easy' || q.difficulty === 'Medium'; });

    var mathM2Hard = _shuffle(mathHardMcq.slice(0, 17).concat(mathHardSpr.slice(0, 5)));
    if (mathM2Hard.length < 22) mathM2Hard = mathM2Hard.concat(_shuffle(remMathMcq.concat(remMathSpr)).slice(0, 22 - mathM2Hard.length));

    var mathM2Easy = _shuffle(mathEasyMcq.slice(0, 17).concat(mathEasySpr.slice(0, 5)));
    if (mathM2Easy.length < 22) mathM2Easy = mathM2Easy.concat(_shuffle(remMathMcq.concat(remMathSpr)).slice(0, 22 - mathM2Easy.length));

    var initialRwM2 = isAdaptive ? rwM2Hard : remainingRw.slice(0, 27);
    var initialMathM2 = isAdaptive ? mathM2Hard : _shuffle(remMathMcq.slice(0, 17).concat(remMathSpr.slice(0, 5)));

    return {
      id: 'exam_psat89_' + Date.now(),
      title: isAdaptive ? 'Standard PSAT 8/9 Exam (2-Stage Adaptive MST)' : 'Standard PSAT 8/9 Full-Length Exam (Linear)',
      type: 'standard_psat89',
      isAdaptive: isAdaptive,
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
          questionsCount: 27,
          timeLimitSeconds: 32 * 60,
          questions: rwM1Qs
        },
        {
          id: 'rw_m2',
          section: 'Reading and Writing',
          moduleNumber: 2,
          name: isAdaptive ? 'Reading and Writing — Module 2 (Adaptive Stage)' : 'Reading and Writing — Module 2',
          track: isAdaptive ? 'Pending Routing' : 'Standard',
          questionsCount: 27,
          timeLimitSeconds: 32 * 60,
          questions: initialRwM2
        },
        {
          id: 'math_m1',
          section: 'Math',
          moduleNumber: 1,
          name: isAdaptive ? 'Math — Module 1 (Routing Stage)' : 'Math — Module 1',
          track: 'Routing',
          questionsCount: 22,
          timeLimitSeconds: 35 * 60,
          questions: mathM1Qs
        },
        {
          id: 'math_m2',
          section: 'Math',
          moduleNumber: 2,
          name: isAdaptive ? 'Math — Module 2 (Adaptive Stage)' : 'Math — Module 2',
          track: isAdaptive ? 'Pending Routing' : 'Standard',
          questionsCount: 22,
          timeLimitSeconds: 35 * 60,
          questions: initialMathM2
        }
      ]
    };
  }

  /**
   * Generates an 8-question Mini PSAT 8/9 Simulation.
   * Supports optional adaptive routing on Math Section 2.
   * Section 1: Reading & Writing (4 Qs, 5 min)
   * Break: 1 minute quick pause (with early resume)
   * Section 2: Math (4 Qs: 3 MCQs + 1 Grid-In, 5 min)
   */
  function generateMiniPSAT89Exam(allQuestions, options) {
    var opts = options || {};
    var isAdaptive = (opts.isAdaptive !== false);
    var isHighYield = (opts.isHighYield === true || opts.highYield === true);
    var progressMap = opts.progressMap || opts.progress || {};

    var rwPool = allQuestions.filter(function (q) { return q.test === 'Reading and Writing'; });
    var mathPool = allQuestions.filter(function (q) { return q.test === 'Math'; });

    var orderedRw = _prioritizeUnseen(rwPool, progressMap, { isHighYield: isHighYield });
    var orderedMath = _prioritizeUnseen(mathPool, progressMap, { isHighYield: isHighYield });

    var rwM1Qs = orderedRw.slice(0, 4);

    var mathMcqs = _prioritizeUnseen(orderedMath.filter(function (q) { return (q.type || q.question_type) !== 'free_response'; }), progressMap, { isHighYield: isHighYield });
    var mathSprs = _prioritizeUnseen(orderedMath.filter(function (q) { return (q.type || q.question_type) === 'free_response'; }), progressMap, { isHighYield: isHighYield });

    var mathHardPool = mathMcqs.filter(function(q) { return q.difficulty === 'Hard' || q.difficulty === 'Medium'; });
    var mathEasyPool = mathMcqs.filter(function(q) { return q.difficulty === 'Easy' || q.difficulty === 'Medium'; });

    var mathM1Qs = _shuffle(mathMcqs.slice(0, 3).concat(mathSprs.slice(0, 1)));
    var mathM2Hard = _shuffle(mathHardPool.slice(0, 3).concat(mathSprs.slice(1, 2)));
    var mathM2Easy = _shuffle(mathEasyPool.slice(0, 3).concat(mathSprs.slice(1, 2)));

    return {
      id: 'exam_mini_' + Date.now(),
      title: isAdaptive ? 'Mini PSAT 8/9 Quick Simulation (Adaptive)' : 'Mini PSAT 8/9 Quick Simulation (8 Qs)',
      type: 'mini_psat89',
      isAdaptive: isAdaptive,
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
    'concept_gap': { id: 'concept_gap', label: 'Concept Gap', icon: 'book-open', color: 'rose', description: 'Did not know the mathematical rule or grammatical principle' },
    'misread': { id: 'misread', label: 'Misread Question / Trap', icon: 'alert-triangle', color: 'amber', description: 'Understood concept but misread the prompt or fell for a trap choice' },
    'calc_error': { id: 'calc_error', label: 'Calculation Slip', icon: 'calculator', color: 'blue', description: 'Simple arithmetic or algebraic computation error' },
    'time_pressure': { id: 'time_pressure', label: 'Rushed / Time Pressure', icon: 'clock', color: 'indigo', description: 'Had to rush or ran out of time' },
    'vocab_trap': { id: 'vocab_trap', label: 'Vocabulary / Wording', icon: 'type', color: 'purple', description: 'Unfamiliar word or nuanced context clue' }
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
   * Calculates an empirical practice scaled score estimate for a section (120–720 scale).
   * Monotonic Guarantee: Score is strictly non-decreasing with raw correct answers across all tracks.
   * Zero raw correct always yields the baseline floor (120).
   * Upper Track scales up to 720; Lower Track is capped at 580 maximum.
   */
  function calculateSectionScaledScore(correct, total, track, isAdaptive) {
    if (!total || total <= 0 || correct <= 0) return 120;
    var rawRatio = Math.max(0, Math.min(1, correct / total));

    if (!isAdaptive || !track || track === 'Standard' || track === 'Baseline') {
      return Math.min(720, Math.max(120, Math.round(120 + rawRatio * 600)));
    }

    if (track === 'Hard') {
      // Upper difficulty track: Floor starts at 120, smoothly scales with difficulty weighting up to 720 (100%)
      var curved = Math.pow(rawRatio, 0.85);
      return Math.min(720, Math.max(120, Math.round(120 + curved * 600)));
    } else {
      // Lower difficulty track: Capped at 580 maximum
      var curvedLower = Math.pow(rawRatio, 1.1);
      return Math.min(580, Math.max(120, Math.round(120 + curvedLower * 460)));
    }
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
    var MIN_PER_SECTION = 15;
    var rwReady = rwTotal >= MIN_PER_SECTION;
    var mathReady = mathTotal >= MIN_PER_SECTION;
    var isScaledReady = rwReady && mathReady;

    var rwTrack = (exam.routingTracks && exam.routingTracks.rw) ? exam.routingTracks.rw : (exam.isAdaptive ? 'Hard' : 'Standard');
    var mathTrack = (exam.routingTracks && exam.routingTracks.math) ? exam.routingTracks.math : (exam.isAdaptive ? 'Hard' : 'Standard');

    var rwScaled = calculateSectionScaledScore(rwCorrect, rwTotal, rwTrack, exam.isAdaptive);
    var mathScaled = calculateSectionScaledScore(mathCorrect, mathTotal, mathTrack, exam.isAdaptive);

    var totalScaled = rwScaled + mathScaled;
    var overallAcc = totalQuestionsCount > 0 ? Math.round(((rwCorrect + mathCorrect) / totalQuestionsCount) * 100) : 0;

    var allExamQIds = {};
    exam.modules.forEach(function(mod) {
      mod.questions.forEach(function(q) { allExamQIds[q.id] = true; });
    });
    var totalExamAttempted = Object.keys(answers).filter(function(k) {
      return allExamQIds[k] && answers[k] !== undefined && answers[k] !== null && String(answers[k]).trim() !== '' && String(answers[k]).trim() !== 'Unanswered';
    }).length;

    return {
      examId: exam.id,
      completedAt: Date.now(),
      isAdaptive: exam.isAdaptive === true,
      routingTracks: { rw: rwTrack, math: mathTrack },
      totalQuestions: totalQuestionsCount,
      totalCorrect: rwCorrect + mathCorrect,
      totalAttempted: totalExamAttempted,
      overallAccuracyPercent: overallAcc,
      scores: {
        isScaledReady: isScaledReady,
        totalScaled: isScaledReady ? totalScaled : null,
        rwScaled: rwReady ? rwScaled : null,
        mathScaled: mathReady ? mathScaled : null,
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
      return store.getItem(env.storagePrefix + 'psat_sample_data_active') === 'true';
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
   * Merges SRS card states by choosing the newer review record per question.
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
        merged[qid] = (lTime >= cTime) ? Object.assign({}, l) : Object.assign({}, c);
      } else if (c) {
        merged[qid] = Object.assign({}, c);
      } else if (l) {
        merged[qid] = Object.assign({}, l);
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
        examHistory: JSON.parse((store.getItem ? store.getItem(hKey) : null) || '[]')
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
      return { success: true, timestamp: snap.timestamp, reason: snap.reason };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Pushes progress and exam history to Cosmos DB cloud API.
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

    var payload = {
      student_name: sName,
      progress: progress,
      srsState: srs,
      sessionsState: sessions,
      examHistory: history,
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
        return { success: true, updatedAt: result.updatedAt };
      });
    }).catch(function(err) {
      return { success: false, error: err.message };
    });
  }

  /**
   * Pulls latest progress and exam history from Cosmos DB and merges with local storage.
   */
  function pullFromCloud(store, customFetch, studentName, safeSetStorageFn, loc) {
    var env = getEnvironmentConfig(loc);
    var sName = studentName || env.studentName;
    var prefix = env.storagePrefix;
    var fetchFn = customFetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) return Promise.resolve({ success: false, error: 'No fetch API available' });
    if (isDemoModeActive(store, loc)) return Promise.resolve({ success: false, reason: 'demo_mode' });

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
          }
          return { success: true, updated: false, empty: true };
        });
      }).catch(function(err) {
        return { success: false, error: err.message };
      });
  }

  return {
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
    aggregateErrorTags: aggregateErrorTags,
    getEnvironmentConfig: getEnvironmentConfig,
    createClientSnapshot: createClientSnapshot,
    listClientSnapshots: listClientSnapshots,
    restoreClientSnapshot: restoreClientSnapshot,
    _shuffle: _shuffle,
    _prioritizeUnseen: _prioritizeUnseen,
    pushToCloud: pushToCloud,
    pullFromCloud: pullFromCloud
  };
});
