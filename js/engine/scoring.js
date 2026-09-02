/**
 * js/engine/scoring.js — Score modelling and the official test blueprints: raw->scaled conversion,
 * Wilson intervals, the MIN_PER_SECTION gate, full-exam scoring, trouble spots
 * and error-tag analytics.
 *
 * OFFICIAL_BLUEPRINTS / PSAT_89_SPECS live HERE rather than in examgen.js on
 * purpose: scoreStandardExam needs the blueprint to label a report, and examgen
 * needs it to assemble a module. Putting it in examgen would make scoring and
 * examgen mutually dependent; putting it in scoring leaves a clean one-way edge
 * examgen -> scoring.
 *
 * Part of the engine that was one 3,458-line srs.js until REFACTOR_PLAN.md
 * WI-10. The code below is the SAME code, moved verbatim; `srs.js` is now a
 * facade that recomposes these parts into the unchanged `PSAT_ENGINE` object.
 *
 * Loading: same UMD shape as srs.js always had — `module.exports` under Node,
 * `window.__PSAT_ENGINE_PARTS.scoring` in the browser. There is no build step,
 * so the pages load the parts as ordinary <script> tags in dependency order
 * (grading -> scheduler -> scoring -> storage -> examgen -> sync) before srs.js.
 * The tunable scoring/blueprint constants themselves live in
 * js/engine/adaptive_config.js (a no-dep part) and are re-exported here unchanged.
 * Dependencies: adaptive_config, grading.
 * A missing dependency throws immediately rather than yielding a half-built
 * part whose functions ReferenceError at call time (CLAUDE.md failure mode 5).
 */
(function (root, factory) {
  var DEPS = ['adaptive_config', 'grading'];
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory.apply(null, DEPS.map(function (d) { return require('./' + d + '.js'); }));
  } else {
    var parts = root.__PSAT_ENGINE_PARTS = root.__PSAT_ENGINE_PARTS || {};
    parts.scoring = factory.apply(null, DEPS.map(function (d) {
      if (!parts[d]) {
        throw new Error(
          'js/engine/scoring.js requires js/engine/' + d + '.js, which has not loaded yet. ' +
          'Load the engine parts in this order before srs.js: grading, scheduler, scoring, storage, examgen, sync.'
        );
      }
      return parts[d];
    }));
  }
})(typeof self !== 'undefined' ? self : this, function (adaptive_config, grading) {
  // Cross-part bindings, aliased to their original bare names so the moved
  // code below stays byte-identical to what it was inside srs.js.
  var gradeFreeResponse = grading.gradeFreeResponse;

  // WI-16: the scoring/blueprint constants now live in js/engine/adaptive_config.js
  // (a documented single source of record). Alias them back to the bare names the
  // code below has always used, and re-export them unchanged from this part so the
  // frozen PSAT_ENGINE public API is byte-identical (tests/test_adaptive_config.js
  // pins the equivalence).
  var SCALING_ASSUMPTIONS = adaptive_config.SCALING_ASSUMPTIONS;
  var OFFICIAL_BLUEPRINTS = adaptive_config.OFFICIAL_BLUEPRINTS;
  var PSAT_89_SPECS = adaptive_config.PSAT_89_SPECS;

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
   * WI-16: route module 2 by module-1 accuracy. Returns the upper ('Hard') track
   * when the raw ratio is at or above SCALING_ASSUMPTIONS.ROUTING_THRESHOLD (0.58 =
   * >= 16/27 RW, >= 13/22 Math), else the lower ('Easy') track. Centralises the
   * threshold that was inline-duplicated in the exam runner (js/pages/student.js).
   * @param {number} rawRatio - module-1 accuracy proportion [0,1]
   * @returns {'Hard'|'Easy'}
   */
  function routeAdaptiveTrack(rawRatio) {
    var r = (typeof rawRatio === 'number' && !isNaN(rawRatio)) ? rawRatio : 0;
    return r >= SCALING_ASSUMPTIONS.ROUTING_THRESHOLD ? 'Hard' : 'Easy';
  }

  return {
    SCALING_ASSUMPTIONS: SCALING_ASSUMPTIONS,
    scaleSectionRawScore: scaleSectionRawScore,
    routeAdaptiveTrack: routeAdaptiveTrack,
    calculateWilsonScoreInterval: calculateWilsonScoreInterval,
    calculateScaledScore: calculateScaledScore,
    calculateSectionScaledScore: calculateSectionScaledScore,
    OFFICIAL_BLUEPRINTS: OFFICIAL_BLUEPRINTS,
    PSAT_89_SPECS: PSAT_89_SPECS,
    ERROR_TAGS: ERROR_TAGS,
    aggregateErrorTags: aggregateErrorTags,
    calculateErrorTagTrends: calculateErrorTagTrends,
    buildTroubleSpots: buildTroubleSpots,
    scoreStandardExam: scoreStandardExam
  };
});
