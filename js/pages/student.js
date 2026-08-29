/**
 * js/pages/student.js — page controller for index.html.
 *
 * WI-09: relocated out of index.html's 2,713-line inline <script>. Pure
 * mechanical move. The only edits are the shared-module imports below
 * (replacing byte-identical local copies, including the ~360-line math-tools
 * block that was duplicated with parent.html) and the explicit window
 * bindings at the bottom.
 *
 * NOT unified with parent.js (a real divergence found, deliberately left
 * alone): restoreRealStudentData(). The parent portal wraps the restore in
 * PSAT_ENGINE.runTransactionalAction and aborts if the pre-restore snapshot
 * fails; this page calls PSAT_ENGINE.restoreRealData directly. Reconciling
 * them changes what happens to a student's data on a failed snapshot, which
 * is a storage-semantics decision owned by WI-11, not a mechanical
 * relocation. Recorded in the WI-09 duplication ledger as an open twin.
 */
import { esc } from '../shared/html.js';
import { APP_ENV } from '../shared/env.js';
import { safeGetStorage, safeSetStorage, readSyncBadgeState, onPendingSyncCountChanged } from '../shared/storage.js';
import { cloneProdDataToBeta, resetBetaSandbox } from '../shared/beta_sandbox.js';
import { questionImageSrc } from '../shared/questions.js';
import { setClassName } from '../shared/dom.js';
import { toggleDesmosCalculator, initDesmosCalculator, fallbackDesmosIframe, toggleDesmosSize, toggleScientificCalculator, toggleScientificAngleMode, sciCalcInput, sciCalcClear, sciCalcBackspace, sciCalcEvaluate, updateSciCalcDisplay, toggleReferenceSheet, setFormulaTab, makeDraggable } from '../shared/math_tools.js';

// safeSetStorage bumps the pending-sync counter; this is how it reaches this
// page's badge. Registered during module evaluation, before any write can
// happen -- the inline original called updateSyncStatusBadge() directly.
onPendingSyncCountChanged(updateSyncStatusBadge);

function updateSyncStatusBadge() {
  const badge = document.getElementById('hdr-cloud-badge');
  if (!badge) return;
  const { pending, lastSync, minutesAgo } = readSyncBadgeState();

  let timeAgoStr = 'Never';
  if (lastSync) {
    const mins = minutesAgo;
    if (mins < 1) timeAgoStr = 'Just now';
    else if (mins === 1) timeAgoStr = '1m ago';
    else if (mins < 60) timeAgoStr = `${mins}m ago`;
    else timeAgoStr = `${Math.floor(mins / 60)}h ago`;
  }

  if (pending > 0) {
    badge.innerHTML = `<i data-lucide="cloud-rain" class="w-3.5 h-3.5 text-amber-500 mr-1"></i> Cosmos DB: ${pending} Pending`;
  } else {
    badge.innerHTML = `<i data-lucide="cloud" class="w-3.5 h-3.5 text-emerald-500 mr-1"></i> Cosmos DB: Synced (${timeAgoStr})`;
  }
  lucide.createIcons();
}

let questions = window.QUESTIONS_DATA || [];
let filteredQuestions = [...questions];
let currentIndex = 0;
let viewMode = 'card';

// Persistent local states with crash guards
let progress = safeGetStorage('psat_progress', {});
let srsState = safeGetStorage('psat_srs', {});
let sessionsState = safeGetStorage('psat_sessions', {});

// Timing tracking
let questionShownAt = null;
let accumulatedForegroundTimeMs = 0;
let lastVisibilityTimestamp = Date.now();

// Pagination states
let palettePage = 0;
const PALETTE_PAGE_SIZE = 40;
let bankPage = 0;
const BANK_PAGE_SIZE = 25;
let searchedBankQuestions = [...questions];

let domainChartInstance = null;
let difficultyChartInstance = null;

// Visibility-aware timer
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (questionShownAt !== null) {
      accumulatedForegroundTimeMs += (Date.now() - lastVisibilityTimestamp);
    }
  } else {
    lastVisibilityTimestamp = Date.now();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  if (!Array.isArray(questions) || questions.length === 0) {
    document.body.innerHTML = `
      <div class="min-h-screen flex items-center justify-center p-6 bg-slate-100">
        <div class="bg-white p-8 rounded-2xl shadow-md max-w-md text-center space-y-4">
          <h2 class="text-xl font-bold text-rose-600">Question Data Bundle Not Found</h2>
          <p class="text-sm text-slate-600">Make sure data/questions_data.js is generated.</p>
        </div>
      </div>`;
    return;
  }
  lucide.createIcons();
  checkDemoModeBanner();
  applyFilters();
  updateHeaderStats();
  renderExamLobbyHistory();
});

function checkDemoModeBanner() {
  const isDemo = (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.isDemoModeActive) ? PSAT_ENGINE.isDemoModeActive() : (localStorage.getItem('psat_sample_data_active') === 'true');
  const banner = document.getElementById('demo-mode-warning-banner');
  if (banner) {
    if (isDemo) banner.classList.remove('hidden');
    else banner.classList.add('hidden');
  }
}

function restoreRealStudentData() {
  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.restoreRealData) {
    PSAT_ENGINE.restoreRealData(localStorage, safeGetStorage, safeSetStorage);
    location.reload();
  } else {
    alert('Restore is unavailable because the app engine did not load. Your backup is intact — please reload the page and try again.');
    return;
  }
}

function manualTriggerCloudSync(isManual = false) {
  const btnText = document.getElementById('cloud-sync-btn-text');
  if (btnText) btnText.innerText = 'Syncing...';
  const el = document.getElementById('hdr-cloud-badge');
  if (el) {
    el.innerHTML = '<i data-lucide="refresh-cw" class="w-3.5 h-3.5 text-indigo-600 mr-1 animate-spin"></i> Syncing...';
    lucide.createIcons();
  }
  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.pullFromCloud) {
    return PSAT_ENGINE.pullFromCloud(localStorage, null, APP_ENV.studentName, safeSetStorage, window.location, isManual).then(pullRes => {
      if (pullRes && pullRes.success) {
        progress = safeGetStorage('psat_progress', {});
        srsState = safeGetStorage('psat_srs', {});
        sessionsState = safeGetStorage('psat_sessions', {});
        updateHeaderStats();
        renderPalette();
        renderExamLobbyHistory();
        if (!document.getElementById('view-analytics').classList.contains('hidden')) {
          renderAnalytics();
        }
        if (typeof PSAT_ENGINE.pushToCloud === 'function') {
          PSAT_ENGINE.pushToCloud(localStorage, null, APP_ENV.studentName);
        }
        if (btnText) btnText.innerText = 'Sync';
        localStorage.setItem(APP_ENV.storagePrefix + 'psat_pending_sync_count', '0');
        localStorage.setItem(APP_ENV.storagePrefix + 'psat_last_cloud_sync_time', String(Date.now()));
        updateSyncStatusBadge();
        if (isManual) {
          if (pullRes.updated) {
            alert(`✓ Successfully synced student progress from Cosmos DB (${APP_ENV.studentName})!\n${pullRes.totalAttempts || Object.keys(progress).length} total attempts loaded across all domains.`);
          } else if (pullRes.empty) {
            alert(`Cosmos DB is connected, but no student test attempts exist yet for ${APP_ENV.studentName}.`);
          } else {
            alert('✓ Cosmos DB is up to date — all attempts are synchronized.');
          }
        }
      } else {
        if (btnText) btnText.innerText = 'Sync';
        updateSyncStatusBadge();
        if (isManual) {
          const errMsg = (pullRes && pullRes.error) ? pullRes.error : 'Could not connect to Cosmos DB server';
          alert(`Sync notice: ${errMsg}. Practice data remains safely stored in local cache.`);
        }
      }
      lucide.createIcons();
      return pullRes;
    }).catch(err => {
      console.warn('Manual cloud sync failed:', err);
      if (btnText) btnText.innerText = 'Sync';
      updateSyncStatusBadge();
      if (isManual) alert('Sync notice: Could not reach Cosmos DB sync endpoint.');
      lucide.createIcons();
    });
  }
}

// Explainer index: question id -> published step-by-step explainer
let explainerIndex = null;
fetch('explanations/index.json')
  .then(r => r.ok ? r.json() : null)
  .then(d => { explainerIndex = (d && d.questions) || {}; })
  .catch(() => { explainerIndex = {}; });

function showExplainerLink(questionId) {
  const el = document.getElementById('explainer-link');
  if (!el) return;
  const hit = explainerIndex && explainerIndex[String(questionId).slice(0, 8)];
  if (hit && hit.url) {
    el.href = hit.url;
    document.getElementById('explainer-link-skill').innerText = hit.skill || '';
    el.classList.remove('hidden');
    el.classList.add('flex');
  } else {
    el.classList.add('hidden');
    el.classList.remove('flex');
  }
}

let cloudPushDebounce = null;
function triggerCloudSync() {
  if (cloudPushDebounce) clearTimeout(cloudPushDebounce);
  cloudPushDebounce = setTimeout(() => {
    if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.pushToCloud) {
      PSAT_ENGINE.pushToCloud(localStorage).then(res => {
        const el = document.getElementById('hdr-cloud-badge');
        if (el) {
          if (res && res.success) {
            el.innerHTML = '<i data-lucide="cloud-check" class="w-3.5 h-3.5 text-emerald-500 mr-1"></i> Cosmos DB Synced';
          } else {
            el.innerHTML = '<i data-lucide="cloud-off" class="w-3.5 h-3.5 text-amber-500 mr-1"></i> Cosmos DB: Offline';
          }
          lucide.createIcons();
        }
      }).catch(() => {
        const el = document.getElementById('hdr-cloud-badge');
        if (el) {
          el.innerHTML = '<i data-lucide="cloud-off" class="w-3.5 h-3.5 text-amber-500 mr-1"></i> Cosmos DB: Offline';
          lucide.createIcons();
        }
      });
    }
  }, 1500);
}

function saveProgress() {
  const ok1 = safeSetStorage('psat_progress', progress);
  const ok2 = safeSetStorage('psat_srs', srsState);
  const ok3 = safeSetStorage('psat_sessions', sessionsState);

  if (!ok1 || !ok2 || !ok3) {
    showStorageWarningBanner();
  }

  updateHeaderStats();
  renderPalette();
  triggerCloudSync();
}

function showStorageWarningBanner() {
  const el = document.getElementById('storage-quota-warning');
  if (el) {
    el.classList.remove('hidden');
    setTimeout(() => { if (el) el.classList.add('hidden'); }, 9000);
  }
}

function resetAllProgress() {
  if (confirm('Are you sure you want to reset all test attempts, SRS review queues, and session analytics?')) {
    const result = (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.runTransactionalAction) ?
      PSAT_ENGINE.runTransactionalAction(localStorage, 'reset_all_progress', function(ctx) {
        progress = {};
        srsState = {};
        sessionsState = {};
        const ok1 = safeSetStorage('psat_progress', progress);
        const ok2 = safeSetStorage('psat_srs', srsState);
        const ok3 = safeSetStorage('psat_sessions', sessionsState);
        const ok4 = safeSetStorage('psat_exam_history', []);
        safeSetStorage('psat_active_exam_state', null);
        if (!ok1 || !ok2 || !ok3 || !ok4) {
          return { success: false, error: 'Storage write failed during reset' };
        }
        return { success: true };
      }, window.location) :
      { success: false, error: 'Engine unavailable' };

    if (!result.success) {
      alert('❌ Reset Cancelled: Could not create pre-reset safety snapshot (' + (result.error || 'Storage error') + '). Student records have not been modified.');
      return;
    }

    saveProgress();
    loadQuestion(currentIndex);
    renderExamLobbyHistory();
    if (!document.getElementById('view-analytics').classList.contains('hidden')) {
      renderAnalytics();
    }
  }
}

function switchTab(tab) {
  ['practice', 'exam', 'analytics', 'bank'].forEach(t => {
    const viewEl = document.getElementById(`view-${t}`);
    const tabEl = document.getElementById(`tab-${t}`);
    if (viewEl) viewEl.classList.add('hidden');
    if (tabEl) tabEl.className = 'tab-link';
  });

  const activeView = document.getElementById(`view-${tab}`);
  const activeTab = document.getElementById(`tab-${tab}`);
  if (activeView) activeView.classList.remove('hidden');
  if (activeTab) activeTab.className = 'tab-link tab-active is-active';

  if (tab === 'exam') {
    renderExamLobbyHistory();
  } else if (tab === 'analytics') {
    progress = safeGetStorage('psat_progress', {});
    srsState = safeGetStorage('psat_srs', {});
    renderAnalytics();
    if (Object.keys(progress).length === 0 && typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.pullFromCloud) {
      manualTriggerCloudSync(false);
    }
  } else if (tab === 'bank') {
    renderBankTable();
  }
  lucide.createIcons();
}

