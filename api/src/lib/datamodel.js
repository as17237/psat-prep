/**
 * api/src/lib/datamodel.js — WI-11.5 "bound the data model": slim records + sharded documents.
 *
 * WHY THIS FILE EXISTS (measured, not hypothetical)
 * ------------------------------------------------
 * The single `student_<name>` master document holds every progress entry and every SRS
 * card. Measured on the real live document 2026-08-29: 406 progress entries, 392 SRS
 * cards, 234,708 bytes. `scripts/simulate_full_bank.js` projects **3.29 MB at full
 * 3,059-question coverage**, which is over Cosmos DB's **2 MB hard per-document limit** —
 * a write rejection, i.e. data loss, at roughly 1,500-2,000 answered questions.
 *
 * WI-11's 20-event SRS history cap saves 0 bytes on that trajectory: the growth driver is
 * the PER-ENTRY size, not the history length. So this module attacks both halves:
 *
 *   A. SLIM  — stop persisting fields that are exactly recomputable from the fields that
 *              remain, and shorten the hottest key names through ONE central mapping.
 *   B. SHARD — move progress and SRS out of the master document into ≤16 bucketed
 *              documents per collection, on the SAME `/student_name` partition key so a
 *              full read stays a single cheap in-partition query.
 *
 * THE LOSSLESSNESS PROPERTY (this is the part that matters)
 * --------------------------------------------------------
 * `slimProgressEntry` / `slimSrsCard` are **self-verifying**. Each one encodes, then
 * immediately expands its own output and compares it BYTE-FOR-BYTE (`JSON.stringify`,
 * key order included) with the input. If the round-trip is not byte-identical for any
 * reason at all — an unknown field, a key collision, a derived value that does not
 * actually hold, a key order this file has never seen — the encoder discards the slim
 * form and stores the original verbatim under `$r`.
 *
 * That means the codec cannot lose or alter a byte of student data even on input shapes
 * that did not exist when it was written. It can only fail to *save* bytes, and it
 * reports how often that happens (`fallbacks` in the shard-build result) so a silent
 * regression in compression shows up as a number rather than as corruption.
 *
 * Real key orders observed in the live document (all four progress shapes and the one
 * SRS shape round-trip with zero fallbacks — see tests/integrity/test_datamodel.js):
 *   progress n=299 [answered,selectedAnswer,isCorrect,timeSpentMs,timingReliable,isFlagged,
 *                   timestamp,timesSeen,timesCorrect,timesIncorrect,accuracyPercent,attempts]
 *   progress n=93  [ …same minus attempts ]
 *   progress n=13  [answered,isCorrect,timesSeen,timesCorrect,timesIncorrect,accuracyPercent,attempts]
 *   progress n=1   [isCorrect,timestamp,timesSeen,timesCorrect,timesIncorrect]
 *   srsState n=392 [questionId,repetitions,intervalDays,easeFactor,lastReviewedAt,dueAt,
 *                   lastGrade,history]
 *
 * PURITY: every function here is pure — no Cosmos client, no `context`, no network, no
 * clock reads, no mutation of any argument. Same contract as ../lib/merge.js, and for the
 * same reason: it must be unit-pinnable offline against real data.
 */

'use strict';

// ===========================================================================
// 1. Bucketing
// ===========================================================================

/**
 * Number of buckets per sharded collection. 16 keeps a full read to at most
 * 1 profile + 16 progress + 16 SRS = 33 documents in ONE partition, which Cosmos
 * serves as a single in-partition query.
 */
const SHARD_COUNT = 16;

