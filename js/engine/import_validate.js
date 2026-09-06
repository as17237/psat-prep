/**
 * js/engine/import_validate.js — DATA-05: the pure validator and preview builder
 * for the parent portal's "Import Student Data" path.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The import path in js/pages/parent.js used to accept any JSON object that had
 * ONE non-empty container among four, then wrote it straight into the student's
 * four localStorage keys. A file from another app, a truncated download, or a
 * hand-edited file with `"isCorrect": "yes"` in it was indistinguishable from a
 * real export. Worse, the strategy prompt was a single confirm() whose Cancel
 * branch REPLACED everything, so a parent pressing Escape destroyed the profile.
 *
 * Everything in here is pure and clock-free: `now` is a parameter, nothing reads
 * localStorage, nothing writes anything, and no input object is mutated (the
 * accepted entries are deep-copied into `normalized`). The parent page owns the
 * dialog and the writes; this file owns the judgement and the numbers.
 *
 * CLAUDE.md failure mode 1 — every count this file returns is a measurement of
 * the parsed file and the current profile. There is no estimate anywhere, and no
 * count is invented for missing data: a container the file does not contain is
 * reported as 0 present, not as "unchanged".
 *
 * CLAUDE.md failure mode 5 — an entry is never silently dropped. Every rejected
 * entry lands in `normalized.skipped` with a plain-English reason and is counted
 * in `normalized.counts.<section>.skipped`, so the UI can show "kept N, skipped M"
 * rather than one flattering number.
 *
 * Loading: same UMD shape as the other engine parts — `module.exports` under Node,
 * `root.__PSAT_ENGINE_PARTS.importValidate` in the browser. No dependencies on any
 * other part (deliberately: a validator that needs the scheduler to decide whether
 * a file is safe is a validator that can fail for the wrong reason).
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    var parts = root.__PSAT_ENGINE_PARTS = root.__PSAT_ENGINE_PARTS || {};
    parts.importValidate = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * The shape version this validator understands. It is written into
   * `normalized.schemaVersion` so a preview/report can say what it validated
   * against; a file declaring a HIGHER version is accepted with a warning rather
   * than rejected (the four containers have never changed shape), and a file
   * declaring a lower/absent version is the normal case — every export written
   * before DATA-05 has no version field at all.
   */
  var IMPORT_SCHEMA_VERSION = 1;

  /** The three outcomes the parent dialog can produce. Cancel is a real option. */
  var IMPORT_STRATEGIES = {
    MERGE: 'merge',
    REPLACE: 'replace',
    CANCEL: 'cancel'
  };

  /**
   * The four sections, in the order the UI renders them. `storageKey` is the real
   * localStorage key so the preview and the writer cannot disagree about which
   * key a row describes (CLAUDE.md mode 2 — one name, one place).
   */
  var SECTIONS = [
    { id: 'progress',     storageKey: 'psat_progress',     label: 'question attempts',         kind: 'map',   aliases: ['questionAttempts', 'progress'] },
    { id: 'srsState',     storageKey: 'psat_srs',          label: 'spaced-repetition cards',   kind: 'map',   aliases: ['spacedRepetitionCards', 'srsState', 'srs'] },
    { id: 'sessionsState',storageKey: 'psat_sessions',     label: 'daily practice sessions',   kind: 'map',   aliases: ['sessionsLog', 'sessionsState', 'sessions'] },
    { id: 'examHistory',  storageKey: 'psat_exam_history', label: 'completed exam reports',    kind: 'array', aliases: ['examHistoryLog', 'examHistory'] }
  ];

  /**
   * The oldest timestamp this app could plausibly have produced. Anything older is
   * not "a very keen student" — it is a unit-less number (seconds instead of
   * milliseconds is the usual cause) that would sort every chart wrongly forever.
   * 2015-01-01T00:00:00Z.
   */
  var MIN_PLAUSIBLE_TS = 1420070400000;

  /** Allowance for a clock that is slightly ahead. One day. */
  var FUTURE_SLACK_MS = 86400000;

  /**
   * A question id as this question bank actually writes them: 8 lowercase hex
   * characters (verified against all 3,059 records in data/*.json). Ids that do
   * not match are not rejected outright — an older export, or a bank rebuild,
   * could legitimately differ — but they ARE counted and reported so a file full
   * of foreign keys is visible rather than silent.
   */
  var CANONICAL_QID = /^[0-9a-f]{8}$/;

  /** The widest key this validator will store at all: no spaces, no control chars. */
  var PLAUSIBLE_QID = /^[A-Za-z0-9_.:-]{3,64}$/;

  /** A daily-session key, as scheduler.localDateKey() writes it. */
  var DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

  // ---------------------------------------------------------------------------
  // Small predicates. Deliberately explicit: `typeof x === 'number'` alone accepts
  // NaN, and `!x` alone rejects a legitimate 0.
  // ---------------------------------------------------------------------------

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function isRealNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function isNonNegNumber(v) {
    return isRealNumber(v) && v >= 0;
  }

  function isNonNegInt(v) {
    return isNonNegNumber(v) && Math.floor(v) === v;
  }

  function isBool(v) {
    return v === true || v === false;
  }

  function plausibleTimestamp(v, now) {
    if (!isRealNumber(v)) return false;
    return v >= MIN_PLAUSIBLE_TS && v <= now + FUTURE_SLACK_MS;
  }

  /** True only for a real calendar date in a plausible range. 2026-02-30 is false. */
  function plausibleDateKey(key, now) {
    if (typeof key !== 'string' || !DATE_KEY.test(key)) return false;
    var y = parseInt(key.slice(0, 4), 10);
    var m = parseInt(key.slice(5, 7), 10);
    var d = parseInt(key.slice(8, 10), 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var asUtc = Date.UTC(y, m - 1, d);
    var back = new Date(asUtc);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return false;
    // A session day is a LOCAL date key, so allow a day either side of the UTC edge.
    return asUtc >= MIN_PLAUSIBLE_TS - FUTURE_SLACK_MS && asUtc <= now + 2 * FUTURE_SLACK_MS;
  }

  /** Structured deep copy of JSON-safe data. Keeps the caller's object untouched. */
  function deepCopy(v) {
    return JSON.parse(JSON.stringify(v));
  }

  /**
   * The identity mergeExamHistory() keys an exam report by. Mirrored here on
   * purpose: if the preview counted exams differently from the merge, the preview
   * would be an estimate (CLAUDE.md mode 1). `examId` wins, `completedAt` is the
   * fallback, and an entry with neither has NO identity — the merge drops such an
   * entry, so the preview must be able to say so out loud.
   */
  function examIdentity(entry) {
    if (!isPlainObject(entry)) return null;
    if (typeof entry.examId === 'string' && entry.examId.length > 0) return entry.examId;
    if (isRealNumber(entry.completedAt) && entry.completedAt !== 0) return 'completedAt:' + entry.completedAt;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Per-entry validation. Each returns null when the entry is acceptable, or a
  // plain-English reason string a parent can read when it is not.
  //
  // The rule applied throughout: a field that is ABSENT is fine (exports written
  // by older builds omit fields that exist today); a field that is PRESENT with
  // the wrong type is a rejection, because that is what silently corrupts a chart
  // or a score later.
  // ---------------------------------------------------------------------------

  function checkProgressEntry(qid, entry, now) {
    if (!isPlainObject(entry)) return 'the record is not an object (it is ' + describe(entry) + ')';
    if (entry.answered !== undefined && !isBool(entry.answered)) return '"answered" must be true or false, not ' + describe(entry.answered);
    if (entry.isCorrect !== undefined && !isBool(entry.isCorrect)) return '"isCorrect" must be true or false, not ' + describe(entry.isCorrect);
    if (entry.isFlagged !== undefined && !isBool(entry.isFlagged)) return '"isFlagged" must be true or false, not ' + describe(entry.isFlagged);
    if (entry.timingReliable !== undefined && !isBool(entry.timingReliable)) return '"timingReliable" must be true or false, not ' + describe(entry.timingReliable);
    if (entry.timeSpentMs !== undefined && entry.timeSpentMs !== null && !isNonNegNumber(entry.timeSpentMs)) return '"timeSpentMs" must be a number of milliseconds (or null), not ' + describe(entry.timeSpentMs);
    if (entry.timestamp !== undefined && entry.timestamp !== null && !plausibleTimestamp(entry.timestamp, now)) return '"timestamp" is not a plausible date (it must be a millisecond time between 2015 and now), got ' + describe(entry.timestamp);
    if (entry.timesSeen !== undefined && !isNonNegInt(entry.timesSeen)) return '"timesSeen" must be a whole number of attempts, not ' + describe(entry.timesSeen);
    if (entry.timesCorrect !== undefined && !isNonNegInt(entry.timesCorrect)) return '"timesCorrect" must be a whole number, not ' + describe(entry.timesCorrect);
    if (entry.timesIncorrect !== undefined && !isNonNegInt(entry.timesIncorrect)) return '"timesIncorrect" must be a whole number, not ' + describe(entry.timesIncorrect);
    if (entry.attempts !== undefined && !Array.isArray(entry.attempts)) return '"attempts" must be a list, not ' + describe(entry.attempts);
    if (entry.selectedAnswer !== undefined && entry.selectedAnswer !== null &&
        typeof entry.selectedAnswer !== 'string' && typeof entry.selectedAnswer !== 'number') {
      return '"selectedAnswer" must be text or a number, not ' + describe(entry.selectedAnswer);
    }
    if (isNonNegInt(entry.timesSeen) && isNonNegInt(entry.timesCorrect) && entry.timesCorrect > entry.timesSeen) {
      return 'it reports ' + entry.timesCorrect + ' correct answers out of only ' + entry.timesSeen + ' attempts';
    }
    return null;
  }

  function checkSrsEntry(qid, card, now) {
    if (!isPlainObject(card)) return 'the card is not an object (it is ' + describe(card) + ')';
    if (card.easeFactor !== undefined && (!isRealNumber(card.easeFactor) || card.easeFactor < 1 || card.easeFactor > 5)) {
      return '"easeFactor" must be a number between 1 and 5, got ' + describe(card.easeFactor);
    }
    if (card.intervalDays !== undefined && !isNonNegNumber(card.intervalDays)) return '"intervalDays" must be a number of days, not ' + describe(card.intervalDays);
    if (card.repetitions !== undefined && !isNonNegInt(card.repetitions)) return '"repetitions" must be a whole number, not ' + describe(card.repetitions);
    if (card.totalReviews !== undefined && !isNonNegInt(card.totalReviews)) return '"totalReviews" must be a whole number, not ' + describe(card.totalReviews);
    if (card.totalLapses !== undefined && !isNonNegInt(card.totalLapses)) return '"totalLapses" must be a whole number, not ' + describe(card.totalLapses);
    if (card.history !== undefined && !Array.isArray(card.history)) return '"history" must be a list of review events, not ' + describe(card.history);
    if (card.lastReviewedAt !== undefined && card.lastReviewedAt !== null && !plausibleTimestamp(card.lastReviewedAt, now)) return '"lastReviewedAt" is not a plausible date, got ' + describe(card.lastReviewedAt);
    if (card.firstReviewedAt !== undefined && card.firstReviewedAt !== null && !plausibleTimestamp(card.firstReviewedAt, now)) return '"firstReviewedAt" is not a plausible date, got ' + describe(card.firstReviewedAt);
    // dueAt is the ONE timestamp that is legitimately in the future (that is what a
    // due date is), so it is bounded below only.
    if (card.dueAt !== undefined && card.dueAt !== null && (!isRealNumber(card.dueAt) || card.dueAt < MIN_PLAUSIBLE_TS)) {
      return '"dueAt" is not a plausible due date, got ' + describe(card.dueAt);
    }
    if (isNonNegInt(card.totalReviews) && isNonNegInt(card.totalLapses) && card.totalLapses > card.totalReviews) {
      return 'it reports ' + card.totalLapses + ' lapses from only ' + card.totalReviews + ' reviews';
    }
    return null;
  }

  function checkSessionEntry(dayKey, day, now) {
    if (!isPlainObject(day)) return 'the day record is not an object (it is ' + describe(day) + ')';
    if (day.date !== undefined && day.date !== dayKey) return 'its "date" field says ' + describe(day.date) + ' but it is filed under ' + dayKey;
    if (day.questionsAnswered !== undefined && !isNonNegInt(day.questionsAnswered)) return '"questionsAnswered" must be a whole number, not ' + describe(day.questionsAnswered);
    if (day.correct !== undefined && !isNonNegInt(day.correct)) return '"correct" must be a whole number, not ' + describe(day.correct);
    if (day.totalTimeMs !== undefined && !isNonNegNumber(day.totalTimeMs)) return '"totalTimeMs" must be a number of milliseconds, not ' + describe(day.totalTimeMs);
    if (isNonNegInt(day.questionsAnswered) && isNonNegInt(day.correct) && day.correct > day.questionsAnswered) {
      return 'it reports ' + day.correct + ' correct out of only ' + day.questionsAnswered + ' answered';
    }
    return null;
  }

  function checkExamEntry(entry, now) {
    if (!isPlainObject(entry)) return 'the exam report is not an object (it is ' + describe(entry) + ')';
    if (examIdentity(entry) === null) {
      return 'it has neither an "examId" nor a "completedAt" date, so it cannot be told apart from any other report';
    }
    if (entry.examId !== undefined && typeof entry.examId !== 'string') return '"examId" must be text, not ' + describe(entry.examId);
    if (entry.completedAt !== undefined && entry.completedAt !== null && !plausibleTimestamp(entry.completedAt, now)) return '"completedAt" is not a plausible date, got ' + describe(entry.completedAt);
    if (entry.totalQuestions !== undefined && !isNonNegInt(entry.totalQuestions)) return '"totalQuestions" must be a whole number, not ' + describe(entry.totalQuestions);
    if (entry.totalCorrect !== undefined && !isNonNegInt(entry.totalCorrect)) return '"totalCorrect" must be a whole number, not ' + describe(entry.totalCorrect);
    if (entry.totalAttempted !== undefined && !isNonNegInt(entry.totalAttempted)) return '"totalAttempted" must be a whole number, not ' + describe(entry.totalAttempted);
    if (entry.moduleReports !== undefined && !Array.isArray(entry.moduleReports)) return '"moduleReports" must be a list, not ' + describe(entry.moduleReports);
    if (entry.scores !== undefined && entry.scores !== null && !isPlainObject(entry.scores)) return '"scores" must be an object, not ' + describe(entry.scores);
    if (isNonNegInt(entry.totalQuestions) && isNonNegInt(entry.totalCorrect) && entry.totalCorrect > entry.totalQuestions) {
      return 'it reports ' + entry.totalCorrect + ' correct out of only ' + entry.totalQuestions + ' questions';
    }
    return null;
  }

  /** A short, non-technical description of a bad value, for the reason strings. */
  function describe(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'missing';
    if (Array.isArray(v)) return 'a list of ' + v.length;
    if (typeof v === 'object') return 'an object';
    if (typeof v === 'string') return 'the text "' + (v.length > 40 ? v.slice(0, 40) + '…' : v) + '"';
    if (typeof v === 'number' && !isFinite(v)) return 'a non-finite number';
    return String(v);
  }

  /** Picks the first alias present on the parsed file, and says which one it was. */
  function pickContainer(parsed, aliases) {
    for (var i = 0; i < aliases.length; i++) {
      if (Object.prototype.hasOwnProperty.call(parsed, aliases[i]) && parsed[aliases[i]] !== null && parsed[aliases[i]] !== undefined) {
        return { name: aliases[i], value: parsed[aliases[i]] };
      }
    }
    return null;
  }

  /**
   * Validates a parsed import file, entry by entry, and returns the subset that is
   * safe to write plus a full account of what was rejected and why.
   *
   * @param {*} parsed  the result of JSON.parse on the chosen file (any value)
   * @param {number} now  the caller's clock, in ms. Required — this function never
   *   reads Date.now() itself, so a test can pin every "is this date plausible" check.
   * @returns {{ok:boolean, errors:string[], warnings:string[], normalized:(Object|null)}}
   *   `normalized` is null whenever ok is false; when ok is true it holds
   *   deep-copied, validated `progress` / `srsState` / `sessionsState` /
   *   `examHistory` plus `counts`, `skipped`, `isSampleData` and `exportedAt`.
   */
  function validateImportFile(parsed, now) {
    var atMs = isRealNumber(now) ? now : Date.now();
    var errors = [];
    var warnings = [];

    if (typeof parsed === 'string') {
      errors.push('This file contains a single piece of text, not a student data export. Choose the JSON file produced by "Export Audit Data".');
      return { ok: false, errors: errors, warnings: warnings, normalized: null };
    }
    if (Array.isArray(parsed)) {
      errors.push('This file is a bare list. A student data export is an object with named sections (questionAttempts, spacedRepetitionCards, sessionsLog, examHistoryLog).');
      return { ok: false, errors: errors, warnings: warnings, normalized: null };
    }
    if (!isPlainObject(parsed)) {
      errors.push('This file does not contain a student data export (it is ' + describe(parsed) + ').');
      return { ok: false, errors: errors, warnings: warnings, normalized: null };
    }

    // --- The four containers, by their known aliases -------------------------
    var found = {};
    var presentSections = [];
    SECTIONS.forEach(function (sec) {
      var hit = pickContainer(parsed, sec.aliases);
      if (!hit) { found[sec.id] = null; return; }
      presentSections.push(sec.id);
      found[sec.id] = hit;
    });

    if (presentSections.length === 0) {
      errors.push(
        'This file has none of the sections a student data export contains. ' +
        'Expected at least one of: questionAttempts, spacedRepetitionCards, sessionsLog, examHistoryLog. ' +
        'Found instead: ' + (Object.keys(parsed).slice(0, 8).join(', ') || '(nothing)') + '.'
      );
      return { ok: false, errors: errors, warnings: warnings, normalized: null };
    }

    // --- Container shapes ----------------------------------------------------
    SECTIONS.forEach(function (sec) {
      var hit = found[sec.id];
      if (!hit) return;
      if (sec.kind === 'array' && !Array.isArray(hit.value)) {
        errors.push('The "' + hit.name + '" section must be a list of exam reports, but it is ' + describe(hit.value) + '.');
        found[sec.id] = null;
      } else if (sec.kind === 'map' && !isPlainObject(hit.value)) {
        errors.push('The "' + hit.name + '" section must be an object keyed by question id, but it is ' + describe(hit.value) + '.');
        found[sec.id] = null;
      }
    });
    if (errors.length > 0) {
      return { ok: false, errors: errors, warnings: warnings, normalized: null };
    }

    // --- The sample-data flag ------------------------------------------------
    var isSampleData = false;
    if (parsed.summary !== undefined && parsed.summary !== null) {
      if (!isPlainObject(parsed.summary)) {
        errors.push('The file\'s "summary" section must be an object, but it is ' + describe(parsed.summary) + '.');
        return { ok: false, errors: errors, warnings: warnings, normalized: null };
      }
      if (parsed.summary.isSampleData !== undefined) {
        if (!isBool(parsed.summary.isSampleData)) {
          errors.push('The file\'s "summary.isSampleData" flag must be true or false, but it is ' + describe(parsed.summary.isSampleData) + '. Because that flag decides whether this data is treated as demo data, the file is not safe to import.');
          return { ok: false, errors: errors, warnings: warnings, normalized: null };
        }
        isSampleData = parsed.summary.isSampleData === true;
      }
    }

    if (parsed.schemaVersion !== undefined && isRealNumber(parsed.schemaVersion) && parsed.schemaVersion > IMPORT_SCHEMA_VERSION) {
      warnings.push('This file says it was written by a newer version of the app (schema ' + parsed.schemaVersion + '; this app understands ' + IMPORT_SCHEMA_VERSION + '). It will be checked with the rules this version knows.');
    }
    if (parsed.exportedAt !== undefined && typeof parsed.exportedAt === 'string' && isNaN(Date.parse(parsed.exportedAt))) {
      warnings.push('The file\'s "exportedAt" stamp (' + describe(parsed.exportedAt) + ') is not a readable date, so the age of this backup cannot be shown.');
    }

    // --- Per-entry validation ------------------------------------------------
    var normalized = {
      schemaVersion: IMPORT_SCHEMA_VERSION,
      exportedAt: (typeof parsed.exportedAt === 'string') ? parsed.exportedAt : null,
      isSampleData: isSampleData,
      progress: {},
      srsState: {},
      sessionsState: {},
      examHistory: [],
      counts: {
        progress: { present: 0, kept: 0, skipped: 0 },
        srsState: { present: 0, kept: 0, skipped: 0 },
        sessionsState: { present: 0, kept: 0, skipped: 0 },
        examHistory: { present: 0, kept: 0, skipped: 0 }
      },
      skipped: [],
      nonCanonicalIds: 0,
      sampleFlaggedEntries: 0
    };

    function skip(sectionId, key, reason) {
      normalized.counts[sectionId].skipped++;
      normalized.skipped.push({ section: sectionId, key: String(key), reason: reason });
    }

    // progress + srs share the question-id key rule, so it is written once.
    [
      { id: 'progress', check: checkProgressEntry },
      { id: 'srsState', check: checkSrsEntry }
    ].forEach(function (spec) {
      var hit = found[spec.id];
      if (!hit) return;
      var src = hit.value;
      Object.keys(src).forEach(function (qid) {
        normalized.counts[spec.id].present++;
        if (!PLAUSIBLE_QID.test(qid)) {
          skip(spec.id, qid, 'the question id "' + (qid.length > 40 ? qid.slice(0, 40) + '…' : qid) + '" is not a usable question id');
          return;
        }
        if (!CANONICAL_QID.test(qid)) normalized.nonCanonicalIds++;
        var reason = spec.check(qid, src[qid], atMs);
        if (reason) { skip(spec.id, qid, reason); return; }
        normalized[spec.id][qid] = deepCopy(src[qid]);
        if (src[qid] && src[qid].isSample === true) normalized.sampleFlaggedEntries++;
        normalized.counts[spec.id].kept++;
      });
    });

    if (found.sessionsState) {
      var sessSrc = found.sessionsState.value;
      Object.keys(sessSrc).forEach(function (dayKey) {
        normalized.counts.sessionsState.present++;
        if (!plausibleDateKey(dayKey, atMs)) {
          skip('sessionsState', dayKey, '"' + dayKey + '" is not a real practice date in YYYY-MM-DD form');
          return;
        }
        var reason = checkSessionEntry(dayKey, sessSrc[dayKey], atMs);
        if (reason) { skip('sessionsState', dayKey, reason); return; }
        normalized.sessionsState[dayKey] = deepCopy(sessSrc[dayKey]);
        normalized.counts.sessionsState.kept++;
      });
    }

    if (found.examHistory) {
      var seenExamIds = {};
      found.examHistory.value.forEach(function (entry, idx) {
        normalized.counts.examHistory.present++;
        var reason = checkExamEntry(entry, atMs);
        if (reason) { skip('examHistory', 'exam #' + (idx + 1), reason); return; }
        var identity = examIdentity(entry);
        if (seenExamIds[identity]) {
          skip('examHistory', identity, 'this exam report appears more than once in the file; the first copy was kept');
          return;
        }
        seenExamIds[identity] = true;
        normalized.examHistory.push(deepCopy(entry));
        if (entry.isSample === true) normalized.sampleFlaggedEntries++;
        normalized.counts.examHistory.kept++;
      });
    }

    var totalPresent = 0, totalKept = 0, totalSkipped = 0;
    Object.keys(normalized.counts).forEach(function (id) {
      totalPresent += normalized.counts[id].present;
      totalKept += normalized.counts[id].kept;
      totalSkipped += normalized.counts[id].skipped;
    });
    normalized.totals = { present: totalPresent, kept: totalKept, skipped: totalSkipped };

    if (totalPresent === 0) {
      errors.push('The file has the right sections but every one of them is empty — there is nothing to import.');
      return { ok: false, errors: errors, warnings: warnings, normalized: null };
    }
    if (totalKept === 0) {
      errors.push(
        'None of the ' + totalPresent + ' records in this file passed validation, so there is nothing safe to import. ' +
        'First problem: ' + (normalized.skipped[0] ? (normalized.skipped[0].key + ' — ' + normalized.skipped[0].reason) : 'unknown') + '.'
      );
      return { ok: false, errors: errors, warnings: warnings, normalized: null };
    }

    if (totalSkipped > 0) {
      warnings.push(totalSkipped + ' of the ' + totalPresent + ' records in this file failed validation and will NOT be imported. The other ' + totalKept + ' will be.');
    }
    if (normalized.nonCanonicalIds > 0) {
      warnings.push(normalized.nonCanonicalIds + ' record(s) use question ids that do not match this question bank\'s format (8 hex characters). They will be imported, but they may not match any question in the bank.');
    }
    if (isSampleData) {
      warnings.push('This file is flagged as SAMPLE (demo) data, not real student work. Importing it will switch the app into demo mode and show the demo banner.');
    } else if (normalized.sampleFlaggedEntries > 0) {
      warnings.push(normalized.sampleFlaggedEntries + ' record(s) inside this file are individually marked as sample data, but the file itself is not flagged as a sample export.');
    }

    return { ok: true, errors: errors, warnings: warnings, normalized: normalized };
  }

  // ---------------------------------------------------------------------------
  // The preview
  // ---------------------------------------------------------------------------

  function countKeys(v) {
    return isPlainObject(v) ? Object.keys(v).length : 0;
  }

  /**
   * Compares one map-shaped section (progress / srs / sessions).
   *
   * added        = keys in the file that the profile does not have
   * overwritten  = keys the file and the profile both have. Under MERGE these are
   *                reconciled record by record; under REPLACE the profile's copy
   *                is discarded outright.
   * erased       = keys the profile has that the file does NOT — zero under MERGE
   *                (a merge never removes a key), all of them under REPLACE.
   */
  function diffMaps(fileMap, currentMap, strategy) {
    var file = isPlainObject(fileMap) ? fileMap : {};
    var current = isPlainObject(currentMap) ? currentMap : {};
    var added = 0, overwritten = 0, erased = 0;
    Object.keys(file).forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(current, k)) overwritten++;
      else added++;
    });
    Object.keys(current).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(file, k)) {
        if (strategy === IMPORT_STRATEGIES.REPLACE) erased++;
      }
    });
    var fileCount = Object.keys(file).length;
    var currentCount = Object.keys(current).length;
    var resultCount;
    if (strategy === IMPORT_STRATEGIES.REPLACE) resultCount = fileCount;
    else if (strategy === IMPORT_STRATEGIES.MERGE) resultCount = currentCount + added;
    else { added = 0; overwritten = 0; erased = 0; resultCount = currentCount; }
    return {
      fileCount: fileCount, currentCount: currentCount,
      added: added, overwritten: overwritten, erased: erased, resultCount: resultCount
    };
  }

  /**
   * The exam-history comparison, keyed exactly the way mergeExamHistory keys it.
   *
   * `unkeyedCurrent` counts exam reports ALREADY in the profile that have neither
   * an examId nor a completedAt: the client merge silently drops those, so a merge
   * is not perfectly non-destructive for them and the preview says so out loud
   * instead of showing a comforting erased-0 (CLAUDE.md mode 1).
   */
  function diffExams(fileList, currentList, strategy) {
    var file = Array.isArray(fileList) ? fileList : [];
    var current = Array.isArray(currentList) ? currentList : [];
    var fileIds = {};
    file.forEach(function (e) {
      var id = examIdentity(e);
      if (id !== null) fileIds[id] = true;
    });
    var currentIds = {};
    var unkeyedCurrent = 0;
    current.forEach(function (e) {
      var id = examIdentity(e);
      if (id === null) { unkeyedCurrent++; return; }
      currentIds[id] = true;
    });

    var added = 0, overwritten = 0, erased = 0;
    Object.keys(fileIds).forEach(function (id) {
      if (currentIds[id]) overwritten++; else added++;
    });
    Object.keys(currentIds).forEach(function (id) {
      if (!fileIds[id] && strategy === IMPORT_STRATEGIES.REPLACE) erased++;
    });

    var fileCount = Object.keys(fileIds).length;
    var keyedCurrentCount = Object.keys(currentIds).length;
    var currentCount = current.length;
    var resultCount;
    if (strategy === IMPORT_STRATEGIES.REPLACE) {
      resultCount = fileCount;
      erased += unkeyedCurrent;
    } else if (strategy === IMPORT_STRATEGIES.MERGE) {
      resultCount = keyedCurrentCount + added;
      // A merge drops an unidentifiable stored report; that is an erasure and is
      // counted as one.
      erased += unkeyedCurrent;
    } else {
      added = 0; overwritten = 0; erased = 0;
      resultCount = currentCount;
    }
    return {
      fileCount: fileCount, currentCount: currentCount,
      added: added, overwritten: overwritten, erased: erased,
      resultCount: resultCount, unkeyedCurrent: unkeyedCurrent
    };
  }

  /**
   * Builds the per-key before/after table the parent dialog renders.
   *
   * Every number here is counted from the two objects passed in — the validated
   * file and the profile as it stands right now. Nothing is estimated, and the
   * CANCEL strategy is a real row of zeros so "cancel changes nothing" is a
   * measurement the parent can see rather than a promise.
   *
   * @param {Object} normalized the `normalized` object from validateImportFile
   * @param {{progress:Object, srsState:Object, sessionsState:Object, examHistory:Array}} current
   * @param {string} strategy one of IMPORT_STRATEGIES
   * @param {number} now caller's clock (recorded on the preview; nothing is derived from it)
   */
  function buildImportPreview(normalized, current, strategy, now) {
    var atMs = isRealNumber(now) ? now : Date.now();
    var strat = (strategy === IMPORT_STRATEGIES.MERGE || strategy === IMPORT_STRATEGIES.REPLACE)
      ? strategy : IMPORT_STRATEGIES.CANCEL;
    var norm = normalized || { progress: {}, srsState: {}, sessionsState: {}, examHistory: [], counts: null };
    var cur = current || {};

    var rows = [];
    var mapSpecs = [
      { id: 'progress', file: norm.progress, currentVal: cur.progress },
      { id: 'srsState', file: norm.srsState, currentVal: cur.srsState },
      { id: 'sessionsState', file: norm.sessionsState, currentVal: cur.sessionsState }
    ];
    mapSpecs.forEach(function (spec) {
      var sec = SECTIONS.filter(function (s) { return s.id === spec.id; })[0];
      var d = diffMaps(spec.file, spec.currentVal, strat);
      rows.push({
        id: sec.id, storageKey: sec.storageKey, label: sec.label,
        fileCount: d.fileCount, currentCount: d.currentCount,
        added: d.added, overwritten: d.overwritten, erased: d.erased, resultCount: d.resultCount
      });
    });

    var examSec = SECTIONS.filter(function (s) { return s.id === 'examHistory'; })[0];
    var ed = diffExams(norm.examHistory, cur.examHistory, strat);
    rows.push({
      id: examSec.id, storageKey: examSec.storageKey, label: examSec.label,
      fileCount: ed.fileCount, currentCount: ed.currentCount,
      added: ed.added, overwritten: ed.overwritten, erased: ed.erased, resultCount: ed.resultCount,
      unkeyedCurrent: ed.unkeyedCurrent
    });

    var totals = { fileCount: 0, currentCount: 0, added: 0, overwritten: 0, erased: 0, resultCount: 0 };
    rows.forEach(function (r) {
      totals.fileCount += r.fileCount;
      totals.currentCount += r.currentCount;
      totals.added += r.added;
      totals.overwritten += r.overwritten;
      totals.erased += r.erased;
      totals.resultCount += r.resultCount;
    });

    var warnings = [];
    if (ed.unkeyedCurrent > 0) {
      warnings.push(ed.unkeyedCurrent + ' exam report(s) already on this device have no exam id and no completion date. They cannot be carried across by either strategy and will be lost.');
    }
    if (strat === IMPORT_STRATEGIES.REPLACE && totals.currentCount > 0) {
      warnings.push('Replace erases ' + totals.currentCount + ' record(s) currently on this device: ' + totals.erased + ' of them exist nowhere in the import file.');
    }

    return {
      strategy: strat,
      generatedAt: atMs,
      isSampleData: !!norm.isSampleData,
      skippedCount: (norm.counts ? (norm.totals ? norm.totals.skipped : 0) : 0),
      rows: rows,
      totals: totals,
      warnings: warnings,
      // The exam count the writer must end up with. The old import passed a cap of
      // 15 to mergeExamHistory and silently dropped everything past it; the writer
      // now passes THIS number, so the cap can never be smaller than the result.
      examResultCount: ed.resultCount
    };
  }

  return {
    IMPORT_SCHEMA_VERSION: IMPORT_SCHEMA_VERSION,
    IMPORT_STRATEGIES: IMPORT_STRATEGIES,
    IMPORT_SECTIONS: SECTIONS,
    validateImportFile: validateImportFile,
    buildImportPreview: buildImportPreview
  };
});
