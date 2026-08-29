/**
 * js/engine/sync.js — The cloud sync client and the field-level merge rules it shares with the
 * server (api/src/lib/merge.js): push/pull against CLOUD_SYNC_ENDPOINT, plus
 * the progress / SRS / sessions / exam-history mergers.
 *
 * Part of the engine that was one 3,458-line srs.js until REFACTOR_PLAN.md
 * WI-10. The code below is the SAME code, moved verbatim; `srs.js` is now a
 * facade that recomposes these parts into the unchanged `PSAT_ENGINE` object.
 *
 * Loading: same UMD shape as srs.js always had — `module.exports` under Node,
 * `window.__PSAT_ENGINE_PARTS.sync` in the browser. There is no build step,
 * so the pages load the parts as ordinary <script> tags in dependency order
 * (grading -> scheduler -> scoring -> storage -> examgen -> sync) before srs.js.
 * Dependencies: scheduler, storage.
 * A missing dependency throws immediately rather than yielding a half-built
 * part whose functions ReferenceError at call time (CLAUDE.md failure mode 5).
 */
(function (root, factory) {
  var DEPS = ['scheduler', 'storage'];
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory.apply(null, DEPS.map(function (d) { return require('./' + d + '.js'); }));
  } else {
    var parts = root.__PSAT_ENGINE_PARTS = root.__PSAT_ENGINE_PARTS || {};
    parts.sync = factory.apply(null, DEPS.map(function (d) {
      if (!parts[d]) {
        throw new Error(
          'js/engine/sync.js requires js/engine/' + d + '.js, which has not loaded yet. ' +
          'Load the engine parts in this order before srs.js: grading, scheduler, scoring, storage, examgen, sync.'
        );
      }
      return parts[d];
    }));
  }
})(typeof self !== 'undefined' ? self : this, function (scheduler, storage) {
  // Cross-part bindings, aliased to their original bare names so the moved
  // code below stays byte-identical to what it was inside srs.js.
  var localDateKey = scheduler.localDateKey;
  var ackOutboxOps = storage.ackOutboxOps;
  var getEnvironmentConfig = storage.getEnvironmentConfig;
  var getOutboxOps = storage.getOutboxOps;
  var isDemoModeActive = storage.isDemoModeActive;


  var CLOUD_SYNC_ENDPOINT = 'https://psat-api-4915.azurewebsites.net/api/sync';


  /**
   * Identifies which deployment lane this client was served from, so the server can
   * attribute a write to the app build that produced it.
   *
   * The working-tree copy is deliberately version-neutral: it reports 'v1' unless a page
   * sets `window.PSAT_CLIENT_VERSION` before srs.js is used. `scripts/deploy_v2.sh`
   * injects that global (`v2-<short-git-sha>`) into the /v2/ copies of the HTML pages at
   * upload time; nothing in the repo hardcodes a version.
   */
  var CLIENT_VERSION_DEFAULT = 'v1';


  function getClientVersion() {
    try {
      var scope = (typeof window !== 'undefined' && window) ? window :
                  ((typeof globalThis !== 'undefined' && globalThis) ? globalThis : null);
      if (scope && typeof scope.PSAT_CLIENT_VERSION === 'string' && scope.PSAT_CLIENT_VERSION) {
        return scope.PSAT_CLIENT_VERSION;
      }
    } catch (e) {
      // A blocked/throwing global must never break sync. Report and fall back.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('Unable to read PSAT_CLIENT_VERSION; reporting "' + CLIENT_VERSION_DEFAULT + '":', e && e.message);
      }
    }
    return CLIENT_VERSION_DEFAULT;
  }


  /**
   * Derives daily session stats directly from progress question attempt timestamps.
   */
  function deriveSessionsFromProgress(progress) {
    var sessions = {};
    if (!progress) return sessions;
    Object.keys(progress).forEach(function(qid) {
      var p = progress[qid];
      if (p && p.answered && p.timestamp) {
        var day = localDateKey(new Date(p.timestamp));
        if (!sessions[day]) {
          sessions[day] = { date: day, questionsAnswered: 0, correct: 0, totalTimeMs: 0 };
        }
        sessions[day].questionsAnswered++;
        if (p.isCorrect) sessions[day].correct++;
        sessions[day].totalTimeMs += (p.timeSpentMs || 0);
      }
    });
    return sessions;
  }


  /**
   * Merges daily session maps idempotently using Math.max and derived progress timestamps.
   * Prevents session totals and practice time from inflating across syncs and page refreshes.
   */
  function mergeSessionsState(cloudSessions, localSessions, mergedProgress) {
    var cloud = cloudSessions || {};
    var local = localSessions || {};
    var merged = {};

    var allDays = Object.keys(cloud).concat(Object.keys(local));
    allDays.forEach(function(day) {
      if (merged[day]) return;
      var cDay = cloud[day];
      var lDay = local[day];

      if (cDay && lDay) {
        merged[day] = {
          date: day,
          questionsAnswered: Math.max(cDay.questionsAnswered || cDay.totalAnswered || 0, lDay.questionsAnswered || lDay.totalAnswered || 0),
          correct: Math.max(cDay.correct || cDay.totalCorrect || 0, lDay.correct || lDay.totalCorrect || 0),
          totalTimeMs: Math.max(cDay.totalTimeMs || cDay.totalTimeSpentMs || 0, lDay.totalTimeMs || lDay.totalTimeSpentMs || 0)
        };
      } else if (cDay) {
        merged[day] = Object.assign({}, cDay);
      } else if (lDay) {
        merged[day] = Object.assign({}, lDay);
      }
    });

    if (mergedProgress && typeof mergedProgress === 'object') {
      var derived = deriveSessionsFromProgress(mergedProgress);
      Object.keys(derived).forEach(function(day) {
        var d = derived[day];
        if (!merged[day]) {
          merged[day] = d;
        } else {
          merged[day].questionsAnswered = Math.max(merged[day].questionsAnswered || 0, d.questionsAnswered);
          merged[day].correct = Math.max(merged[day].correct || 0, d.correct);
          merged[day].totalTimeMs = Math.max(merged[day].totalTimeMs || 0, d.totalTimeMs);
        }
      });
    }

    return merged;
  }


  /**
   * Merges progress maps by choosing the newer record timestamp per question.
   */
  function mergeProgress(cloudProgress, localProgress) {
    var cloud = cloudProgress || {};
    var local = localProgress || {};
    var merged = {};

    var allQids = Object.keys(cloud).concat(Object.keys(local));
    allQids.forEach(function(qid) {
      if (merged[qid]) return;
      var c = cloud[qid];
      var l = local[qid];

      if (c && l) {
        var cTime = c.timestamp || c.lastAttemptTime || 0;
        var lTime = l.timestamp || l.lastAttemptTime || 0;
        var chosen = (lTime >= cTime) ? Object.assign({}, l) : Object.assign({}, c);

        var cSeen = c.timesSeen || (c.answered ? 1 : 0);
        var lSeen = l.timesSeen || (l.answered ? 1 : 0);
        var cCorrect = c.timesCorrect || (c.answered && c.isCorrect ? 1 : 0);
        var lCorrect = l.timesCorrect || (l.answered && l.isCorrect ? 1 : 0);
        var cIncorrect = c.timesIncorrect || (c.answered && !c.isCorrect ? 1 : 0);
        var lIncorrect = l.timesIncorrect || (l.answered && !l.isCorrect ? 1 : 0);

        var cAttempts = Array.isArray(c.attempts) ? c.attempts : [];
        var lAttempts = Array.isArray(l.attempts) ? l.attempts : [];

        var attemptMap = {};
        cAttempts.forEach(function(att) { if (att && att.at) attemptMap[att.at] = att; });
        lAttempts.forEach(function(att) { if (att && att.at) attemptMap[att.at] = att; });

        var combinedAttempts = Object.values(attemptMap).sort(function(a, b) { return a.at - b.at; });
        var derivedSeen = combinedAttempts.length;
        var derivedCorrect = combinedAttempts.filter(function(a) { return a.isCorrect; }).length;
        var derivedIncorrect = derivedSeen - derivedCorrect;

        // Authoritative accumulation: Stored counters must never decay when attempt logs are capped
        var finalSeen = Math.max(cSeen, lSeen, derivedSeen);
        var finalCorrect = Math.max(cCorrect, lCorrect, derivedCorrect);
        var finalIncorrect = Math.max(cIncorrect, lIncorrect, derivedIncorrect);

        chosen.timesSeen = finalSeen;
        chosen.timesCorrect = finalCorrect;
        chosen.timesIncorrect = finalIncorrect;
        if (finalSeen > 0) {
          chosen.accuracyPercent = Math.round((finalCorrect / finalSeen) * 100);
        }
        chosen.attempts = (combinedAttempts.length > 0 ? combinedAttempts : (cAttempts.length > 0 ? cAttempts : lAttempts)).slice(-3);
        merged[qid] = chosen;
      } else if (c) {
        merged[qid] = Object.assign({}, c);
      } else if (l) {
        merged[qid] = Object.assign({}, l);
      }
    });

    return merged;
  }


  /**
   * Merges SRS card states by choosing the newer review record per question while preserving cumulative counters.
   */
  function mergeSrsState(cloudSrs, localSrs) {
    var cloud = cloudSrs || {};
    var local = localSrs || {};
    var merged = {};

    var allQids = Object.keys(cloud).concat(Object.keys(local));
    allQids.forEach(function(qid) {
      if (merged[qid]) return;
      var c = cloud[qid];
      var l = local[qid];

      if (c && l) {
        var cTime = (typeof c.lastReviewedAt === 'number') ? c.lastReviewedAt : (c.timestamp || 0);
        var lTime = (typeof l.lastReviewedAt === 'number') ? l.lastReviewedAt : (l.timestamp || 0);
        var chosen = (lTime >= cTime) ? Object.assign({}, l) : Object.assign({}, c);

        // Preserve cumulative counters across sync
        var cRev = typeof c.totalReviews === 'number' ? c.totalReviews : (c.lastReviewedAt ? 1 : 0);
        var lRev = typeof l.totalReviews === 'number' ? l.totalReviews : (l.lastReviewedAt ? 1 : 0);
        chosen.totalReviews = Math.max(cRev, lRev, chosen.totalReviews || 0);

        var cLapses = typeof c.totalLapses === 'number' ? c.totalLapses : 0;
        var lLapses = typeof l.totalLapses === 'number' ? l.totalLapses : 0;
        chosen.totalLapses = Math.max(cLapses, lLapses, chosen.totalLapses || 0);

        var cFirst = c.firstReviewedAt || c.lastReviewedAt || null;
        var lFirst = l.firstReviewedAt || l.lastReviewedAt || null;
        if (cFirst && lFirst) chosen.firstReviewedAt = Math.min(cFirst, lFirst);
        else chosen.firstReviewedAt = cFirst || lFirst || chosen.lastReviewedAt || null;

        // Merge and deduplicate review history array, capped at 20 newest events
        var cHist = Array.isArray(c.history) ? c.history : [];
        var lHist = Array.isArray(l.history) ? l.history : [];
        var histMap = {};
        cHist.concat(lHist).forEach(function(ev) {
          if (ev && ev.reviewedAt) histMap[ev.reviewedAt] = ev;
        });
        var combinedHist = Object.keys(histMap).map(function(k) { return histMap[k]; }).sort(function(a, b) { return a.reviewedAt - b.reviewedAt; }).slice(-20);
        chosen.history = combinedHist;

        if (combinedHist.length > 0) {
          var times = combinedHist.map(function(h) { return h.responseTimeMs; }).filter(function(t) { return typeof t === 'number' && t > 0; });
          if (times.length > 0) {
            chosen.avgResponseTimeMs = Math.round(times.reduce(function(a, b) { return a + b; }, 0) / times.length);
          }
        }

        merged[qid] = chosen;
      } else if (c) {
        merged[qid] = Object.assign({}, c);
        if (Array.isArray(c.history) && c.history.length > 20) merged[qid].history = c.history.slice(-20);
      } else if (l) {
        merged[qid] = Object.assign({}, l);
        if (Array.isArray(l.history) && l.history.length > 20) merged[qid].history = l.history.slice(-20);
      }
    });

    return merged;
  }


  /**
   * Merges exam histories, deduplicating by examId and capping at maxCap (default 15).
   */
  function mergeExamHistory(cloudHistory, localHistory, maxCap) {
    var cap = (typeof maxCap === 'number') ? maxCap : 15;
    var histMap = {};
    (cloudHistory || []).forEach(function(h) {
      if (h && (h.examId || h.completedAt)) {
        histMap[h.examId || h.completedAt] = h;
      }
    });
    (localHistory || []).forEach(function(h) {
      if (h && (h.examId || h.completedAt)) {
        histMap[h.examId || h.completedAt] = h;
      }
    });

    var merged = Object.values(histMap).sort(function(a, b) {
      return (b.completedAt || 0) - (a.completedAt || 0);
    });

    return merged.slice(0, cap);
  }


  /**
   * Pushes progress, exam history, and pending outbox operations to Cosmos DB cloud API.
   */
  function pushToCloud(store, customFetch, studentName, loc) {
    var env = getEnvironmentConfig(loc);
    var sName = studentName || env.studentName;
    var prefix = env.storagePrefix;
    var fetchFn = customFetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) return Promise.resolve({ success: false, error: 'No fetch API available' });
    if (isDemoModeActive(store, loc)) return Promise.resolve({ success: false, reason: 'demo_mode' });

    var progress = JSON.parse((store && store.getItem ? store.getItem(prefix + 'psat_progress') : null) || '{}');
    var srs = JSON.parse((store && store.getItem ? store.getItem(prefix + 'psat_srs') : null) || '{}');
    var sessions = JSON.parse((store && store.getItem ? store.getItem(prefix + 'psat_sessions') : null) || '{}');
    var history = JSON.parse((store && store.getItem ? store.getItem(prefix + 'psat_exam_history') : null) || '[]');
    var outbox = getOutboxOps(store, loc);

    var payload = {
      student_name: sName,
      progress: progress,
      srsState: srs,
      sessionsState: sessions,
      examHistory: history,
      outboxOps: outbox,
      clientTimestamp: new Date().toISOString(),
      client_version: getClientVersion()
    };

    return fetchFn(CLOUD_SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(res) {
      if (!res || !res.ok) {
        return { success: false, error: 'HTTP_' + (res ? res.status : 'Unknown') };
      }
      return res.json().then(function(result) {
        if (!result || !result.success || result.error) {
          return { success: false, error: (result && result.error) ? result.error : 'Server returned error' };
        }
        // Acknowledge synced outbox ops
        if (Array.isArray(result.ackOpIds) && result.ackOpIds.length > 0) {
          ackOutboxOps(store, result.ackOpIds, loc);
        } else if (outbox.length > 0) {
          ackOutboxOps(store, outbox.map(function(o) { return o.id; }), loc);
        }
        return { success: true, updatedAt: result.updatedAt, ackCount: outbox.length };
      });
    }).catch(function(err) {
      return { success: false, error: err.message };
    });
  }


  /**
   * Pulls latest progress and exam history from Cosmos DB and merges with local storage.
   */
  function pullFromCloud(store, customFetch, studentName, safeSetStorageFn, loc, forceSync) {
    var env = getEnvironmentConfig(loc);
    var sName = studentName || env.studentName;
    var prefix = env.storagePrefix;
    var fetchFn = customFetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) return Promise.resolve({ success: false, error: 'No fetch API available' });
    if (!forceSync && isDemoModeActive(store, loc)) return Promise.resolve({ success: false, reason: 'demo_mode' });
    if (forceSync && store && store.removeItem) {
      try { store.removeItem(prefix + 'psat_sample_data_active'); } catch(e) {}
    }

    var setter = safeSetStorageFn || function(key, val) {
      try {
        if (store && store.setItem) {
          store.setItem(prefix + key, JSON.stringify(val));
          return true;
        }
        return false;
      } catch (e) {
        console.error('Storage quota write error for key:', key, e);
        return false;
      }
    };

    var getter = function(key) {
      try {
        if (store && store.getItem) {
          return store.getItem(prefix + key);
        }
        return null;
      } catch (e) {
        return null;
      }
    };

    return fetchFn(CLOUD_SYNC_ENDPOINT + '?student_name=' + encodeURIComponent(sName))
      .then(function(res) {
        if (!res || !res.ok) {
          return { success: false, error: 'HTTP_' + (res ? res.status : 'Unknown') };
        }
        return res.json().then(function(result) {
          if (!result || !result.success || result.error) {
            return { success: false, error: (result && result.error) ? result.error : 'Server returned error' };
          }
          if (result.exists && result.data) {
            var cloud = result.data;
            var localProgRaw = getter('psat_progress');
            var localHistRaw = getter('psat_exam_history');
            var localSessRaw = getter('psat_sessions');
            var localSrsRaw = getter('psat_srs');

            var localProg = JSON.parse(localProgRaw || '{}');
            var localHist = JSON.parse(localHistRaw || '[]');
            var localSess = JSON.parse(localSessRaw || '{}');
            var localSrs = JSON.parse(localSrsRaw || '{}');

            var mergedProg = mergeProgress(cloud.progress, localProg);
            var mergedSrs = mergeSrsState(cloud.srsState, localSrs);
            var mergedSess = mergeSessionsState(cloud.sessionsState, localSess, mergedProg);
            var mergedHist = mergeExamHistory(cloud.examHistory, localHist, 15);

            // Pass unprefixed keys to setter (the browser storage wrapper safeSetStorage prefixes them)
            var ok1 = setter('psat_progress', mergedProg);
            var ok2 = setter('psat_srs', mergedSrs);
            var ok3 = setter('psat_sessions', mergedSess);
            var ok4 = setter('psat_exam_history', mergedHist);

            if (!ok1 || !ok2 || !ok3 || !ok4) {
              // Rollback to original uncorrupted state on partial quota write failure
              try {
                if (store) {
                  if (localProgRaw !== null && store.setItem) store.setItem(prefix + 'psat_progress', localProgRaw);
                  else if (store.removeItem) store.removeItem(prefix + 'psat_progress');

                  if (localSrsRaw !== null && store.setItem) store.setItem(prefix + 'psat_srs', localSrsRaw);
                  else if (store.removeItem) store.removeItem(prefix + 'psat_srs');

                  if (localSessRaw !== null && store.setItem) store.setItem(prefix + 'psat_sessions', localSessRaw);
                  else if (store.removeItem) store.removeItem(prefix + 'psat_sessions');

                  if (localHistRaw !== null && store.setItem) store.setItem(prefix + 'psat_exam_history', localHistRaw);
                  else if (store.removeItem) store.removeItem(prefix + 'psat_exam_history');
                }
              } catch (rollbackErr) {
                console.error('Error during storage rollback:', rollbackErr);
              }
              return { success: false, error: 'Storage quota exceeded while writing merged data', quotaExceeded: true };
            }

            return {
              success: true,
              updated: true,
              data: cloud,
              mergedHistoryCount: mergedHist.length,
              totalAttempts: Object.keys(mergedProg).length
            };
          } else if (env.isBeta && !result.exists) {
            // Beta sandbox auto-seed from production default_student if beta cloud profile is empty
            return fetchFn(CLOUD_SYNC_ENDPOINT + '?student_name=default_student')
              .then(function(prodRes) {
                if (!prodRes || !prodRes.ok) return { success: true, updated: false, empty: true };
                return prodRes.json().then(function(prodResult) {
                  if (prodResult && prodResult.exists && prodResult.data) {
                    var cloud = prodResult.data;
                    var localProgRaw = getter('psat_progress');
                    var localHistRaw = getter('psat_exam_history');
                    var localSessRaw = getter('psat_sessions');
                    var localSrsRaw = getter('psat_srs');

                    var localProg = JSON.parse(localProgRaw || '{}');
                    var localHist = JSON.parse(localHistRaw || '[]');
                    var localSess = JSON.parse(localSessRaw || '{}');
                    var localSrs = JSON.parse(localSrsRaw || '{}');

                    var mergedProg = mergeProgress(cloud.progress, localProg);
                    var mergedSrs = mergeSrsState(cloud.srsState, localSrs);
                    var mergedSess = mergeSessionsState(cloud.sessionsState, localSess, mergedProg);
                    var mergedHist = mergeExamHistory(cloud.examHistory, localHist, 15);

                    setter('psat_progress', mergedProg);
                    setter('psat_srs', mergedSrs);
                    setter('psat_sessions', mergedSess);
                    setter('psat_exam_history', mergedHist);

                    return {
                      success: true,
                      updated: true,
                      seededFromProd: true,
                      data: cloud,
                      mergedHistoryCount: mergedHist.length,
                      totalAttempts: Object.keys(mergedProg).length
                    };
                  }
                  return { success: true, updated: false, empty: true };
                });
              }).catch(function() {
                return { success: true, updated: false, empty: true };
              });
          }
          return { success: true, updated: false, empty: true };
        });
      }).catch(function(err) {
        return { success: false, error: err.message };
      });
  }

  return {
    getClientVersion: getClientVersion,
    pushToCloud: pushToCloud,
    pullFromCloud: pullFromCloud,
    mergeProgress: mergeProgress,
    mergeSrsState: mergeSrsState,
    mergeSessionsState: mergeSessionsState,
    mergeExamHistory: mergeExamHistory
  };
});