/**
 * FNV-1a (32-bit). Deterministic, dependency-free, stable across Node versions and
 * machines — it is pure integer arithmetic on char codes with no locale, no clock and
 * no randomness. Chosen over "first hex character of the id" (the shape WI-11.5's spec
 * sketched) for one measured reason: the real live document contains the id `q100`,
 * which is not hex, and a prefix scheme has no defined bucket for it. Hashing the whole
 * id gives every id shape a bucket by the same rule, and measures slightly more evenly
 * on the real bundle (3,059 ids: spread 46 vs 60 — see tests/integrity/test_datamodel.js,
 * which prints both histograms).
 *
 * @param {string} str
 * @returns {number} unsigned 32-bit hash
 */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The bucket a question's records live in. Deterministic and permanent: a question
 * never changes bucket, because nothing but the id feeds the function.
 *
 * @param {string|number} questionId
 * @returns {number} 0 .. SHARD_COUNT-1
 */
function bucketOf(questionId) {
  return fnv1a32(String(questionId)) % SHARD_COUNT;
}

/** Zero-padded bucket label, so document ids sort naturally: b00 .. b15. */
function bucketLabel(bucket) {
  return 'b' + String(bucket).padStart(2, '0');
}

/**
 * Document ids. Deliberately NOT prefixed `student_` (that is the master profile) or
 * `exam_` (those are the immutable, protected exam_session records — REFACTOR_PLAN §3
 * forbids any tooling from writing them).
 */
function progressShardId(studentName, bucket) {
  return 'pshard_' + studentName + '_' + bucketLabel(bucket);
}
function srsShardId(studentName, bucket) {
  return 'sshard_' + studentName + '_' + bucketLabel(bucket);
}

const PROGRESS_SHARD_TYPE = 'progress_shard';
const SRS_SHARD_TYPE = 'srs_shard';

// ===========================================================================
// 2. The central key mapping
// ===========================================================================
//
// ONE table per record type. Nothing anywhere else in the codebase may shorten or
// lengthen a stored key — that is the "centralized mapping" precondition WI-11.5 puts
// on key shortening, and the round-trip tests are what make it safe.

/** progress entry: long field name -> stored short key. */
const PROGRESS_KEYS = {
  selectedAnswer: 'a',
  isCorrect: 'c',
  timeSpentMs: 't',
  timingReliable: 'r',
  isFlagged: 'f',
  timestamp: 'ts',
  errorTag: 'e',
  historicalErrorTags: 'h',
  timesSeen: 'n',
  timesCorrect: 'k',
  attempts: 'x'
};

/** one element of progress.attempts: long field name -> stored short key. */
const ATTEMPT_KEYS = {
  at: 'at',
  selectedAnswer: 'a',
  isCorrect: 'c',
  timeSpentMs: 't',
  source: 's'
};

/** SRS card: long field name -> stored short key. */
const SRS_KEYS = {
  repetitions: 'p',
  intervalDays: 'i',
  easeFactor: 'ef',
  lastReviewedAt: 'l',
  firstReviewedAt: 'fr',
  totalReviews: 'tr',
  totalLapses: 'tl',
  avgResponseTimeMs: 'ar',
  lastGrade: 'g',
  history: 'h'
};

/** one SRS history event: long field name -> stored short key. */
const SRS_EVENT_KEYS = {
  reviewedAt: 'v',
  grade: 'g',
  intervalDays: 'i',
  responseTimeMs: 'rt'
};

/**
 * Fields that are NOT persisted because they are exactly recomputable from fields that
 * are. Each carries:
 *   derive(rec)  -> the recomputed value, or the symbol MISMATCH when it cannot be derived
 *   anchor       -> where the expander re-inserts it, so key ORDER survives the round trip
 *                   ({first:true} | {after:'<field>'} | {before:'<field>'})
 *
 * Anchors were chosen to hold for BOTH record generations present in production: the
 * older writer that emits `isFlagged` before `timestamp`, and js/engine/storage.js's
 * current `buildProgressEntry`, which emits `timestamp` before `isFlagged`. The anchors
 * below reference only fields whose relative order is identical in both.
 */
const UNDERIVABLE = Symbol('underivable');

