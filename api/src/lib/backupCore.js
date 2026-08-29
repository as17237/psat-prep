/**
 * api/src/lib/backupCore.js
 *
 * Pure, side-effect-free helpers shared by the backup functions:
 *   - api/src/functions/backup.js       (nightly timer + POST /api/backup)
 *   - api/src/functions/backupStatus.js (GET /api/backup-status)
 *
 * Kept out of src/functions/ deliberately: the Azure Functions v4 model discovers
 * functions from src/functions/*.js (see package.json "main"), so anything here is
 * loaded only by explicit require. That also lets tests import this logic without
 * registering HTTP/timer triggers (tests/test_backup_status.js).
 *
 * Design rules honoured here (CLAUDE.md):
 *   - mode 1: no invented numbers. Absent data is `null`, never 0.
 *   - mode 5: every catch either recovers or reports; nothing is swallowed.
 *   - mode 4: no clock reads inside the logic — "now" is always a parameter.
 */

/**
 * Live Questions container holds 3,059 documents (measured 2026-08-29). A backup that
 * returns fewer than this floor is a partial export, not a smaller dataset, and must
 * abort rather than silently overwrite the latest pointer with an incomplete snapshot.
 */
const QUESTIONS_MIN_EXPECTED = 3000;

/** A cloud backup older than this is stale (nightly timer runs every 24 h). */
const BACKUP_MAX_AGE_HOURS = 26;

/** Timestamped archive blobs written by performCosmosBackup(). */
const BACKUP_ARCHIVE_RE = /^cosmos_backup_.+\.json$/;
/** Failure markers written by writeFailureMarker(). */
const FAILURE_MARKER_RE = /^backup_FAILED_.+\.json$/;
/** The mutable "latest" pointer is a copy of an archive, not an independent backup. */
const LATEST_POINTER_NAME = 'cosmos_backup_latest.json';

/**
 * Guards the Questions export.
 *
 * Accepted outcomes:
 *   - 0 documents (or a non-array, meaning the fetch failed upstream): the container is
 *     missing/unreadable. Warn LOUDLY and continue — student data is the critical payload
 *     and must still be backed up.
 *   - >= QUESTIONS_MIN_EXPECTED documents: complete export.
 *
 * Anything in between is a silent partial and throws, aborting the whole backup.
 */
function assertQuestionsIntegrity(questionDocs, { warn = console.warn, containerName = 'Questions' } = {}) {
  const count = Array.isArray(questionDocs) ? questionDocs.length : 0;

  if (count === 0) {
    warn(
      `⚠️  BACKUP SCOPE WARNING: 0 documents retrieved from the ${containerName} container. ` +
      `The question mirror is NOT in this backup. Student data was still backed up. ` +
      `Investigate: the container may be missing, renamed, or unreadable by this identity.`
    );
    return { count: 0, warned: true };
  }

  if (count < QUESTIONS_MIN_EXPECTED) {
    throw new Error(
      `Safety guard: partial ${containerName} export — ${count} documents retrieved, but a valid ` +
      `backup needs either 0 (container missing) or at least ${QUESTIONS_MIN_EXPECTED}. ` +
      `Refusing to write a silently partial backup.`
    );
  }

  return { count, warned: false };
}

/**
 * Builds the cloud backup payload. Format version 1.1 adds the `questions` array and
 * `backupMetadata.questionsCount`; 1.0 payloads (no questions key) remain valid input to
 * scripts/restore_cosmos.js, which restores studentAnswers/feedback only.
 */
function buildCloudBackupPayload({ studentDocs, feedbackDocs, questionDocs, dbName, triggerType, now }) {
  const students = Array.isArray(studentDocs) ? studentDocs : [];
  const feedback = Array.isArray(feedbackDocs) ? feedbackDocs : [];
  const questions = Array.isArray(questionDocs) ? questionDocs : [];

  return {
    backupMetadata: {
      generatedAt: now.toISOString(),
      triggerType: triggerType,
      database: dbName,
      totalDocuments: students.length + feedback.length + questions.length,
      studentAnswersCount: students.length,
      feedbackCount: feedback.length,
      questionsCount: questions.length,
      version: '1.1'
    },
    studentAnswers: students,
    feedback: feedback,
    questions: questions
  };
}

function errorMessageOf(error) {
  if (!error) return 'Unknown error (no error object supplied)';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  try {
    return JSON.stringify(error);
  } catch (e) {
    return String(error);
  }
}

/**
 * Builds the `backup_FAILED_<timestamp>.json` marker blob contents. Pure — no IO.
 */
function buildFailureMarker({ error, triggerType, now }) {
  const timestampStr = now.toISOString().replace(/[:.]/g, '-');
  const filename = `backup_FAILED_${timestampStr}.json`;
  const payload = {
    marker: 'cosmos_backup_failure',
    success: false,
    failedAt: now.toISOString(),
    triggerType: triggerType,
    error: errorMessageOf(error),
    errorName: (error && error.name) ? String(error.name) : null,
    stack: (error && error.stack) ? String(error.stack).split('\n').slice(0, 8).join('\n') : null
  };
  return { filename, payload, content: JSON.stringify(payload, null, 2) };
}