function setViewMode(mode) {
  const q = filteredQuestions[currentIndex];
  if (mode === 'text' && q && q.text_complete === false) {
    alert('Inline formulas for this question are preserved in the Official Visual Card view.');
    return;
  }

  viewMode = mode;
  const btnCard = document.getElementById('btn-view-card');
  const btnText = document.getElementById('btn-view-text');
  const visualContainer = document.getElementById('q-visual-container');
  const textContainer = document.getElementById('q-text-container');

  // The card/text toggle buttons and the text container were removed in the
  // UI simplification pass (7b22ff6); guard every read so this never throws.
  if (mode === 'card') {
    if (btnCard) btnCard.className = 'btn btn-sm btn-primary is-active';
    if (btnText) btnText.className = 'btn btn-sm btn-ghost text-slate-600';
    if (visualContainer) visualContainer.classList.remove('hidden');
    if (textContainer) textContainer.classList.add('hidden');
  } else {
    if (btnText) btnText.className = 'btn btn-sm btn-primary is-active';
    if (btnCard) btnCard.className = 'btn btn-sm btn-ghost text-slate-600';
    if (visualContainer) visualContainer.classList.add('hidden');
    if (textContainer) textContainer.classList.remove('hidden');
  }
  lucide.createIcons();
}

function applyFilters() {
  const subject = document.getElementById('filter-subject').value;
  const difficulty = document.getElementById('filter-difficulty').value;
  const status = document.getElementById('filter-status').value;
  const now = Date.now();

  filteredQuestions = questions.filter(q => {
    if (subject !== 'all' && q.test !== subject) return false;
    if (difficulty !== 'all' && q.difficulty !== difficulty) return false;
    
    const qProg = progress[q.id];
    const card = srsState[q.id];

    if (status === 'due') {
      if (!card || card.dueAt > now) return false;
    } else if (status === 'unanswered' && qProg?.answered) {
      return false;
    } else if (status === 'incorrect' && (!qProg?.answered || qProg?.isCorrect)) {
      return false;
    } else if (status === 'flagged' && (!qProg || !qProg.isFlagged)) {
      return false;
    }

    return true;
  });

  currentIndex = 0;
  palettePage = 0;
  renderPalette();
  if (filteredQuestions.length > 0) {
    loadQuestion(0);
  } else {
    document.getElementById('q-index-badge').innerText = '0 Questions';
    document.getElementById('q-id-badge').innerText = 'No match';
    document.getElementById('options-container').innerHTML = '<p class="text-sm text-slate-500 italic p-4">No questions matched the selected filters.</p>';
  }
}

function loadQuestion(idx) {
  if (filteredQuestions.length === 0) return;
  currentIndex = Math.max(0, Math.min(idx, filteredQuestions.length - 1));
  const q = filteredQuestions[currentIndex];
  const qProg = progress[q.id] || {};
  const card = srsState[q.id];

  // Start timing if unanswered
  if (!qProg.answered) {
    questionShownAt = Date.now();
    accumulatedForegroundTimeMs = 0;
    lastVisibilityTimestamp = Date.now();
  } else {
    questionShownAt = null;
  }

  // Palette page synchronization
  palettePage = Math.floor(currentIndex / PALETTE_PAGE_SIZE);

  // Badges
  document.getElementById('q-index-badge').innerText = `Q${currentIndex + 1} of ${filteredQuestions.length}`;
  document.getElementById('q-id-badge').innerText = `ID: ${q.id}`;
  document.getElementById('q-domain-badge').innerText = q.domain || 'Domain';
  document.getElementById('q-skill-badge').innerText = q.skill || 'Skill';
  
  const diffBadge = document.getElementById('q-diff-badge');
  diffBadge.innerText = q.difficulty;
  diffBadge.className = q.difficulty === 'Easy' ? 'px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-700' :
                       (q.difficulty === 'Medium' ? 'px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-700' : 'px-2 py-0.5 text-xs font-semibold rounded-full bg-rose-100 text-rose-700');

  document.getElementById('side-skill-name').innerText = q.skill;
  document.getElementById('side-skill-desc').innerText = `Domain: ${q.domain} (${q.test})`;

  const flagBtn = document.getElementById('btn-flag');
  if (qProg.isFlagged) {
    flagBtn.className = 'p-1.5 text-amber-500 bg-amber-50 rounded-lg transition-colors ml-2';
  } else {
    flagBtn.className = 'p-1.5 text-slate-400 hover:text-amber-500 hover:bg-amber-50 rounded-lg transition-colors ml-2';
  }

  // SRS badge
  const srsBadge = document.getElementById('srs-status-badge');
  if (card) {
    const isDue = card.dueAt <= Date.now();
    srsBadge.innerText = `SRS: Reps ${card.repetitions} · Interval ${card.intervalDays}d ${isDue ? '(Due Now)' : ''}`;
    srsBadge.className = isDue ? 'text-xs font-semibold px-2 py-0.5 rounded bg-rose-100 text-rose-800' : 'text-xs font-semibold px-2 py-0.5 rounded bg-indigo-100 text-indigo-800';
  } else {
    srsBadge.innerText = 'SRS: New Card';
    srsBadge.className = 'text-xs font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-600';
  }

  // Visual Image
  const imgPath = questionImageSrc(q);
  document.getElementById('q-image').src = imgPath;

  // Text View Warnings (#text-mode-warning was removed in 7b22ff6 -- guard it)
  const textWarning = document.getElementById('text-mode-warning');
  if (q.text_complete === false) {
    if (textWarning) textWarning.classList.remove('hidden');
    if (viewMode === 'text') setViewMode('card');
  } else {
    if (textWarning) textWarning.classList.add('hidden');
  }

  // Text Body (#q-text-body was removed in 7b22ff6 -- guard it)
  const textBody = document.getElementById('q-text-body');
  if (textBody) textBody.innerText = q.question_text || 'Stimulus formulas displayed in Visual Card view.';

  // Mismatch Notice (#mismatch-notice was removed in 7b22ff6 -- guard it)
  const mismatchNotice = document.getElementById('mismatch-notice');
  if (mismatchNotice) {
    if (q.rationale_letter_mismatch) {
      mismatchNotice.classList.remove('hidden');
    } else {
      mismatchNotice.classList.add('hidden');
    }
  }

  // Options vs Free Response
  const optContainer = document.getElementById('options-container');
  const frContainer = document.getElementById('free-response-container');
  const frInput = document.getElementById('free-response-input');

  optContainer.innerHTML = '';
  frInput.value = '';

  if (q.type === 'multiple_choice') {
    optContainer.classList.remove('hidden');
    frContainer.classList.add('hidden');

    q.options.forEach(opt => {
      const btn = document.createElement('button');
      let stateStyle = 'border-slate-200 hover:border-indigo-300 bg-white text-slate-800';
      if (qProg.answered) {
        if (opt.key === q.correct_answer) {
          stateStyle = 'border-emerald-500 bg-emerald-50 text-emerald-950 font-semibold';
        } else if (opt.key === qProg.selectedAnswer) {
          stateStyle = 'border-rose-500 bg-rose-50 text-rose-950';
        } else {
          stateStyle = 'border-slate-200 opacity-60 bg-white';
        }
      }

      btn.className = `w-full text-left p-4 rounded-xl border-2 transition-all flex items-start space-x-3 ${stateStyle}`;
      
      const keySpan = document.createElement('span');
      keySpan.className = 'w-7 h-7 rounded-lg bg-slate-100 border border-slate-300 font-bold text-xs flex items-center justify-center flex-shrink-0 text-slate-700';
      keySpan.textContent = opt.key;

      const textSpan = document.createElement('span');
      textSpan.className = 'text-sm pt-0.5 leading-relaxed';
      textSpan.textContent = opt.text;

      btn.appendChild(keySpan);
      btn.appendChild(textSpan);

      if (!qProg.answered) {
        btn.onclick = () => selectMultipleChoice(opt.key);
      }
      optContainer.appendChild(btn);
    });
  } else {
    optContainer.classList.add('hidden');
    frContainer.classList.remove('hidden');
    if (qProg.answered) {
      frInput.value = qProg.selectedAnswer || '';
      frInput.disabled = true;
    } else {
      frInput.disabled = false;
    }
  }

  // Feedback & Rationale
  const feedbackBanner = document.getElementById('feedback-banner');
  const rationaleContainer = document.getElementById('rationale-container');
  const rationaleBody = document.getElementById('rationale-body');
  showExplainerLink(q.id);

  if (qProg.answered) {
    feedbackBanner.classList.remove('hidden');
    const acceptedDisplay = q.type === 'free_response' ? PSAT_ENGINE.formatAcceptedAnswers(q.correct_answer) : q.correct_answer;
    const timeSec = (qProg.timingReliable !== false && typeof qProg.timeSpentMs === 'number') ? ` (${Math.round(qProg.timeSpentMs / 1000)}s)` : '';

    if (qProg.isCorrect) {
      feedbackBanner.className = 'p-4 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900';
      document.getElementById('feedback-icon').innerHTML = `<i data-lucide="check-circle" class="w-6 h-6 text-emerald-600"></i>`;
      document.getElementById('feedback-title').innerText = `Correct!${timeSec}`;
      document.getElementById('feedback-desc').innerText = `Your answer: ${qProg.selectedAnswer}`;
    } else {
      feedbackBanner.className = 'p-4 rounded-xl border border-rose-200 bg-rose-50 text-rose-900';
      document.getElementById('feedback-icon').innerHTML = `<i data-lucide="x-circle" class="w-6 h-6 text-rose-600"></i>`;
      document.getElementById('feedback-title').innerText = `Incorrect${timeSec}`;
      document.getElementById('feedback-desc').innerText = `Your answer: ${qProg.selectedAnswer} | Correct: ${acceptedDisplay}`;
    }

    rationaleContainer.classList.remove('hidden');
    if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.renderRationale) {
      rationaleBody.innerHTML = PSAT_ENGINE.renderRationale(q, { userSelectedAnswer: qProg.selectedAnswer });
    } else {
      rationaleBody.innerText = q.rationale || 'No rationale available.';
    }
  } else {
    feedbackBanner.classList.add('hidden');
    rationaleContainer.classList.add('hidden');
  }

  document.getElementById('btn-prev').disabled = (currentIndex === 0);
  document.getElementById('btn-next').disabled = (currentIndex === filteredQuestions.length - 1);

  renderPalette();
  lucide.createIcons();
}

function recordAttempt(selectedAnswer, isCorrect) {
  const q = filteredQuestions[currentIndex];
  
  // Calculate elapsed time
  let timeSpentMs = null;
  let timingReliable = false;

  if (questionShownAt !== null) {
    const currentForeground = document.hidden ? 0 : (Date.now() - lastVisibilityTimestamp);
    const totalRaw = accumulatedForegroundTimeMs + currentForeground;
    if (totalRaw < 600000 && totalRaw > 500) {
      timeSpentMs = totalRaw;
      timingReliable = true;
    }
  }

  const prevProg = progress[q.id] || {};
  const prevTimesSeen = prevProg.timesSeen || (prevProg.answered ? 1 : 0);
  const prevTimesCorrect = prevProg.timesCorrect || (prevProg.answered && prevProg.isCorrect ? 1 : 0);
  const prevTimesIncorrect = prevProg.timesIncorrect || (prevProg.answered && !prevProg.isCorrect ? 1 : 0);
  const prevAttempts = Array.isArray(prevProg.attempts) ? prevProg.attempts.slice() : [];

  const newTimesSeen = prevTimesSeen + 1;
  const newTimesCorrect = prevTimesCorrect + (isCorrect ? 1 : 0);
  const newTimesIncorrect = prevTimesIncorrect + (isCorrect ? 0 : 1);

  prevAttempts.push({
    at: Date.now(),
    selectedAnswer: selectedAnswer,
    isCorrect: isCorrect,
    timeSpentMs: timeSpentMs,
    source: 'practice'
  });

  const prevErrorTag = prevProg.errorTag || null;
  let historicalErrorTags = Array.isArray(prevProg.historicalErrorTags) ? prevProg.historicalErrorTags.slice() : [];
  if (prevErrorTag && isCorrect && !historicalErrorTags.some(h => h.tag === prevErrorTag)) {
    historicalErrorTags.push({ tag: prevErrorTag, resolvedAt: Date.now() });
  }

  progress[q.id] = {
    answered: true,
    selectedAnswer: selectedAnswer,
    isCorrect: isCorrect,
    timeSpentMs: timeSpentMs,
    timingReliable: timingReliable,
    timestamp: Date.now(),
    isFlagged: prevProg.isFlagged || false,
    errorTag: isCorrect ? null : (prevProg.errorTag || null),
    historicalErrorTags: historicalErrorTags,
    timesSeen: newTimesSeen,
    timesCorrect: newTimesCorrect,
    timesIncorrect: newTimesIncorrect,
    accuracyPercent: Math.round((newTimesCorrect / newTimesSeen) * 100),
    attempts: prevAttempts.slice(-3)
  };

  // Spaced Repetition SM-2 Update
  const grade = PSAT_ENGINE.gradeAttempt(isCorrect, timeSpentMs, timingReliable);
  const existingCard = srsState[q.id] || { questionId: q.id, repetitions: 0, intervalDays: 1, easeFactor: 2.5, history: [] };
  srsState[q.id] = PSAT_ENGINE.scheduleNext(existingCard, grade, Date.now(), timeSpentMs);

  // Update Daily Session Log
  sessionsState = PSAT_ENGINE.recordDailySession(sessionsState, isCorrect, timeSpentMs, null, timingReliable);

  // Durable Outbox Op Enqueue
  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.enqueueOutboxOp) {
    PSAT_ENGINE.enqueueOutboxOp(localStorage, 'question_attempt', {
      questionId: q.id,
      selectedAnswer: selectedAnswer,
      isCorrect: isCorrect,
      timeSpentMs: timeSpentMs,
      timestamp: Date.now()
    }, window.location);
  }

  saveProgress();
  loadQuestion(currentIndex);
}

