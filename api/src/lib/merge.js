/**
 * api/src/lib/merge.js
 *
 * The four non-destructive server-side merge rules applied by POST /api/sync
 * (api/src/functions/sync.js). Extracted verbatim from that handler in WI-07 so the
 * rules can be unit-pinned offline (tests/integrity/test_merge_pins.js) — this merge
 * is the contract that lets a v1 client (prod/beta lane) and a v2 client (/v2/ lane)
 * write to the SAME Cosmos document concurrently without either destroying the other's
 * data (REFACTOR_PLAN.md §3).
 *
 * Every function here is PURE:
 *   - no Cosmos client, no `context`, no network, no clock reads;
 *   - inputs are never mutated (sync.js reuses `existingMaster` after merging);
 *   - a null/undefined/absent argument degrades to an empty merge, never a throw
 *     (the first-ever push for a student has no stored document at all).
 *
 * Most of the behaviour below is a faithful transcription of what shipped, INCLUDING the
 * parts that are surprising. Those are pinned, not endorsed:
 *   - ties on timestamp / lastReviewedAt favour the INCOMING write (`>=`, not `>`);
 *   - exam entries with no `examId` are dropped (they cannot be deduplicated);
 *   - the session max-branch emits exactly {date, questionsAnswered, correct,
 *     totalTimeMs} and drops any other field the incoming day carried.
 * Changing any of these is a deliberate decision that must update the pin tests in the
 * same commit.
 *
 * ---------------------------------------------------------------------------
 * WI-22 CHANGED BEHAVIOUR — two deliberate, pin-updating edits (see
 * docs/PRODUCT_REVIEW_AND_IMPLEMENTATION_PLAN.md rows DATA-02 and DATA-01).
 *
 * 1. DATA-02 (was P0 data loss, now FIXED). `mergeSessions` used to read
 *    `if (prior && sess.questionsAnswered)`, so an incoming day whose
 *    `questionsAnswered` was 0 or missing REPLACED the stored day outright. A stored
 *    day holding ten answers was silently and permanently overwritten with zero in the
 *    master Cosmos document. A day present on BOTH sides now ALWAYS takes the per-field
 *    maximum, so an incoming zero can never subtract. A day only the incoming side
 *    knows about is still added as-is — that path was always correct.
 *    The pin in tests/integrity/test_merge_pins.js that asserted the destructive
 *    behaviour was rewritten in the same edit; new-behaviour coverage lives in
 *    tests/integrity/test_merge_semantics.js.
 *
 * 2. DATA-01 (P1, PARTIALLY mitigated — NOT closed). `mergeProgress` replaced the whole
 *    stored entry whenever the incoming `timestamp` was newer, so two devices that each
 *    answered the same question from a shared base of one prior attempt ended at
 *    `timesSeen: 2` when the true count is 3 — one branch's evidence was thrown away.
 *    The merge is now MONOTONIC: the newer timestamp still wins the answer CONTENT
 *    (selectedAnswer / isCorrect / timeSpentMs / timingReliable / timestamp),
 *    but timesSeen / timesCorrect / timesIncorrect take the per-field MAXIMUM, the
 *    capped `attempts` log becomes the deduplicated union of both sides,
 *    `historicalErrorTags` becomes a union by tag, and `isFlagged` is true if either
 *    side had it. A merge can therefore never make a counter go DOWN.
 *
 *    Be honest about what this does not do: it does NOT make the DATA-01 reproduction
 *    return the true 3. Two independent branches off a shared base of 1 still merge to
 *    2, because max(2,2) = 2 — the two attempts are indistinguishable without stable
 *    per-attempt identity. The real fix is durable append-only attempt events with
 *    stable ids (Milestone 3), which is out of scope here. This change only stops the
 *    counters from going backwards.
 *
 *    Two consequences worth stating plainly rather than hiding:
 *      - independent per-field maxima can break the `timesSeen === timesCorrect +
 *        timesIncorrect` invariant that buildProgressEntry maintains. That is lossless
 *        through the shard codec (api/src/lib/datamodel.js stores a `$v` override for a
 *        derived field whose real value differs), it just costs a few bytes. An
 *        inconsistent-but-never-shrinking counter is preferred here over a derived
 *        counter that can shrink.
 *      - a DELIBERATE downward correction — e.g. a parent "Replace" import that resets
 *        progress — is now harder to propagate, because a stale device pushing older,
 *        higher counters would resurrect them. That interaction is DATA-06 and is
 *        explicitly NOT solved here.
 *
 * The client-side twins of these rules live in `js/engine/sync.js`
 * (`mergeProgress` / `mergeSessionsState`) and already did per-field maxima; this change
 * brings the server into line with them rather than inventing a new rule
 * (CLAUDE.md mode 2).
 * ---------------------------------------------------------------------------
 *
 * Field names verified against the live `student_default_student` document on
 * 2026-08-29 (406 progress entries, 392 SRS cards): SRS cards use camelCase
 * `easeFactor` / `lastReviewedAt` / `intervalDays` — there is no `ease_factor` field.
 */

