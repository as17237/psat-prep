/**
 * tests/test_flag_ordering.js — WI-32/33. Bookmark removal must survive a sync.
 *
 * Both merges forced `isFlagged` true if EITHER side had it, so un-bookmarking synced
 * up as "still flagged" and came straight back — locally and on the server — while the
 * UI reported "All work saved". Reproduced by the reviewer through the real button on
 * desktop and mobile.
 *
 * Flag edits now carry their own `flagUpdatedAt`. Deliberately NOT `timestamp`: that
 * drives learning metrics and the delta cursor, and a bookmark is not an attempt.
 *
 * The client (js/engine/sync.js) and the server (api/src/lib/merge.js) must implement
 * the SAME rule — if they disagree, they fight and the flag oscillates. Both are
 * exercised here against identical fixtures. Expected values hand-written.
 */
const assert = require('assert');
const PSAT_ENGINE = require('../srs.js');
const serverMerge = require('../api/src/lib/merge.js');

let n = 0;
const ok = (name) => { n++; console.log('  ok ' + n + ' — ' + name); };

// Both ends, same fixture, same expectation.
function bothEnds(stored, incoming) {
  const server = serverMerge.mergeProgress({ q: stored }, { q: incoming }).q;
  const client = PSAT_ENGINE.mergeProgress({ q: incoming }, { q: stored }).q;
  return { server, client };
}

const FLAGGED_OLD = { answered: true, isCorrect: true, timestamp: 500, isFlagged: true, flagUpdatedAt: 1000 };
const UNFLAGGED_NEW = { answered: true, isCorrect: true, timestamp: 500, isFlagged: false, flagUpdatedAt: 2000 };

{
  const { server, client } = bothEnds(FLAGGED_OLD, UNFLAGGED_NEW);
  assert.strictEqual(server.isFlagged, false,
    'server: a NEWER deliberate removal must win over an older raise');
  assert.strictEqual(client.isFlagged, false,
    'client: same rule, or the two ends fight and the bookmark oscillates');
  assert.strictEqual(server.flagUpdatedAt, 2000, 'the winning edit time is carried forward');
}
ok('a deliberate removal beats an older raise, on both ends');

{
  // Reverse arrival order: a stale "still flagged" record arriving late must not win.
  const { server, client } = bothEnds(UNFLAGGED_NEW, FLAGGED_OLD);
  assert.strictEqual(server.isFlagged, false, 'server: arrival order must not decide it');
  assert.strictEqual(client.isFlagged, false, 'client: arrival order must not decide it');
}
ok('a stale raise arriving later still loses — ordering, not arrival, decides');

{
  const RAISED_NEW = { answered: true, timestamp: 500, isFlagged: true, flagUpdatedAt: 3000 };
  const { server, client } = bothEnds(UNFLAGGED_NEW, RAISED_NEW);
  assert.strictEqual(server.isFlagged, true, 'server: a newer raise still wins');
  assert.strictEqual(client.isFlagged, true, 'client: a newer raise still wins');
}
ok('adding a bookmark still works — the fix is not one-directional');

{
  // LEGACY: neither side carries flagUpdatedAt. Ordering is unknowable, so the old
  // OR is kept — losing a raise is worse than keeping one. This is the compatibility
  // clause; without it, existing records would silently lose their bookmarks.
  const legacyRaised = { answered: true, timestamp: 100, isFlagged: true };
  const legacyClear = { answered: true, timestamp: 900, isFlagged: false };
  const { server, client } = bothEnds(legacyRaised, legacyClear);
  assert.strictEqual(server.isFlagged, true,
    'server: with no flagUpdatedAt on either side the raise is preserved');
  assert.strictEqual(client.isFlagged, true, 'client: same');
}
ok('legacy records with no edit time keep the raise — absent means unknown, not false');

{
  // One side migrated, one not. The explicit edit must win over the silent legacy value.
  const legacyRaised = { answered: true, timestamp: 100, isFlagged: true };
  const { server, client } = bothEnds(legacyRaised, UNFLAGGED_NEW);
  assert.strictEqual(server.isFlagged, false,
    'server: an explicit removal beats a legacy record with no edit time');
  assert.strictEqual(client.isFlagged, false, 'client: same');
}
ok('an explicit edit beats a legacy record that carries no edit time');

{
  // The flag edit must NOT disturb the attempt timestamp — it feeds learning metrics
  // and the delta cursor, and moving it would misreport when the student last worked.
  const { server } = bothEnds(FLAGGED_OLD, UNFLAGGED_NEW);
  assert.strictEqual(server.timestamp, 500,
    'a bookmark edit must never advance the attempt timestamp');
}
ok('a bookmark edit leaves the attempt timestamp alone');

{
  // Neither merge may mutate its inputs.
  const a = JSON.parse(JSON.stringify(FLAGGED_OLD));
  const b = JSON.parse(JSON.stringify(UNFLAGGED_NEW));
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  serverMerge.mergeProgress({ q: a }, { q: b });
  PSAT_ENGINE.mergeProgress({ q: a }, { q: b });
  assert.strictEqual(JSON.stringify(a), sa, 'stored entry unmutated');
  assert.strictEqual(JSON.stringify(b), sb, 'incoming entry unmutated');
}
ok('neither merge mutates its inputs');