function selectMultipleChoice(selectedKey) {
  const q = filteredQuestions[currentIndex];
  const isCorrect = (selectedKey.toUpperCase() === q.correct_answer.toUpperCase());
  recordAttempt(selectedKey, isCorrect);
}

function submitFreeResponse() {
  const q = filteredQuestions[currentIndex];
  const inputVal = document.getElementById('free-response-input').value.trim();
  if (!inputVal) {
    alert('Please enter an answer before submitting.');
    return;
  }
  const isCorrect = PSAT_ENGINE.gradeFreeResponse(inputVal, q.correct_answer);
  recordAttempt(inputVal, isCorrect);
}

function toggleFlagCurrentQuestion() {
  const q = filteredQuestions[currentIndex];
  if (!progress[q.id]) {
    progress[q.id] = { answered: false, isFlagged: true };
  } else {
    progress[q.id].isFlagged = !progress[q.id].isFlagged;
  }
  saveProgress();
  loadQuestion(currentIndex);
}

function reportCurrentQuestionIssue() {
  const q = filteredQuestions[currentIndex];
  if (q) {
    window.open('feedback.html?qid=' + encodeURIComponent(q.id), '_blank');
  }
}

function toggleRationale() {
  const body = document.getElementById('rationale-body');
  const arrow = document.getElementById('rationale-arrow');
  if (body.classList.contains('hidden')) {
    body.classList.remove('hidden');
    arrow.style.transform = 'rotate(0deg)';
  } else {
    body.classList.add('hidden');
    arrow.style.transform = 'rotate(-90deg)';
  }
}

function nextQuestion() {
  if (currentIndex < filteredQuestions.length - 1) {
    loadQuestion(currentIndex + 1);
  }
}

function prevQuestion() {
  if (currentIndex > 0) {
    loadQuestion(currentIndex - 1);
  }
}

// Palette Pagination
function nextPalettePage() {
  if ((palettePage + 1) * PALETTE_PAGE_SIZE < filteredQuestions.length) {
    palettePage++;
    renderPalette();
  }
}

function prevPalettePage() {
  if (palettePage > 0) {
    palettePage--;
    renderPalette();
  }
}

function renderPalette() {
  const palette = document.getElementById('palette-grid');
  palette.innerHTML = '';
  
  let doneCount = 0;
  filteredQuestions.forEach(q => {
    if (progress[q.id]?.answered) doneCount++;
  });
  document.getElementById('palette-stats').innerText = `${doneCount}/${filteredQuestions.length} Done`;

  const start = palettePage * PALETTE_PAGE_SIZE;
  const end = Math.min(start + PALETTE_PAGE_SIZE, filteredQuestions.length);
  document.getElementById('pal-page-indicator').innerText = `${start + 1} - ${end}`;
  document.getElementById('btn-pal-prev').disabled = (palettePage === 0);
  document.getElementById('btn-pal-next').disabled = (end >= filteredQuestions.length);

  for (let idx = start; idx < end; idx++) {
    const q = filteredQuestions[idx];
    const qProg = progress[q.id];
    const btn = document.createElement('button');
    
    let colorClass = 'bg-slate-100 text-slate-700 hover:bg-slate-200 border-slate-300';
    if (qProg && qProg.answered) {
      colorClass = qProg.isCorrect ? 'bg-emerald-500 text-white font-bold' : 'bg-rose-500 text-white font-bold';
    }

    if (idx === currentIndex) {
      colorClass += ' ring-2 ring-indigo-600 ring-offset-2';
    }

    if (qProg && qProg.isFlagged) {
      colorClass += ' border-2 border-amber-400';
    }

    btn.className = `h-9 rounded-xl font-bold text-xs flex items-center justify-center border transition-all ${colorClass}`;
    btn.textContent = `${idx + 1}${qProg?.isFlagged ? ' ★' : ''}`;
    btn.onclick = () => loadQuestion(idx);
    palette.appendChild(btn);
  }
}

function updateHeaderStats() {
  progress = safeGetStorage('psat_progress', {});
  const total = questions.length;
  let attempted = 0;
  let correct = 0;

  questions.forEach(q => {
    const p = progress[q.id];
    if (p && p.answered) {
      attempted++;
      if (p.isCorrect) correct++;
    }
  });

  const acc = attempted > 0 ? Math.round((correct / attempted) * 100) : 0;
  // #hdr-attempted / #hdr-accuracy were removed from the header in 7b22ff6 --
  // guard them so this never aborts renderAnalytics() or saveProgress().
  const hdrAttempted = document.getElementById('hdr-attempted');
  if (hdrAttempted) hdrAttempted.innerText = `${attempted}/${total}`;
  const hdrAccuracy = document.getElementById('hdr-accuracy');
  if (hdrAccuracy) hdrAccuracy.innerText = `${acc}%`;

  document.getElementById('stat-attempted').innerText = `${attempted} / ${total}`;
  document.getElementById('stat-accuracy').innerText = `${acc}%`;
  checkDemoModeBanner();
}

// Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
  if (!document.getElementById('view-practice').classList.contains('hidden')) {
    if (['input', 'textarea'].includes(document.activeElement.tagName.toLowerCase())) return;

    const key = e.key.toUpperCase();
    if (['A', 'B', 'C', 'D'].includes(key)) {
      const q = filteredQuestions[currentIndex];
      if (q && q.type === 'multiple_choice' && !progress[q.id]?.answered) {
        selectMultipleChoice(key);
      }
    } else if (e.key === 'ArrowRight') {
      nextQuestion();
    } else if (e.key === 'ArrowLeft') {
      prevQuestion();
    }
  }
});

// ================= Analytics Rendering =================
function renderAnalytics() {
  progress = safeGetStorage('psat_progress', {});
  srsState = safeGetStorage('psat_srs', {});
  sessionsState = safeGetStorage('psat_sessions', {});
  updateHeaderStats();
  const skillStats = {};
  const domainStats = {};
  const diffStats = { Easy: { c: 0, t: 0 }, Medium: { c: 0, t: 0 }, Hard: { c: 0, t: 0 } };
  let flaggedCount = 0;

  questions.forEach(q => {
    const p = progress[q.id];
    if (p && p.isFlagged) flaggedCount++;

    if (!domainStats[q.domain]) domainStats[q.domain] = { c: 0, t: 0, total: 0 };
    domainStats[q.domain].total++;

    if (!skillStats[q.skill]) skillStats[q.skill] = { domain: q.domain, c: 0, t: 0, total: 0 };
    skillStats[q.skill].total++;

    if (!diffStats[q.difficulty]) diffStats[q.difficulty] = { c: 0, t: 0 };

    if (p && p.answered) {
      domainStats[q.domain].t++;
      skillStats[q.skill].t++;
      diffStats[q.difficulty].t++;
      if (p.isCorrect) {
        domainStats[q.domain].c++;
        skillStats[q.skill].c++;
        diffStats[q.difficulty].c++;
      }
    }
  });

  document.getElementById('stat-flagged').innerText = flaggedCount;

  const strengthsList = document.getElementById('strengths-list');
  const weaknessesList = document.getElementById('weaknesses-list');
  const inprogressList = document.getElementById('inprogress-list');
  strengthsList.innerHTML = '';
  weaknessesList.innerHTML = '';
  inprogressList.innerHTML = '';

  let topWeakness = null;
  let minAcc = 999;

  Object.entries(skillStats).forEach(([skill, data]) => {
    const acc = data.t > 0 ? Math.round((data.c / data.t) * 100) : null;
    const item = document.createElement('div');
    item.className = 'p-3.5 rounded-xl border border-slate-100 bg-slate-50 flex items-center justify-between';
    
    const badge = acc === null ? 
      `<span class="text-xs font-semibold px-2 py-1 rounded bg-slate-200 text-slate-700">Unattempted</span>` :
      `<span class="text-xs font-bold px-2 py-1 rounded ${acc >= 75 ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">${acc}% (${data.c}/${data.t})</span>`;

    item.innerHTML = `
      <div>
        <h4 class="text-sm font-bold text-slate-900">${esc(skill)}</h4>
        <p class="text-xs text-slate-500">${esc(data.domain)} &bull; ${data.total} Questions</p>
      </div>
      <div>${badge}</div>
    `;

    if (acc === null) {
      // Unattempted
    } else if (data.t < 3) {
      // In progress (< 3 attempts) regardless of accuracy
      inprogressList.appendChild(item);
    } else if (acc >= 75) {
      // Mastered (>= 3 attempts and >= 75% accuracy)
      strengthsList.appendChild(item);
    } else {
      // Focus Areas (< 75% accuracy and >= 3 attempts)
      weaknessesList.appendChild(item);
      if (acc < minAcc) {
        minAcc = acc;
        topWeakness = `${skill} (${acc}%)`;
      }
    }
  });

  if (strengthsList.children.length === 0) {
    strengthsList.innerHTML = `<p class="text-sm text-slate-400 italic py-2">No mastered skills yet (min 3 attempts at ≥75%).</p>`;
  }
  if (weaknessesList.children.length === 0) {
    weaknessesList.innerHTML = `<p class="text-sm text-slate-400 italic py-2">No weak areas identified yet (min 3 attempts at &lt;75%).</p>`;
  }
  if (inprogressList.children.length === 0) {
    inprogressList.innerHTML = `<p class="text-sm text-slate-400 italic py-2">No skills currently in progress (&lt;3 attempts).</p>`;
  }

  document.getElementById('stat-weakness').innerText = topWeakness || 'None yet';
  renderCharts(domainStats, diffStats);
}

function renderCharts(domainStats, diffStats) {
  if (typeof Chart === 'undefined') {
    console.warn('Chart.js library not loaded; charts omitted.');
    return;
  }
  const dLabels = Object.keys(domainStats);
  const dAccuracies = dLabels.map(k => {
    const d = domainStats[k];
    return d.t > 0 ? Math.round((d.c / d.t) * 100) : 0;
  });

  if (domainChartInstance) domainChartInstance.destroy();
  const ctxDomain = document.getElementById('domainChart').getContext('2d');
  domainChartInstance = new Chart(ctxDomain, {
    type: 'bar',
    data: {
      labels: dLabels,
      datasets: [{
        label: 'Accuracy %',
        data: dAccuracies,
        backgroundColor: '#4f46e5',
        borderRadius: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, max: 100 } }
    }
  });

  const diffLabels = ['Easy', 'Medium', 'Hard'];
  const diffAccuracies = diffLabels.map(k => {
    const d = diffStats[k];
    return d.t > 0 ? Math.round((d.c / d.t) * 100) : 0;
  });

  if (difficultyChartInstance) difficultyChartInstance.destroy();
  const ctxDiff = document.getElementById('difficultyChart').getContext('2d');
  difficultyChartInstance = new Chart(ctxDiff, {
    type: 'bar',
    data: {
      labels: diffLabels,
      datasets: [{
        label: 'Accuracy %',
        data: diffAccuracies,
        backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
        borderRadius: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, max: 100 } }
    }
  });
}