/**
 * The master document stores at most this many exam-history entries
 * (`sync.js` has always applied `.slice(0, 50)`). Older exams are not lost: every exam
 * is also written as its own immutable `exam_session` document, and GET /api/sync
 * re-merges those back in uncapped.
 */
const EXAM_HISTORY_CAP = 50;

/**
 * The per-question detail log is capped at the newest N attempts. This MUST stay equal
 * to the cap the client writes with — `buildProgressEntry` in js/engine/storage.js ends
 * with `attempts: attempts.slice(-3)`, and js/engine/sync.js's client-side merge uses
 * the same `.slice(-3)`. Read from there, not guessed; do not change it here alone.
 *
 * The counters timesSeen / timesCorrect / timesIncorrect are the durable exact totals
 * and are NEVER derived from this array's length — the array is lossy by design, so
 * deriving from it would make counters shrink.
 */
const ATTEMPT_LOG_CAP = 3;

/** Shallow copy of a plain object, tolerant of null/undefined/non-objects. */
function copyOf(obj) {
  return Object.assign({}, (obj && typeof obj === 'object') ? obj : {});
}

/** Entries of a plain object, tolerant of null/undefined/non-objects. */
function entriesOf(obj) {
  return (obj && typeof obj === 'object') ? Object.entries(obj) : [];
}

/**
 * The three durable per-question counters, each with the value implied by a LEGACY entry
 * that predates them entirely (13 of the 406 live progress entries carry no `timestamp`,
 * and older generations carry no counters at all). The implied values mirror the same
 * fallback js/engine/sync.js uses client-side.
 */
const PROGRESS_COUNTERS = {
  timesSeen: rec => (rec.answered ? 1 : 0),
  timesCorrect: rec => (rec.answered && rec.isCorrect ? 1 : 0),
  timesIncorrect: rec => (rec.answered && !rec.isCorrect ? 1 : 0)
};
const COUNTER_FIELDS = Object.keys(PROGRESS_COUNTERS);

/** True when a record carries NONE of the three counters — i.e. it predates them. */
function isPreCounterRecord(rec) {
  return !COUNTER_FIELDS.some(f => typeof rec[f] === 'number');
}

/**
 * Per-field MAX of one counter across two entries, or `null` when NEITHER side can speak
 * to it. Returning null rather than 0 is deliberate: a merge must never invent a counter
 * onto a record that never had one (CLAUDE.md mode 1).
 *
 * The legacy "answered implies 1" fallback applies ONLY to a side that carries none of
 * the three counters. A side that carries SOME of them is a counter-aware record whose
 * silence on one field is silence, not evidence — inferring `timesIncorrect: 1` from
 * `isCorrect: false` on a record that already reported `timesSeen: 1, timesCorrect: 0`
 * would double-count the single attempt it is describing, and would make a stale re-push
 * rewrite a Cosmos shard for no reason.
 */
function maxCounter(a, b, field) {
  const aVal = counterValue(a, field);
  const bVal = counterValue(b, field);
  if (aVal === null && bVal === null) return null;
  if (aVal === null) return bVal;
  if (bVal === null) return aVal;
  return Math.max(aVal, bVal);
}

function counterValue(rec, field) {
  if (typeof rec[field] === 'number') return rec[field];
  return isPreCounterRecord(rec) ? PROGRESS_COUNTERS[field](rec) : null;
}

