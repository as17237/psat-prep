/**
 * tests/test_backup_status.js
 *
 * Unit tests for the WI-04 backup hardening logic in api/src/lib/backupCore.js.
 * Everything here runs offline against injected fakes (dependency injection — no
 * monkeypatching of module exports, no network, no Azure, no clock reads: "now" is
 * always passed in as a parameter).
 *
 * Covered:
 *  1. assertQuestionsIntegrity  — the 0-or->=3000 guard (0 warns loudly, a partial throws).
 *  2. buildCloudBackupPayload   — questions array + questionsCount metadata, hand-written expectation.
 *  3. buildFailureMarker        — backup_FAILED_<ts>.json name + payload shape.
 *  4. writeFailureMarker        — uploads via an injected fake container client, and NEVER
 *                                 throws when the marker write itself fails (must not mask
 *                                 the original backup error).
 *  5. computeBackupStatus       — lastSuccessAt / lastAttemptAt / lastFailureAt / ageHours / healthy
 *                                 from a hand-written blob listing.
 */

const assert = require('assert');

const {
  QUESTIONS_MIN_EXPECTED,
  BACKUP_MAX_AGE_HOURS,
  assertQuestionsIntegrity,
  buildCloudBackupPayload,
  buildFailureMarker,
  writeFailureMarker,
  computeBackupStatus
} = require('../api/src/lib/backupCore.js');

console.log('Testing WI-04 backup scope guard, failure markers, and backup-status logic...');

// ---------------------------------------------------------------------------
// 1. Questions container guard: 0 (missing) warns, partial throws, full passes.
// ---------------------------------------------------------------------------
assert.strictEqual(QUESTIONS_MIN_EXPECTED, 3000, 'Questions guard threshold must be 3000');

const warnings = [];
const warnSpy = (msg) => warnings.push(String(msg));

const zeroResult = assertQuestionsIntegrity([], { warn: warnSpy });
assert.strictEqual(zeroResult.count, 0);
assert.strictEqual(zeroResult.warned, true);
assert.strictEqual(warnings.length, 1, 'A 0-document Questions container must warn exactly once');
assert.ok(/Questions/.test(warnings[0]), 'Warning must name the Questions container');
assert.ok(/0 document/i.test(warnings[0]), 'Warning must state that 0 documents were retrieved');

// A non-array (fetch threw upstream) is treated as 0 + loud warning, not a crash.
warnings.length = 0;
const nullResult = assertQuestionsIntegrity(null, { warn: warnSpy });
assert.strictEqual(nullResult.count, 0);
assert.strictEqual(nullResult.warned, true);
assert.strictEqual(warnings.length, 1);

// 1 .. 2999 documents == silent partial == hard failure.
warnings.length = 0;
assert.throws(
  () => assertQuestionsIntegrity(new Array(2999).fill({ id: 'q' }), { warn: warnSpy }),
  /partial/i,
  '2999 Questions documents must abort the backup as a partial export'
);
assert.throws(
  () => assertQuestionsIntegrity([{ id: 'q1' }], { warn: warnSpy }),
  /partial/i,
  '1 Questions document must abort the backup as a partial export'
);

// >= 3000 passes with no warning.
warnings.length = 0;
const fullResult = assertQuestionsIntegrity(new Array(3059).fill({ id: 'q' }), { warn: warnSpy });
assert.strictEqual(fullResult.count, 3059);
assert.strictEqual(fullResult.warned, false);
assert.strictEqual(warnings.length, 0, 'A complete Questions export must not warn');
console.log('✓ Questions container 0-or->=3000 backup guard verified (0 warns, 1..2999 aborts, 3059 passes)');

// ---------------------------------------------------------------------------
// 2. Cloud payload shape — hand-written expectation, not derived from the code.
// ---------------------------------------------------------------------------
const FIXED_NOW = new Date('2026-08-29T15:30:00.000Z');
const studentDocs = [
  { id: 'student_default_student', student_name: 'default_student', doc_type: 'student_master_profile' },
  { id: 'exam_default_student_1', student_name: 'default_student', doc_type: 'exam_session' }
];
const feedbackDocs = [{ id: 'fb_1', category: 'bug' }];
const questionDocs = [{ id: 'q1', domain: 'Algebra' }, { id: 'q2', domain: 'Geometry' }];

const expectedPayload = {
  backupMetadata: {
    generatedAt: '2026-08-29T15:30:00.000Z',
    triggerType: 'http_request',
    database: 'psat-prep-db',
    totalDocuments: 5,
    studentAnswersCount: 2,
    feedbackCount: 1,
    questionsCount: 2,
    version: '1.1'
  },
  studentAnswers: studentDocs,
  feedback: feedbackDocs,
  questions: questionDocs
};

const actualPayload = buildCloudBackupPayload({
  studentDocs,
  feedbackDocs,
  questionDocs,
  dbName: 'psat-prep-db',
  triggerType: 'http_request',
  now: FIXED_NOW
});
assert.deepStrictEqual(actualPayload, expectedPayload, 'Cloud backup payload must match the hand-written expectation');
console.log('✓ Cloud backup payload includes questions array + questionsCount metadata');