const PROGRESS_DERIVED = {
  // buildProgressEntry() sets this literally true on every entry it writes.
  answered: { derive: function () { return true; }, anchor: { first: true } },
  // timesSeen = timesCorrect + timesIncorrect, by construction in buildProgressEntry.
  timesIncorrect: {
    derive: function (r) {
      if (typeof r.timesSeen !== 'number' || typeof r.timesCorrect !== 'number') return UNDERIVABLE;
      return r.timesSeen - r.timesCorrect;
    },
    anchor: { after: 'timesCorrect' }
  },
  accuracyPercent: {
    derive: function (r) {
      if (typeof r.timesSeen !== 'number' || typeof r.timesCorrect !== 'number') return UNDERIVABLE;
      if (r.timesSeen === 0) return UNDERIVABLE;
      return Math.round((r.timesCorrect / r.timesSeen) * 100);
    },
    anchor: { after: 'timesIncorrect' }
  }
};

const SRS_DERIVED = {
  // scheduleNext() writes `card.questionId || ''`, and 392/392 live cards hold ''.
  // A card that carries a real id round-trips through the $v escape hatch instead.
  questionId: { derive: function () { return ''; }, anchor: { first: true } },
  // scheduleNext(): dueAt = lastReviewedAt + intervalDays * 86400000. Verified exact on
  // 392/392 live cards.
  dueAt: {
    derive: function (r) {
      if (typeof r.lastReviewedAt !== 'number' || typeof r.intervalDays !== 'number') return UNDERIVABLE;
      return r.lastReviewedAt + r.intervalDays * 86400000;
    },
    anchor: { before: 'lastGrade' }
  }
};

/** Escape-hatch keys on a slim record. Chosen to be impossible as JS identifiers. */
const K_OMITTED = '$o';   // derived fields that were ABSENT from the original
const K_OVERRIDE = '$v';  // derived fields whose stored value differs from the derived one
const K_RAW = '$r';       // whole original record, stored verbatim (round-trip fallback)

// ===========================================================================
// 3. The codec
// ===========================================================================

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Encodes one record against a key map + derived-field table, WITHOUT the self-verify
 * step. Never called directly from outside; `encodeChecked` wraps it.
 */
function encodeRecord(rec, keyMap, derivedTable, encodeValue) {
  const out = {};
  const omitted = [];
  const overrides = {};

  Object.keys(derivedTable).forEach(function (field) {
    if (!(field in rec)) { omitted.push(field); return; }
    const want = derivedTable[field].derive(rec);
    if (want === UNDERIVABLE || want !== rec[field]) overrides[field] = rec[field];
  });

  Object.keys(rec).forEach(function (field) {
    if (field in derivedTable) return;               // handled above
    const short = keyMap[field] || field;            // unknown fields pass through verbatim
    out[short] = encodeValue ? encodeValue(field, rec[field], rec) : rec[field];
  });

  if (omitted.length) out[K_OMITTED] = omitted;
  if (Object.keys(overrides).length) out[K_OVERRIDE] = overrides;
  return out;
}

/**
 * Decodes a slim record back to its full shape, re-inserting derived fields at their
 * anchored positions so that key ORDER — and therefore the serialised bytes — matches
 * the original.
 */