/**
 * Union of two capped attempt logs, deduplicated by `at` (the client's stable per-attempt
 * key), oldest-first, then re-capped to ATTEMPT_LOG_CAP — the same cap and the same
 * newest-N ordering `buildProgressEntry` applies.
 *
 * Attempts with no numeric `at` cannot be deduped by key; rather than dropping them
 * (which is data loss) they are deduped by exact content and sorted to the FRONT, so the
 * cap discards them before it discards a real, timestamped attempt.
 *
 * Returns null when neither side has an attempts array, and null when the union would add
 * nothing the WINNING record does not already hold. That second case matters: it is what
 * makes `mergeProgress(x, x)` the exact identity, which in turn is what makes a v2 delta
 * push and a v1 full push converge on a byte-identical master document (the safety
 * argument written out in js/engine/sync.js's WI-11 comment). Rebuilding an identical
 * array would also re-cap a longer legacy log and rewrite a Cosmos shard for no reason.
 *
 * @param {Object} winner the record whose content won the timestamp race
 * @param {Object} loser  the other record
 */
function mergeAttemptLog(winner, loser) {
  const wList = Array.isArray(winner.attempts) ? winner.attempts : null;
  const lList = Array.isArray(loser.attempts) ? loser.attempts : null;
  if (!wList && !lList) return null;

  const attemptKey = att => att.attemptId ? `id:${att.attemptId}` : ((typeof att.at === 'number') ? `at:${att.at}` : `raw:${JSON.stringify(att)}`);
  const winnerKeys = new Set((wList || []).filter(a => a && typeof a === 'object').map(attemptKey));
  const adds = (lList || []).some(att => att && typeof att === 'object' && !winnerKeys.has(attemptKey(att)));
  if (!adds && wList) return null; // the winner already holds everything — leave it alone

  const byKey = new Map();
  (wList || []).concat(lList || []).forEach(att => {
    if (!att || typeof att !== 'object') return;
    const key = attemptKey(att);
    if (!byKey.has(key)) byKey.set(key, att);
  });

  const all = Array.from(byKey.values()).sort((x, y) => {
    const xa = (typeof x.at === 'number') ? x.at : -Infinity;
    const ya = (typeof y.at === 'number') ? y.at : -Infinity;
    return xa - ya;
  });
  return all.slice(-ATTEMPT_LOG_CAP);
}

/**
 * Union of two `historicalErrorTags` lists, deduplicated by `tag` (first occurrence wins,
 * winner's copy first). Returns null when neither side has the array, and null when the
 * loser contributes no tag the winner lacks — same identity argument as mergeAttemptLog.
 */
function mergeHistoricalErrorTags(winner, loser) {
  const wList = Array.isArray(winner.historicalErrorTags) ? winner.historicalErrorTags : null;
  const lList = Array.isArray(loser.historicalErrorTags) ? loser.historicalErrorTags : null;
  if (!wList && !lList) return null;

  const winnerTags = new Set((wList || []).filter(h => h && typeof h === 'object').map(h => String(h.tag)));
  const adds = (lList || []).some(h => h && typeof h === 'object' && !winnerTags.has(String(h.tag)));
  if (!adds && wList) return null; // nothing new to add — leave the winner's array alone

  const seen = new Set();
  const out = [];
  (wList || []).concat(lList || []).forEach(h => {
    if (!h || typeof h !== 'object') return;
    const key = String(h.tag);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(h);
  });
  return out;
}

/**
 * Merges per-question progress.
 *
 * For a question BOTH sides know about:
 *   - the newer `timestamp` wins the answer CONTENT (selectedAnswer, isCorrect,
 *     timeSpentMs, timingReliable, timestamp — everything on the winning
 *     record). A missing timestamp counts as 0, so a timestamp-less incoming entry can
 *     never displace a timestamped stored one; equal timestamps favour incoming (`>=`).
 *   - timesSeen / timesCorrect / timesIncorrect take the per-field MAXIMUM (WI-22,
 *     DATA-01): a merge can never make a counter go down. They are NOT derived from
 *     `attempts`, which is capped and lossy.
 *   - `attempts` becomes the deduplicated union of both logs, re-capped.
 *   - `historicalErrorTags` becomes the union by tag; `isFlagged` is true if either side
 *     had it.
 *   - `accuracyPercent` is RECOMPUTED from the merged counters when both are known and
 *     timesSeen > 0, so it can never disagree with the numbers beside it.
 *
 * A question only the incoming side knows about is added as-is. Null/undefined incoming
 * entries are skipped so a partial client payload can never blank a stored attempt.
 *
 * KNOWN LIMIT (DATA-01 is mitigated, not closed): two devices answering the same question
 * independently from a shared base still merge to 2, not the true 3. See the module
 * header. Fields the winning record does not carry at all, other than the ones unioned
 * above, are still dropped — whole-entry replacement remains for unmodelled fields.
 *
 * @param {Object|null|undefined} existing stored progress map (questionId -> entry)
 * @param {Object|null|undefined} incoming client-pushed progress map
 * @returns {Object} a new map; neither argument is mutated
 */