// ---------------------------------------------------------------------------
// 3. Failure marker filename + payload.
// ---------------------------------------------------------------------------
const marker = buildFailureMarker({
  error: new Error('Cosmos endpoint unreachable'),
  triggerType: 'scheduled_cron',
  now: FIXED_NOW
});
assert.strictEqual(marker.filename, 'backup_FAILED_2026-08-29T15-30-00-000Z.json');
assert.strictEqual(marker.payload.success, false);
assert.strictEqual(marker.payload.failedAt, '2026-08-29T15:30:00.000Z');
assert.strictEqual(marker.payload.triggerType, 'scheduled_cron');
assert.strictEqual(marker.payload.error, 'Cosmos endpoint unreachable');
assert.strictEqual(marker.payload.marker, 'cosmos_backup_failure');
assert.strictEqual(JSON.parse(marker.content).error, 'Cosmos endpoint unreachable');

// A thrown non-Error value must still produce a usable message, never "undefined".
const stringMarker = buildFailureMarker({ error: 'plain string failure', triggerType: 'timer', now: FIXED_NOW });
assert.strictEqual(stringMarker.payload.error, 'plain string failure');
console.log('✓ backup_FAILED_<ts>.json marker filename and payload verified');

// ---------------------------------------------------------------------------
// 4. writeFailureMarker against injected fake blob clients.
// ---------------------------------------------------------------------------
function makeFakeContainerClient({ failOnUpload = false, failOnCreate = false } = {}) {
  const uploads = [];
  return {
    uploads,
    createIfNotExists: async () => {
      if (failOnCreate) throw new Error('container create denied');
      return {};
    },
    getBlockBlobClient: (name) => ({
      upload: async (buffer, length, opts) => {
        if (failOnUpload) throw new Error('blob upload denied');
        uploads.push({ name, body: buffer.toString('utf8'), length, opts });
        return {};
      }
    })
  };
}

const okContainer = makeFakeContainerClient();
const writeOk = writeFailureMarker(okContainer, {
  error: new Error('boom'),
  triggerType: 'scheduled_cron',
  now: FIXED_NOW,
  warn: warnSpy
});

