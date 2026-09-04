/**
 * js/engine/examgen.js — Exam, drill and sample-payload generation: the adaptive MST assembler, the
 * full 98-question mock, the 8-question mini exam, gap/tag-targeted drills, the
 * custom test builder and the post-exam recovery plan.
 *
 * Part of the engine that was one 3,458-line srs.js until REFACTOR_PLAN.md
 * WI-10. The code below is the SAME code, moved verbatim; `srs.js` is now a
 * facade that recomposes these parts into the unchanged `PSAT_ENGINE` object.
 *
 * Loading: same UMD shape as srs.js always had — `module.exports` under Node,
 * `window.__PSAT_ENGINE_PARTS.examgen` in the browser. There is no build step,
 * so the pages load the parts as ordinary <script> tags in dependency order
 * (grading -> scheduler -> scoring -> storage -> examgen -> sync) before srs.js.
 * Dependencies: grading, scheduler, scoring, storage.
 * A missing dependency throws immediately rather than yielding a half-built
 * part whose functions ReferenceError at call time (CLAUDE.md failure mode 5).
 */
(function (root, factory) {
  var DEPS = ['grading', 'scheduler', 'scoring', 'storage'];
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory.apply(null, DEPS.map(function (d) { return require('./' + d + '.js'); }));
  } else {
    var parts = root.__PSAT_ENGINE_PARTS = root.__PSAT_ENGINE_PARTS || {};
    parts.examgen = factory.apply(null, DEPS.map(function (d) {
      if (!parts[d]) {
        throw new Error(
          'js/engine/examgen.js requires js/engine/' + d + '.js, which has not loaded yet. ' +
          'Load the engine parts in this order before srs.js: grading, scheduler, scoring, storage, examgen, sync.'
        );
      }
      return parts[d];
    }));
  }
})(typeof self !== 'undefined' ? self : this, function (grading, scheduler, scoring, storage) {
  // Cross-part bindings, aliased to their original bare names so the moved
  // code below stays byte-identical to what it was inside srs.js.
  var extractAcceptedForms = grading.extractAcceptedForms;
  var gradeAttempt = grading.gradeAttempt;
  var localDateKey = scheduler.localDateKey;
  var recordDailySession = scheduler.recordDailySession;
  var scheduleNext = scheduler.scheduleNext;
  var ERROR_TAGS = scoring.ERROR_TAGS;
  var OFFICIAL_BLUEPRINTS = scoring.OFFICIAL_BLUEPRINTS;
  var scoreStandardExam = scoring.scoreStandardExam;
  var toLeanReport = storage.toLeanReport;


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

  // =========================================================================
  // WI-20 — offline exam mode (take on a plane, sync on reconnect)
  // =========================================================================
  // Three pure helpers backing the "Prepare for offline" flow. They live here,
  // not in the page, so they are unit-testable against the real question bundle
  // (tests/test_offline_exam.js) — this project's #1 rule is "run the real code
  // path against the real dataset", and generation/rehydration is exactly where
  // a schema mistake (failure mode 3) would silently ship a broken exam.

  /**
   * Collects the unique question ids an exam can present — every module question
   * PLUS every adaptive-pool question. Either routing branch may be taken while
   * offline, so BOTH the Hard and Easy pools count; missing a pool here would
   * silently leave a whole adaptive branch's images uncached before a flight.
   */
  function collectExamQuestionIds(exam) {
    var ids = {};
    if (exam && Array.isArray(exam.modules)) {
      exam.modules.forEach(function (m) {
        (m && Array.isArray(m.questions) ? m.questions : []).forEach(function (q) {
          if (q && q.id != null) ids[q.id] = true;
        });
      });
    }
    if (exam && exam.adaptivePools) {
      ['rwM2Hard', 'rwM2Easy', 'mathM2Hard', 'mathM2Easy'].forEach(function (k) {
        var pool = exam.adaptivePools[k];
        (Array.isArray(pool) ? pool : []).forEach(function (q) {
          if (q && q.id != null) ids[q.id] = true;
        });
      });
    }
    return Object.keys(ids);
  }

  /**
   * Builds a LEAN, storable pin of a generated exam: full question objects are
   * dropped and only their ids kept (they rehydrate from the local bundle),
   * mirroring the in-progress resume snapshot so the pin can never become the
   * storage bloat of failure mode 6. `meta` carries the honest prefetch tally
   * (imageTotal/imageCached) and preparedAt, which the lobby shows verbatim —
   * never an invented number (failure mode 1). A missing tally stays null, not 0.
   */
  function toOfflineExamPin(exam, meta) {
    if (!exam) return null;
    var m = meta || {};
    var leanModules = (exam.modules || []).map(function (mod) {
      return {
        id: mod.id,
        section: mod.section,
        moduleNumber: mod.moduleNumber,
        name: mod.name,
        track: mod.track || 'Standard',
        questionsCount: mod.questionsCount || (mod.questions ? mod.questions.length : 0),
        timeLimitSeconds: mod.timeLimitSeconds,
        questionIds: (mod.questions || []).map(function (q) { return q.id; })
      };
    });
    var leanPools = exam.adaptivePools ? {
      rwM2Hard: (exam.adaptivePools.rwM2Hard || []).map(function (q) { return q.id; }),
      rwM2Easy: (exam.adaptivePools.rwM2Easy || []).map(function (q) { return q.id; }),
      mathM2Hard: (exam.adaptivePools.mathM2Hard || []).map(function (q) { return q.id; }),
      mathM2Easy: (exam.adaptivePools.mathM2Easy || []).map(function (q) { return q.id; })
    } : null;
    return {
      examMeta: {
        id: exam.id,
        title: exam.title,
        type: exam.type,
        isAdaptive: exam.isAdaptive === true,
        routingTracks: exam.routingTracks || { rw: 'Baseline', math: 'Baseline' },
        adaptivePools: leanPools,
        totalQuestions: exam.totalQuestions,
        totalTimeMinutes: exam.totalTimeMinutes,
        breakMinutes: exam.breakMinutes,
        createdAt: exam.createdAt,
        modules: leanModules
      },
      preparedAt: (typeof m.preparedAt === 'number') ? m.preparedAt : Date.now(),
      imageTotal: (typeof m.imageTotal === 'number') ? m.imageTotal : null,
      imageCached: (typeof m.imageCached === 'number') ? m.imageCached : null
    };
  }

  /**
   * Rehydrates a lean pin into a full exam by looking every id up in the bundle.
   * Returns the exam PLUS an explicit integrity result: if ANY module id fails
   * to resolve, `ok` is false and `missingIds` lists them — the caller must
   * refuse to start rather than run a short exam scored as full (failure modes
   * 3 and 5). Adaptive-pool misses are reported in `missingPoolIds` but are not
   * fatal on their own (the other routing branch may still be whole).
   */
  function rehydrateOfflineExamPin(pin, allQuestions) {
    var meta = pin && pin.examMeta ? pin.examMeta : null;
    if (!meta) return { ok: false, exam: null, missingIds: [], missingPoolIds: [], reason: 'no_pin' };

    var qMap = {};
    (Array.isArray(allQuestions) ? allQuestions : []).forEach(function (q) { if (q && q.id != null) qMap[q.id] = q; });

    var missingIds = [];
    var modules = (meta.modules || []).map(function (m) {
      var qs = [];
      (m.questionIds || []).forEach(function (qid) {
        if (qMap[qid]) qs.push(qMap[qid]); else missingIds.push(qid);
      });
      return {
        id: m.id, section: m.section, moduleNumber: m.moduleNumber, name: m.name,
        track: m.track || 'Standard',
        questionsCount: m.questionsCount || (m.questionIds ? m.questionIds.length : 0),
        timeLimitSeconds: m.timeLimitSeconds, questions: qs
      };
    });

    var missingPoolIds = [];
    var pools = meta.adaptivePools ? {} : null;
    if (pools) {
      ['rwM2Hard', 'rwM2Easy', 'mathM2Hard', 'mathM2Easy'].forEach(function (k) {
        pools[k] = (meta.adaptivePools[k] || []).map(function (qid) {
          if (qMap[qid]) return qMap[qid];
          missingPoolIds.push(qid); return null;
        }).filter(Boolean);
      });
    }

    var exam = {
      id: meta.id, title: meta.title, type: meta.type,
      isAdaptive: meta.isAdaptive === true,
      routingTracks: meta.routingTracks || { rw: 'Baseline', math: 'Baseline' },
      adaptivePools: pools,
      totalQuestions: meta.totalQuestions, totalTimeMinutes: meta.totalTimeMinutes,
      breakMinutes: meta.breakMinutes, createdAt: meta.createdAt, modules: modules
    };

    return { ok: missingIds.length === 0, exam: exam, missingIds: missingIds, missingPoolIds: missingPoolIds };
  }


  /**
   * Demo Mode State & Data Protection Manager
   * Handles safe archival of real student data before sample loading and lossless recovery.
   */

  return {
    _shuffle: _shuffle,
    _prioritizeUnseen: _prioritizeUnseen,
    _assembleModuleByBlueprint: _assembleModuleByBlueprint,
    generateStandardPSAT89Exam: generateStandardPSAT89Exam,
    generateMiniPSAT89Exam: generateMiniPSAT89Exam,
    generateGapTargetedDrill: generateGapTargetedDrill,
    calculateGapFocusMetrics: calculateGapFocusMetrics,
    generateCustomTest: generateCustomTest,
    generateTagCoachingDrill: generateTagCoachingDrill,
    generatePostExamRecoveryPlan: generatePostExamRecoveryPlan,
    generateSampleDiagnosticPayload: generateSampleDiagnosticPayload,
    collectExamQuestionIds: collectExamQuestionIds,
    toOfflineExamPin: toOfflineExamPin,
    rehydrateOfflineExamPin: rehydrateOfflineExamPin
  };
});