function mergeProgress(existing, incoming) {
  const merged = copyOf(existing);
  entriesOf(incoming).forEach(([qid, p]) => {
    if (!p) return;
    const prior = merged[qid];
    if (!prior) {
      merged[qid] = p;
      return;
    }

    // A replay must not add derived fields to an unchanged legacy record.
    if (JSON.stringify(prior) === JSON.stringify(p)) {merged[qid] = copyOf(prior); return;}

    // Content: newest write wins, unchanged from the shipped rule. Copied, never aliased,
    // so neither argument is mutated by the field writes below.
    const incomingWins = (p.timestamp || 0) >= (prior.timestamp || 0);
    const out = copyOf(incomingWins ? p : prior);

    // Counters: monotonic per-field max, never derived from the capped attempt log.
    Object.keys(PROGRESS_COUNTERS).filter(() => !(isPreCounterRecord(prior) && isPreCounterRecord(p))).forEach(field => {
      const v = maxCounter(prior, p, field);
      if (v !== null) out[field] = v;
    });
    if (typeof out.timesSeen === 'number' && typeof out.timesCorrect === 'number' && out.timesSeen > 0) {
      out.accuracyPercent = Math.round((out.timesCorrect / out.timesSeen) * 100);
    }

    const attempts = mergeAttemptLog(incomingWins ? p : prior, incomingWins ? prior : p);
    if (attempts !== null) out.attempts = attempts;

    const tags = mergeHistoricalErrorTags(incomingWins ? p : prior, incomingWins ? prior : p);
    if (tags !== null) out.historicalErrorTags = tags;

    // WI-32: flag edits are ordered by their own `flagUpdatedAt`, so a deliberate
    // REMOVAL is no longer undone by the other side's stale `true`. This mirrors
    // js/engine/sync.js exactly — the same rule on both ends, or they fight.
    // With neither side carrying the field we keep the old OR: absent means "legacy
    // record, ordering unknown", and losing a raise is worse than keeping one.
    var priorAt = (typeof prior.flagUpdatedAt === 'number') ? prior.flagUpdatedAt : null;
    var incomingAt = (typeof p.flagUpdatedAt === 'number') ? p.flagUpdatedAt : null;
    if (priorAt === null && incomingAt === null) {
      if (prior.isFlagged || p.isFlagged) out.isFlagged = true;
    } else if (incomingAt !== null && (priorAt === null || incomingAt >= priorAt)) {
      out.isFlagged = p.isFlagged === true;
      out.flagUpdatedAt = incomingAt;
    } else {
      out.isFlagged = prior.isFlagged === true;
      out.flagUpdatedAt = priorAt;
    }

    // Mirror the client's independent tag clock, including legacy removals.
    const priorMeta = Object.prototype.hasOwnProperty.call(prior, 'errorTag')
      ? (Number.isFinite(prior.metaUpdatedAt) ? prior.metaUpdatedAt : (prior.timestamp || prior.lastAttemptTime || 0)) : -1;
    const incomingMeta = Object.prototype.hasOwnProperty.call(p, 'errorTag')
      ? (Number.isFinite(p.metaUpdatedAt) ? p.metaUpdatedAt : (p.timestamp || p.lastAttemptTime || 0)) : -1;
    if (priorMeta >= 0 || incomingMeta >= 0) {
      const tagSource = incomingMeta >= priorMeta ? p : prior;
      out.errorTag = tagSource.errorTag;
      if (Number.isFinite(tagSource.metaUpdatedAt)) out.metaUpdatedAt = tagSource.metaUpdatedAt;
      else delete out.metaUpdatedAt;
    }

    merged[qid] = out;
  });
  return merged;
}