/**
 * Writes the failure marker through an already-resolved container client.
 *
 * This is wrapped in its own try/catch by design: a marker write that fails must be
 * REPORTED but must never throw, or it would replace the original backup error in the
 * logs with a storage error (CLAUDE.md modes 5 and 6). Returns a checked success flag.
 *
 * @returns {Promise<{written: boolean, filename: string, error?: string}>}
 */
async function writeFailureMarker(containerClient, { error, triggerType, now, warn = console.warn }) {
  const { filename, content } = buildFailureMarker({ error, triggerType, now });
  try {
    if (typeof containerClient.createIfNotExists === 'function') {
      await containerClient.createIfNotExists();
    }
    const buffer = Buffer.from(content, 'utf8');
    const blobClient = containerClient.getBlockBlobClient(filename);
    await blobClient.upload(buffer, buffer.length, {
      blobHTTPHeaders: { blobContentType: 'application/json' }
    });
    return { written: true, filename };
  } catch (markerErr) {
    warn(
      `⚠️  Could not write backup failure marker ${filename}: ${errorMessageOf(markerErr)}. ` +
      `The original backup failure was: ${errorMessageOf(error)}`
    );
    return { written: false, filename, error: errorMessageOf(markerErr) };
  }
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Computes backup freshness from a blob listing. Pure: `nowMs` is a parameter.
 *
 * @param {Array<{name: string, lastModified: (Date|string)}>} blobs
 * @param {number} nowMs epoch milliseconds
 * @returns {{
 *   checkedAt: string, lastSuccessAt: (string|null), lastAttemptAt: (string|null),
 *   lastFailureAt: (string|null), ageHours: (number|null), healthy: boolean,
 *   reason: string, successBackupCount: number, failureMarkerCount: number,
 *   maxAgeHours: number
 * }}
 */
function computeBackupStatus(blobs, nowMs) {
  const list = Array.isArray(blobs) ? blobs : [];

  let lastSuccessMs = null;
  let lastFailureMs = null;
  let successBackupCount = 0;
  let failureMarkerCount = 0;

  for (const blob of list) {
    if (!blob || !blob.name) continue;
    const ms = toMillis(blob.lastModified);
    if (ms === null) continue;

    if (blob.name === LATEST_POINTER_NAME) {
      // Mirror of the newest archive; counting it would double-count a single backup.
      continue;
    }
    if (BACKUP_ARCHIVE_RE.test(blob.name)) {
      successBackupCount += 1;
      if (lastSuccessMs === null || ms > lastSuccessMs) lastSuccessMs = ms;
    } else if (FAILURE_MARKER_RE.test(blob.name)) {
      failureMarkerCount += 1;
      if (lastFailureMs === null || ms > lastFailureMs) lastFailureMs = ms;
    }
  }

  const ageHours = lastSuccessMs === null
    ? null
    : Math.round(((nowMs - lastSuccessMs) / 3600000) * 100) / 100;

  let healthy;
  let reason;
  if (lastSuccessMs === null) {
    healthy = false;
    reason = 'No successful cosmos_backup_*.json archive found in the cosmos-backups container.';
  } else if (ageHours >= BACKUP_MAX_AGE_HOURS) {
    healthy = false;
    reason = `Last successful backup is ${ageHours} h old (stale: the limit is ${BACKUP_MAX_AGE_HOURS} h).`;
  } else if (lastFailureMs !== null && lastFailureMs > lastSuccessMs) {
    healthy = false;
    reason = 'A backup failure marker is newer than the last successful backup.';
  } else {
    healthy = true;
    reason = `Last successful backup is ${ageHours} h old.`;
  }

  const lastAttemptMs = (lastSuccessMs === null && lastFailureMs === null)
    ? null
    : Math.max(lastSuccessMs === null ? -Infinity : lastSuccessMs, lastFailureMs === null ? -Infinity : lastFailureMs);

  return {
    checkedAt: new Date(nowMs).toISOString(),
    lastSuccessAt: lastSuccessMs === null ? null : new Date(lastSuccessMs).toISOString(),
    lastAttemptAt: lastAttemptMs === null ? null : new Date(lastAttemptMs).toISOString(),
    lastFailureAt: lastFailureMs === null ? null : new Date(lastFailureMs).toISOString(),
    ageHours: ageHours,
    healthy: healthy,
    reason: reason,
    successBackupCount: successBackupCount,
    failureMarkerCount: failureMarkerCount,
    maxAgeHours: BACKUP_MAX_AGE_HOURS
  };
}

module.exports = {
  QUESTIONS_MIN_EXPECTED,
  BACKUP_MAX_AGE_HOURS,
  BACKUP_ARCHIVE_RE,
  FAILURE_MARKER_RE,
  LATEST_POINTER_NAME,
  assertQuestionsIntegrity,
  buildCloudBackupPayload,
  buildFailureMarker,
  writeFailureMarker,
  computeBackupStatus
};
