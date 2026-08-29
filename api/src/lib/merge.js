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
 * The behaviour below is a faithful transcription of what shipped, INCLUDING the
 * parts that are surprising. It is pinned, not endorsed:
 *   - ties on timestamp / lastReviewedAt favour the INCOMING write (`>=`, not `>`);
 *   - an incoming session day with a falsy `questionsAnswered` REPLACES the stored day
 *     outright rather than taking per-field maxima;
 *   - exam entries with no `examId` are dropped (they cannot be deduplicated).
 * Changing any of these is a deliberate decision that must update the pin tests in the
 * same commit.
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

/** Shallow copy of a plain object, tolerant of null/undefined/non-objects. */
function copyOf(obj) {
  return Object.assign({}, (obj && typeof obj === 'object') ? obj : {});
}

/** Entries of a plain object, tolerant of null/undefined/non-objects. */
function entriesOf(obj) {
  return (obj && typeof obj === 'object') ? Object.entries(obj) : [];
}

/**
 * Merges per-question progress. Newer `timestamp` wins; a missing timestamp counts as 0,
 * so a timestamp-less incoming entry can never displace a timestamped stored one.
 * Null/undefined incoming entries are skipped so a partial client payload can never
 * blank a stored attempt.
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
    if (!prior || (p.timestamp || 0) >= (prior.timestamp || 0)) {
      merged[qid] = p;
    }
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
 * Pinned quirk: when the incoming day has a falsy `questionsAnswered` (0 or missing) the
 * stored record is REPLACED by it rather than max-merged.
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
    if (prior && sess.questionsAnswered) {
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