// ================= Bank Table Rendering =================
function nextBankPage() {
  if ((bankPage + 1) * BANK_PAGE_SIZE < searchedBankQuestions.length) {
    bankPage++;
    renderBankTable();
  }
}

function prevBankPage() {
  if (bankPage > 0) {
    bankPage--;
    renderBankTable();
  }
}

function filterBankTable() {
  const query = document.getElementById('bank-search').value.toLowerCase();
  searchedBankQuestions = questions.filter(q => {
    return q.id.toLowerCase().includes(query) ||
           (q.domain && q.domain.toLowerCase().includes(query)) ||
           (q.skill && q.skill.toLowerCase().includes(query)) ||
           (q.question_text && q.question_text.toLowerCase().includes(query));
  });
  bankPage = 0;
  renderBankTable();
}

function renderBankTable() {
  const tbody = document.getElementById('bank-table-body');
  tbody.innerHTML = '';

  const start = bankPage * BANK_PAGE_SIZE;
  const end = Math.min(start + BANK_PAGE_SIZE, searchedBankQuestions.length);
  document.getElementById('bank-page-info').innerText = `Showing ${start + 1}-${end} of ${searchedBankQuestions.length}`;
  document.getElementById('btn-bank-prev').disabled = (bankPage === 0);
  document.getElementById('btn-bank-next').disabled = (end >= searchedBankQuestions.length);

  for (let i = start; i < end; i++) {
    const q = searchedBankQuestions[i];
    const qProg = progress[q.id];
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50 transition-colors';

    let statusBadge = '<span class="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-xs">Unanswered</span>';
    if (qProg && qProg.answered) {
      statusBadge = qProg.isCorrect ? 
        '<span class="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded font-semibold text-xs">Correct</span>' :
        '<span class="px-2 py-0.5 bg-rose-100 text-rose-800 rounded font-semibold text-xs">Incorrect</span>';
    }

    const answerDisplay = q.type === 'free_response' ? PSAT_ENGINE.formatAcceptedAnswers(q.correct_answer) : q.correct_answer;

    tr.innerHTML = `
      <td class="px-4 py-3 font-mono text-xs font-bold text-slate-900">${esc(q.id)}</td>
      <td class="px-4 py-3 text-xs font-medium text-slate-700">${esc(q.test)}</td>
      <td class="px-4 py-3 text-xs text-slate-600">${esc(q.domain)}</td>
      <td class="px-4 py-3 text-xs font-semibold text-slate-800">${esc(q.skill)}</td>
      <td class="px-4 py-3 text-xs"><span class="px-2 py-0.5 rounded text-xs font-semibold ${q.difficulty === 'Easy' ? 'bg-emerald-100 text-emerald-700' : (q.difficulty === 'Medium' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700')}">${esc(q.difficulty)}</span></td>
      <td class="px-4 py-3 text-xs text-slate-500 capitalize">${esc(q.type.replace('_', ' '))}</td>
      <td class="px-4 py-3 font-mono text-xs font-bold text-indigo-700">${esc(answerDisplay)}</td>
      <td class="px-4 py-3 text-xs">${statusBadge}</td>
      <td class="px-4 py-3 text-right" id="action-cell-${i}"></td>
    `;

    tbody.appendChild(tr);

    // Safe DOM event binding for Practice button
    const actionTd = tr.querySelector(`#action-cell-${i}`);
    const practiceBtn = document.createElement('button');
    practiceBtn.className = 'btn btn-sm btn-primary';
    practiceBtn.textContent = 'Practice';
    practiceBtn.onclick = () => jumpToQuestion(q.id);
    actionTd.appendChild(practiceBtn);
  }
}

function jumpToQuestion(qid) {
  document.getElementById('filter-subject').value = 'all';
  document.getElementById('filter-difficulty').value = 'all';
  document.getElementById('filter-status').value = 'all';
  applyFilters();

  const targetIdx = filteredQuestions.findIndex(q => q.id === qid);
  if (targetIdx !== -1) {
    switchTab('practice');
    loadQuestion(targetIdx);
  }
}

// ============================================================
// OFFICIAL PSAT 8/9 EXAM & ADAPTIVE TEST RUNNER ENGINE
// ============================================================
let activeExam = null;
let currentModuleIndex = 0;
let currentExamQIndex = 0;
let examUserAnswers = {};
let examUserTimes = {};
let examMarkedForReview = {};
let examModuleTimerSeconds = 0;
let examTimerInterval = null;
let breakTimerInterval = null;
let examQuestionShownAt = null;
let examTimerHidden = false;
let examViewMode = 'card';
let currentExamReport = null;
let reportFilterMode = 'all';