(async () => {
  const okResult = await writeOk;
  assert.strictEqual(okResult.written, true);
  assert.strictEqual(okResult.filename, 'backup_FAILED_2026-08-29T15-30-00-000Z.json');
  assert.strictEqual(okContainer.uploads.length, 1);
  assert.strictEqual(okContainer.uploads[0].name, 'backup_FAILED_2026-08-29T15-30-00-000Z.json');
  assert.strictEqual(JSON.parse(okContainer.uploads[0].body).error, 'boom');
  assert.strictEqual(okContainer.uploads[0].opts.blobHTTPHeaders.blobContentType, 'application/json');
  console.log('✓ writeFailureMarker uploads the marker blob via the injected client');

  // A failing marker write must be reported but must NOT throw: the original backup
  // error is what has to reach the logs (CLAUDE.md mode 5 / mode 6).
  warnings.length = 0;
  const badContainer = makeFakeContainerClient({ failOnUpload: true });
  const badResult = await writeFailureMarker(badContainer, {
    error: new Error('original cosmos failure'),
    triggerType: 'http_request',
    now: FIXED_NOW,
    warn: warnSpy
  });
  assert.strictEqual(badResult.written, false, 'A failing marker upload must report written:false');
  assert.ok(badResult.error && /blob upload denied/.test(badResult.error), 'The marker-write error must be reported');
  assert.strictEqual(warnings.length, 1, 'A failing marker write must warn exactly once');
  assert.ok(/original cosmos failure/.test(warnings[0]) || /marker/i.test(warnings[0]),
    'The warning must make clear the marker write failed');
  console.log('✓ writeFailureMarker never throws when the marker write itself fails');

  const badCreate = makeFakeContainerClient({ failOnCreate: true });
  const badCreateResult = await writeFailureMarker(badCreate, {
    error: new Error('x'), triggerType: 'timer', now: FIXED_NOW, warn: warnSpy
  });
  assert.strictEqual(badCreateResult.written, false);

  // -------------------------------------------------------------------------
  // 5. computeBackupStatus — hand-written blob listings.
  // -------------------------------------------------------------------------
  assert.strictEqual(BACKUP_MAX_AGE_HOURS, 26, 'Freshness window must be 26 hours');

  const NOW = Date.parse('2026-08-29T18:00:00.000Z');

  // 5A. Healthy: newest success 4 h old, no failure markers.
  const healthyBlobs = [
    { name: 'cosmos_backup_2026-08-27T02-00-00-000Z.json', lastModified: '2026-08-27T02:00:00.000Z' },
    { name: 'cosmos_backup_2026-08-28T02-00-00-000Z.json', lastModified: '2026-08-28T02:00:00.000Z' },
    { name: 'cosmos_backup_2026-08-29T14-00-00-000Z.json', lastModified: '2026-08-29T14:00:00.000Z' },
    { name: 'cosmos_backup_2026-08-29T14-00-00-000Z.json.sha256', lastModified: '2026-08-29T14:00:00.000Z' },
    { name: 'cosmos_backup_latest.json', lastModified: '2026-08-29T14:00:00.000Z' },
    { name: 'cosmos_backup_latest.json.sha256', lastModified: '2026-08-29T14:00:00.000Z' }
  ];
  const healthy = computeBackupStatus(healthyBlobs, NOW);
  assert.strictEqual(healthy.lastSuccessAt, '2026-08-29T14:00:00.000Z');
  assert.strictEqual(healthy.lastAttemptAt, '2026-08-29T14:00:00.000Z');
  assert.strictEqual(healthy.lastFailureAt, null);
  assert.strictEqual(healthy.ageHours, 4);
  assert.strictEqual(healthy.healthy, true);
  assert.strictEqual(healthy.successBackupCount, 3, 'Sidecars and the latest pointer must not count as backups');
  assert.strictEqual(healthy.failureMarkerCount, 0);
  console.log('✓ computeBackupStatus healthy case (4 h old, no failures)');

  // 5B. Stale: newest success 30 h old.
  const staleBlobs = [
    { name: 'cosmos_backup_2026-08-28T12-00-00-000Z.json', lastModified: '2026-08-28T12:00:00.000Z' }
  ];
  const stale = computeBackupStatus(staleBlobs, NOW);
  assert.strictEqual(stale.ageHours, 30);
  assert.strictEqual(stale.healthy, false);
  assert.strictEqual(stale.lastFailureAt, null);
  assert.ok(/stale|old/i.test(stale.reason), 'Stale status must explain itself');
  console.log('✓ computeBackupStatus stale case (30 h old -> unhealthy)');

  // 5C. Boundary: exactly 26 h is NOT healthy; 25.9 h is.
  assert.strictEqual(
    computeBackupStatus([{ name: 'cosmos_backup_a.json', lastModified: '2026-08-28T16:00:00.000Z' }], NOW).healthy,
    false, '26.0 h must be unhealthy'
  );
  assert.strictEqual(
    computeBackupStatus([{ name: 'cosmos_backup_a.json', lastModified: '2026-08-28T16:06:00.000Z' }], NOW).healthy,
    true, '25.9 h must be healthy'
  );
  console.log('✓ computeBackupStatus 26 h boundary verified');

  // 5D. A FAILED marker NEWER than the last success => unhealthy even though fresh.
  const failedNewer = computeBackupStatus([
    { name: 'cosmos_backup_2026-08-29T14-00-00-000Z.json', lastModified: '2026-08-29T14:00:00.000Z' },
    { name: 'backup_FAILED_2026-08-29T17-00-00-000Z.json', lastModified: '2026-08-29T17:00:00.000Z' }
  ], NOW);
  assert.strictEqual(failedNewer.lastSuccessAt, '2026-08-29T14:00:00.000Z');
  assert.strictEqual(failedNewer.lastFailureAt, '2026-08-29T17:00:00.000Z');
  assert.strictEqual(failedNewer.lastAttemptAt, '2026-08-29T17:00:00.000Z');
  assert.strictEqual(failedNewer.ageHours, 4);
  assert.strictEqual(failedNewer.healthy, false, 'A failure marker newer than the last success must be unhealthy');
  assert.strictEqual(failedNewer.failureMarkerCount, 1);
  console.log('✓ computeBackupStatus flags a FAILED marker newer than the last success');

  // 5E. A FAILED marker OLDER than the last success does not make it unhealthy.
  const failedOlder = computeBackupStatus([
    { name: 'backup_FAILED_2026-08-29T03-00-00-000Z.json', lastModified: '2026-08-29T03:00:00.000Z' },
    { name: 'cosmos_backup_2026-08-29T14-00-00-000Z.json', lastModified: '2026-08-29T14:00:00.000Z' }
  ], NOW);
  assert.strictEqual(failedOlder.healthy, true, 'A recovered-from failure must not keep the status red');
  assert.strictEqual(failedOlder.lastFailureAt, '2026-08-29T03:00:00.000Z');
  assert.strictEqual(failedOlder.lastAttemptAt, '2026-08-29T14:00:00.000Z');
  console.log('✓ computeBackupStatus clears once a later success supersedes a failure');

  // 5F. Empty container: no invented numbers — nulls, and unhealthy.
  const empty = computeBackupStatus([], NOW);
  assert.strictEqual(empty.lastSuccessAt, null);
  assert.strictEqual(empty.lastAttemptAt, null);
  assert.strictEqual(empty.lastFailureAt, null);
  assert.strictEqual(empty.ageHours, null, 'No backup means ageHours is null, never 0');
  assert.strictEqual(empty.healthy, false);
  console.log('✓ computeBackupStatus returns nulls (never 0) when no backup exists');

  console.log('✓ All WI-04 backup guard / failure-marker / backup-status unit tests passed!\n');
})().catch(err => {
  console.error('\n❌ test_backup_status.js FAILED:', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