// ---------------------------------------------------------------------------
// WI-38 — the COMPOSITION the seven checks above could not see.
//
// Every check so far feeds hand-written records straight to the merges, so they prove
// the ordering RULE. None of them runs a record through buildProgressEntry first —
// and that builder was dropping `flagUpdatedAt` entirely. A record that had been
// through an answer therefore reached the server with no revision, both merges fell
// to their legacy branch, and the older cloud `true` won: a bookmark the student had
// deleted came back.
//
// The rule was right and its tests were green. The writer was stripping the field the
// rule depends on. This exercises writer + merge together, which is the only place
// that defect is visible.
// ---------------------------------------------------------------------------
{
  const cloudRaised = { answered: true, isCorrect: true, timestamp: 500, isFlagged: true, flagUpdatedAt: 1000 };
  let local = { answered: true, isCorrect: true, timestamp: 500, isFlagged: false, flagUpdatedAt: 2000 };

  // Control: the removal survives on its own.
  assert.strictEqual(serverMerge.mergeProgress({ q: cloudRaised }, { q: local }).q.isFlagged, false,
    'control — a removal with a newer revision beats the cloud raise');

  // Now answer the question again, the way the practice and exam paths both do.
  local = PSAT_ENGINE.buildProgressEntry(local, {
    selectedAnswer: 'B', isCorrect: true, timeSpentMs: 20000,
    timingReliable: true, at: 3000, source: 'practice'
  });

  assert.strictEqual(local.flagUpdatedAt, 2000,
    'buildProgressEntry must CARRY the bookmark revision; dropping it silently disarms ' +
    'the ordering rule on the next sync');
  assert.strictEqual(local.isFlagged, false, 'and the bookmark stays removed locally');
  assert.strictEqual(serverMerge.mergeProgress({ q: cloudRaised }, { q: local }).q.isFlagged, false,
    'answering a question must not resurrect a bookmark the student deleted');
}
ok('answering after removing a bookmark does not bring it back');

{
  // A record that never had a bookmark must not gain a spurious revision — an invented
  // field would start winning merges it has no business deciding.
  const plain = PSAT_ENGINE.buildProgressEntry(
    { answered: true, isCorrect: false, timestamp: 1 },
    { selectedAnswer: 'A', isCorrect: true, timeSpentMs: 9000, timingReliable: true, at: 2, source: 'practice' }
  );
  assert.strictEqual(plain.flagUpdatedAt, undefined, 'no revision is invented');
  assert.ok(!JSON.stringify(plain).includes('flagUpdatedAt'),
    'and it does not bloat the stored record either');
}
ok('a record with no bookmark gains no revision field');



// An answer revision and a tag revision are independent, on both merge paths.
for (const reverse of [false, true]) {
  const answer = { answered: true, timestamp: 3000, selectedAnswer: 'B', errorTag: 'misread', metaUpdatedAt: 1000 };
  const tag = { answered: true, timestamp: 500, selectedAnswer: 'A', errorTag: 'concept_gap', metaUpdatedAt: 4000 };
  const results = reverse ? bothEnds(tag, answer) : bothEnds(answer, tag);
  for (const merged of Object.values(results)) {
    assert.strictEqual(merged.selectedAnswer, 'B');
    assert.strictEqual(merged.errorTag, 'concept_gap');
    assert.strictEqual(merged.metaUpdatedAt, 4000);
  }
}
ok('newer error tag survives a newer answer in either arrival order');
{
  const old = { answered: true, errorTag: 'concept_gap', metaUpdatedAt: 4000, timestamp: 500 };
  const solved = PSAT_ENGINE.buildProgressEntry(old, { isCorrect: true, selectedAnswer: 'B', at: 5000 });
  for (const merged of Object.values(bothEnds(old, solved))) {
    assert.strictEqual(merged.errorTag, null);
    assert.ok(merged.metaUpdatedAt > 4000);
  }
}
ok('a correct answer advances the revision of its resolved tag');

console.log('✓ All ' + n + ' metadata-ordering checks passed.');

for (const tagged of [
  { timestamp: 500, errorTag: 'misread', metaUpdatedAt: 4000 },
  { timestamp: 5000, errorTag: null },
  { timestamp: 6000 }
]) {
  const prior = { timestamp: 100, errorTag: 'concept_gap', metaUpdatedAt: 3000 };
  const expected = tagged.errorTag === undefined ? 'concept_gap' : tagged.errorTag;
  for (const merged of Object.values(bothEnds(prior, tagged))) assert.strictEqual(merged.errorTag, expected);
  const codec = require('../api/src/lib/datamodel');
  assert.deepStrictEqual(codec.expandProgressEntry(codec.slimProgressEntry(tagged).slim), tagged);
}
console.log('Legacy tag removal, missing metadata, and cloud codec round-trips passed.');