function showExamSubview(subviewId) {
  ['exam-lobby', 'exam-active', 'exam-module-review', 'exam-break', 'exam-report'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  const target = document.getElementById(subviewId);
  if (target) target.classList.remove('hidden');
  lucide.createIcons();
}

function startStandardExam(opts) {
  const mergedOpts = Object.assign({ progressMap: progress }, opts || {});
  activeExam = PSAT_ENGINE.generateStandardPSAT89Exam(questions, mergedOpts);
  initExamSession();
}

function startMiniExam(opts) {
  const mergedOpts = Object.assign({ progressMap: progress }, opts || {});
  activeExam = PSAT_ENGINE.generateMiniPSAT89Exam(questions, mergedOpts);
  initExamSession();
}

function startGapDrillFromLobby() {
  const drill = PSAT_ENGINE.generateGapTargetedDrill(questions, progress, srsState, { count: 20 });
  startCustomTestDirect(drill);
}

function startSectionTest(testType) {
  const isMath = (testType === 'Math');
  const pool = questions.filter(q => q.test === testType);
  const shuffled = PSAT_ENGINE._shuffle(pool);

  let modules = [];
  if (!isMath) {
    modules = [
      { id: 'rw_m1', section: 'Reading and Writing', moduleNumber: 1, name: 'Reading and Writing — Module 1', questionsCount: 27, timeLimitSeconds: 32 * 60, questions: shuffled.slice(0, 27) },
      { id: 'rw_m2', section: 'Reading and Writing', moduleNumber: 2, name: 'Reading and Writing — Module 2', questionsCount: 27, timeLimitSeconds: 32 * 60, questions: shuffled.slice(27, 54) }
    ];
  } else {
    const mcqs = shuffled.filter(q => (q.type || q.question_type) !== 'free_response');
    const sprs = shuffled.filter(q => (q.type || q.question_type) === 'free_response');
    modules = [
      { id: 'math_m1', section: 'Math', moduleNumber: 1, name: 'Math — Module 1', questionsCount: 22, timeLimitSeconds: 35 * 60, questions: PSAT_ENGINE._shuffle(mcqs.slice(0, 17).concat(sprs.slice(0, 5))) },
      { id: 'math_m2', section: 'Math', moduleNumber: 2, name: 'Math — Module 2', questionsCount: 22, timeLimitSeconds: 35 * 60, questions: PSAT_ENGINE._shuffle(mcqs.slice(17, 34).concat(sprs.slice(5, 10))) }
    ];
  }

  activeExam = {
    id: 'section_test_' + Date.now(),
    title: `${testType} Section Test`,
    type: 'section_test',
    totalQuestions: isMath ? 44 : 54,
    totalTimeMinutes: isMath ? 70 : 64,
    breakMinutes: 0,
    createdAt: Date.now(),
    modules: modules
  };

  initExamSession();
}

function startCustomTestDirect(customTestData) {
  activeExam = {
    id: customTestData.id || 'custom_' + Date.now(),
    title: customTestData.title || 'Custom Practice Test',
    type: customTestData.type || 'custom_test',
    totalQuestions: customTestData.questions.length,
    totalTimeMinutes: customTestData.timeLimitMinutes || 30,
    breakMinutes: 0,
    createdAt: Date.now(),
    modules: [
      {
        id: 'custom_m1',
        section: customTestData.questions[0]?.test || 'Practice',
        moduleNumber: 1,
        name: customTestData.title || 'Custom Test Module',
        questionsCount: customTestData.questions.length,
        timeLimitSeconds: (customTestData.isUntimed ? 999999 : (customTestData.timeLimitMinutes || 30) * 60),
        questions: customTestData.questions
      }
    ]
  };

  initExamSession();
}

let examModuleDeadline = 0;
let examModuleExpired = false;
let examFiveMinAlertShown = false;

function showExamToast(msg) {
  let toast = document.getElementById('exam-toast-banner');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'exam-toast-banner';
    toast.className = 'fixed top-5 left-1/2 transform -translate-x-1/2 z-50 px-6 py-3 bg-slate-900 text-white text-sm font-bold rounded-2xl shadow-2xl border border-slate-700 flex items-center space-x-2 transition-all duration-300';
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<i data-lucide="bell" class="w-4 h-4 text-amber-400 mr-2"></i> ${esc(msg)}`;
  toast.classList.remove('hidden');
  lucide.createIcons();
  setTimeout(() => {
    if (toast) toast.classList.add('hidden');
  }, 4500);
}

function initExamSession() {
  currentModuleIndex = 0;
  currentExamQIndex = 0;
  examUserAnswers = {};
  examUserTimes = {};
  examMarkedForReview = {};
  switchTab('exam');
  loadExamModule(0);
}

function flushExamQuestionTime() {
  if (examQuestionShownAt !== null && activeExam && activeExam.modules[currentModuleIndex]) {
    const curQ = activeExam.modules[currentModuleIndex].questions[currentExamQIndex];
    if (curQ) {
      const elapsed = Date.now() - examQuestionShownAt;
      if (elapsed > 0) {
        examUserTimes[curQ.id] = (examUserTimes[curQ.id] || 0) + elapsed;
      }
    }
    examQuestionShownAt = Date.now();
  }
}

function loadExamModule(modIdx) {
  if (examTimerInterval) clearInterval(examTimerInterval);
  currentModuleIndex = modIdx;
  currentExamQIndex = 0;
  examModuleExpired = false;
  examFiveMinAlertShown = false;

  const mod = activeExam.modules[currentModuleIndex];
  examModuleTimerSeconds = mod.timeLimitSeconds;
  examModuleDeadline = Date.now() + (mod.timeLimitSeconds * 1000);

  document.getElementById('exam-active-module-title').innerText = mod.name;

  // Start module countdown based on wall-clock deadline
  updateExamTimerDisplay();
  examTimerInterval = setInterval(() => {
    const remainingMs = examModuleDeadline - Date.now();
    examModuleTimerSeconds = Math.max(0, Math.round(remainingMs / 1000));
    updateExamTimerDisplay();

    if (examModuleTimerSeconds <= 300 && !examFiveMinAlertShown && examModuleTimerSeconds > 0) {
      examFiveMinAlertShown = true;
      showExamToast('5 Minutes Remaining in this module!');
    }

    if (examModuleTimerSeconds <= 0) {
      clearInterval(examTimerInterval);
      examModuleExpired = true;
      flushExamQuestionTime();
      showExamToast('Time has expired for this module! Opening module review.');
      showModuleReviewScreen();
    }
  }, 1000);

  showExamSubview('exam-active');
  loadExamQuestion(0);
}

function updateExamTimerDisplay() {
  const m = Math.floor(examModuleTimerSeconds / 60);
  const s = examModuleTimerSeconds % 60;
  const str = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  const el = document.getElementById('exam-timer-display');
  if (el) el.innerText = examTimerHidden ? '—:—' : str;
}

function toggleExamTimerVisibility() {
  examTimerHidden = !examTimerHidden;
  document.getElementById('btn-toggle-timer').innerText = examTimerHidden ? 'Show' : 'Hide';
  updateExamTimerDisplay();
}

function loadExamQuestion(qIdx) {
  flushExamQuestionTime();
  examQuestionShownAt = Date.now();

  currentExamQIndex = qIdx;
  const mod = activeExam.modules[currentModuleIndex];
  const q = mod.questions[currentExamQIndex];

  document.getElementById('exam-active-q-pos').innerText = `Question ${qIdx + 1} of ${mod.questions.length}`;
  document.getElementById('exam-q-badge').innerText = `Q${qIdx + 1}`;
  document.getElementById('exam-q-domain').innerText = `${q.domain} • ${q.skill}`;

  // Mark for Review Checkbox
  document.getElementById('exam-mark-review').checked = !!examMarkedForReview[q.id];

  // Question body
  const imgPath = questionImageSrc(q);
  document.getElementById('exam-q-image').src = imgPath;
  document.getElementById('exam-q-prompt').innerText = q.question_text || q.prompt || 'View official question card above.';

  // Input controls: MCQ vs Free Response
  const isFreeResponse = ((q.type || q.question_type) === 'free_response');
  const mcqContainer = document.getElementById('exam-mcq-options');
  const sprContainer = document.getElementById('exam-spr-container');

  if (isFreeResponse) {
    mcqContainer.classList.add('hidden');
    sprContainer.classList.remove('hidden');
    document.getElementById('exam-spr-input').value = examUserAnswers[q.id] || '';
  } else {
    sprContainer.classList.add('hidden');
    mcqContainer.classList.remove('hidden');
    renderExamMcqOptions(q);
  }

  // Prev / Next button states
  document.getElementById('btn-exam-prev').disabled = (qIdx === 0);
  document.getElementById('btn-exam-prev').className = (qIdx === 0) ? 
    'px-5 py-2 bg-slate-100 text-slate-400 font-bold text-xs rounded-xl cursor-not-allowed' :
    'px-5 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-xs rounded-xl transition-colors';

  const isLastQ = (qIdx === mod.questions.length - 1);
  document.getElementById('btn-exam-next').innerText = isLastQ ? 'Review Module →' : 'Next →';

  renderExamPalettePills();
  setExamViewMode(examViewMode);
  persistActiveExamState();
  lucide.createIcons();
}

function renderExamMcqOptions(q) {
  const container = document.getElementById('exam-mcq-options');
  container.innerHTML = '';
  const selected = examUserAnswers[q.id];

  ['A', 'B', 'C', 'D'].forEach(letter => {
    const isSelected = (selected === letter);
    let optText = `Choice (${letter})`;

    if (Array.isArray(q.options)) {
      const found = q.options.find(o => o.key === letter);
      if (found && found.text) optText = found.text;
    } else if (q.options && q.options[letter]) {
      optText = q.options[letter];
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.onclick = () => selectExamMcqChoice(letter);
    btn.className = isSelected ?
      'p-3.5 rounded-xl border-2 border-indigo-600 bg-indigo-50 text-indigo-900 font-bold text-sm text-left flex items-center transition-all shadow-sm' :
      'p-3.5 rounded-xl border border-slate-200 bg-white hover:border-indigo-300 hover:bg-slate-50 text-slate-800 text-sm text-left flex items-center transition-all';

    btn.innerHTML = `
      <span class="w-7 h-7 rounded-lg ${isSelected ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700'} flex items-center justify-center font-bold text-xs mr-3 shrink-0">${letter}</span>
      <span class="font-medium text-xs sm:text-sm line-clamp-2">${esc(optText)}</span>
    `;
    container.appendChild(btn);
  });
}

function selectExamMcqChoice(choice) {
  const q = activeExam.modules[currentModuleIndex].questions[currentExamQIndex];
  examUserAnswers[q.id] = choice;
  renderExamMcqOptions(q);
  renderExamPalettePills();
  persistActiveExamState();
}

function recordExamSprAnswer(val) {
  const q = activeExam.modules[currentModuleIndex].questions[currentExamQIndex];
  examUserAnswers[q.id] = val.trim();
  renderExamPalettePills();
  persistActiveExamState();
}

function toggleExamMarkForReview() {
  const q = activeExam.modules[currentModuleIndex].questions[currentExamQIndex];
  examMarkedForReview[q.id] = document.getElementById('exam-mark-review').checked;
  renderExamPalettePills();
  persistActiveExamState();
}

function setExamViewMode(mode) {
  examViewMode = mode;
  const visualEl = document.getElementById('exam-q-visual');
  const textEl = document.getElementById('exam-q-text');
  const btnCard = document.getElementById('btn-exam-card');
  const btnText = document.getElementById('btn-exam-text');

  if (mode === 'card') {
    visualEl.classList.remove('hidden');
    textEl.classList.add('hidden');
    btnCard.className = 'btn btn-sm btn-primary is-active';
    btnText.className = 'btn btn-sm btn-ghost text-slate-600';
  } else {
    visualEl.classList.add('hidden');
    textEl.classList.remove('hidden');
    btnText.className = 'btn btn-sm btn-primary is-active';
    btnCard.className = 'btn btn-sm btn-ghost text-slate-600';
  }
}

let examZoomPercentage = 100;

function adjustExamZoom(delta) {
  examZoomPercentage = Math.max(70, Math.min(220, examZoomPercentage + delta));
  applyExamZoom();
}

function resetExamZoom() {
  examZoomPercentage = 100;
  applyExamZoom();
}

function applyExamZoom() {
  const img = document.getElementById('exam-q-image');
  const label = document.getElementById('exam-zoom-label');
  if (label) label.innerText = `${examZoomPercentage}%`;
  if (img) {
    img.style.transform = `scale(${examZoomPercentage / 100})`;
    img.style.transformOrigin = 'top center';
  }
}

function renderExamPalettePills() {
  const container = document.getElementById('exam-palette-pills');
  if (!container) return;
  container.innerHTML = '';
  const mod = activeExam.modules[currentModuleIndex];

  mod.questions.forEach((q, idx) => {
    const isCurrent = (idx === currentExamQIndex);
    const isAnswered = (examUserAnswers[q.id] !== undefined && examUserAnswers[q.id] !== '');
    const isMarked = !!examMarkedForReview[q.id];

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.onclick = () => loadExamQuestion(idx);

    let bg = 'bg-slate-100 text-slate-600';
    if (isCurrent) bg = 'bg-indigo-600 text-white font-bold ring-2 ring-indigo-300';
    else if (isMarked) bg = 'bg-amber-100 text-amber-800 border border-amber-300 font-bold';
    else if (isAnswered) bg = 'bg-indigo-100 text-indigo-800 font-semibold';

    pill.className = `w-7 h-7 rounded-lg text-xs flex items-center justify-center transition-all shrink-0 ${bg}`;
    pill.innerText = idx + 1;
    container.appendChild(pill);
  });
}

function prevExamQuestion() {
  if (currentExamQIndex > 0) {
    loadExamQuestion(currentExamQIndex - 1);
  }
}

function nextExamQuestion() {
  const mod = activeExam.modules[currentModuleIndex];
  if (currentExamQIndex < mod.questions.length - 1) {
    loadExamQuestion(currentExamQIndex + 1);
  } else {
    showModuleReviewScreen();
  }
}

function showModuleReviewScreen() {
  flushExamQuestionTime();
  const mod = activeExam.modules[currentModuleIndex];
  document.getElementById('review-module-heading').innerText = `${mod.name} — Review`;

  let answeredCount = 0;
  let unansweredCount = 0;
  let markedCount = 0;

  const grid = document.getElementById('review-matrix-grid');
  grid.innerHTML = '';

  mod.questions.forEach((q, idx) => {
    const ans = examUserAnswers[q.id];
    const isAnswered = (ans !== undefined && ans !== '');
    const isMarked = !!examMarkedForReview[q.id];

    if (isAnswered) answeredCount++;
    else unansweredCount++;
    if (isMarked) markedCount++;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.onclick = () => {
      if (examModuleExpired) {
        alert('Time for this module has expired. You cannot return to edit questions.');
        return;
      }
      showExamSubview('exam-active');
      loadExamQuestion(idx);
    };

    btn.className = isMarked ?
      'p-3 rounded-xl border-2 border-amber-400 bg-amber-50 text-amber-900 font-bold text-xs flex flex-col items-center justify-center space-y-1 hover:bg-amber-100 transition-all' :
      (isAnswered ?
        'p-3 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-900 font-semibold text-xs flex flex-col items-center justify-center space-y-1 hover:bg-indigo-100 transition-all' :
        'p-3 rounded-xl border border-slate-200 bg-slate-50 text-slate-600 text-xs flex flex-col items-center justify-center space-y-1 hover:bg-slate-100 transition-all');

    btn.innerHTML = `
      <div class="flex items-center justify-between w-full">
        <span class="font-bold">Q${idx + 1}</span>
        ${isMarked ? '<i data-lucide="bookmark" class="w-3.5 h-3.5 text-amber-500"></i>' : ''}
      </div>
      <span class="text-[10px] uppercase font-bold tracking-wider">${isAnswered ? 'Answered' : 'Unanswered'}</span>
    `;
    grid.appendChild(btn);
  });

  document.getElementById('review-answered-count').innerText = answeredCount;
  document.getElementById('review-unanswered-count').innerText = unansweredCount;
  document.getElementById('review-marked-count').innerText = markedCount;

  const isLastModule = (currentModuleIndex === activeExam.modules.length - 1);
  document.getElementById('btn-submit-module').innerText = isLastModule ? 'Submit Exam & View Scores →' : 'Submit Module & Continue →';

  showExamSubview('exam-module-review');
}

function returnToActiveExamQuestion() {
  if (examModuleExpired) {
    alert('Time for this module has expired. You cannot return to edit questions.');
    return;
  }
  showExamSubview('exam-active');
  loadExamQuestion(currentExamQIndex);
}

function submitCurrentExamModule() {
  flushExamQuestionTime();
  const mod = activeExam.modules[currentModuleIndex];
  const unanswered = mod.questions.filter(q => !examUserAnswers[q.id]).length;
  let msg = 'Are you sure you want to submit this module? Once submitted, you cannot return to change answers in this module.';
  if (unanswered > 0) {
    msg = `You have ${unanswered} unanswered question(s) in this module.\n\n` + msg;
  }

  if (!confirm(msg)) return;

  if (examTimerInterval) clearInterval(examTimerInterval);

  // Digital PSAT/SAT Multi-Stage Adaptive Routing (MST)
  if (activeExam && activeExam.isAdaptive && activeExam.adaptivePools) {
    if (activeExam.type === 'standard_psat89' && currentModuleIndex === 0) {
      // Reading & Writing M1 Routing -> Route M2
      let m1Correct = 0;
      mod.questions.forEach(q => {
        const ans = examUserAnswers[q.id];
        const isSpr = (q.type === 'free_response' || q.question_type === 'free_response');
        const ok = isSpr ? PSAT_ENGINE.gradeFreeResponse(ans, q.correct_answer) : (String(ans).trim().toUpperCase() === String(q.correct_answer).trim().toUpperCase());
        if (ok) m1Correct++;
      });
      const routingThreshold = (PSAT_ENGINE.SCALING_ASSUMPTIONS && PSAT_ENGINE.SCALING_ASSUMPTIONS.ROUTING_THRESHOLD) || 0.58;
      const isUpper = (m1Correct / mod.questions.length) >= routingThreshold; // >= 16/27
      activeExam.routingTracks = activeExam.routingTracks || {};
      activeExam.routingTracks.rw = isUpper ? 'Hard' : 'Easy';
      activeExam.modules[1].questions = isUpper ? activeExam.adaptivePools.rwM2Hard : activeExam.adaptivePools.rwM2Easy;
      activeExam.modules[1].name = isUpper ? 'Reading and Writing — Module 2 (Upper Difficulty Track)' : 'Reading and Writing — Module 2 (Standard Difficulty Track)';
      activeExam.modules[1].track = isUpper ? 'Hard' : 'Easy';
    } else if (activeExam.type === 'standard_psat89' && currentModuleIndex === 2) {
      // Math M1 Routing -> Route Math M2
      let mathM1Correct = 0;
      mod.questions.forEach(q => {
        const ans = examUserAnswers[q.id];
        const isSpr = (q.type === 'free_response' || q.question_type === 'free_response');
        const ok = isSpr ? PSAT_ENGINE.gradeFreeResponse(ans, q.correct_answer) : (String(ans).trim().toUpperCase() === String(q.correct_answer).trim().toUpperCase());
        if (ok) mathM1Correct++;
      });
      const routingThreshold = (PSAT_ENGINE.SCALING_ASSUMPTIONS && PSAT_ENGINE.SCALING_ASSUMPTIONS.ROUTING_THRESHOLD) || 0.58;
      const isUpper = (mathM1Correct / mod.questions.length) >= routingThreshold; // >= 13/22
      activeExam.routingTracks = activeExam.routingTracks || {};
      activeExam.routingTracks.math = isUpper ? 'Hard' : 'Easy';
      activeExam.modules[3].questions = isUpper ? activeExam.adaptivePools.mathM2Hard : activeExam.adaptivePools.mathM2Easy;
      activeExam.modules[3].name = isUpper ? 'Math — Module 2 (Upper Difficulty Track)' : 'Math — Module 2 (Standard Difficulty Track)';
      activeExam.modules[3].track = isUpper ? 'Hard' : 'Easy';
    } else if (activeExam.type === 'mini_psat89' && currentModuleIndex === 0) {
      // Mini PSAT 8/9 Section 1 Routing -> Route Math Section 2
      let rwCorrect = 0;
      mod.questions.forEach(q => {
        const ans = examUserAnswers[q.id];
        if (String(ans).trim().toUpperCase() === String(q.correct_answer).trim().toUpperCase()) rwCorrect++;
      });
      const isUpper = rwCorrect >= 3;
      activeExam.routingTracks = activeExam.routingTracks || {};
      activeExam.routingTracks.math = isUpper ? 'Hard' : 'Easy';
      if (activeExam.adaptivePools.mathM2Hard && activeExam.adaptivePools.mathM2Easy) {
        activeExam.modules[1].questions = isUpper ? activeExam.adaptivePools.mathM2Hard : activeExam.adaptivePools.mathM2Easy;
        activeExam.modules[1].name = isUpper ? 'Section 2: Math (Upper Difficulty Track)' : 'Section 2: Math (Standard Difficulty Track)';
        activeExam.modules[1].track = isUpper ? 'Hard' : 'Easy';
      }
    }
  }

  // Check if this was Section 1 (Module 2 of standard PSAT 8/9, or Module 1 of mini PSAT 8/9), which triggers the break
  if (activeExam.type === 'standard_psat89' && currentModuleIndex === 1) {
    startBreakTimer(10 * 60);
    return;
  }
  if (activeExam.type === 'mini_psat89' && currentModuleIndex === 0) {
    startBreakTimer(60); // 1-minute quick break for mini exam
    return;
  }

  // If more modules exist, move to next module
  if (currentModuleIndex < activeExam.modules.length - 1) {
    loadExamModule(currentModuleIndex + 1);
  } else {
    finishExamAndShowReport();
  }
}

function startBreakTimer(breakSecs) {
  let breakSeconds = typeof breakSecs === 'number' ? breakSecs : 10 * 60;
  showExamSubview('exam-break');

  const isMini = (activeExam && activeExam.type === 'mini_psat89');
  const breakTitle = document.getElementById('break-title');
  const breakDesc = document.getElementById('break-description');
  if (breakTitle) breakTitle.innerText = isMini ? 'Scheduled Quick Break' : 'Scheduled 10-Minute Break';
  if (breakDesc) breakDesc.innerText = isMini ?
    'Take a breath before starting Section 2: Math (4 Questions / 5 Minutes).' :
    'Take a breath, stretch, and relax before starting Section 2: Math (44 Questions / 70 Minutes).';

  function updateBreakDisplay() {
    const m = Math.floor(breakSeconds / 60);
    const s = breakSeconds % 60;
    document.getElementById('break-timer-display').innerText = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  updateBreakDisplay();
  if (breakTimerInterval) clearInterval(breakTimerInterval);
  breakTimerInterval = setInterval(() => {
    if (breakSeconds > 0) {
      breakSeconds--;
      updateBreakDisplay();
    } else {
      clearInterval(breakTimerInterval);
      showExamToast('Break is over! Starting Section 2: Math.');
      resumeExamAfterBreak();
    }
  }, 1000);
}

function resumeExamAfterBreak() {
  if (breakTimerInterval) clearInterval(breakTimerInterval);
  if (activeExam && activeExam.type === 'mini_psat89') {
    loadExamModule(1); // Start Section 2: Math Module
  } else {
    loadExamModule(2); // Start Section 2: Math Module 1
  }
}

function finishExamAndShowReport() {
  flushExamQuestionTime();
  currentExamReport = PSAT_ENGINE.scoreStandardExam(activeExam, examUserAnswers, examUserTimes);
  
  // PSAT_ENGINE.toLeanReport() persists `title`/`type` -- writing
  // `examTitle`/`examType` here stored every exam-history entry with
  // title: undefined, type: undefined (so parent.html/index.html both
  // fell back to the generic "Practice Exam" label and never recognised
  // a standard exam). Field names must match the engine's contract.
  currentExamReport.title = activeExam.title || 'Standard PSAT 8/9 Exam';
  currentExamReport.type = activeExam.type || 'standard_psat89';
  currentExamReport.formattedDate = new Date(currentExamReport.completedAt).toLocaleString();

  // Automatically persist all answered questions to practice progress & SRS
  let savedCount = 0;
  currentExamReport.moduleReports.forEach(m => {
    m.questions.forEach(q => {
      if (q.answered && q.userAnswer && q.userAnswer !== 'Unanswered') {
        const existingProgress = progress[q.questionId] || {};
        const timeSpent = q.timeSpentMs || 0;
        const isReliable = timeSpent > 0;

        const prevSeen = existingProgress.timesSeen || (existingProgress.answered ? 1 : 0);
        const prevCorrect = existingProgress.timesCorrect || (existingProgress.answered && existingProgress.isCorrect ? 1 : 0);
        const prevIncorrect = existingProgress.timesIncorrect || (existingProgress.answered && !existingProgress.isCorrect ? 1 : 0);
        const prevAttempts = Array.isArray(existingProgress.attempts) ? existingProgress.attempts.slice() : [];

        const newSeen = prevSeen + 1;
        const newCorrect = prevCorrect + (q.isCorrect ? 1 : 0);
        const newIncorrect = prevIncorrect + (q.isCorrect ? 0 : 1);

        prevAttempts.push({
          at: Date.now(),
          selectedAnswer: q.userAnswer,
          isCorrect: q.isCorrect,
          timeSpentMs: timeSpent,
          source: activeExam.type || 'exam'
        });

        progress[q.questionId] = {
          answered: true,
          selectedAnswer: q.userAnswer,
          isCorrect: q.isCorrect,
          timeSpentMs: timeSpent,
          timingReliable: isReliable,
          isFlagged: existingProgress.isFlagged || false,
          timestamp: Date.now(),
          timesSeen: newSeen,
          timesCorrect: newCorrect,
          timesIncorrect: newIncorrect,
          accuracyPercent: Math.round((newCorrect / newSeen) * 100),
          attempts: prevAttempts.slice(-3)
        };

        const grade = PSAT_ENGINE.gradeAttempt(q.isCorrect, timeSpent, isReliable);
        srsState[q.questionId] = PSAT_ENGINE.scheduleNext(srsState[q.questionId], grade, Date.now(), timeSpent);
        sessionsState = PSAT_ENGINE.recordDailySession(sessionsState, q.isCorrect, timeSpent, null, isReliable);
        savedCount++;
      }
    });
  });
  saveProgress();

  // Automatically persist lean score report to Exam History (Capped at 15 exams to protect localStorage quota)
  const leanReport = PSAT_ENGINE.toLeanReport(currentExamReport);
  let examHistory = safeGetStorage('psat_exam_history', []);
  examHistory.unshift(leanReport);
  if (examHistory.length > 15) examHistory = examHistory.slice(0, 15);
  safeSetStorage('psat_exam_history', examHistory);

  // Enqueue exam completed outbox operation
  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.enqueueOutboxOp) {
    PSAT_ENGINE.enqueueOutboxOp(localStorage, 'exam_completed', {
      examId: leanReport.examId,
      completedAt: leanReport.completedAt,
      totalScore: leanReport.scores ? leanReport.scores.totalScaled : null
    }, window.location);
  }

  // Instantly push completed exam report to Azure Cosmos DB
  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.pushToCloud) {
    PSAT_ENGINE.pushToCloud(localStorage, null, APP_ENV.studentName, window.location);
  }

  // Clear in-progress exam state once completed
  clearActiveExamState();

  // Render score report and update lobby
  renderExamLobbyHistory();
  renderExamReport(currentExamReport);
  showExamSubview('exam-report');
}

function renderExamReport(report) {
  const fullReport = PSAT_ENGINE.rehydrateReport(report, window.QUESTIONS_DATA || questions);
  currentExamReport = fullReport;

  document.getElementById('report-date').innerText = fullReport.formattedDate || new Date(fullReport.completedAt || Date.now()).toLocaleString();
  
  const isScaledReady = fullReport.scores && fullReport.scores.isScaledReady !== false && fullReport.scores.totalScaled !== null;
  
  if (isScaledReady) {
    document.getElementById('report-score-label').innerText = 'Composite Scaled Score (240–1440)';
    document.getElementById('report-total-score').innerText = fullReport.scores.totalScaled;
    document.getElementById('report-scale-denom').innerText = '/ 1440';
    
    const rwRangeStr = fullReport.scores.rwRangeFormatted ? ` (${fullReport.scores.rwRangeFormatted})` : '';
    const mathRangeStr = fullReport.scores.mathRangeFormatted ? ` (${fullReport.scores.mathRangeFormatted})` : '';
    document.getElementById('report-rw-score').innerText = `${fullReport.scores.rwScaled} / 720${rwRangeStr}`;
    document.getElementById('report-math-score').innerText = `${fullReport.scores.mathScaled} / 720${mathRangeStr}`;

    const rangeStr = fullReport.scores.totalRangeFormatted ? `Score Range: ${fullReport.scores.totalRangeFormatted} (${fullReport.scores.confidenceInterval || '90% Confidence Interval'}). ` : '';
    const basisStr = fullReport.scores.dataBasis ? `Basis: ${fullReport.scores.dataBasis}. ` : '';
    document.getElementById('report-scaling-note').innerText = `${rangeStr}${basisStr}Estimated from section accuracy scaled to the 240–1440 PSAT 8/9 scale.`;
  } else {
    document.getElementById('report-score-label').innerText = 'Practice Check Score (Raw)';
    document.getElementById('report-total-score').innerText = `${fullReport.totalCorrect} / ${fullReport.totalQuestions}`;
    document.getElementById('report-scale-denom').innerText = `(${fullReport.overallAccuracyPercent}%)`;
    document.getElementById('report-rw-score').innerText = `${fullReport.scores.rwCorrect} / ${fullReport.scores.rwTotal} Correct`;
    document.getElementById('report-math-score').innerText = `${fullReport.scores.mathCorrect} / ${fullReport.scores.mathTotal} Correct`;
    document.getElementById('report-scaling-note').innerText = 'Scaled 240–1440 projection requires a standard full-length test (≥15 questions per section).';
  }

  document.getElementById('report-accuracy-summary').innerText = `Overall Accuracy: ${fullReport.overallAccuracyPercent}% (${fullReport.totalCorrect} / ${fullReport.totalQuestions} Correct)`;

  const totalMins = Math.round(fullReport.totalTimeSpentMs / 60000);
  document.getElementById('report-total-time').innerText = `${Math.floor(totalMins / 60)}h ${totalMins % 60}m`;

  // Dynamically render module cards
  const modGrid = document.getElementById('report-modules-grid');
  if (modGrid && Array.isArray(fullReport.moduleReports)) {
    modGrid.innerHTML = '';
    fullReport.moduleReports.forEach((m, idx) => {
      const div = document.createElement('div');
      div.className = 'bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-1';
      div.innerHTML = `
        <span class="text-xs font-semibold text-slate-500 uppercase">${esc(m.name || `${m.section} • Module ${idx + 1}`)}</span>
        <h4 class="text-xl font-bold text-slate-900">${m.correct} / ${m.totalQuestions} (${m.accuracyPercent}%)</h4>
        <span class="text-[11px] text-slate-400 font-mono">${m.attempted} attempted</span>
      `;
      modGrid.appendChild(div);
    });
  }

  // Post-Exam Targeted Recovery Plan Generation
  const recoveryCard = document.getElementById('report-recovery-card');
  if (recoveryCard && typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.generatePostExamRecoveryPlan) {
    if (fullReport.totalCorrect < fullReport.totalQuestions) {
      const plan = PSAT_ENGINE.generatePostExamRecoveryPlan(fullReport, window.QUESTIONS_DATA || questions, progress, { count: 10 });
      if (plan && plan.questions && plan.questions.length > 0) {
        window._activeRecoveryPlan = plan;
        const missesEl = document.getElementById('recovery-misses-cnt');
        const transEl = document.getElementById('recovery-transfer-cnt');
        const breakEl = document.getElementById('recovery-q-breakdown');
        if (missesEl) missesEl.innerText = plan.directMissesCount;
        if (transEl) transEl.innerText = plan.transferCount;
        if (breakEl) breakEl.innerText = `${plan.questions.length} Questions • ~${Math.round(plan.questions.length * 1.5)} Minutes`;
        recoveryCard.classList.remove('hidden');
      } else {
        recoveryCard.classList.add('hidden');
      }
    } else {
      recoveryCard.classList.add('hidden');
    }
  }

  const btn = document.getElementById('btn-save-exam');
  if (btn) {
    btn.innerText = '✓ Saved to Practice & Exam History';
    btn.className = 'btn btn-md btn-success is-done cursor-default';
    btn.disabled = true;
  }

  filterReportQuestions('all');
}

function launchPostExamRecoveryDrill() {
  if (!window._activeRecoveryPlan) {
    alert('No recovery plan available.');
    return;
  }
  sessionStorage.setItem('psat_active_custom_test', JSON.stringify(window._activeRecoveryPlan));
  startCustomTestDirect(window._activeRecoveryPlan);
}

function renderExamLobbyHistory() {
  checkActiveExamResume();
  const container = document.getElementById('exam-history-container');
  const badge = document.getElementById('exam-history-count-badge');
  if (!container) return;

  const history = safeGetStorage('psat_exam_history', []);
  if (badge) badge.innerText = `${history.length} Completed Test${history.length === 1 ? '' : 's'}`;

  if (history.length === 0) {
    container.innerHTML = `
      <div class="p-6 rounded-2xl bg-slate-50 border border-slate-200 text-center space-y-2">
        <i data-lucide="award" class="w-8 h-8 mx-auto text-slate-300"></i>
        <p class="text-xs font-semibold text-slate-600">No exams completed yet.</p>
        <p class="text-[11px] text-slate-400">Complete the standard PSAT 8/9 exam or a section test above to view score trends and diagnostic reviews here.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  container.innerHTML = '';
  history.forEach((h, idx) => {
    const div = document.createElement('div');
    div.className = 'p-4 sm:p-5 rounded-2xl border border-slate-200 bg-slate-50 hover:bg-white hover:border-indigo-200 transition-all flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 shadow-xs';
    
    const totalMins = Math.round((h.totalTimeSpentMs || 0) / 60000);
    const timeStr = `${Math.floor(totalMins / 60)}h ${totalMins % 60}m`;
    const isStandard = (h.type === 'standard_psat89');

    div.innerHTML = `
      <div class="space-y-1.5">
        <div class="flex flex-wrap items-center gap-2">
          <span class="px-2.5 py-0.5 rounded-md text-[11px] font-bold ${isStandard ? 'bg-emerald-100 text-emerald-800' : 'bg-indigo-100 text-indigo-800'}">
            ${esc(h.title || 'Practice Test')}
          </span>
          <span class="text-xs text-slate-400 font-mono">${esc(h.formattedDate || new Date(h.completedAt).toLocaleDateString())}</span>
        </div>
        <div class="text-xs text-slate-600 flex flex-wrap items-center gap-3">
          <span><strong>Accuracy:</strong> ${h.overallAccuracyPercent}% (${h.totalCorrect}/${h.totalQuestions})</span>
          <span>&bull;</span>
          <span><strong>R&W:</strong> ${h.scores?.rwScaled || '—'}/720</span>
          <span>&bull;</span>
          <span><strong>Math:</strong> ${h.scores?.mathScaled || '—'}/720</span>
          <span>&bull;</span>
          <span><strong>Time:</strong> ${timeStr}</span>
        </div>
      </div>

      <div class="flex items-center space-x-3 shrink-0">
        <div class="text-right">
          <span class="text-[10px] text-slate-400 uppercase font-semibold block">Composite Score</span>
          <span class="text-2xl font-black text-indigo-900">${h.scores?.totalScaled || '—'}<span class="text-xs font-normal text-slate-400">/1440</span></span>
        </div>
        <button onclick="viewExamReportFromHistory('${h.examId}')" class="btn btn-sm btn-primary">
          <i data-lucide="file-search" class="w-3.5 h-3.5 mr-1.5"></i> Review Test &rarr;
        </button>
      </div>
    `;
    container.appendChild(div);
  });

  lucide.createIcons();
}

function viewExamReportFromHistory(examId) {
  const history = safeGetStorage('psat_exam_history', []);
  const found = history.find(h => h.examId === examId);
  if (!found) {
    alert('Exam report not found in history.');
    return;
  }
  const fullReport = PSAT_ENGINE.rehydrateReport(found, window.QUESTIONS_DATA || questions);
  currentExamReport = fullReport;
  renderExamReport(currentExamReport);
  showExamSubview('exam-report');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================================
// IN-PROGRESS EXAM STATE PERSISTENCE & RECOVERY CONTROLLERS
// ============================================================
function persistActiveExamState() {
  if (!activeExam || document.getElementById('view-exam').classList.contains('hidden')) return;

  const leanModules = (activeExam.modules || []).map(m => ({
    id: m.id,
    section: m.section,
    moduleNumber: m.moduleNumber,
    name: m.name,
    track: m.track || 'Standard',
    questionsCount: m.questionsCount || (m.questions ? m.questions.length : 0),
    timeLimitSeconds: m.timeLimitSeconds,
    questionIds: (m.questions || []).map(q => q.id)
  }));

  const leanPools = activeExam.adaptivePools ? {
    rwM2Hard: (activeExam.adaptivePools.rwM2Hard || []).map(q => q.id),
    rwM2Easy: (activeExam.adaptivePools.rwM2Easy || []).map(q => q.id),
    mathM2Hard: (activeExam.adaptivePools.mathM2Hard || []).map(q => q.id),
    mathM2Easy: (activeExam.adaptivePools.mathM2Easy || []).map(q => q.id)
  } : null;

  const snapshot = {
    activeExamMeta: {
      id: activeExam.id,
      title: activeExam.title,
      type: activeExam.type,
      isAdaptive: activeExam.isAdaptive === true,
      routingTracks: activeExam.routingTracks || null,
      adaptivePools: leanPools,
      totalQuestions: activeExam.totalQuestions,
      totalTimeMinutes: activeExam.totalTimeMinutes,
      breakMinutes: activeExam.breakMinutes,
      createdAt: activeExam.createdAt,
      modules: leanModules
    },
    currentModuleIndex: currentModuleIndex,
    currentExamQIndex: currentExamQIndex,
    examModuleDeadline: examModuleDeadline,
    examUserAnswers: examUserAnswers,
    examUserTimes: examUserTimes,
    examMarkedForReview: examMarkedForReview,
    examViewMode: examViewMode,
    savedAt: Date.now()
  };
  safeSetStorage('psat_active_exam_state', snapshot);
}

function clearActiveExamState() {
  try {
    localStorage.removeItem('psat_active_exam_state');
  } catch (e) {}
}

function checkActiveExamResume() {
  const saved = safeGetStorage('psat_active_exam_state', null);
  const banner = document.getElementById('exam-resume-banner');
  if (!banner) return;
  const meta = saved ? (saved.activeExamMeta || saved.activeExam) : null;
  if (saved && meta && saved.examModuleDeadline > Date.now()) {
    const titleEl = document.getElementById('resume-exam-title');
    const detailsEl = document.getElementById('resume-exam-details');
    if (titleEl) titleEl.innerText = meta.title || 'In-Progress Exam Available';
    const minsLeft = Math.max(1, Math.round((saved.examModuleDeadline - Date.now()) / 60000));
    const totalMods = (meta.modules && meta.modules.length) || 1;
    if (detailsEl) detailsEl.innerText = `Module ${saved.currentModuleIndex + 1} of ${totalMods} • ~${minsLeft} min remaining before module expires.`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
    if (saved && saved.examModuleDeadline <= Date.now()) {
      clearActiveExamState();
    }
  }
}

function resumeActiveExamState() {
  const saved = safeGetStorage('psat_active_exam_state', null);
  if (!saved || (!saved.activeExamMeta && !saved.activeExam)) return;

  const qMap = {};
  (window.QUESTIONS_DATA || questions).forEach(q => { qMap[q.id] = q; });

  if (saved.activeExamMeta) {
    const meta = saved.activeExamMeta;
    const rehydratedModules = [];
    let hasMismatch = false;

    for (let i = 0; i < (meta.modules || []).length; i++) {
      const m = meta.modules[i];
      const expectedCount = m.questionsCount || (m.questionIds ? m.questionIds.length : 0);
      const rehydratedQuestions = (m.questionIds || []).map(qid => qMap[qid]).filter(Boolean);

      if (rehydratedQuestions.length !== expectedCount) {
        console.error(`Active exam module "${m.name}" rehydration mismatch: found ${rehydratedQuestions.length} of ${expectedCount} questions.`);
        hasMismatch = true;
      }

      rehydratedModules.push({
        id: m.id,
        section: m.section,
        moduleNumber: m.moduleNumber,
        name: m.name,
        track: m.track || 'Standard',
        questionsCount: expectedCount,
        timeLimitSeconds: m.timeLimitSeconds,
        questions: rehydratedQuestions
      });
    }

    if (hasMismatch) {
      alert('Warning: Some questions from your saved in-progress exam could not be loaded from the question bank. Please start a new exam to ensure accurate scoring.');
      clearActiveExamState();
      showExamSubview('exam-lobby');
      renderExamLobbyHistory();
      return;
    }

    const rehydratedPools = meta.adaptivePools ? {
      rwM2Hard: (meta.adaptivePools.rwM2Hard || []).map(qid => qMap[qid]).filter(Boolean),
      rwM2Easy: (meta.adaptivePools.rwM2Easy || []).map(qid => qMap[qid]).filter(Boolean),
      mathM2Hard: (meta.adaptivePools.mathM2Hard || []).map(qid => qMap[qid]).filter(Boolean),
      mathM2Easy: (meta.adaptivePools.mathM2Easy || []).map(qid => qMap[qid]).filter(Boolean)
    } : null;

    activeExam = {
      id: meta.id,
      title: meta.title,
      type: meta.type,
      isAdaptive: meta.isAdaptive === true,
      routingTracks: meta.routingTracks || { rw: 'Baseline', math: 'Baseline' },
      adaptivePools: rehydratedPools,
      totalQuestions: meta.totalQuestions,
      totalTimeMinutes: meta.totalTimeMinutes,
      breakMinutes: meta.breakMinutes,
      createdAt: meta.createdAt,
      modules: rehydratedModules
    };
  } else {
    activeExam = saved.activeExam;
  }

  currentModuleIndex = saved.currentModuleIndex || 0;
  currentExamQIndex = saved.currentExamQIndex || 0;
  examUserAnswers = saved.examUserAnswers || {};
  examUserTimes = saved.examUserTimes || {};
  examMarkedForReview = saved.examMarkedForReview || {};
  examModuleDeadline = saved.examModuleDeadline || (Date.now() + 30 * 60000);
  examViewMode = saved.examViewMode || 'card';

  showExamSubview('exam-active');
  
  const mod = activeExam.modules[currentModuleIndex];
  document.getElementById('exam-active-module-title').innerText = `${esc(mod.section)} — ${esc(mod.name || `Module ${currentModuleIndex + 1}`)}`;

  if (examTimerInterval) clearInterval(examTimerInterval);
  updateExamTimerDisplay();
  examTimerInterval = setInterval(() => {
    const remainingMs = examModuleDeadline - Date.now();
    if (remainingMs <= 0) {
      clearInterval(examTimerInterval);
      updateExamTimerDisplay();
      showExamToast('Time is up for this module! Directing to module review.');
      showModuleReviewScreen();
    } else {
      updateExamTimerDisplay();
    }
  }, 1000);

  loadExamQuestion(currentExamQIndex);
  lucide.createIcons();
}

function discardActiveExamState() {
  if (confirm('Are you sure you want to discard your unfinished exam session?')) {
    clearActiveExamState();
    checkActiveExamResume();
  }
}

window.addEventListener('beforeunload', function (e) {
  if (activeExam && !document.getElementById('view-exam').classList.contains('hidden') && !document.getElementById('exam-active').classList.contains('hidden')) {
    persistActiveExamState();
    e.preventDefault();
    e.returnValue = 'You have an active exam in progress. Are you sure you want to leave?';
    return e.returnValue;
  }
});

function filterReportQuestions(filter) {
  reportFilterMode = filter;
  if (!currentExamReport) return;

  let allReviewedQs = [];
  currentExamReport.moduleReports.forEach(m => {
    allReviewedQs = allReviewedQs.concat(m.questions);
  });

  const incorrectCount = allReviewedQs.filter(q => !q.isCorrect).length;
  const correctCount = allReviewedQs.filter(q => q.isCorrect).length;

  document.getElementById('rf-all-cnt').innerText = allReviewedQs.length;
  document.getElementById('rf-inc-cnt').innerText = incorrectCount;
  document.getElementById('rf-cor-cnt').innerText = correctCount;

  ['all', 'incorrect', 'correct'].forEach(f => {
    const btn = document.getElementById(`rf-${f === 'incorrect' ? 'inc' : (f === 'correct' ? 'cor' : 'all')}`);
    if (btn) {
      btn.className = (f === filter) ?
        'px-3 py-1.5 rounded-lg bg-white text-indigo-600 shadow-sm font-bold' :
        'px-3 py-1.5 rounded-lg text-slate-600 hover:text-slate-900 font-semibold';
    }
  });

  const filteredList = allReviewedQs.filter(q => {
    if (filter === 'incorrect') return !q.isCorrect;
    if (filter === 'correct') return q.isCorrect;
    return true;
  });

  const container = document.getElementById('report-questions-list');
  container.innerHTML = '';

  filteredList.forEach((q, idx) => {
    const div = document.createElement('div');
    div.className = 'pt-6 space-y-4';

    const statusBadge = q.isCorrect ?
      '<span class="px-2.5 py-1 bg-emerald-100 text-emerald-800 text-xs font-bold rounded-md">✓ Correct</span>' :
      '<span class="px-2.5 py-1 bg-rose-100 text-rose-800 text-xs font-bold rounded-md">✗ Incorrect</span>';

    const timeSec = Math.round((q.timeSpentMs || 0) / 1000);

    div.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center space-x-2">
          ${statusBadge}
          <span class="font-mono text-xs text-slate-400">ID: ${esc(q.questionId)}</span>
          <span class="text-xs font-semibold text-slate-700">${esc(q.section)} • ${esc(q.skill)}</span>
        </div>
        <span class="text-xs text-slate-400 font-mono"><i data-lucide="clock" class="w-3.5 h-3.5 inline mr-1"></i> ${timeSec}s spent</span>
      </div>

      <!-- Official Card / Prompt -->
      ${q.image_url ? `
        <div class="flex justify-center p-4 bg-slate-50 rounded-2xl border border-slate-200">
          <img src="${esc(q.image_url)}" alt="Question Card" class="max-w-full w-auto h-auto object-contain rounded-xl">
        </div>` : `
        <div class="p-4 bg-slate-50 rounded-xl border border-slate-200 text-sm text-slate-800">${esc(q.question_text || q.prompt)}</div>
      `}

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <div class="p-3 rounded-xl ${q.isCorrect ? 'bg-emerald-50 border border-emerald-200 text-emerald-900' : 'bg-rose-50 border border-rose-200 text-rose-900'}">
          <span class="font-bold block uppercase text-[10px] tracking-wider text-slate-500">Your Answer:</span>
          <span class="font-mono font-bold text-sm">${esc(q.userAnswer)}</span>
        </div>
        <div class="p-3 rounded-xl bg-slate-100 border border-slate-200 text-slate-900">
          <span class="font-bold block uppercase text-[10px] tracking-wider text-slate-500">Official Correct Answer:</span>
          <span class="font-mono font-bold text-sm text-indigo-600">${esc(q.correctAnswer)}</span>
        </div>
      </div>

      <!-- Error Root-Cause Tag Selector -->
      ${!q.isCorrect ? `
        <div class="p-3 bg-rose-50/60 rounded-xl border border-rose-200/60 space-y-2 text-xs">
          <div class="flex items-center justify-between">
            <span class="font-bold text-rose-900 flex items-center">
              <i data-lucide="tag" class="w-3.5 h-3.5 mr-1 text-rose-600"></i> Why did you miss this? (Error Tagging)
            </span>
            <span class="text-[11px] text-slate-500">Categorizes error in Parent Portal</span>
          </div>
          <div class="flex flex-wrap gap-1.5 pt-1" id="tag-bar-${esc(q.questionId)}">
            ${Object.values(PSAT_ENGINE.ERROR_TAGS || {}).map(t => {
              const currentTag = (progress[q.questionId] && progress[q.questionId].errorTag) || q.errorTag;
              const isActive = (currentTag === t.id);
              return `
                <button type="button" onclick="setQuestionErrorTag('${esc(q.questionId)}', '${t.id}')"
                  class="px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-all ${isActive ? 'bg-rose-600 border-rose-600 text-white shadow-xs' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}">
                  ${t.label}
                </button>
              `;
            }).join('')}
          </div>
        </div>
      ` : ''}

      <details class="p-3.5 bg-slate-50 rounded-xl border border-slate-200 text-xs text-slate-700 space-y-1.5">
        <summary class="font-bold text-indigo-700 cursor-pointer flex items-center justify-between">
          <span>View Official Step-by-Step Rationale</span>
          <i data-lucide="chevron-down" class="w-4 h-4"></i>
        </summary>
        <div class="pt-2 text-slate-800 leading-relaxed">
          ${(typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.renderRationale) ?
            PSAT_ENGINE.renderRationale(q, { userSelectedAnswer: q.userAnswer }) :
            esc(q.rationale)
          }
        </div>
      </details>
    `;
    container.appendChild(div);
  });

  lucide.createIcons();
}

function setQuestionErrorTag(qid, tagId) {
  if (!progress[qid]) {
    progress[qid] = { answered: true, isCorrect: false, timestamp: Date.now() };
  }
  progress[qid].errorTag = tagId;
  safeSetStorage('psat_progress', progress);
  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.pushToCloud) {
    PSAT_ENGINE.pushToCloud(localStorage);
  }
  // Re-render tag buttons for this question
  const bar = document.getElementById(`tag-bar-${qid}`);
  if (bar && PSAT_ENGINE.ERROR_TAGS) {
    bar.innerHTML = Object.values(PSAT_ENGINE.ERROR_TAGS).map(t => {
      const isActive = (progress[qid].errorTag === t.id);
      return `
        <button type="button" onclick="setQuestionErrorTag('${qid}', '${t.id}')"
          class="px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-all ${isActive ? 'bg-rose-600 border-rose-600 text-white shadow-xs' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}">
          ${t.label}
        </button>
      `;
    }).join('');
  }
}

function saveExamResultsToHistory() {
  // Re-trigger progress save
  saveProgress();
  const btn = document.getElementById('btn-save-exam');
  if (btn) {
    btn.innerText = '✓ Saved to Practice & Exam History';
    btn.className = 'btn btn-md btn-success is-done cursor-default';
    btn.disabled = true;
  }
}

// Auto-launch modes from URL Query Parameters
document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const mode = urlParams.get('mode');

  if (mode === 'psat89' || mode === 'standard_psat89') {
    const isAdaptive = (urlParams.get('adaptive') !== 'false');
    const isHighYield = (urlParams.get('highyield') === 'true' || urlParams.get('high_yield') === 'true');
    startStandardExam({ isAdaptive: isAdaptive, isHighYield: isHighYield });
  } else if (mode === 'mini_psat89' || mode === 'mini') {
    const isAdaptive = (urlParams.get('adaptive') !== 'false');
    const isHighYield = (urlParams.get('highyield') === 'true' || urlParams.get('high_yield') === 'true');
    startMiniExam({ isAdaptive: isAdaptive, isHighYield: isHighYield });
  } else if (mode === 'gap_drill') {
    const countParam = parseInt(urlParams.get('count') || '20', 10);
    const focusParam = urlParams.get('focus') || 'all';
    const drill = PSAT_ENGINE.generateGapTargetedDrill(questions, progress, srsState, { count: countParam, focus: focusParam });
    startCustomTestDirect(drill);
  } else if (mode === 'custom') {
    const stored = sessionStorage.getItem('psat_active_custom_test');
    if (stored) {
      try {
        const customData = JSON.parse(stored);
        startCustomTestDirect(customData);
      } catch (e) {
        console.error('Error parsing custom test from session:', e);
      }
    }
  } else if (mode === 'custom_filter') {
    const testParam = urlParams.get('test') || 'Both';
    const diffParam = urlParams.get('diff') || 'All';
    const countParam = parseInt(urlParams.get('count') || '20', 10);
    const skillsParam = urlParams.get('skills');
    const skillsArr = skillsParam ? skillsParam.split(',').filter(Boolean) : null;

    const filtered = PSAT_ENGINE.generateCustomTest(questions, {
      test: testParam,
      skills: skillsArr,
      difficulties: diffParam === 'All' ? null : [diffParam],
      count: countParam
    });
    startCustomTestDirect(filtered);
  }

  // Show Beta Sandbox banner if running in beta mode
  if (APP_ENV.isBeta) {
    const betaBanner = document.getElementById('beta-sandbox-banner');
    if (betaBanner) betaBanner.classList.remove('hidden');
  }
  updateSyncStatusBadge();

  // Automatic cloud sync on app start
  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.pullFromCloud) {
    PSAT_ENGINE.pullFromCloud(localStorage, null, APP_ENV.studentName, safeSetStorage).then(res => {
      if (res && res.success) {
        progress = safeGetStorage('psat_progress', {});
        srsState = safeGetStorage('psat_srs', {});
        sessionsState = safeGetStorage('psat_sessions', {});
        updateHeaderStats();
        renderPalette();
        renderExamLobbyHistory();
        if (!document.getElementById('view-analytics').classList.contains('hidden')) {
          renderAnalytics();
        }
        localStorage.setItem(APP_ENV.storagePrefix + 'psat_last_cloud_sync_time', String(Date.now()));
        localStorage.setItem(APP_ENV.storagePrefix + 'psat_pending_sync_count', '0');
        updateSyncStatusBadge();
      } else {
        updateSyncStatusBadge();
      }
    }).catch(() => {
      updateSyncStatusBadge();
    });
  }
});

// ---------------------------------------------------------------------------
// Global handler surface.
//
// A classic <script> puts every top-level function declaration on `window`;
// an ES module does not. index.html's markup (and the markup this module
// generates) calls these from inline on* attributes, so they are re-published
// explicitly. The HTML's handler attributes are untouched — converting them to
// addEventListener is deliberately out of WI-09's scope.
// ---------------------------------------------------------------------------
Object.assign(window, {
  // shared modules (were top-level declarations of the inline script)
  esc,
  safeGetStorage,
  safeSetStorage,
  cloneProdDataToBeta,
  resetBetaSandbox,
  questionImageSrc,
  setClassName,
  toggleDesmosCalculator,
  initDesmosCalculator,
  fallbackDesmosIframe,
  toggleDesmosSize,
  toggleScientificCalculator,
  toggleScientificAngleMode,
  sciCalcInput,
  sciCalcClear,
  sciCalcBackspace,
  sciCalcEvaluate,
  updateSciCalcDisplay,
  toggleReferenceSheet,
  setFormulaTab,
  makeDraggable,
  // page functions
  updateSyncStatusBadge,
  checkDemoModeBanner,
  restoreRealStudentData,
  manualTriggerCloudSync,
  showExplainerLink,
  triggerCloudSync,
  saveProgress,
  showStorageWarningBanner,
  resetAllProgress,
  switchTab,
  setViewMode,
  applyFilters,
  loadQuestion,
  recordAttempt,
  selectMultipleChoice,
  submitFreeResponse,
  toggleFlagCurrentQuestion,
  reportCurrentQuestionIssue,
  toggleRationale,
  nextQuestion,
  prevQuestion,
  nextPalettePage,
  prevPalettePage,
  renderPalette,
  updateHeaderStats,
  renderAnalytics,
  renderCharts,
  nextBankPage,
  prevBankPage,
  filterBankTable,
  renderBankTable,
  jumpToQuestion,
  showExamSubview,
  startStandardExam,
  startMiniExam,
  startGapDrillFromLobby,
  startSectionTest,
  startCustomTestDirect,
  showExamToast,
  initExamSession,
  flushExamQuestionTime,
  loadExamModule,
  updateExamTimerDisplay,
  toggleExamTimerVisibility,
  loadExamQuestion,
  renderExamMcqOptions,
  selectExamMcqChoice,
  recordExamSprAnswer,
  toggleExamMarkForReview,
  setExamViewMode,
  adjustExamZoom,
  resetExamZoom,
  applyExamZoom,
  renderExamPalettePills,
  prevExamQuestion,
  nextExamQuestion,
  showModuleReviewScreen,
  returnToActiveExamQuestion,
  submitCurrentExamModule,
  startBreakTimer,
  resumeExamAfterBreak,
  finishExamAndShowReport,
  renderExamReport,
  launchPostExamRecoveryDrill,
  renderExamLobbyHistory,
  viewExamReportFromHistory,
  persistActiveExamState,
  clearActiveExamState,
  checkActiveExamResume,
  resumeActiveExamState,
  discardActiveExamState,
  filterReportQuestions,
  setQuestionErrorTag,
  saveExamResultsToHistory,
});
