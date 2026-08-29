/**
 * js/engine/storage.js — Client-side storage: environment/lane detection, demo-mode guards, the
 * pre-destructive-action snapshot ring, the transactional-action wrapper, the
 * sync outbox, and the lean/rehydrated exam-report payload pair that keeps
 * localStorage records small.
 *
 * Part of the engine that was one 3,458-line srs.js until REFACTOR_PLAN.md
 * WI-10. The code below is the SAME code, moved verbatim; `srs.js` is now a
 * facade that recomposes these parts into the unchanged `PSAT_ENGINE` object.
 *
 * Loading: same UMD shape as srs.js always had — `module.exports` under Node,
 * `window.__PSAT_ENGINE_PARTS.storage` in the browser. There is no build step,
 * so the pages load the parts as ordinary <script> tags in dependency order
 * (grading -> scheduler -> scoring -> storage -> examgen -> sync) before srs.js.
 * Dependencies: scheduler (WI-11 — the migration needs summarizeSrsCard and the
 * 20-event history cap; the load order grading -> scheduler -> scoring -> storage
 * already satisfies this).
 * A missing dependency throws immediately rather than yielding a half-built
 * part whose functions ReferenceError at call time (CLAUDE.md failure mode 5).
 */
(function (root, factory) {
  var DEPS = ['scheduler'];
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory.apply(null, DEPS.map(function (d) { return require('./' + d + '.js'); }));
  } else {
    var parts = root.__PSAT_ENGINE_PARTS = root.__PSAT_ENGINE_PARTS || {};
    parts.storage = factory.apply(null, DEPS.map(function (d) {
      if (!parts[d]) {
        throw new Error(
          'js/engine/storage.js requires js/engine/' + d + '.js, which has not loaded yet. ' +
          'Load the engine parts in this order before srs.js: grading, scheduler, scoring, storage, examgen, sync.'
        );
      }
      return parts[d];
    }));
  }
})(typeof self !== 'undefined' ? self : this, function (scheduler) {
  var summarizeSrsCard = scheduler.summarizeSrsCard;
  var SRS_HISTORY_CAP = scheduler.SRS_HISTORY_CAP;

  /**
   * Resolves runtime environment configuration for beta vs production isolation.
   */
  function getEnvironmentConfig(loc) {
    var l = loc || (typeof window !== 'undefined' ? window.location : null);
    var isBeta = false;
    if (l) {
      var path = l.pathname || '';
      var search = l.search || '';
      isBeta = (path.indexOf('/beta') !== -1 || search.indexOf('env=beta') !== -1 || (typeof window !== 'undefined' && window.__IS_BETA__ === true));
    }
    return {
      isBeta: isBeta,
      storagePrefix: isBeta ? 'beta_' : '',
      studentName: isBeta ? 'beta_default_student' : 'default_student',
      envName: isBeta ? 'Beta Sandbox' : 'Production'
    };
  }

  /**
   * WI-11 — the delta-sync cursor's localStorage key.
   *
   * The KEY is owned here (storage.js owns localStorage keys); the cursor's read /
   * write / reset semantics live in js/engine/sync.js, which reads this constant
   * from the storage part rather than re-typing the string. One name, one place
   * (CLAUDE.md mode 2).
   */
  var SYNC_CURSOR_KEY = 'psat_sync_cursor';


  /**
   * Drops the delta-sync cursor so the next push sends the complete profile.
   *
   * Called from every path that replaces the four state keys wholesale — a snapshot
   * restore, a demo restore, and (through runTransactionalAction) every destructive
   * page action: reset, import, sample-data activation. After any of those the
   * per-record timestamps no longer describe what the server already holds, so a
   * delta would be computed against a cursor that means nothing.
   *
   * Failing to clear it is not fatal (the 24 h forced full push still heals it), so
   * this reports and continues rather than throwing into a destructive action's
   * rollback path.
   */
  function invalidateSyncCursor(store, loc) {
    if (!store || !store.removeItem) return false;
    try {
      store.removeItem(getEnvironmentConfig(loc).storagePrefix + SYNC_CURSOR_KEY);
      return true;
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('Could not clear the sync cursor after a wholesale state change; the next full push will heal it:', e && e.message);
      }
      return false;
    }
  }


  /**
   * Checks whether synthetic sample diagnostic data is currently loaded.
   */
  function isDemoModeActive(storage, loc) {
    var store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return false;
    var env = getEnvironmentConfig(loc);
    try {
      var flag = store.getItem(env.storagePrefix + 'psat_sample_data_active') === 'true';
      if (!flag) return false;
      var progRaw = store.getItem(env.storagePrefix + 'psat_progress');
      var prog = progRaw ? JSON.parse(progRaw) : {};
      if (!prog || Object.keys(prog).length === 0) {
        try { store.removeItem(env.storagePrefix + 'psat_sample_data_active'); } catch(e) {}
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }


  function backupRealData(storage, safeGetFn, safeSetFn, loc) {
    var store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return false;
    var env = getEnvironmentConfig(loc);
    var prefix = env.storagePrefix;

    // CRITICAL: Only write backup if demo mode is NOT already active in this environment
    if (isDemoModeActive(store, loc)) {
      return false; // Backup already contains real data; do not overwrite with sample data!
    }

    var getFn = safeGetFn || function(key, def) {
      try {
        var v = store.getItem(prefix + key);
        return v ? JSON.parse(v) : def;
      } catch (e) { return def; }
    };
    var setFn = safeSetFn || function(key, val) {
      try {
        store.setItem(prefix + key, JSON.stringify(val));
        return true;
      } catch (e) { return false; }
    };

    var backup = {
      progress: getFn('psat_progress', {}),
      srsState: getFn('psat_srs', {}),
      sessionsState: getFn('psat_sessions', {}),
      examHistory: getFn('psat_exam_history', [])
    };

    return setFn('psat_pre_sample_backup', backup);
  }


  /**
   * Restores the real student records that backupRealData() set aside before demo
   * data was loaded.
   *
   * WI-11 / roadmap §1.3 / CLAUDE.md mode 7 (the Round-8 rule). Before this change,
   * the no-backup branch removed psat_progress, psat_srs, psat_sessions and
   * psat_exam_history and then returned `true` — a fallback path strictly MORE
   * destructive than the primary one, reported to the caller as a success. A
   * missing or unreadable backup now changes nothing and returns false; the caller
   * shows the error and the student's records stay exactly where they are.
   *
   * @returns {boolean} true only if real records were actually restored. The
   *   boolean shape is deliberate: every existing call site treats a falsy result
   *   as failure, so the fail-safe direction needs no call-site change to be safe.
   */
  function restoreRealData(storage, safeGetFn, safeSetFn, loc) {
    var store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return false;
    var env = getEnvironmentConfig(loc);
    var prefix = env.storagePrefix;

    var getFn = safeGetFn || function(key, def) {
      try {
        var v = store.getItem(prefix + key);
        return v ? JSON.parse(v) : def;
      } catch (e) { return def; }
    };
    var setFn = safeSetFn || function(key, val) {
      try {
        store.setItem(prefix + key, JSON.stringify(val));
        return true;
      } catch (e) { return false; }
    };
    var removeFn = function(key) {
      try { store.removeItem(prefix + key); } catch (e) {}
    };

    var backup = getFn('psat_pre_sample_backup', null);
    if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
      // NO usable backup. Do nothing and report it. Deleting the live keys here —
      // which is what this branch used to do — would destroy the very records the
      // caller is trying to rescue.
      if (typeof console !== 'undefined' && console.error) {
        console.error(
          'restoreRealData: no usable psat_pre_sample_backup for this lane (' + env.envName + '). ' +
          'Nothing was changed; the real records are still in place.'
        );
      }
      return false;
    }

    if (backup.progress) setFn('psat_progress', backup.progress);
    else removeFn('psat_progress');

    if (backup.srsState) setFn('psat_srs', backup.srsState);
    else removeFn('psat_srs');

    if (backup.sessionsState) setFn('psat_sessions', backup.sessionsState);
    else removeFn('psat_sessions');

    if (backup.examHistory) setFn('psat_exam_history', backup.examHistory);
    else removeFn('psat_exam_history');

    removeFn('psat_sample_data_active');
    removeFn('psat_pre_sample_backup');
    // The four state keys were just replaced wholesale, so per-record timestamps no
    // longer describe what the server holds: force the next push to be a full one.
    invalidateSyncCursor(store, loc);
    return true;
  }


  /**
   * Strips redundant question payloads (text, rationales, images) to store lean records in localStorage.
   * Compresses ~200KB full reports to ~8KB per exam (~96% storage reduction).
   */
  function toLeanReport(report) {
    if (!report) return report;
    var leanModules = (report.moduleReports || []).map(function (m) {
      var leanQuestions = (m.questions || []).map(function (q) {
        return {
          questionId: q.questionId,
          userAnswer: q.userAnswer,
          isCorrect: q.isCorrect,
          answered: q.answered,
          timeSpentMs: q.timeSpentMs
        };
      });

      return {
        id: m.id,
        name: m.name,
        section: m.section,
        totalQuestions: m.totalQuestions,
        attempted: m.attempted,
        correct: m.correct,
        accuracyPercent: m.accuracyPercent,
        questions: leanQuestions
      };
    });

    return {
      examId: report.examId,
      title: report.title,
      type: report.type,
      isSample: report.isSample || false,
      completedAt: report.completedAt,
      formattedDate: report.formattedDate,
      totalQuestions: report.totalQuestions,
      totalCorrect: report.totalCorrect,
      totalAttempted: report.totalAttempted,
      overallAccuracyPercent: report.overallAccuracyPercent,
      scores: report.scores,
      totalTimeSpentMs: report.totalTimeSpentMs,
      moduleReports: leanModules
    };
  }


  /**
   * Rehydrates a lean exam report with full question text, options, image URLs, and rationales from QUESTIONS_DATA.
   */
  function rehydrateReport(leanReport, questionsData) {
    if (!leanReport) return leanReport;
    var qMap = {};
    if (Array.isArray(questionsData)) {
      questionsData.forEach(function(q) { qMap[q.id] = q; });
    }
    var rehydrated = JSON.parse(JSON.stringify(leanReport));
    if (Array.isArray(rehydrated.moduleReports)) {
      rehydrated.moduleReports.forEach(function(m) {
        if (Array.isArray(m.questions)) {
          m.questions.forEach(function(q) {
            var original = qMap[q.questionId] || {};
            q.question_text = original.question_text || original.prompt || q.question_text || '';
            q.prompt = q.question_text;
            q.rationale = original.rationale || q.rationale || '';
            q.image_url = original.image_url || (original.question_image ? 'data/' + original.question_image : '') || q.image_url || '';
            q.options = original.options || q.options || [];
            q.correctAnswer = original.correct_answer || q.correctAnswer || '';
            q.domain = original.domain || q.domain || '';
            q.skill = original.skill || q.skill || '';
            q.difficulty = original.difficulty || q.difficulty || '';
            q.section = original.test || m.section || q.section || '';
            q.type = original.type || original.question_type || q.type || 'multiple_choice';
            q.questionType = q.type;
          });
        }
      });
    }
    return rehydrated;
  }


  /**
   * Creates a durable pre-action client snapshot in localStorage before critical state changes.
   * Capped to the last 5 snapshots to avoid storage bloat.
   */
  function createClientSnapshot(store, reason, loc) {
    if (!store) return { success: false, error: 'No storage available' };
    var env = getEnvironmentConfig(loc);
    var prefix = env.storagePrefix;
    var pKey = prefix + 'psat_progress';
    var sKey = prefix + 'psat_srs';
    var sessKey = prefix + 'psat_sessions';
    var hKey = prefix + 'psat_exam_history';
    var actKey = prefix + 'psat_active_exam_state';
    var outKey = prefix + 'psat_sync_outbox';

    var snapId = 'snap_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    var snapshot = {
      id: snapId,
      timestamp: Date.now(),
      reason: reason || 'manual_snapshot',
      env: env.envName,
      data: {
        progress: JSON.parse((store.getItem ? store.getItem(pKey) : null) || '{}'),
        srs: JSON.parse((store.getItem ? store.getItem(sKey) : null) || '{}'),
        sessions: JSON.parse((store.getItem ? store.getItem(sessKey) : null) || '{}'),
        examHistory: JSON.parse((store.getItem ? store.getItem(hKey) : null) || '[]'),
        activeExamState: JSON.parse((store.getItem ? store.getItem(actKey) : null) || 'null'),
        outbox: JSON.parse((store.getItem ? store.getItem(outKey) : null) || '[]')
      }
    };

    var snapKey = prefix + 'psat_snapshot_' + snapshot.id;
    var indexKey = prefix + 'psat_client_snapshots';

    try {
      store.setItem(snapKey, JSON.stringify(snapshot));

      var idxRaw = store.getItem(indexKey);
      var index = idxRaw ? JSON.parse(idxRaw) : [];
      index.unshift({ id: snapshot.id, timestamp: snapshot.timestamp, reason: snapshot.reason, key: snapKey });
      
      // Prune snapshots beyond 5
      if (index.length > 5) {
        var pruned = index.slice(5);
        pruned.forEach(function(item) {
          try { store.removeItem(item.key); } catch (e) {}
        });
        index = index.slice(0, 5);
      }
      store.setItem(indexKey, JSON.stringify(index));
      return { success: true, snapshotId: snapshot.id, snapshotKey: snapKey };
    } catch (err) {
      console.error('Failed to create pre-action safety snapshot:', err);
      return { success: false, error: err.message || 'Storage Quota Exceeded' };
    }
  }


  function listClientSnapshots(store, loc) {
    if (!store) return [];
    var env = getEnvironmentConfig(loc);
    var indexKey = env.storagePrefix + 'psat_client_snapshots';
    try {
      var idxRaw = store.getItem(indexKey);
      return idxRaw ? JSON.parse(idxRaw) : [];
    } catch (e) {
      return [];
    }
  }


  function restoreClientSnapshot(store, snapshotId, loc) {
    if (!store || !snapshotId) return { success: false, error: 'Invalid parameters' };
    var env = getEnvironmentConfig(loc);
    var snapKey = snapshotId.indexOf(env.storagePrefix + 'psat_snapshot_') === 0 ? 
      snapshotId : 
      (env.storagePrefix + 'psat_snapshot_' + snapshotId);
    try {
      var raw = store.getItem(snapKey);
      if (!raw) return { success: false, error: 'Snapshot not found' };
      var snap = JSON.parse(raw);
      if (!snap || !snap.data) return { success: false, error: 'Malformed snapshot data' };

      // Pre-restore snapshot of current state before rollback
      var preSnap = createClientSnapshot(store, 'pre_snapshot_rollback', loc);
      if (!preSnap || !preSnap.success) {
        return { success: false, error: 'Pre-restore safety snapshot failed: ' + ((preSnap && preSnap.error) || 'Storage error') };
      }

      var prefix = env.storagePrefix;
      store.setItem(prefix + 'psat_progress', JSON.stringify(snap.data.progress || {}));
      store.setItem(prefix + 'psat_srs', JSON.stringify(snap.data.srs || {}));
      store.setItem(prefix + 'psat_sessions', JSON.stringify(snap.data.sessions || {}));
      store.setItem(prefix + 'psat_exam_history', JSON.stringify(snap.data.examHistory || []));
      if (snap.data.activeExamState !== undefined && snap.data.activeExamState !== null) {
        store.setItem(prefix + 'psat_active_exam_state', JSON.stringify(snap.data.activeExamState));
      } else {
        try { store.removeItem(prefix + 'psat_active_exam_state'); } catch (e) {}
      }
      if (Array.isArray(snap.data.outbox)) {
        store.setItem(prefix + 'psat_sync_outbox', JSON.stringify(snap.data.outbox));
      }
      // Wholesale state replacement: the delta cursor no longer describes the server.
      invalidateSyncCursor(store, loc);
      return { success: true, timestamp: snap.timestamp, reason: snap.reason };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }


  /**
   * Executes a destructive action with automated pre-action safety snapshotting and transactional rollback.
   * If snapshot creation fails, aborts immediately.
   * If mutationFn throws or returns { success: false }, automatically rolls back all storage keys to initial snapshot state.
   */
  function runTransactionalAction(store, actionName, mutationFn, loc) {
    if (!store || typeof mutationFn !== 'function') {
      return { success: false, error: 'Invalid parameters for transactional action' };
    }
    var env = getEnvironmentConfig(loc);
    
    // 1. Mandatory Pre-Action Snapshot
    var snap = createClientSnapshot(store, actionName || 'transactional_action', loc);
    if (!snap || !snap.success) {
      return {
        success: false,
        error: 'Pre-action safety snapshot creation failed: ' + ((snap && snap.error) || 'Storage error'),
        aborted: true
      };
    }

    try {
      var result = mutationFn({
        snapshotId: snap.snapshotId,
        storagePrefix: env.storagePrefix
      });

      // If mutationFn returned an explicit failure object, roll back
      if (result && result.success === false) {
        restoreClientSnapshot(store, snap.snapshotId, loc);
        return {
          success: false,
          error: result.error || 'Action failed during execution; rolled back to snapshot',
          rolledBack: true,
          snapshotId: snap.snapshotId
        };
      }

      // Every action routed through this wrapper is a destructive one that rewrites
      // state wholesale (reset, import, demo activation, restore). Invalidating the
      // cursor here covers all of them in ONE place instead of at each call site.
      invalidateSyncCursor(store, loc);
      return {
        success: true,
        snapshotId: snap.snapshotId,
        result: result
      };
    } catch (err) {
      // Automatic rollback on exception / quota error
      console.error('Transactional action failed, rolling back to snapshot ' + snap.snapshotId + ':', err);
      restoreClientSnapshot(store, snap.snapshotId, loc);
      return {
        success: false,
        error: err.message || 'Exception during execution; rolled back to snapshot',
        rolledBack: true,
        snapshotId: snap.snapshotId
      };
    }
  }


  // =========================================================================
  // WI-11 — the versioned student-data envelope and its v1 -> v2 migration
  // =========================================================================
  //
  // ROADMAP §1.1: "Define a versioned student-data envelope with schema version,
  // creation time, last update time, progress, SRS state, sessions, and exams."
  //
  // Design decision, and the reason it is a SIDECAR key rather than a re-shaping
  // of the four state keys:
  //
  //   The live student uses the v1 app (prod lane) while v2 soaks on /v2/, and
  //   BOTH lanes read and write the same localStorage keys in the same browser
  //   profile and the same Cosmos document. If v2 rewrapped `psat_progress` as
  //   `{schemaVersion, data:{...}}`, every v1 read would see a map with one key
  //   called "data" and report zero attempts. So the four data keys keep their
  //   EXACT v1 shape forever, and the version metadata lives beside them in
  //   `psat_schema_meta` — a key a v1 client simply never reads.
  //
  //   That is what "v1 (no version) remains readable forever" means concretely:
  //   absence of `psat_schema_meta` IS schemaVersion 1, and readSchemaMeta()
  //   reports that as a measurement rather than treating it as an error.
  //
  // ROLLBACK PROCEDURE (documented here because rollbackLocalStateToV1 is the
  // documented rollback the work item requires):
  //
  //   1. In the browser console of the affected profile:
  //        PSAT_ENGINE.rollbackLocalStateToV1(localStorage, window.location)
  //   2. It restores psat_progress / psat_srs / psat_sessions / psat_exam_history
  //      from the byte-identical `<key>_v1_backup` copies the migration wrote
  //      BEFORE it changed anything, and deletes `psat_schema_meta`.
  //   3. The `_v1_backup` keys are deliberately NOT deleted — a rollback must
  //      never destroy the only backup (CLAUDE.md mode 7, the Round-8 rule).
  //   4. Reload. The page now reads as schemaVersion 1 and is byte-identical to
  //      the pre-migration state; re-running the migration afterwards is safe
  //      and produces the same v2 state again.
  //   5. If no `_v1_backup` key exists, rollback does NOTHING and reports it.
  //      It never falls back to clearing the live keys.
  //
  // Server documents need no migration: the v2 fields are additive and the
  // server merge (api/src/lib/merge.js) is per-key, so a v1 document read by a
  // v2 client and a v2 document read by a v1 client are both fine.

  /** The version this build of the app writes. Absence of the meta key means 1. */
  var SCHEMA_VERSION = 2;

  /** The four keys that hold student records. Order is fixed; it is used in reports. */
  var STATE_KEYS = ['psat_progress', 'psat_srs', 'psat_sessions', 'psat_exam_history'];

  /** Suffix of the pre-migration copy of each state key. */
  var V1_BACKUP_SUFFIX = '_v1_backup';

  /** The sidecar key holding the envelope metadata. Unknown to, and ignored by, v1. */
  var SCHEMA_META_KEY = 'psat_schema_meta';

  function prefixOf(loc) {
    return getEnvironmentConfig(loc).storagePrefix;
  }

  /**
   * Reads the local envelope metadata.
   *
   * A store with no metadata key is schemaVersion 1 — that is a measurement of a
   * pre-v2 install, not a missing value to invent around (CLAUDE.md mode 1). A
   * corrupt metadata value is likewise reported as v1 with `corrupt: true` rather
   * than throwing a page down.
   *
   * @returns {{schemaVersion:number, createdAt:(number|null), updatedAt:(number|null),
   *            migratedAt:(number|null), migratedFrom:(number|null), corrupt:boolean}}
   */
  function readSchemaMeta(store, loc) {
    var blank = {
      schemaVersion: 1,
      createdAt: null,
      updatedAt: null,
      migratedAt: null,
      migratedFrom: null,
      backedUpKeys: [],
      corrupt: false
    };
    if (!store || !store.getItem) return blank;
    var raw;
    try {
      raw = store.getItem(prefixOf(loc) + SCHEMA_META_KEY);
    } catch (e) {
      return blank;
    }
    if (!raw) return blank;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.schemaVersion !== 'number') {
        return Object.assign({}, blank, { corrupt: true });
      }
      return {
        schemaVersion: parsed.schemaVersion,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : null,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null,
        migratedAt: typeof parsed.migratedAt === 'number' ? parsed.migratedAt : null,
        migratedFrom: typeof parsed.migratedFrom === 'number' ? parsed.migratedFrom : null,
        backedUpKeys: Array.isArray(parsed.backedUpKeys) ? parsed.backedUpKeys : [],
        corrupt: false
      };
    } catch (e) {
      // Report rather than swallow: a corrupt envelope is worth a console line,
      // but it must not stop the page from reading the (intact) data keys.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('psat_schema_meta is unreadable; treating this profile as schemaVersion 1:', e && e.message);
      }
      return Object.assign({}, blank, { corrupt: true });
    }
  }


  function writeSchemaMeta(store, loc, meta) {
    store.setItem(prefixOf(loc) + SCHEMA_META_KEY, JSON.stringify(meta));
  }


  /**
   * Upgrades one v1 SRS card in place-safe fashion: caps `history` to the newest
   * SRS_HISTORY_CAP events and backfills the four durable summary fields with the
   * EXACT counts derived from the full pre-trim card. Every other field on the card
   * is preserved verbatim (unlike compactSrsState, which whitelists fields — a
   * migration must not silently drop a field a future reader needs).
   */
  function upgradeSrsCardToV2(card) {
    if (!card || typeof card !== 'object') return { card: card, trimmed: 0 };
    var summary = summarizeSrsCard(card);
    var history = Array.isArray(card.history) ? card.history : [];
    var trimmed = Math.max(0, history.length - SRS_HISTORY_CAP);
    var upgraded = Object.assign({}, card, {
      history: trimmed > 0 ? history.slice(-SRS_HISTORY_CAP) : history.slice(),
      totalReviews: summary.totalReviews,
      totalLapses: summary.totalLapses,
      firstReviewedAt: summary.firstReviewedAt,
      lastReviewedAt: summary.lastReviewedAt
    });
    return { card: upgraded, trimmed: trimmed };
  }


  /**
   * Migrates this profile's local state from v1 to v2. Non-destructive, idempotent
   * and reversible; aborts without changing anything if a backup write fails.
   *
   * Order of operations (the order is the safety property):
   *   1. If the profile already reads as v2, return immediately — no writes at all.
   *   2. Write `<key>_v1_backup` for every state key that exists, byte-identical.
   *      If ANY of those writes fails, undo the backup keys this call created and
   *      return `{success:false}` having changed nothing. The migration never runs
   *      without a complete backup behind it (CLAUDE.md mode 7).
   *   3. Rewrite psat_srs with capped history + exact summaries. On failure, restore
   *      the raw v1 string and abort.
   *   4. Write psat_schema_meta last, so a crash anywhere earlier leaves the profile
   *      as a v1 profile that will simply be migrated again on the next load.
   *
   * @returns {{success:boolean, migrated:boolean, alreadyV2:boolean, schemaVersion:number,
   *            backedUpKeys:string[], cardsUpgraded:number, eventsTrimmed:number,
   *            error:(string|null)}}
   */
  function migrateLocalStateToV2(store, loc) {
    var report = {
      success: false,
      migrated: false,
      alreadyV2: false,
      schemaVersion: 1,
      backedUpKeys: [],
      cardsUpgraded: 0,
      eventsTrimmed: 0,
      error: null
    };
    if (!store || !store.getItem || !store.setItem) {
      report.error = 'No storage available';
      return report;
    }

    var prefix = prefixOf(loc);
    var existing = readSchemaMeta(store, loc);
    if (existing.schemaVersion >= SCHEMA_VERSION) {
      report.success = true;
      report.alreadyV2 = true;
      report.schemaVersion = existing.schemaVersion;
      report.backedUpKeys = existing.backedUpKeys;
      return report;
    }

    // --- Step 2: byte-identical v1 backups, before touching anything ---------
    var createdBackupKeys = [];
    var rawByKey = {};
    try {
      STATE_KEYS.forEach(function (key) {
        var raw = store.getItem(prefix + key);
        if (raw === null || raw === undefined) return;
        rawByKey[key] = raw;
        var backupKey = prefix + key + V1_BACKUP_SUFFIX;
        // Never overwrite an existing v1 backup: the first one taken is the real
        // pre-migration state, and a re-run must not replace it with newer bytes.
        if (store.getItem(backupKey) === null || store.getItem(backupKey) === undefined) {
          store.setItem(backupKey, raw);
          createdBackupKeys.push(backupKey);
        }
        report.backedUpKeys.push(key + V1_BACKUP_SUFFIX);
      });
    } catch (err) {
      // Undo only the backup keys THIS call created; a pre-existing backup is
      // someone else's and is never deleted.
      createdBackupKeys.forEach(function (k) {
        try { store.removeItem(k); } catch (e) {}
      });
      report.error = 'v1 backup write failed, migration aborted: ' + (err && err.message ? err.message : String(err));
      if (typeof console !== 'undefined' && console.error) {
        console.error('PSAT v1->v2 migration aborted (backup write failed):', err);
      }
      return report;
    }

    // --- Step 3: the only data rewrite the migration performs ----------------
    var srsRaw = rawByKey.psat_srs;
    if (srsRaw !== undefined) {
      var upgradedState = null;
      try {
        var parsed = JSON.parse(srsRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          upgradedState = {};
          Object.keys(parsed).forEach(function (qid) {
            var res = upgradeSrsCardToV2(parsed[qid]);
            upgradedState[qid] = res.card;
            report.cardsUpgraded++;
            report.eventsTrimmed += res.trimmed;
          });
        }
      } catch (err) {
        // A corrupt psat_srs is not something a migration should "fix" by
        // discarding it. Leave it exactly as found and say so.
        upgradedState = null;
        report.cardsUpgraded = 0;
        report.eventsTrimmed = 0;
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('psat_srs is not parseable JSON; migrating the envelope only and leaving the value untouched:', err && err.message);
        }
      }

      if (upgradedState) {
        try {
          store.setItem(prefix + 'psat_srs', JSON.stringify(upgradedState));
        } catch (err) {
          try { store.setItem(prefix + 'psat_srs', srsRaw); } catch (e) {}
          report.cardsUpgraded = 0;
          report.eventsTrimmed = 0;
          report.error = 'SRS upgrade write failed, migration aborted: ' + (err && err.message ? err.message : String(err));
          if (typeof console !== 'undefined' && console.error) {
            console.error('PSAT v1->v2 migration aborted (srs write failed):', err);
          }
          return report;
        }
      }
    }

    // --- Step 4: mark the profile v2, last -----------------------------------
    var now = Date.now();
    try {
      writeSchemaMeta(store, loc, {
        schemaVersion: SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
        migratedAt: now,
        migratedFrom: 1,
        backedUpKeys: report.backedUpKeys
      });
    } catch (err) {
      if (srsRaw !== undefined) {
        try { store.setItem(prefix + 'psat_srs', srsRaw); } catch (e) {}
      }
      report.cardsUpgraded = 0;
      report.eventsTrimmed = 0;
      report.error = 'Envelope write failed, migration rolled back: ' + (err && err.message ? err.message : String(err));
      return report;
    }

    report.success = true;
    report.migrated = true;
    report.schemaVersion = SCHEMA_VERSION;
    return report;
  }


  /**
   * The documented rollback (see the block comment above). Restores every state key
   * that has a `<key>_v1_backup` copy, byte-for-byte, and clears the v2 envelope
   * marker. Keys with no backup are LEFT ALONE — never deleted.
   *
   * @returns {{success:boolean, restoredKeys:string[], schemaVersion:number, error:(string|null)}}
   */
  function rollbackLocalStateToV1(store, loc) {
    var report = { success: false, restoredKeys: [], schemaVersion: 2, error: null };
    if (!store || !store.getItem || !store.setItem) {
      report.error = 'No storage available';
      return report;
    }
    var prefix = prefixOf(loc);

    var available = STATE_KEYS.filter(function (key) {
      var v = store.getItem(prefix + key + V1_BACKUP_SUFFIX);
      return v !== null && v !== undefined;
    });
    if (available.length === 0) {
      // Do nothing and report it. A rollback with no backup must not "clean up".
      report.error = 'No psat_*_v1_backup keys found for this profile; nothing was changed.';
      report.schemaVersion = readSchemaMeta(store, loc).schemaVersion;
      return report;
    }

    // Snapshot the current values so a partial failure can be undone.
    var currentByKey = {};
    STATE_KEYS.forEach(function (key) { currentByKey[key] = store.getItem(prefix + key); });
    var currentMeta = store.getItem(prefix + SCHEMA_META_KEY);

    try {
      available.forEach(function (key) {
        store.setItem(prefix + key, store.getItem(prefix + key + V1_BACKUP_SUFFIX));
        report.restoredKeys.push(key);
      });
      store.removeItem(prefix + SCHEMA_META_KEY);
    } catch (err) {
      try {
        report.restoredKeys.forEach(function (key) {
          if (currentByKey[key] === null || currentByKey[key] === undefined) store.removeItem(prefix + key);
          else store.setItem(prefix + key, currentByKey[key]);
        });
        if (currentMeta !== null && currentMeta !== undefined) store.setItem(prefix + SCHEMA_META_KEY, currentMeta);
      } catch (e) {}
      report.restoredKeys = [];
      report.error = 'Rollback write failed and was undone: ' + (err && err.message ? err.message : String(err));
      return report;
    }

    report.success = true;
    report.schemaVersion = 1;
    return report;
  }


  /**
   * Builds the versioned student-data envelope for this profile: the schema version,
   * creation/update times and the four record collections, in one object.
   *
   * Used by the export path and by anything that needs to hand the whole profile
   * to another component. It READS only — nothing here writes to storage.
   */
  function buildStateEnvelope(store, loc) {
    var prefix = prefixOf(loc);
    function readJson(key, fallback) {
      try {
        var raw = store && store.getItem ? store.getItem(prefix + key) : null;
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    }
    var meta = readSchemaMeta(store, loc);
    var now = Date.now();
    return {
      schemaVersion: SCHEMA_VERSION,
      storedSchemaVersion: meta.schemaVersion,
      createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : now,
      updatedAt: now,
      progress: readJson('psat_progress', {}),
      srsState: readJson('psat_srs', {}),
      sessionsState: readJson('psat_sessions', {}),
      examHistory: readJson('psat_exam_history', [])
    };
  }


  /**
   * WI-11 — the ONE builder for a stored per-question progress entry.
   *
   * This record shape existed twice inside js/pages/student.js: once in
   * recordAttempt() for practice, once in the exam-submission handler. The two
   * copies had diverged — the exam copy omitted `errorTag` and
   * `historicalErrorTags` entirely, so answering a tagged question inside an exam
   * silently DELETED the error tag the student had set on it. That is CLAUDE.md
   * mode 2 ("a rule applied in one place but not its twin") with real data loss
   * attached, so the shape now lives here and both call sites use it.
   *
   * PURE and clock-free: the caller passes `at`, so a test and a simulation can
   * drive it deterministically (CLAUDE.md mode 4 — no monkeypatched clocks).
   *
   * @param {Object|null|undefined} prevEntry the stored entry for this question, if any
   * @param {{selectedAnswer:*, isCorrect:boolean, timeSpentMs:(number|null),
   *          timingReliable:boolean, at:number, source:string}} attempt
   * @returns {Object} the new entry; `prevEntry` is not mutated
   */
  function buildProgressEntry(prevEntry, attempt) {
    var prev = prevEntry || {};
    var a = attempt || {};
    var at = typeof a.at === 'number' ? a.at : Date.now();

    var prevSeen = prev.timesSeen || (prev.answered ? 1 : 0);
    var prevCorrect = prev.timesCorrect || (prev.answered && prev.isCorrect ? 1 : 0);
    var prevIncorrect = prev.timesIncorrect || (prev.answered && !prev.isCorrect ? 1 : 0);

    var newSeen = prevSeen + 1;
    var newCorrect = prevCorrect + (a.isCorrect ? 1 : 0);
    var newIncorrect = prevIncorrect + (a.isCorrect ? 0 : 1);

    var attempts = Array.isArray(prev.attempts) ? prev.attempts.slice() : [];
    attempts.push({
      at: at,
      selectedAnswer: a.selectedAnswer,
      isCorrect: !!a.isCorrect,
      timeSpentMs: (typeof a.timeSpentMs === 'number') ? a.timeSpentMs : null,
      source: a.source || 'practice'
    });

    // An error tag the student set on a miss is resolved — moved into the history
    // list — the first time they get the question right, from EITHER path.
    var prevErrorTag = prev.errorTag || null;
    var historicalErrorTags = Array.isArray(prev.historicalErrorTags) ? prev.historicalErrorTags.slice() : [];
    if (prevErrorTag && a.isCorrect && !historicalErrorTags.some(function (h) { return h && h.tag === prevErrorTag; })) {
      historicalErrorTags.push({ tag: prevErrorTag, resolvedAt: at });
    }

    return {
      answered: true,
      selectedAnswer: a.selectedAnswer,
      isCorrect: !!a.isCorrect,
      timeSpentMs: (typeof a.timeSpentMs === 'number') ? a.timeSpentMs : null,
      timingReliable: !!a.timingReliable,
      timestamp: at,
      isFlagged: prev.isFlagged || false,
      errorTag: a.isCorrect ? null : prevErrorTag,
      historicalErrorTags: historicalErrorTags,
      timesSeen: newSeen,
      timesCorrect: newCorrect,
      timesIncorrect: newIncorrect,
      accuracyPercent: Math.round((newCorrect / newSeen) * 100),
      // The detailed attempt log stays capped at the newest 3 (unchanged), while
      // timesSeen/timesCorrect/timesIncorrect above remain the durable exact counts.
      attempts: attempts.slice(-3)
    };
  }


  /**
   * WI-11 — the stable, content-derived identity of an append-only op.
   *
   * Before WI-11 an op id was `op_<Date.now()>_<random>`, which meant the SAME
   * attempt enqueued twice (a double-submit, a retried code path, a page that
   * re-ran its handler) produced two ops the server would count as two
   * deliveries. Deriving the identity from the op's CONTENT makes the queue
   * idempotent at the point of entry: replaying an attempt is a no-op instead of
   * a duplicate.
   *
   * Returns null when the payload has no natural identity, in which case the
   * caller keeps the old timestamp+random id (never worse than before).
   */
  function outboxOpIdentity(opType, payload) {
    var p = payload || {};
    if (opType === 'question_attempt') {
      if (p.questionId === undefined || p.questionId === null) return null;
      if (typeof p.timestamp !== 'number') return null;
      return 'att_' + p.questionId + '_' + p.timestamp;
    }
    if (opType === 'exam_completed') {
      if (!p.examId) return null;
      return 'exam_' + p.examId;
    }
    return null;
  }


  /**
   * Enqueues an immutable operation to the local durable sync outbox.
   *
   * Append-only and content-addressed (WI-11): if an op with the same derived
   * identity is already queued, the queued op is returned unchanged and nothing is
   * added. See outboxOpIdentity above for why.
   */
  function enqueueOutboxOp(store, opType, payload, loc) {
    if (!store) return null;
    var env = getEnvironmentConfig(loc);
    var outboxKey = env.storagePrefix + 'psat_sync_outbox';
    var type = opType || 'question_attempt';
    var stableId = outboxOpIdentity(type, payload);
    var op = {
      id: stableId || ('op_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)),
      type: type,
      timestamp: Date.now(),
      payload: payload || {}
    };
    try {
      var raw = store.getItem(outboxKey);
      var queue = raw ? JSON.parse(raw) : [];
      if (stableId) {
        for (var i = 0; i < queue.length; i++) {
          if (queue[i] && queue[i].id === stableId) {
            return queue[i];
          }
        }
      }
      queue.push(op);
      // Cap outbox to 500 ops maximum to prevent quota issues during long offline periods
      if (queue.length > 500) {
        queue = queue.slice(-500);
      }
      store.setItem(outboxKey, JSON.stringify(queue));
      return op;
    } catch (e) {
      console.warn('Failed to enqueue outbox op:', e);
      return null;
    }
  }


  /**
   * Retrieves all pending outbox operations.
   */
  function getOutboxOps(store, loc) {
    if (!store) return [];
    var env = getEnvironmentConfig(loc);
    var outboxKey = env.storagePrefix + 'psat_sync_outbox';
    try {
      var raw = store.getItem(outboxKey);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }


  /**
   * Acknowledges and removes confirmed operations from the outbox.
   */
  function ackOutboxOps(store, ackOpIds, loc) {
    if (!store || !Array.isArray(ackOpIds) || ackOpIds.length === 0) return 0;
    var env = getEnvironmentConfig(loc);
    var outboxKey = env.storagePrefix + 'psat_sync_outbox';
    try {
      var raw = store.getItem(outboxKey);
      if (!raw) return 0;
      var queue = JSON.parse(raw);
      var ackSet = {};
      ackOpIds.forEach(function(id) { ackSet[id] = true; });
      var initialLen = queue.length;
      var filtered = queue.filter(function(op) { return !ackSet[op.id]; });
      store.setItem(outboxKey, JSON.stringify(filtered));
      return initialLen - filtered.length;
    } catch (e) {
      console.warn('Failed to ack outbox ops:', e);
      return 0;
    }
  }


  /**
   * Clears the outbox queue.
   */
  function clearOutbox(store, loc) {
    if (!store) return;
    var env = getEnvironmentConfig(loc);
    try {
      store.removeItem(env.storagePrefix + 'psat_sync_outbox');
    } catch (e) {}
  }

  return {
    getEnvironmentConfig: getEnvironmentConfig,
    isDemoModeActive: isDemoModeActive,
    backupRealData: backupRealData,
    restoreRealData: restoreRealData,
    toLeanReport: toLeanReport,
    rehydrateReport: rehydrateReport,
    createClientSnapshot: createClientSnapshot,
    listClientSnapshots: listClientSnapshots,
    restoreClientSnapshot: restoreClientSnapshot,
    runTransactionalAction: runTransactionalAction,
    buildProgressEntry: buildProgressEntry,
    enqueueOutboxOp: enqueueOutboxOp,
    getOutboxOps: getOutboxOps,
    ackOutboxOps: ackOutboxOps,
    clearOutbox: clearOutbox,
    // Part-level only (not in srs.js's API_MANIFEST, so it never reaches the frozen
    // PSAT_ENGINE surface): js/engine/sync.js reads the cursor key from here.
    SYNC_CURSOR_KEY: SYNC_CURSOR_KEY,
    invalidateSyncCursor: invalidateSyncCursor,
    SCHEMA_VERSION: SCHEMA_VERSION,
    readSchemaMeta: readSchemaMeta,
    migrateLocalStateToV2: migrateLocalStateToV2,
    rollbackLocalStateToV1: rollbackLocalStateToV1,
    buildStateEnvelope: buildStateEnvelope
  };
});
