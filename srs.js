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
   * Assembles a strictly formatted standard 98-question PSAT 8/9 exam.
   * Section 1: 54 Reading & Writing (two 32-min modules of 27 Qs each)
   * Break: 10 minutes
   * Section 2: 44 Math (two 35-min modules of 22 Qs each, with realistic MCQ & SPR mix)
   */
  function generateStandardPSAT89Exam(allQuestions) {
    var rwPool = allQuestions.filter(function (q) { return q.test === 'Reading and Writing'; });
    var mathPool = allQuestions.filter(function (q) { return q.test === 'Math'; });

    var shuffledRw = _shuffle(rwPool);
    var shuffledMath = _shuffle(mathPool);

    var rwM1Qs = shuffledRw.slice(0, 27);
    var rwM2Qs = shuffledRw.slice(27, 54);

    // For Math, ensure a realistic mix of ~17 MCQs and ~5 Free-Response per module
    var mathMcqs = shuffledMath.filter(function (q) { return (q.type || q.question_type) !== 'free_response'; });
    var mathSprs = shuffledMath.filter(function (q) { return (q.type || q.question_type) === 'free_response'; });

    var mathM1Qs = _shuffle(mathMcqs.slice(0, 17).concat(mathSprs.slice(0, 5)));
    var mathM2Qs = _shuffle(mathMcqs.slice(17, 34).concat(mathSprs.slice(5, 10)));

    return {
      id: 'exam_psat89_' + Date.now(),
      title: 'Standard PSAT 8/9 Full-Length Exam',
      type: 'standard_psat89',
      totalQuestions: 98,
      totalTimeMinutes: 134,
      breakMinutes: 10,
      createdAt: Date.now(),
      modules: [
        {
          id: 'rw_m1',
          section: 'Reading and Writing',
          moduleNumber: 1,
          name: 'Reading and Writing — Module 1',
          questionsCount: 27,
          timeLimitSeconds: 32 * 60,
          questions: rwM1Qs
        },
        {
          id: 'rw_m2',
          section: 'Reading and Writing',
          moduleNumber: 2,
          name: 'Reading and Writing — Module 2',
          questionsCount: 27,
          timeLimitSeconds: 32 * 60,
          questions: rwM2Qs
        },
        {
          id: 'math_m1',
          section: 'Math',
          moduleNumber: 1,
          name: 'Math — Module 1',
          questionsCount: 22,
          timeLimitSeconds: 35 * 60,
          questions: mathM1Qs
        },
        {
          id: 'math_m2',
          section: 'Math',
          moduleNumber: 2,
          name: 'Math — Module 2',
          questionsCount: 22,
          timeLimitSeconds: 35 * 60,
          questions: mathM2Qs
        }
      ]
    };
  }

  /**
   * Generates an 8-question Mini PSAT 8/9 Simulation for rapid ~10-minute end-to-end testing.
   * Section 1: Reading & Writing (4 Qs, 5 min)
   * Break: 1 minute quick pause (with early resume)
   * Section 2: Math (4 Qs: 3 MCQs + 1 Grid-In, 5 min)
   */
  function generateMiniPSAT89Exam(allQuestions) {
    var rwPool = allQuestions.filter(function (q) { return q.test === 'Reading and Writing'; });
    var mathPool = allQuestions.filter(function (q) { return q.test === 'Math'; });

    var shuffledRw = _shuffle(rwPool);
    var shuffledMath = _shuffle(mathPool);

    var rwM1Qs = shuffledRw.slice(0, 4);

    var mathMcqs = shuffledMath.filter(function (q) { return (q.type || q.question_type) !== 'free_response'; });
    var mathSprs = shuffledMath.filter(function (q) { return (q.type || q.question_type) === 'free_response'; });

    var mathM1Qs = _shuffle(mathMcqs.slice(0, 3).concat(mathSprs.slice(0, 1)));

    return {
      id: 'exam_mini_' + Date.now(),
      title: 'Mini PSAT 8/9 Quick Simulation (8 Qs)',
      type: 'mini_psat89',
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
          questionsCount: 4,
          timeLimitSeconds: 5 * 60,
          questions: rwM1Qs
        },
        {
          id: 'mini_math_m1',
          section: 'Math',
          moduleNumber: 2,
          name: 'Section 2: Math',
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

    var count = Math.min(filtered.length, Math.max(1, f.count || 20));
    var shuffled = _shuffle(filtered).slice(0, count);

    var timeLimitMinutes = f.timeLimitMinutes ? parseInt(f.timeLimitMinutes, 10) : Math.round(count * 1.5);

    return {
      id: 'custom_test_' + Date.now(),
      title: f.title || 'Custom Practice Test',
      type: 'custom_test',
      totalQuestions: shuffled.length,
      timeLimitMinutes: timeLimitMinutes,
      isUntimed: f.isUntimed === true,
      filters: f,
      createdAt: Date.now(),
      questions: shuffled
    };
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
      if (mod.section === 'Reading and Writing') rwTotal += mod.questions.length;
      else mathTotal += mod.questions.length;
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

        if (isCorrect) {
          modCorrect++;
          if (mod.section === 'Reading and Writing') rwCorrect++;
          else mathCorrect++;
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

    var rwScaled = rwTotal > 0 ? Math.min(720, Math.max(120, Math.round(120 + (rwCorrect / rwTotal) * 600))) : 120;
    var mathScaled = mathTotal > 0 ? Math.min(720, Math.max(120, Math.round(120 + (mathCorrect / mathTotal) * 600))) : 120;
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
  function isDemoModeActive(storage) {
    var store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return false;
    try {
      return store.getItem('psat_sample_data_active') === 'true';
    } catch (e) {
      return false;
    }
  }

  function backupRealData(storage, safeGetFn, safeSetFn) {
    var store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return false;

    // CRITICAL: Only write backup if demo mode is NOT already active
    if (isDemoModeActive(store)) {
      return false; // Backup already contains real data; do not overwrite with sample data!
    }

    var getFn = safeGetFn || function(key, def) {
      try {
        var v = store.getItem(key);
        return v ? JSON.parse(v) : def;
      } catch (e) { return def; }
    };
    var setFn = safeSetFn || function(key, val) {
      try {
        store.setItem(key, JSON.stringify(val));
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

  function restoreRealData(storage, safeGetFn, safeSetFn) {
    var store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return false;

    var getFn = safeGetFn || function(key, def) {
      try {
        var v = store.getItem(key);
        return v ? JSON.parse(v) : def;
      } catch (e) { return def; }
    };
    var setFn = safeSetFn || function(key, val) {
      try {
        store.setItem(key, JSON.stringify(val));
        return true;
      } catch (e) { return false; }
    };
    var removeFn = function(key) {
      try { store.removeItem(key); } catch (e) {}
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
   * Merges sessions additively across devices for each day key.
   */
  function mergeSessionsState(cloudSessions, localSessions) {
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
          questionsAnswered: (cDay.questionsAnswered || cDay.totalAnswered || 0) + (lDay.questionsAnswered || lDay.totalAnswered || 0),
          correct: (cDay.correct || cDay.totalCorrect || 0) + (lDay.correct || lDay.totalCorrect || 0),
          totalTimeMs: (cDay.totalTimeMs || cDay.totalTimeSpentMs || 0) + (lDay.totalTimeMs || lDay.totalTimeSpentMs || 0)
        };
      } else if (cDay) {
        merged[day] = Object.assign({}, cDay);
      } else if (lDay) {
        merged[day] = Object.assign({}, lDay);
      }
    });

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
   * Pushes progress and exam history to Cosmos DB cloud API.
   */
  function pushToCloud(store, customFetch, studentName) {
    var sName = studentName || 'default_student';
    var fetchFn = customFetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) return Promise.resolve({ success: false, error: 'No fetch API available' });
    if (isDemoModeActive(store)) return Promise.resolve({ success: false, reason: 'demo_mode' });

    var progress = JSON.parse((store && store.getItem ? store.getItem('psat_progress') : null) || '{}');
    var srs = JSON.parse((store && store.getItem ? store.getItem('psat_srs') : null) || '{}');
    var sessions = JSON.parse((store && store.getItem ? store.getItem('psat_sessions') : null) || '{}');
    var history = JSON.parse((store && store.getItem ? store.getItem('psat_exam_history') : null) || '[]');

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
  function pullFromCloud(store, customFetch, studentName, safeSetStorageFn) {
    var sName = studentName || 'default_student';
    var fetchFn = customFetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) return Promise.resolve({ success: false, error: 'No fetch API available' });
    if (isDemoModeActive(store)) return Promise.resolve({ success: false, reason: 'demo_mode' });

    var setter = safeSetStorageFn || function(key, val) {
      try {
        if (store && store.setItem) {
          store.setItem(key, JSON.stringify(val));
          return true;
        }
        return false;
      } catch (e) {
        console.error('Storage quota write error for key:', key, e);
        return false;
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
            var localProgRaw = (store && store.getItem ? store.getItem('psat_progress') : null);
            var localHistRaw = (store && store.getItem ? store.getItem('psat_exam_history') : null);
            var localSessRaw = (store && store.getItem ? store.getItem('psat_sessions') : null);
            var localSrsRaw = (store && store.getItem ? store.getItem('psat_srs') : null);

            var localProg = JSON.parse(localProgRaw || '{}');
            var localHist = JSON.parse(localHistRaw || '[]');
            var localSess = JSON.parse(localSessRaw || '{}');
            var localSrs = JSON.parse(localSrsRaw || '{}');

            var mergedProg = mergeProgress(cloud.progress, localProg);
            var mergedSrs = mergeSrsState(cloud.srsState, localSrs);
            var mergedSess = mergeSessionsState(cloud.sessionsState, localSess);
            var mergedHist = mergeExamHistory(cloud.examHistory, localHist, 15);

            var ok1 = setter('psat_progress', mergedProg);
            var ok2 = setter('psat_srs', mergedSrs);
            var ok3 = setter('psat_sessions', mergedSess);
            var ok4 = setter('psat_exam_history', mergedHist);

            if (!ok1 || !ok2 || !ok3 || !ok4) {
              // Rollback to original uncorrupted state on partial quota write failure
              try {
                if (store) {
                  if (localProgRaw !== null && store.setItem) store.setItem('psat_progress', localProgRaw);
                  else if (store.removeItem) store.removeItem('psat_progress');

                  if (localSrsRaw !== null && store.setItem) store.setItem('psat_srs', localSrsRaw);
                  else if (store.removeItem) store.removeItem('psat_srs');

                  if (localSessRaw !== null && store.setItem) store.setItem('psat_sessions', localSessRaw);
                  else if (store.removeItem) store.removeItem('psat_sessions');

                  if (localHistRaw !== null && store.setItem) store.setItem('psat_exam_history', localHistRaw);
                  else if (store.removeItem) store.removeItem('psat_exam_history');
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
    pushToCloud: pushToCloud,
    pullFromCloud: pullFromCloud
  };
});