/**
 * Merges SM-2 SRS cards. Newer `lastReviewedAt` wins; a missing value counts as 0.
 * Cards are replaced wholesale (never field-merged) so a card's SM-2 state stays
 * internally consistent.
 *
 * @param {Object|null|undefined} existing stored card map (questionId -> card)
 * @param {Object|null|undefined} incoming client-pushed card map
 * @returns {Object} a new map; neither argument is mutated
 */
function mergeSrsState(existing, incoming) {
  const merged = copyOf(existing);
  entriesOf(incoming).forEach(([qid, card]) => {
    if (!card) return;
    const prior = merged[qid];
    if (!prior || (card.lastReviewedAt || 0) >= (prior.lastReviewedAt || 0)) {
      merged[qid] = card;
    }
  });
  return merged;
}

/**
 * Merges daily session totals. For a day both sides know about, each of
 * questionsAnswered / correct / totalTimeMs takes the MAX independently, so two devices
 * used on the same day cannot subtract from each other.
 *
 * WI-22 / DATA-02 — FIXED, this used to be the P0. The condition was
 * `if (prior && sess.questionsAnswered)`, so an incoming day whose `questionsAnswered`
 * was 0 or missing fell through to the else branch and REPLACED the stored day outright:
 * a stored day with ten answers became a day with zero, permanently, in the master Cosmos
 * document. A day present on both sides now ALWAYS max-merges, so an incoming zero can
 * only ever be a no-op. A day only the incoming side knows about is still added as-is.
 *
 * Still pinned, not endorsed: the max branch emits exactly {date, questionsAnswered,
 * correct, totalTimeMs}, so any other field on the incoming record is dropped for a day
 * that already exists. Also unchanged: per-field maxima cannot ADD two devices' genuinely
 * independent same-day work (that needs the durable unique events of Milestone 3) — but
 * max can only ever over-preserve, never delete.
 *
 * @param {Object|null|undefined} existing stored sessions map (dateStr -> record)
 * @param {Object|null|undefined} incoming client-pushed sessions map
 * @returns {Object} a new map; neither argument is mutated
 */
function mergeSessions(existing, incoming) {
  const merged = copyOf(existing);
  entriesOf(incoming).forEach(([dStr, sess]) => {
    if (!sess) return;
    const prior = merged[dStr];
    if (prior) {
      merged[dStr] = {
        date: dStr,
        questionsAnswered: Math.max(prior.questionsAnswered || 0, sess.questionsAnswered || 0),
        correct: Math.max(prior.correct || 0, sess.correct || 0),
        totalTimeMs: Math.max(prior.totalTimeMs || 0, sess.totalTimeMs || 0)
      };
    } else {
      merged[dStr] = sess;
    }
  });
  return merged;
}

/**
 * Merges exam history: deduplicate by `examId` (the incoming version of a duplicate
 * wins), sort newest-first by `completedAt` (missing counts as 0, sorting last), then
 * optionally truncate to `cap`.
 *
 * Entries that are null or carry no `examId` are dropped — they cannot be deduplicated,
 * and this is what the shipped code does.
 *
 * @param {Array|null|undefined} existing stored exam-history entries
 * @param {Array|null|undefined} incoming client-pushed exam entries (or `exam_session` docs)
 * @param {number} [cap] optional maximum entries to keep (POST passes EXAM_HISTORY_CAP;
 *                       the GET path omits it and keeps every exam)
 * @returns {Array} a new array; neither argument is mutated
 */
function mergeExamHistory(existing, incoming, cap) {
  const examMap = {};
  (Array.isArray(existing) ? existing : []).forEach(e => { if (e && e.examId) examMap[e.examId] = e; });
  (Array.isArray(incoming) ? incoming : []).forEach(e => { if (e && e.examId) examMap[e.examId] = e; });
  const merged = Object.values(examMap).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  return (typeof cap === 'number' && cap >= 0) ? merged.slice(0, cap) : merged;
}

module.exports = {
  EXAM_HISTORY_CAP,
  mergeProgress,
  mergeSrsState,
  mergeSessions,
  mergeExamHistory
};