function decodeRecord(slim, keyMap, derivedTable, decodeValue) {
  if (isPlainObject(slim) && K_RAW in slim) return slim[K_RAW];

  const shortToLong = {};
  Object.keys(keyMap).forEach(function (long) { shortToLong[keyMap[long]] = long; });

  const omitted = Array.isArray(slim[K_OMITTED]) ? slim[K_OMITTED] : [];
  const overrides = isPlainObject(slim[K_OVERRIDE]) ? slim[K_OVERRIDE] : {};

  // Which derived fields are present in the reconstructed record, and with what value.
  const derivedPresent = {};
  Object.keys(derivedTable).forEach(function (field) {
    if (omitted.indexOf(field) !== -1) return;
    derivedPresent[field] = (field in overrides) ? overrides[field] : null; // value filled below
  });

  // Rebuild the kept fields in stored order first (that order mirrors the original).
  const kept = [];
  Object.keys(slim).forEach(function (short) {
    if (short === K_OMITTED || short === K_OVERRIDE) return;
    const long = shortToLong[short] || short;
    kept.push(long);
  });

  // Assemble in order, splicing derived fields in at their anchors.
  const order = [];
  Object.keys(derivedTable).forEach(function (field) {
    if (!(field in derivedPresent)) return;
    if (derivedTable[field].anchor.first) order.push(field);
  });
  kept.forEach(function (long) {
    Object.keys(derivedTable).forEach(function (field) {
      if (!(field in derivedPresent)) return;
      if (derivedTable[field].anchor.before === long) order.push(field);
    });
    order.push(long);
    Object.keys(derivedTable).forEach(function (field) {
      if (!(field in derivedPresent)) return;
      if (derivedTable[field].anchor.after === long) order.push(field);
    });
  });
  // A derived field anchored AFTER another derived field (accuracyPercent after
  // timesIncorrect) needs a second pass now that timesIncorrect is placed.
  let grew = true;
  while (grew) {
    grew = false;
    Object.keys(derivedTable).forEach(function (field) {
      if (!(field in derivedPresent) || order.indexOf(field) !== -1) return;
      const a = derivedTable[field].anchor;
      const target = a.after || a.before;
      const idx = order.indexOf(target);
      if (idx === -1) return;
      order.splice(a.after ? idx + 1 : idx, 0, field);
      grew = true;
    });
  }
  // Anything still unplaced (anchor target absent from this record) goes last, in
  // declaration order — the round-trip check will reject it if that is wrong.
  Object.keys(derivedTable).forEach(function (field) {
    if ((field in derivedPresent) && order.indexOf(field) === -1) order.push(field);
  });

  const out = {};
  order.forEach(function (field) {
    if (field in derivedPresent) {
      if (field in overrides) { out[field] = overrides[field]; return; }
      const want = derivedTable[field].derive(out);
      out[field] = (want === UNDERIVABLE) ? null : want;
      return;
    }
    const short = keyMap[field] || field;
    out[field] = decodeValue ? decodeValue(field, slim[short], out, slim) : slim[short];
  });
  return out;
}

/**
 * Self-verifying encode. Returns `{slim, fellBack}`; `fellBack` is true when the codec
 * refused its own output and stored the original verbatim.
 *
 * The comparison is `JSON.stringify` on both sides, so it catches value changes AND key
 * reordering. This is the single mechanism that makes "no data loss" a property of the
 * code rather than a claim about the fields it happens to know about today.
 */
function encodeChecked(rec, encode, decode) {
  if (!isPlainObject(rec)) return { slim: { [K_RAW]: rec }, fellBack: true };
  let slim;
  try {
    slim = encode(rec);
  } catch (err) {
    return { slim: { [K_RAW]: rec }, fellBack: true };
  }
  let roundTrip;
  try {
    roundTrip = decode(slim);
  } catch (err) {
    return { slim: { [K_RAW]: rec }, fellBack: true };
  }
  if (JSON.stringify(roundTrip) !== JSON.stringify(rec)) {
    return { slim: { [K_RAW]: rec }, fellBack: true };
  }
  return { slim: slim, fellBack: false };
}

// --- progress ---------------------------------------------------------------

/**
 * Encodes progress.attempts. The NEWEST attempt duplicates four fields that the entry
 * already carries at top level (`at`==timestamp, selectedAnswer, isCorrect, timeSpentMs
 * — verified identical on all 298 live entries that have an attempt), so those are
 * dropped from that one element and refilled on read.
 */
function encodeAttempts(attempts, entry) {
  if (!Array.isArray(attempts)) return attempts;
  const lastIdx = attempts.length - 1;
  return attempts.map(function (att, i) {
    if (!isPlainObject(att)) return att;
    const out = {};
    Object.keys(att).forEach(function (field) {
      if (i === lastIdx) {
        if (field === 'at' && att.at === entry.timestamp) return;
        if (field === 'selectedAnswer' && att.selectedAnswer === entry.selectedAnswer) return;
        if (field === 'isCorrect' && att.isCorrect === entry.isCorrect) return;
        if (field === 'timeSpentMs' && att.timeSpentMs === entry.timeSpentMs) return;
      }
      out[ATTEMPT_KEYS[field] || field] = att[field];
    });
    return out;
  });
}

