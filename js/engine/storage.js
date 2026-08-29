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
 * Dependencies: none.
 * A missing dependency throws immediately rather than yielding a half-built
 * part whose functions ReferenceError at call time (CLAUDE.md failure mode 5).
 */
(function (root, factory) {
  var DEPS = [];
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
})(typeof self !== 'undefined' ? self : this, function () {

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
    if (backup) {
      if (backup.progress) setFn('psat_progress', backup.progress);
      else removeFn('psat_progress');

      if (backup.srsState) setFn('psat_srs', backup.srsState);
      else removeFn('psat_srs');

      if (backup.sessionsState) setFn('psat_sessions', backup.sessionsState);
      else removeFn('psat_sessions');

      if (backup.examHistory) setFn('psat_exam_history', backup.examHistory);
      else removeFn('psat_exam_history');
    } else {
      removeFn('psat_progress');
      removeFn('psat_srs');
      removeFn('psat_sessions');
      removeFn('psat_exam_history');
    }

    removeFn('psat_sample_data_active');
    removeFn('psat_pre_sample_backup');
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


  /**
   * Enqueues an immutable operation to the local durable sync outbox.
   */
  function enqueueOutboxOp(store, opType, payload, loc) {
    if (!store) return null;
    var env = getEnvironmentConfig(loc);
    var outboxKey = env.storagePrefix + 'psat_sync_outbox';
    var op = {
      id: 'op_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      type: opType || 'question_attempt',
      timestamp: Date.now(),
      payload: payload || {}
    };
    try {
      var raw = store.getItem(outboxKey);
      var queue = raw ? JSON.parse(raw) : [];
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
    enqueueOutboxOp: enqueueOutboxOp,
    getOutboxOps: getOutboxOps,
    ackOutboxOps: ackOutboxOps,
    clearOutbox: clearOutbox
  };
});
