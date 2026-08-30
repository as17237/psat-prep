/**
 * tests/integrity/test_datamodel.js — WI-11.5 slim-codec and bucket pins.
 *
 * OFFLINE. No Cosmos, no network, no clock reads. Two data sources, both real:
 *
 *   - tests/integrity/fixtures/real_master_profile_2026-08-29.json — a verbatim copy of
 *     the PRODUCTION student document, taken read-only from the WI-02 immutable baseline
 *     (blob refactor-baseline/baseline_2026-08-29T14-09-29Z/cosmos/UATStudentAnswers.json,
 *     sha256 verified before parsing). 406 progress entries, 392 SRS cards, 9 exams.
 *     Only Cosmos system fields were stripped; nothing else was altered.
 *   - data/questions_data.js — the real 3,059-question bundle, for the bucket histogram.
 *
 * CLAUDE.md mode 4 is the reason for that: a round-trip codec tested only against
 * hand-made fixtures proves nothing about the shapes production actually contains, and
 * the real document turns out to contain four different progress key-orders, one entry
 * with `timesSeen: 0`, and one entry whose stored `timesIncorrect` contradicts
 * `timesSeen - timesCorrect`. Every one of those is a trap for a naive "just recompute
 * it" slimmer, and each is pinned below.
 *
 * The ten hand-checked expectations in section 3 are written out BY HAND from the
 * fixture's stored bytes — they are not produced by calling the code under test.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dm = require('../../api/src/lib/datamodel.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'real_master_profile_2026-08-29.json');
const BUNDLE = path.join(__dirname, '..', '..', 'data', 'questions_data.js');

let checks = 0;
function ok(msg) { checks++; console.log(`  ✓ ${msg}`); }

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const MASTER = fixture.documents.find(d => d.id === 'student_default_student');
assert.ok(MASTER, 'fixture must contain student_default_student');

console.log('WI-11.5 data-model pins (offline; real production document + real question bundle)\n');

// =========================================================================
// 1. Bucket assignment: deterministic, stable, bounded, evenly spread.
// =========================================================================
console.log('1. bucketOf — determinism, stability, distribution');
{
  // Hand-written: FNV-1a is a fixed algorithm, so these are constants of the function,
  // not of any run. Recomputed here by hand from the published FNV-1a 32-bit definition
  // (offset basis 2166136261, prime 16777619) — see the note below each value.
  assert.strictEqual(dm.fnv1a32(''), 2166136261, 'empty string is the offset basis');
  assert.strictEqual(dm.fnv1a32('a'), 0xe40c292c, "fnv1a32('a') is the canonical test vector");
  assert.strictEqual(dm.fnv1a32('foobar'), 0xbf9cf968, "fnv1a32('foobar') is the canonical test vector");
  ok('fnv1a32 matches the published FNV-1a 32-bit test vectors');

  assert.strictEqual(dm.SHARD_COUNT, 16);
  ok('SHARD_COUNT is 16 (a full read is 1 profile + ≤16 + ≤16 documents in one partition)');

  // Determinism across calls and across a fresh module instance.
  const ids = ['15074829', '1b9fa866', 'q100', '737870c6', 'da9a6075'];
  const first = ids.map(dm.bucketOf);
  const second = ids.map(dm.bucketOf);
  delete require.cache[require.resolve('../../api/src/lib/datamodel.js')];
  const reloaded = require('../../api/src/lib/datamodel.js');
  const third = ids.map(reloaded.bucketOf);
  assert.deepStrictEqual(second, first, 'repeat calls must agree');
  assert.deepStrictEqual(third, first, 'a freshly loaded module must agree');
  ok(`bucketOf is stable across calls and module reloads: ${ids.map((i, n) => `${i}->${first[n]}`).join(', ')}`);

  // Non-hex ids exist in the real document; a prefix-of-hex scheme has no bucket for them.
  assert.ok(Number.isInteger(dm.bucketOf('q100')) && dm.bucketOf('q100') >= 0 && dm.bucketOf('q100') < 16,
    'the real id "q100" is not hex and must still get a bucket');
  ok('non-hex real id "q100" gets a valid bucket (this is why the scheme hashes the whole id)');

  // Distribution over the real 3,059-question bundle.
  const js = fs.readFileSync(BUNDLE, 'utf8');
  const questions = JSON.parse(js.slice(js.indexOf('=') + 1, js.lastIndexOf(']') + 1));
  assert.strictEqual(questions.length, 3059, 'the bundle is frozen at 3,059 questions');
  const hist = new Array(16).fill(0);
  const hexHist = new Array(16).fill(0);
  questions.forEach(q => {
    hist[dm.bucketOf(q.id)]++;
    hexHist[parseInt(String(q.id)[0], 16) & 15]++;
  });
  const total = hist.reduce((a, b) => a + b, 0);
  const min = Math.min.apply(null, hist), max = Math.max.apply(null, hist);
  console.log(`     fnv1a bucket histogram over 3,059 real ids : ${hist.join(',')}`);
  console.log(`       min ${min}  max ${max}  spread ${max - min}  mean ${(3059 / 16).toFixed(1)}`);
  console.log(`     (first-hex-char alternative, for contrast) : ${hexHist.join(',')}  spread ` +
    `${Math.max.apply(null, hexHist) - Math.min.apply(null, hexHist)}`);
  assert.strictEqual(total, 3059, 'every question lands in exactly one bucket');
  assert.ok(min > 0, 'no empty bucket');
  // Even to within ±30% of the mean. Hand-chosen tolerance: a 16-way split of 3,059 has
  // mean 191.2, so this rejects any bucket outside 134..249.
  assert.ok(min >= 134 && max <= 249, `bucket sizes ${min}..${max} must sit within 134..249`);
  ok(`3,059 real ids spread over all 16 buckets, ${min}..${max} per bucket (mean 191.2)`);

  // Document ids.
  assert.strictEqual(dm.progressShardId('default_student', 3), 'pshard_default_student_b03');
  assert.strictEqual(dm.srsShardId('default_student', 15), 'sshard_default_student_b15');
  ok('shard document ids are zero-padded and collide with neither student_* nor exam_*');
}

// =========================================================================
// 2. Lossless round trip on EVERY real record.
// =========================================================================
console.log('\n2. Slim round trip on all 406 real progress entries and 392 real SRS cards');
{
  const progress = MASTER.progress;
  const srs = MASTER.srsState;
  assert.strictEqual(Object.keys(progress).length, 406, 'the fixture must hold the real 406 entries');
  assert.strictEqual(Object.keys(srs).length, 392, 'the fixture must hold the real 392 cards');

  const p = dm.slimProgressMap(progress);
  const s = dm.slimSrsMap(srs);
  const backP = dm.expandProgressMap(p.slim);
  const backS = dm.expandSrsMap(s.slim);

  // Per-entry, so a failure names the question rather than saying "the map differs".
  Object.keys(progress).forEach(qid => {
    assert.strictEqual(JSON.stringify(backP[qid]), JSON.stringify(progress[qid]),
      `progress entry ${qid} did not round-trip byte-for-byte`);
  });
  Object.keys(srs).forEach(qid => {
    assert.strictEqual(JSON.stringify(backS[qid]), JSON.stringify(srs[qid]),
      `srs card ${qid} did not round-trip byte-for-byte`);
  });
  ok('all 798 real records round-trip byte-for-byte (JSON.stringify, key order included)');

  assert.strictEqual(JSON.stringify(backP), JSON.stringify(progress),
    'the whole progress map must round-trip byte-for-byte');
  assert.strictEqual(JSON.stringify(backS), JSON.stringify(srs),
    'the whole srsState map must round-trip byte-for-byte');
  ok('both whole maps round-trip byte-for-byte');

  assert.strictEqual(p.fallbacks, 0, 'no real progress entry should need the verbatim fallback');
  assert.strictEqual(s.fallbacks, 0, 'no real SRS card should need the verbatim fallback');
  ok('zero codec fallbacks on real data (every record actually compressed)');

  const pm = dm.measureReduction(progress, p.slim);
  const sm = dm.measureReduction(srs, s.slim);
  console.log(`     progress : ${pm.count} entries  ${pm.beforeBytes} -> ${pm.afterBytes} bytes  ` +
    `(${pm.beforePerEntry.toFixed(1)} -> ${pm.afterPerEntry.toFixed(1)} B/entry, ${pm.reductionPercent.toFixed(1)}% smaller)`);
  console.log(`     srsState : ${sm.count} cards    ${sm.beforeBytes} -> ${sm.afterBytes} bytes  ` +
    `(${sm.beforePerEntry.toFixed(1)} -> ${sm.afterPerEntry.toFixed(1)} B/card, ${sm.reductionPercent.toFixed(1)}% smaller)`);
  // WI-11.5's acceptance target is ≥40% per entry.
  assert.ok(pm.reductionPercent >= 40, `progress reduction ${pm.reductionPercent.toFixed(1)}% must be ≥40%`);
  assert.ok(sm.reductionPercent >= 40, `srs reduction ${sm.reductionPercent.toFixed(1)}% must be ≥40%`);
  ok(`per-record reduction beats the 40% target: progress ${pm.reductionPercent.toFixed(1)}%, srs ${sm.reductionPercent.toFixed(1)}%`);
}

// =========================================================================
// 3. Ten hand-checked records. Expected values written out by hand from the
//    fixture's stored bytes — NOT produced by the code under test.
// =========================================================================
console.log('\n3. Ten hand-written expectations (read off the fixture, not computed by the codec)');
{
  const P = MASTER.progress;
  const S = MASTER.srsState;

  // --- (1) A one-attempt practice entry: the four derivable fields must vanish, and
  //         the single attempt must collapse to just its `source`.
  assert.deepStrictEqual(P['52332846'], {
    answered: true, selectedAnswer: 'C', isCorrect: true, timeSpentMs: 25734,
    timingReliable: true, isFlagged: false, timestamp: 1787771651633,
    timesSeen: 1, timesCorrect: 1, timesIncorrect: 0, accuracyPercent: 100,
    attempts: [{ at: 1787771651633, selectedAnswer: 'C', isCorrect: true, timeSpentMs: 25734, source: 'custom_test' }]
  }, 'fixture drift: 52332846 is not the entry this test was written against');
  assert.strictEqual(
    JSON.stringify(dm.slimProgressEntry(P['52332846']).slim),
    '{"a":"C","c":true,"t":25734,"r":true,"f":false,"ts":1787771651633,"n":1,"k":1,"x":[{"s":"custom_test"}]}'
  );
  ok('(1) 52332846: answered/timesIncorrect/accuracyPercent dropped; the attempt collapses to {"s":"custom_test"}');

  // --- (2) The same entry expands back to exactly the original bytes.
  assert.strictEqual(
    JSON.stringify(dm.expandProgressEntry(dm.slimProgressEntry(P['52332846']).slim)),
    JSON.stringify(P['52332846'])
  );
  ok('(2) 52332846 expands back byte-identically, isFlagged still before timestamp');

  // --- (3) An entry with NO attempts array (93 of them look like this).
  assert.strictEqual(P['15074829'].attempts, undefined, 'fixture drift: 15074829 should have no attempts');
  assert.strictEqual(
    JSON.stringify(dm.slimProgressEntry(P['15074829']).slim),
    '{"a":"A","c":true,"t":33659,"r":true,"f":false,"ts":1787702485906,"n":1,"k":1}'
  );
  ok('(3) 15074829: no attempts key in, no attempts key out — absence is preserved, not defaulted');

  // --- (4) The entry whose stored timesIncorrect CONTRADICTS timesSeen - timesCorrect.
  //         This is the trap: recomputing would silently rewrite a stored 1 to a 0.
  assert.strictEqual(P['1b9fa866'].timesSeen, 1);
  assert.strictEqual(P['1b9fa866'].timesCorrect, 1);
  assert.strictEqual(P['1b9fa866'].timesIncorrect, 1, 'fixture drift: 1b9fa866 is the inconsistent entry');
  const slim1b = dm.slimProgressEntry(P['1b9fa866']).slim;
  assert.deepStrictEqual(slim1b[dm.K_OVERRIDE], { timesIncorrect: 1 },
    'a stored value that does not match the derivation must be kept explicitly');
  assert.strictEqual(dm.expandProgressEntry(slim1b).timesIncorrect, 1,
    'the contradictory stored value must survive the round trip unchanged');
  ok('(4) 1b9fa866: stored timesIncorrect=1 contradicts 1-1=0 and is preserved verbatim via $v');

  // --- (5) The entry with timesSeen: 0 and no `answered` / `accuracyPercent`.
  assert.deepStrictEqual(P['q100'], { isCorrect: true, timestamp: 12345, timesSeen: 0, timesCorrect: 0, timesIncorrect: 0 },
    'fixture drift: q100 is the zero-seen entry');
  const slimQ = dm.slimProgressEntry(P['q100']).slim;
  assert.deepStrictEqual(slimQ[dm.K_OMITTED], ['answered', 'accuracyPercent'],
    'fields absent from the original must be recorded as absent, never invented on read');
  assert.strictEqual(JSON.stringify(dm.expandProgressEntry(slimQ)), JSON.stringify(P['q100']));
  ok('(5) q100: absent answered/accuracyPercent recorded in $o and NOT invented on expand (timesSeen 0 → no divide-by-zero)');

  // --- (6) An entry with an EMPTY attempts array (13 look like this).
  assert.deepStrictEqual(P['27754367'], {
    answered: true, isCorrect: true, timesSeen: 1, timesCorrect: 1, timesIncorrect: 0,
    accuracyPercent: 100, attempts: []
  }, 'fixture drift: 27754367 is the empty-attempts shape');
  assert.strictEqual(JSON.stringify(dm.slimProgressEntry(P['27754367']).slim), '{"c":true,"n":1,"k":1,"x":[]}');
  assert.strictEqual(JSON.stringify(dm.expandProgressEntry(dm.slimProgressEntry(P['27754367']).slim)),
    JSON.stringify(P['27754367']));
  ok('(6) 27754367: 116 bytes -> 29 bytes, and the empty attempts array round-trips as empty');

  // --- (7) An SRS card: questionId "" and dueAt both derivable, both dropped.
  assert.deepStrictEqual(S['15074829'], {
    questionId: '', repetitions: 1, intervalDays: 1, easeFactor: 2.6,
    lastReviewedAt: 1787702485906, dueAt: 1787788885906, lastGrade: 5, history: []
  }, 'fixture drift: 15074829 card');
  // Hand-check the dueAt derivation: 1787702485906 + 1 * 86400000 = 1787788885906.
  assert.strictEqual(1787702485906 + 86400000, 1787788885906);
  assert.strictEqual(JSON.stringify(dm.slimSrsCard(S['15074829']).slim),
    '{"p":1,"i":1,"ef":2.6,"l":1787702485906,"g":5,"h":[]}');
  ok('(7) SRS 15074829: questionId "" and dueAt (= lastReviewedAt + 1 day) both dropped; 8 fields -> 6');

  // --- (8) That card expands back byte-identically, dueAt restored in its original slot.
  assert.strictEqual(JSON.stringify(dm.expandSrsCard(dm.slimSrsCard(S['15074829']).slim)),
    JSON.stringify(S['15074829']));
  ok('(8) SRS 15074829 expands back byte-identically with dueAt reinserted between lastReviewedAt and lastGrade');

  // --- (9) Every one of the 392 real cards has questionId "" and a derivable dueAt.
  let emptyQid = 0, derivableDue = 0;
  Object.values(S).forEach(card => {
    if (card.questionId === '') emptyQid++;
    if (card.dueAt === card.lastReviewedAt + card.intervalDays * 86400000) derivableDue++;
  });
  assert.strictEqual(emptyQid, 392);
  assert.strictEqual(derivableDue, 392);
  ok('(9) all 392 real cards: questionId === "" and dueAt === lastReviewedAt + intervalDays*86400000');

  // --- (10) A lapsed card (grade < 3 reset the ladder) still round-trips.
  const lapsed = Object.keys(S).find(k => S[k].lastGrade === 1);
  assert.ok(lapsed, 'fixture must contain at least one lapsed card');
  assert.strictEqual(S[lapsed].repetitions, 0, 'a grade-1 card resets repetitions to 0');
  assert.strictEqual(S[lapsed].easeFactor, 1.96, 'the real lapsed cards sit at ease 1.96');
  assert.strictEqual(JSON.stringify(dm.expandSrsCard(dm.slimSrsCard(S[lapsed]).slim)), JSON.stringify(S[lapsed]));
  ok(`(10) lapsed card ${lapsed} (grade 1, reps 0, ease 1.96) round-trips byte-for-byte`);
}

// =========================================================================
// 4. The codec cannot lose data on shapes it has never seen.
// =========================================================================
console.log('\n4. Verbatim fallback — losslessness on unknown/hostile shapes');
{
  // A record whose key order the anchors cannot reproduce.
  const weird = { accuracyPercent: 50, timesCorrect: 1, timesSeen: 2, timesIncorrect: 1, answered: true };
  const r = dm.slimProgressEntry(weird);
  assert.strictEqual(JSON.stringify(dm.expandProgressEntry(r.slim)), JSON.stringify(weird),
    'an unreproducible key order must still round-trip');
  ok(`unreproducible key order round-trips (fellBack=${r.fellBack})`);

  // A record carrying a field that collides with a short key.
  const collide = { selectedAnswer: 'A', a: 'not the same thing', isCorrect: true, timesSeen: 1, timesCorrect: 1 };
  const r2 = dm.slimProgressEntry(collide);
  assert.strictEqual(JSON.stringify(dm.expandProgressEntry(r2.slim)), JSON.stringify(collide),
    'a field colliding with a short key must still round-trip');
  assert.strictEqual(r2.fellBack, true, 'a short-key collision must trigger the verbatim fallback');
  ok('a field named "a" colliding with the short key for selectedAnswer falls back to $r and round-trips');

  // A future field nobody has mapped.
  const future = { answered: true, isCorrect: false, timesSeen: 1, timesCorrect: 0, timesIncorrect: 1,
    accuracyPercent: 0, confidenceRating: 'low' };
  const r3 = dm.slimProgressEntry(future);
  assert.strictEqual(JSON.stringify(dm.expandProgressEntry(r3.slim)), JSON.stringify(future));
  assert.strictEqual(r3.fellBack, false, 'an unmapped field should pass through verbatim, not force a fallback');
  ok('an unmapped future field ("confidenceRating") passes through verbatim without a fallback');

  // Non-objects and null.
  [null, 42, 'x', [1, 2]].forEach(v => {
    assert.strictEqual(JSON.stringify(dm.expandProgressEntry(dm.slimProgressEntry(v).slim)), JSON.stringify(v),
      `value ${JSON.stringify(v)} must round-trip`);
  });
  ok('null / number / string / array inputs round-trip through the verbatim fallback');

  // An SRS card with a real questionId (what compactSrsState writes).
  const compacted = { questionId: 'abc123', repetitions: 2, intervalDays: 3, easeFactor: 2.5,
    lastReviewedAt: 1000, firstReviewedAt: 500, totalReviews: 2, totalLapses: 0,
    avgResponseTimeMs: 1234, dueAt: 1000 + 3 * 86400000, lastGrade: 4, history: [] };
  const r4 = dm.slimSrsCard(compacted);
  assert.strictEqual(JSON.stringify(dm.expandSrsCard(r4.slim)), JSON.stringify(compacted));
  assert.deepStrictEqual(r4.slim[dm.K_OVERRIDE], { questionId: 'abc123' },
    'a populated questionId is stored explicitly rather than being dropped');
  ok('a compactSrsState-shaped card (populated questionId, v2 field order) round-trips byte-for-byte');
}

// =========================================================================
// 5. Shard build + reassembly on the real document.
// =========================================================================
console.log('\n5. Shard build and reassembly on the real 406-entry / 392-card document');
{
  const p = dm.buildProgressShards('default_student', MASTER.progress);
  const s = dm.buildSrsShards('default_student', MASTER.srsState);

  assert.ok(p.docs.length > 0 && p.docs.length <= 16, 'progress shards must be 1..16 documents');
  assert.ok(s.docs.length > 0 && s.docs.length <= 16, 'srs shards must be 1..16 documents');

  // Routing: every entry is in the bucket its id hashes to, and in exactly one shard.
  const seen = new Set();
  p.docs.forEach(d => {
    assert.strictEqual(d.doc_type, 'progress_shard');
    assert.strictEqual(d.student_name, 'default_student');
    assert.strictEqual(d.id, dm.progressShardId('default_student', d.bucket));
    Object.keys(d.entries).forEach(qid => {
      assert.strictEqual(dm.bucketOf(qid), d.bucket, `${qid} is in the wrong shard`);
      assert.ok(!seen.has(qid), `${qid} appears in two shards`);
      seen.add(qid);
    });
    assert.strictEqual(d.entryCount, Object.keys(d.entries).length);
  });
  assert.strictEqual(seen.size, 406, 'every one of the 406 entries must be routed exactly once');
  ok(`406 real progress entries routed into ${p.docs.length} shards, each in its hashed bucket, none duplicated`);

  const seenS = new Set();
  s.docs.forEach(d => {
    assert.strictEqual(d.doc_type, 'srs_shard');
    Object.keys(d.cards).forEach(qid => {
      assert.strictEqual(dm.bucketOf(qid), d.bucket);
      assert.ok(!seenS.has(qid));
      seenS.add(qid);
    });
  });
  assert.strictEqual(seenS.size, 392);
  ok(`392 real SRS cards routed into ${s.docs.length} shards, each in its hashed bucket, none duplicated`);

  // Reassembly equality — the core "no data loss" proof, in three parts:
  //   (a) identical key SETS — nothing gained, nothing lost;
  //   (b) every RECORD byte-identical including its own key order;
  //   (c) the canonical map serialisation byte-identical.
  // (b) is asserted per record in section 2. Sharding regroups the map's keys by bucket,
  // which is why (c) sorts the outer keys — see dm.canonicalMapJson for why that is the
  // right equality and not a weakening of it.
  const rp = dm.reassembleProgress(p.docs);
  const rs = dm.reassembleSrs(s.docs);
  assert.deepStrictEqual(Object.keys(rp).sort(), Object.keys(MASTER.progress).sort(),
    'the reassembled progress map must hold exactly the same question ids');
  assert.deepStrictEqual(Object.keys(rs).sort(), Object.keys(MASTER.srsState).sort(),
    'the reassembled srsState map must hold exactly the same question ids');
  Object.keys(MASTER.progress).forEach(qid => {
    assert.strictEqual(JSON.stringify(rp[qid]), JSON.stringify(MASTER.progress[qid]),
      `reassembled progress entry ${qid} differs`);
  });
  Object.keys(MASTER.srsState).forEach(qid => {
    assert.strictEqual(JSON.stringify(rs[qid]), JSON.stringify(MASTER.srsState[qid]),
      `reassembled srs card ${qid} differs`);
  });
  assert.strictEqual(dm.canonicalMapJson(rp), dm.canonicalMapJson(MASTER.progress),
    'reassembled progress must be byte-identical to the pre-migration document');
  assert.strictEqual(dm.canonicalMapJson(rs), dm.canonicalMapJson(MASTER.srsState),
    'reassembled srsState must be byte-identical to the pre-migration document');
  ok('sharded → reassembled: same 406/392 key sets, every record byte-identical, canonical maps byte-equal');

  // Reassembly ignores documents of other types, so it can take a whole partition.
  const mixed = [].concat(p.docs, s.docs, fixture.documents);
  assert.strictEqual(dm.canonicalMapJson(dm.reassembleProgress(mixed)), dm.canonicalMapJson(MASTER.progress));
  ok('reassembly over a whole mixed partition (master + 9 exam_session docs + shards) is unchanged');

  const before = dm.bytesOf(MASTER.progress) + dm.bytesOf(MASTER.srsState);
  const after = [].concat(p.docs, s.docs).reduce((a, d) => a + dm.bytesOf(d), 0);
  const largest = [].concat(p.docs, s.docs).reduce((a, d) => Math.max(a, dm.bytesOf(d)), 0);
  console.log(`     progress+srs on the master : ${before} bytes in ONE document`);
  console.log(`     the same state as shards   : ${after} bytes across ${p.docs.length + s.docs.length} documents, largest ${largest}`);
  ok(`largest shard is ${largest} bytes (${((100 * largest) / (400 * 1024)).toFixed(1)}% of the 400 KB budget)`);
}

// =========================================================================
// 6. examIndexEntry
// =========================================================================
console.log('\n6. Exam-history index entry');
{
  const exam = MASTER.examHistory.find(e => e && Array.isArray(e.moduleReports) && e.moduleReports.length);
  assert.ok(exam, 'the fixture must contain an exam with moduleReports');
  const idx = dm.examIndexEntry(exam);
  assert.strictEqual(idx.moduleReports, undefined, 'the index entry drops moduleReports');
  assert.strictEqual(idx.examId, exam.examId, 'the examId is what re-joins it to the immutable session doc');
  assert.strictEqual(idx.moduleReportsInSessionDoc, true, 'the index says plainly where the full report lives');
  ['title', 'type', 'completedAt', 'totalQuestions', 'totalCorrect', 'scores'].forEach(k => {
    assert.strictEqual(JSON.stringify(idx[k]), JSON.stringify(exam[k]), `${k} must survive indexing`);
  });
  console.log(`     ${exam.examId}: ${dm.bytesOf(exam)} bytes -> ${dm.bytesOf(idx)} bytes as an index entry`);
  ok('examIndexEntry keeps every summary field and drops only moduleReports');
}

console.log(`\n${checks} checks passed.`);