/** Field order inside one attempt, used to re-insert the collapsed newest-attempt fields. */
const ATTEMPT_ORDER = ['at', 'selectedAnswer', 'isCorrect', 'timeSpentMs', 'source'];

function decodeAttempts(slimAttempts, entrySoFar) {
  if (!Array.isArray(slimAttempts)) return slimAttempts;
  const shortToLong = {};
  Object.keys(ATTEMPT_KEYS).forEach(function (long) { shortToLong[ATTEMPT_KEYS[long]] = long; });
  const lastIdx = slimAttempts.length - 1;
  return slimAttempts.map(function (att, i) {
    if (!isPlainObject(att)) return att;
    const present = {};
    Object.keys(att).forEach(function (short) { present[shortToLong[short] || short] = att[short]; });
    const out = {};
    ATTEMPT_ORDER.forEach(function (field) {
      if (field in present) { out[field] = present[field]; return; }
      if (i !== lastIdx) return;
      if (field === 'at') out.at = entrySoFar.timestamp;
      else if (field === 'selectedAnswer') out.selectedAnswer = entrySoFar.selectedAnswer;
      else if (field === 'isCorrect') out.isCorrect = entrySoFar.isCorrect;
      else if (field === 'timeSpentMs') out.timeSpentMs = entrySoFar.timeSpentMs;
    });
    // Any field the map does not know about keeps its place at the end.
    Object.keys(present).forEach(function (field) {
      if (!(field in out) && ATTEMPT_ORDER.indexOf(field) === -1) out[field] = present[field];
    });
    return out;
  });
}

function encodeProgressRaw(entry) {
  return encodeRecord(entry, PROGRESS_KEYS, PROGRESS_DERIVED, function (field, value, rec) {
    return field === 'attempts' ? encodeAttempts(value, rec) : value;
  });
}

function expandProgressEntry(slim) {
  return decodeRecord(slim, PROGRESS_KEYS, PROGRESS_DERIVED, function (field, value, soFar) {
    return field === 'attempts' ? decodeAttempts(value, soFar) : value;
  });
}

function slimProgressEntry(entry) {
  return encodeChecked(entry, encodeProgressRaw, expandProgressEntry);
}

// --- SRS ---------------------------------------------------------------------

function encodeSrsHistory(history) {
  if (!Array.isArray(history)) return history;
  return history.map(function (ev) {
    if (!isPlainObject(ev)) return ev;
    const out = {};
    Object.keys(ev).forEach(function (field) { out[SRS_EVENT_KEYS[field] || field] = ev[field]; });
    return out;
  });
}

function decodeSrsHistory(slimHistory) {
  if (!Array.isArray(slimHistory)) return slimHistory;
  const shortToLong = {};
  Object.keys(SRS_EVENT_KEYS).forEach(function (long) { shortToLong[SRS_EVENT_KEYS[long]] = long; });
  return slimHistory.map(function (ev) {
    if (!isPlainObject(ev)) return ev;
    const out = {};
    Object.keys(ev).forEach(function (short) { out[shortToLong[short] || short] = ev[short]; });
    return out;
  });
}

function encodeSrsRaw(card) {
  return encodeRecord(card, SRS_KEYS, SRS_DERIVED, function (field, value) {
    return field === 'history' ? encodeSrsHistory(value) : value;
  });
}

function expandSrsCard(slim) {
  return decodeRecord(slim, SRS_KEYS, SRS_DERIVED, function (field, value) {
    return field === 'history' ? decodeSrsHistory(value) : value;
  });
}

function slimSrsCard(card) {
  return encodeChecked(card, encodeSrsRaw, expandSrsCard);
}

// ===========================================================================
// 4. Map-level helpers
// ===========================================================================

function slimProgressMap(progress) {
  const out = {};
  let fallbacks = 0;
  Object.keys(progress || {}).forEach(function (qid) {
    const r = slimProgressEntry(progress[qid]);
    if (r.fellBack) fallbacks++;
    out[qid] = r.slim;
  });
  return { slim: out, fallbacks: fallbacks };
}

function expandProgressMap(slimMap) {
  const out = {};
  Object.keys(slimMap || {}).forEach(function (qid) { out[qid] = expandProgressEntry(slimMap[qid]); });
  return out;
}

function slimSrsMap(srsState) {
  const out = {};
  let fallbacks = 0;
  Object.keys(srsState || {}).forEach(function (qid) {
    const r = slimSrsCard(srsState[qid]);
    if (r.fellBack) fallbacks++;
    out[qid] = r.slim;
  });
  return { slim: out, fallbacks: fallbacks };
}

function expandSrsMap(slimMap) {
  const out = {};
  Object.keys(slimMap || {}).forEach(function (qid) { out[qid] = expandSrsCard(slimMap[qid]); });
  return out;
}

// ===========================================================================
// 5. Shard documents
// ===========================================================================

/**
 * Splits a full progress map into ≤SHARD_COUNT shard documents.
 * Empty buckets produce NO document — a student with 12 answers writes 1-12 shards,
 * not 16 empty ones.
 *
 * @returns {{docs:Object[], fallbacks:number, buckets:number[]}}
 */
function buildProgressShards(studentName, progress, extra) {
  const byBucket = {};
  let fallbacks = 0;
  Object.keys(progress || {}).forEach(function (qid) {
    const b = bucketOf(qid);
    const r = slimProgressEntry(progress[qid]);
    if (r.fellBack) fallbacks++;
    (byBucket[b] = byBucket[b] || {})[qid] = r.slim;
  });
  const docs = Object.keys(byBucket).map(Number).sort(function (a, b) { return a - b; }).map(function (b) {
    return Object.assign({
      id: progressShardId(studentName, b),
      student_name: studentName,
      doc_type: PROGRESS_SHARD_TYPE,
      bucket: b,
      entryCount: Object.keys(byBucket[b]).length,
      entries: byBucket[b]
    }, extra || {});
  });
  return { docs: docs, fallbacks: fallbacks, buckets: Object.keys(byBucket).map(Number) };
}

function buildSrsShards(studentName, srsState, extra) {
  const byBucket = {};
  let fallbacks = 0;
  Object.keys(srsState || {}).forEach(function (qid) {
    const b = bucketOf(qid);
    const r = slimSrsCard(srsState[qid]);
    if (r.fellBack) fallbacks++;
    (byBucket[b] = byBucket[b] || {})[qid] = r.slim;
  });
  const docs = Object.keys(byBucket).map(Number).sort(function (a, b) { return a - b; }).map(function (b) {
    return Object.assign({
      id: srsShardId(studentName, b),
      student_name: studentName,
      doc_type: SRS_SHARD_TYPE,
      bucket: b,
      cardCount: Object.keys(byBucket[b]).length,
      cards: byBucket[b]
    }, extra || {});
  });
  return { docs: docs, fallbacks: fallbacks, buckets: Object.keys(byBucket).map(Number) };
}

/**
 * Reassembles the full progress map from a set of shard documents. Docs of any other
 * type are ignored, so this can be handed the raw result of "SELECT * FROM c WHERE
 * c.student_name = @s".
 */
function reassembleProgress(docs) {
  const out = {};
  (docs || []).forEach(function (d) {
    if (!d || d.doc_type !== PROGRESS_SHARD_TYPE) return;
    Object.keys(d.entries || {}).forEach(function (qid) { out[qid] = expandProgressEntry(d.entries[qid]); });
  });
  return out;
}

function reassembleSrs(docs) {
  const out = {};
  (docs || []).forEach(function (d) {
    if (!d || d.doc_type !== SRS_SHARD_TYPE) return;
    Object.keys(d.cards || {}).forEach(function (qid) { out[qid] = expandSrsCard(d.cards[qid]); });
  });
  return out;
}

// ===========================================================================
// 6. Exam-history index
// ===========================================================================

/**
 * The master document's copy of an exam report, with `moduleReports` removed.
 *
 * This is safe ONLY for an exam whose immutable `exam_session` document is confirmed to
 * exist, because GET /api/sync already merges those documents over the master's copy
 * (mergeExamHistory lets the incoming exam_session win on a duplicate examId) and
 * already does so uncapped. The full report therefore still reaches every reader; what
 * is removed is a second copy of it inside the growth-critical document.
 *
 * `sync.js` only applies this to examIds it has just confirmed present (create returned
 * 201, or 409 "already there"). An unconfirmed exam keeps its full report on the master.
 *
 * Measured need: a 98-question standard mock's lean report is ~8.5 KB, and the master
 * keeps EXAM_HISTORY_CAP = 50 of them — ~425 KB, over the 400 KB budget on its own.
 */
function examIndexEntry(exam) {
  if (!exam || typeof exam !== 'object') return exam;
  const out = {};
  Object.keys(exam).forEach(function (k) {
    if (k === 'moduleReports') return;
    out[k] = exam[k];
  });
  out.moduleReportsInSessionDoc = true;
  return out;
}

// ===========================================================================
// 7. Measurement
// ===========================================================================

function bytesOf(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Serialises a questionId -> record map with its OUTER keys sorted, while each record's
 * own key order is left exactly as stored.
 *
 * This is the equality used to prove a migration lost nothing, and the distinction
 * matters. Inside a record, key order is a property of the bytes that were written and
 * this codec reproduces it exactly — that is asserted per record. Across the map, key
 * order is an insertion-order artefact carrying no information, and sharding necessarily
 * regroups the keys by bucket; preserving it would mean storing an ordering nobody reads.
 * So the map-level proof sorts the keys, and the record-level proof does not.
 *
 * Both halves are asserted in tests/integrity/test_datamodel.js: identical key SETS,
 * every record byte-identical, and this canonical serialisation byte-identical.
 */
function canonicalMapJson(map) {
  const keys = Object.keys(map || {}).sort();
  return '{' + keys.map(function (k) {
    return JSON.stringify(k) + ':' + JSON.stringify(map[k]);
  }).join(',') + '}';
}

/**
 * Before/after per-entry byte measurement for a progress or SRS map. Used by the tests
 * and by scripts/simulate_full_bank.js so the "≥40% reduction" claim is always a printed
 * measurement rather than an assertion in prose (CLAUDE.md mode 1).
 */
function measureReduction(originalMap, slimMap) {
  const n = Object.keys(originalMap || {}).length;
  const before = bytesOf(originalMap);
  const after = bytesOf(slimMap);
  return {
    count: n,
    beforeBytes: before,
    afterBytes: after,
    beforePerEntry: n ? before / n : 0,
    afterPerEntry: n ? after / n : 0,
    savedBytes: before - after,
    reductionPercent: before ? (100 * (before - after) / before) : 0
  };
}

module.exports = {
  SHARD_COUNT,
  PROGRESS_SHARD_TYPE,
  SRS_SHARD_TYPE,
  K_OMITTED,
  K_OVERRIDE,
  K_RAW,
  PROGRESS_KEYS,
  ATTEMPT_KEYS,
  SRS_KEYS,
  SRS_EVENT_KEYS,
  fnv1a32,
  bucketOf,
  bucketLabel,
  progressShardId,
  srsShardId,
  slimProgressEntry,
  expandProgressEntry,
  slimSrsCard,
  expandSrsCard,
  slimProgressMap,
  expandProgressMap,
  slimSrsMap,
  expandSrsMap,
  buildProgressShards,
  buildSrsShards,
  reassembleProgress,
  reassembleSrs,
  examIndexEntry,
  bytesOf,
  canonicalMapJson,
  measureReduction
};
