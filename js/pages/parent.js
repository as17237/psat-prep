/**
 * js/pages/parent.js — page controller for parent.html.
 *
 * WI-09: relocated out of parent.html's 1,820-line inline <script>. Pure
 * mechanical move. The only edits are the shared-module imports below
 * (replacing byte-identical local copies, including the ~360-line math-tools
 * block that was duplicated with index.html), the `launchMistakesDrill()`
 * wrapper binding the shared launcher to this page's list, and the explicit
 * window bindings at the bottom.
 */
import { esc } from '../shared/html.js';
import { APP_ENV } from '../shared/env.js';
import { safeGetStorage, safeSetStorage, readSyncBadgeState, onPendingSyncCountChanged } from '../shared/storage.js';
import { cloneProdDataToBeta, resetBetaSandbox } from '../shared/beta_sandbox.js';
import { questionImageSrc } from '../shared/questions.js';
import { launchTargetedMistakeDrill } from '../shared/drill.js';
import { applyClass } from '../shared/dom.js';
import { toggleDesmosCalculator, initDesmosCalculator, fallbackDesmosIframe, toggleDesmosSize, toggleScientificCalculator, toggleScientificAngleMode, sciCalcInput, sciCalcClear, sciCalcBackspace, sciCalcEvaluate, updateSciCalcDisplay, toggleReferenceSheet, setFormulaTab, makeDraggable } from '../shared/math_tools.js';

// safeSetStorage bumps the pending-sync counter; this is how it reaches this
// page's badge. Registered during module evaluation, before any write can
// happen -- the inline original called updateParentSyncStatusBadge() directly.
onPendingSyncCountChanged(updateParentSyncStatusBadge);

function updateParentSyncStatusBadge() {
  const textEl = document.getElementById('cloud-sync-status-text');
  if (!textEl) return;
  const { pending, lastSync, minutesAgo } = readSyncBadgeState();

  let timeAgoStr = '';
  if (lastSync) {
    const mins = minutesAgo;
    if (mins < 1) timeAgoStr = ' (Just now)';
    else if (mins === 1) timeAgoStr = ' (1m ago)';
    else if (mins < 60) timeAgoStr = ` (${mins}m ago)`;
    else timeAgoStr = ` (${Math.floor(mins / 60)}h ago)`;
  }

  if (pending > 0) {
    textEl.innerText = `Cosmos DB: ${pending} Pending`;
  } else {
    textEl.innerText = `Cosmos DB Synced${timeAgoStr}`;
  }
}

let currentGapCount = 20;
// Explainer index: question id -> published step-by-step explainer
let explainerIndex = null;
fetch('explanations/index.json')
  .then(r => r.ok ? r.json() : null)
  .then(d => { explainerIndex = (d && d.questions) || {}; })
  .catch(() => { explainerIndex = {}; });

function explainerFor(questionId) {
  const hit = explainerIndex && explainerIndex[String(questionId).slice(0, 8)];
  return (hit && hit.url) ? hit : null;
}

let allTroubleList = [];
let parentActiveExamReport = null;
let parentExamFilterMode = 'all';
let selectedSkillsSet = new Set();
let domainToSkillsMap = {};
let skillToDomainMap = {};
let skillToSectionMap = {};
let skillQuestionCountMap = {};

function syncParentFromCloud(isManual = false) {
  const txt = document.getElementById('cloud-sync-status-text');
  if (txt) txt.innerText = 'Syncing...';
  
  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.pullFromCloud) {
    PSAT_ENGINE.pullFromCloud(localStorage, null, APP_ENV.studentName, safeSetStorage).then(res => {
      if (res && res.success) {
        renderParentMetrics();
        localStorage.setItem(APP_ENV.storagePrefix + 'psat_last_cloud_sync_time', String(Date.now()));
        localStorage.setItem(APP_ENV.storagePrefix + 'psat_pending_sync_count', '0');
        updateParentSyncStatusBadge();
        if (isManual) {
          if (res.updated) {
            alert(`Successfully synced latest student progress from Cosmos DB profile (${APP_ENV.studentName})! (${res.mergedHistoryCount} completed test/exam reports loaded).`);
          } else if (res.empty) {
            alert(`Cosmos DB is connected, but no student test attempts or reports have been submitted yet for ${APP_ENV.studentName}.`);
          } else {
            alert('Cosmos DB is up to date — all attempts and reports are currently synchronized.');
          }
        }
      } else {
        updateParentSyncStatusBadge();
        if (res && res.quotaExceeded) {
          if (isManual) alert('Sync Error: Local browser storage is full (quota exceeded). Please clear older test data or export audit data.');
        } else {
          const errMsg = (res && res.error) ? res.error : 'Could not connect to Cosmos DB server';
          if (isManual) alert(`Sync Warning: ${errMsg}. Please check your internet connection.`);
        }
      }
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }).catch(err => {
      updateParentSyncStatusBadge();
      console.warn('Sync failed:', err);
      if (isManual) alert('Sync failed: Could not reach Cosmos DB sync endpoint.');
    });
  } else {
    if (txt) txt.innerText = 'Cosmos DB Sync';
    if (isManual) alert('Engine is loading. Please refresh and try again.');
  }
}

// ---------------------------------------------------------------------
// Cloud backup freshness widget (WI-04c)
//
// Every value rendered here is a measurement returned by GET /api/backup-status.
// There are exactly four render states and no fifth silent one:
//   'loading'     -> "…", no colour claim
//   'healthy'     -> green, real age
//   'unhealthy'   -> red banner + red pill, with the API's own reason
//   'unavailable' -> amber "backup status unavailable" + the fetch error
// A failed fetch must NEVER leave a previous green on screen and must never
// render a fixed checkmark (CLAUDE.md modes 1 and 5).
// ---------------------------------------------------------------------
const PARENT_API_BASE = 'https://psat-api-4915.azurewebsites.net/api';
let backupStatusInFlight = false;

function formatBackupAge(ageHours) {
  if (typeof ageHours !== 'number' || !isFinite(ageHours) || ageHours < 0) return null;
  if (ageHours < 1) return Math.round(ageHours * 60) + 'm ago';
  if (ageHours < 48) return ageHours.toFixed(1) + 'h ago';
  return (ageHours / 24).toFixed(1) + 'd ago';
}

function renderBackupStatus(state, data) {
  const pill = document.getElementById('backup-status-pill');
  const pillText = document.getElementById('backup-status-pill-text');
  const pillDetail = document.getElementById('backup-status-pill-detail');
  const banner = document.getElementById('backup-status-banner');
  const bannerIconWrap = document.getElementById('backup-status-banner-icon-wrap');
  const bannerTitle = document.getElementById('backup-status-banner-title');
  const bannerDetail = document.getElementById('backup-status-banner-detail');
  if (!pill || !pillText || !pillDetail || !banner) return;

  pill.className = 'px-3 py-2 rounded-xl flex items-start gap-2 border';
  banner.className = 'hidden p-4 sm:p-5 rounded-2xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 shadow-lg border-2';

  if (state === 'loading') {
    pill.classList.add('bg-slate-100', 'border-slate-200', 'text-slate-600');
    pillText.textContent = 'Cloud backup: …';
    pillDetail.textContent = 'Checking backup freshness…';
    return;
  }

  if (state === 'unavailable') {
    pill.classList.add('bg-amber-50', 'border-amber-300', 'text-amber-800');
    pillText.textContent = 'Backup status unavailable';
    pillDetail.textContent = (data && data.error) ? String(data.error) : 'The status check could not be completed.';
    banner.classList.remove('hidden');
    banner.classList.add('bg-amber-50', 'border-amber-400', 'text-amber-900');
    if (bannerIconWrap) bannerIconWrap.className = 'w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-amber-500 text-white';
    if (bannerTitle) bannerTitle.textContent = 'BACKUP STATUS UNAVAILABLE — freshness could not be measured';
    if (bannerDetail) {
      bannerDetail.textContent = 'The backup-status service did not answer, so this page cannot tell you whether the nightly cloud backup ran. ' +
        'Do not assume it is healthy. Details: ' + ((data && data.error) ? String(data.error) : 'unknown error');
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  const ageLabel = formatBackupAge(data && data.ageHours);
  const lastSuccess = (data && data.lastSuccessAt) ? new Date(data.lastSuccessAt).toLocaleString() : null;

  if (state === 'healthy') {
    pill.classList.add('bg-emerald-50', 'border-emerald-300', 'text-emerald-800');
    pillText.textContent = 'Cloud backup: ' + (ageLabel || 'age unknown');
    pillDetail.textContent = lastSuccess ? ('Last success ' + lastSuccess) : 'Last success timestamp unavailable';
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  // state === 'unhealthy'
  pill.classList.add('bg-rose-50', 'border-rose-300', 'text-rose-800');
  pillText.textContent = ageLabel ? ('Cloud backup STALE: ' + ageLabel) : 'No cloud backup found';
  pillDetail.textContent = (data && data.reason) ? String(data.reason) : 'Backup is not healthy.';
  banner.classList.remove('hidden');
  banner.classList.add('bg-rose-50', 'border-rose-500', 'text-rose-900');
  if (bannerIconWrap) bannerIconWrap.className = 'w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-rose-600 text-white';
  if (bannerTitle) bannerTitle.textContent = 'CLOUD BACKUP NOT HEALTHY';
  if (bannerDetail) {
    bannerDetail.textContent = ((data && data.reason) ? String(data.reason) : 'The nightly cloud backup is not current.') +
      (lastSuccess ? (' Last successful backup: ' + lastSuccess + '.') : ' No successful backup has been recorded.') +
      (data && data.lastFailureAt ? (' Last failure marker: ' + new Date(data.lastFailureAt).toLocaleString() + '.') : '');
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function refreshBackupStatus(force) {
  if (backupStatusInFlight && !force) return;
  backupStatusInFlight = true;
  renderBackupStatus('loading');
  try {
    const res = await fetch(PARENT_API_BASE + '/backup-status', { cache: 'no-store' });
    if (!res.ok) {
      throw new Error('HTTP ' + res.status + ' from /api/backup-status');
    }
    const data = await res.json();
    if (!data || typeof data.healthy !== 'boolean') {
      throw new Error('Malformed response from /api/backup-status (no healthy flag)');
    }
    renderBackupStatus(data.healthy ? 'healthy' : 'unhealthy', data);
  } catch (err) {
    console.error('Backup status check failed:', err);
    renderBackupStatus('unavailable', { error: err && err.message ? err.message : String(err) });
  } finally {
    backupStatusInFlight = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (typeof lucide !== 'undefined') lucide.createIcons();
  switchParentTab('overview'); // WI-14: default to the Overview tab (hides the other four)
  if (APP_ENV.isBeta) {
    const banner = document.getElementById('beta-sandbox-banner');
    if (banner) banner.classList.remove('hidden');
  }
  renderParentMetrics();
  // initCustomDomainSkills() was deleted by 7b22ff6 along with the custom
  // domain/skill picker UI, but its call site was left behind -- a
  // ReferenceError that killed every call below it. The function has no
  // surviving consumers, so the dangling call is removed rather than
  // resurrected (WI-08.5).
  setGapCount(20);
  syncParentFromCloud(false);
  updateParentSyncStatusBadge();
  refreshBackupStatus();
});

function renderParentMetrics() {
  const isSampleActive = (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.isDemoModeActive) ? PSAT_ENGINE.isDemoModeActive() : (localStorage.getItem('psat_sample_data_active') === 'true');
  const demoBanner = document.getElementById('parent-demo-mode-banner');
  const sampleBtn = document.getElementById('btn-load-sample-data');
  if (demoBanner) {
    if (isSampleActive) demoBanner.classList.remove('hidden');
    else demoBanner.classList.add('hidden');
  }
  if (sampleBtn) {
    if (isSampleActive) {
      sampleBtn.classList.add('hidden');
    } else {
      sampleBtn.classList.remove('hidden');
    }
  }

  const questions = window.QUESTIONS_DATA || [];
  const progress = safeGetStorage('psat_progress', {});
  const srsState = safeGetStorage('psat_srs', {});
  const sessionsState = safeGetStorage('psat_sessions', {});
  
  let totalAttempted = 0;
  let totalCorrect = 0;
  let flaggedCount = 0;

  const domainStats = {};
  const skillStats = {};

  questions.forEach(q => {
    const p = progress[q.id];
    if (!domainStats[q.domain]) {
      domainStats[q.domain] = { test: q.test, correct: 0, attempted: 0, total: 0 };
    }
    domainStats[q.domain].total++;

    if (!skillStats[q.skill]) {
      skillStats[q.skill] = { correct: 0, attempted: 0, total: 0 };
    }
    skillStats[q.skill].total++;

    if (p && p.answered) {
      totalAttempted++;
      domainStats[q.domain].attempted++;
      skillStats[q.skill].attempted++;

      if (p.isCorrect) {
        totalCorrect++;
        domainStats[q.domain].correct++;
        skillStats[q.skill].correct++;
      }
    }
    if (p && p.isFlagged) flaggedCount++;
  });

  const overallAcc = totalAttempted > 0 ? Math.round((totalCorrect / totalAttempted) * 100) : 0;
  document.getElementById('stat-total-attempted').innerText = `${totalAttempted} / ${questions.length}`;
  document.getElementById('stat-overall-accuracy').innerText = `${overallAcc}%`;
  document.getElementById('stat-flagged-count').innerText = flaggedCount;

  // Top Weakness (min 3 attempts)
  let topWeakness = 'None yet';
  let lowestAcc = 999;
  Object.entries(skillStats).forEach(([skill, data]) => {
    if (data.attempted >= 3) {
      const acc = data.correct / data.attempted;
      if (acc < 0.75 && acc < lowestAcc) {
        lowestAcc = acc;
        topWeakness = `${skill} (${Math.round(acc * 100)}%)`;
      }
    }
  });
  document.getElementById('stat-top-weakness').innerText = topWeakness;

  // Real Streak Calculation (Local Dates)
  const streak = PSAT_ENGINE.calculateStreak(sessionsState);
  document.getElementById('hero-streak').innerText = `${streak} Day${streak === 1 ? '' : 's'}`;

  // Past 7 Days Practice Duration (Local Dates)
  let past7DaysMs = 0;
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dStr = PSAT_ENGINE.localDateKey(d);
    if (sessionsState[dStr]) {
      past7DaysMs += sessionsState[dStr].totalTimeMs || 0;
    }
  }
  const studyMins = Math.round(past7DaysMs / 60000);
  document.getElementById('hero-study-time').innerText = `${studyMins} mins / 120 min goal`;
  const progressPct = Math.min(100, Math.round((studyMins / 120) * 100)); // 120 min weekly goal
  document.getElementById('hero-progress-bar').style.width = `${progressPct}%`;

  // Real SRS Due Count
  const now = Date.now();
  const dueCardsCount = Object.values(srsState).filter(c => c.dueAt <= now).length;
  document.getElementById('hero-srs-due').innerText = `${dueCardsCount} Question${dueCardsCount === 1 ? '' : 's'}`;

  let weakSkillsCount = 0;
  Object.entries(skillStats).forEach(([skill, data]) => {
    if (data.attempted >= 2 && (data.correct / data.attempted) < 0.75) {
      weakSkillsCount++;
    }
  });
  if (document.getElementById('gap-due-srs')) document.getElementById('gap-due-srs').innerText = dueCardsCount;
  if (document.getElementById('gap-weak-skills')) document.getElementById('gap-weak-skills').innerText = weakSkillsCount;

  // Real PSAT 8/9 Scaled Score (240–1440 scale)
  const scoreData = PSAT_ENGINE.calculateScaledScore(questions, progress);
  if (scoreData.isReady) {
    document.getElementById('hero-scaled-score').innerText = scoreData.totalScore;
    const totalRangeStr = scoreData.totalRangeFormatted ? ` (Likely Range: ${scoreData.totalRangeFormatted}, ${scoreData.confidenceInterval || '90% Confidence'})` : '';
    const sampleNote = scoreData.isLowSample ? ' • Wide range due to sample size (<30 attempts per section).' : '';
    const difficultyNote = ' Estimated from your practice mix, which is harder than a real test form (~60% Hard).';
    document.getElementById('hero-score-subtext').innerText = `Estimated from ${scoreData.rwAttempted} Reading/Writing and ${scoreData.mathAttempted} Math questions${totalRangeStr}.${sampleNote}${difficultyNote} (RW: ${scoreData.rwScore}, Math: ${scoreData.mathScore})`;
  } else {
    document.getElementById('hero-scaled-score').innerText = '—';
    document.getElementById('hero-score-subtext').innerText = `Needs at least ${scoreData.minRequiredPerSection} questions attempted per section (current: ${scoreData.rwAttempted} RW, ${scoreData.mathAttempted} Math).`;
  }

  const elaBadge = document.getElementById('ela-section-score');
  if (scoreData.rwReady) {
    const rwRangeStr = scoreData.rwRangeFormatted ? ` (${scoreData.rwRangeFormatted})` : '';
    elaBadge.innerText = `Est. Section Score: ${scoreData.rwScore} / 720${rwRangeStr}`;
    elaBadge.className = 'badge badge-success';
  } else {
    elaBadge.innerText = `${scoreData.rwAttempted} / ${scoreData.minRequiredPerSection} questions attempted`;
    elaBadge.className = 'badge badge-neutral';
  }

  const mathBadge = document.getElementById('math-section-score');
  if (scoreData.mathReady) {
    const mathRangeStr = scoreData.mathRangeFormatted ? ` (${scoreData.mathRangeFormatted})` : '';
    mathBadge.innerText = `Est. Section Score: ${scoreData.mathScore} / 720${mathRangeStr}`;
    mathBadge.className = 'badge badge-success';
  } else {
    mathBadge.innerText = `${scoreData.mathAttempted} / ${scoreData.minRequiredPerSection} questions attempted`;
    mathBadge.className = 'badge badge-neutral';
  }

  // Render Domain Bars
  const elaContainer = document.getElementById('ela-domain-bars');
  const mathContainer = document.getElementById('math-domain-bars');
  elaContainer.innerHTML = '';
  mathContainer.innerHTML = '';

  Object.entries(domainStats).forEach(([domain, data]) => {
    const acc = data.attempted > 0 ? Math.round((data.correct / data.attempted) * 100) : 0;
    const barColor = acc >= 75 ? 'bg-emerald-500' : (acc >= 50 ? 'bg-amber-500' : 'bg-indigo-500');

    const el = document.createElement('div');
    el.className = 'space-y-1.5';
    el.innerHTML = `
      <div class="flex justify-between text-xs font-semibold">
        <span class="text-slate-800">${esc(domain)}</span>
        <span class="text-slate-500">${data.attempted > 0 ? `${acc}% (${data.correct}/${data.attempted})` : `${data.total} Qs total`}</span>
      </div>
      <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
        <div class="${barColor} h-2 rounded-full transition-all" style="width: ${data.attempted > 0 ? acc : 0}%"></div>
      </div>
    `;

    if (data.test === 'Reading and Writing') {
      elaContainer.appendChild(el);
    } else {
      mathContainer.appendChild(el);
    }
  });

  // Render Trouble Spots & Recurring Mistake Log
  renderTroubleSpots();

  // Render Completed Exams List
  renderParentExamHistory();

  // Update Gap Test Builder metrics & focus calculations
  updateGapTestCalculations();

  // Dynamic Top Recommendation
  const recTitle = document.getElementById('parent-rec-title');
  const recDesc = document.getElementById('parent-rec-desc');
  const recCta = document.getElementById('parent-rec-cta');
  if (recTitle && recDesc && recCta) {
    if (dueCardsCount > 0) {
      recTitle.innerText = `Review ${dueCardsCount} Due Spaced Repetition Card${dueCardsCount === 1 ? '' : 's'}`;
      recDesc.innerText = 'Memory retention decay is active for these questions. Clearing due cards prevents learning loss.';
      recCta.innerText = 'Clear Due Cards →';
      recCta.href = 'index.html?mode=practice&filter=due';
    } else if (weakSkillsCount > 0) {
      recTitle.innerText = `Target ${weakSkillsCount} Weak Learning Skill${weakSkillsCount === 1 ? '' : 's'}`;
      recDesc.innerText = 'The student has sub-75% accuracy in key skills. Launch a targeted gap drill to build mastery.';
      recCta.innerText = 'Launch Weakness Drill →';
      recCta.href = '#bview-gap';
    } else if (totalAttempted < 50) {
      recTitle.innerText = 'Take a Quick Mini PSAT 8/9 Diagnostic';
      recDesc.innerText = 'Complete an 8-question timed simulation to calibrate the student\'s scaled score prediction.';
      recCta.innerText = 'Start Mini Exam →';
      recCta.href = 'index.html?mode=mini_psat89';
    } else {
      recTitle.innerText = 'Simulate Full-Length Official Exam';
      recDesc.innerText = 'Great progress! Take a full standard PSAT 8/9 simulation to test test-taking stamina and timing.';
      recCta.innerText = 'Start Full Exam →';
      recCta.href = 'index.html?mode=psat89';
    }
  }
}

function renderParentExamHistory() {
  const container = document.getElementById('parent-exam-history-container');
  const badge = document.getElementById('parent-exam-count-badge');
  if (!container) return;

  const history = safeGetStorage('psat_exam_history', []).filter(h => h && (h.examId || h.completedAt));
  if (badge) badge.innerText = `${history.length} Completed Test${history.length === 1 ? '' : 's'}`;

  if (history.length === 0) {
    container.innerHTML = `
      <div class="p-6 rounded-2xl bg-slate-50 border border-slate-200 text-center space-y-2">
        <i data-lucide="award" class="w-8 h-8 mx-auto text-slate-300"></i>
        <p class="text-xs font-semibold text-slate-600">No completed exams found yet.</p>
        <p class="text-[11px] text-slate-400">When your student completes a standard PSAT 8/9 exam or practice drill, their score report and question analysis will appear here.</p>
      </div>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  container.innerHTML = '';
  history.forEach((h, idx) => {
    const div = document.createElement('div');
    div.className = 'card flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 hover:border-indigo-200 transition-all';

    const totalSec = Math.round((h.totalTimeSpentMs || 0) / 1000);
    const timeStr = (h.totalTimeSpentMs && h.totalTimeSpentMs > 0) ? 
      (totalSec < 3600 ? `${Math.floor(totalSec / 60)}m ${totalSec % 60}s` : `${Math.floor(totalSec / 3600)}h ${Math.floor((totalSec % 3600) / 60)}m`) : '—';
    const isStandard = (h.type === 'standard_psat89');
    const accPercent = (typeof h.overallAccuracyPercent === 'number') ? h.overallAccuracyPercent : ((h.totalQuestions && h.totalQuestions > 0) ? Math.round(((h.totalCorrect || 0) / h.totalQuestions) * 100) : 0);

    let rwTotal = 0, rwCorrect = 0, mathTotal = 0, mathCorrect = 0;
    if (Array.isArray(h.moduleReports)) {
      h.moduleReports.forEach(m => {
        (m.questions || []).forEach(q => {
          const qMeta = (window.QUESTIONS_DATA || []).find(item => item.id === (q.questionId || q.id)) || q;
          const isMath = (qMeta.test === 'Math' || qMeta.section === 'Math' || (m.section && m.section.indexOf('Math') !== -1));
          if (isMath) {
            mathTotal++;
            if (q.isCorrect) mathCorrect++;
          } else {
            rwTotal++;
            if (q.isCorrect) rwCorrect++;
          }
        });
      });
    }
    if (rwTotal === 0 && mathTotal === 0 && h.scores) {
      rwTotal = h.scores.rwTotal || 0;
      rwCorrect = h.scores.rwCorrect || 0;
      mathTotal = h.scores.mathTotal || 0;
      mathCorrect = h.scores.mathCorrect || 0;
    }

    const hasScaled = (h.scores?.isScaledReady !== false && h.scores?.totalScaled !== null && h.scores?.totalScaled !== undefined);
    const rwPct = rwTotal > 0 ? Math.round((rwCorrect / rwTotal) * 100) : 0;
    const mathPct = mathTotal > 0 ? Math.round((mathCorrect / mathTotal) * 100) : 0;

    const rwText = hasScaled ? `${h.scores?.rwScaled} / 720` : (rwTotal > 0 ? `${rwCorrect}/${rwTotal} Correct (${rwPct}%)` : '—');
    const mathText = hasScaled ? `${h.scores?.mathScaled} / 720` : (mathTotal > 0 ? `${mathCorrect}/${mathTotal} Correct (${mathPct}%)` : '—');
    const scoreBlock = hasScaled ?
      `<span class="text-[10px] text-slate-400 uppercase font-semibold block">Composite Scaled Score</span>
       <span class="text-3xl font-black text-slate-900">${h.scores?.totalScaled}<span class="text-sm font-normal text-slate-400">/1440</span></span>` :
      `<span class="text-[10px] text-slate-400 uppercase font-semibold block">Practice Accuracy</span>
       <span class="text-2xl font-black text-indigo-900">${h.totalCorrect || 0}/${h.totalQuestions || 0} <span class="text-xs font-semibold text-slate-500">(${accPercent}%)</span></span>`;

    div.innerHTML = `
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <span class="px-2.5 py-0.5 rounded-md text-[11px] font-bold ${isStandard ? 'bg-emerald-100 text-emerald-800' : 'bg-indigo-100 text-indigo-800'}">
            ${esc(h.title || 'Practice Exam')}
          </span>
          <span class="text-xs text-slate-400 font-mono"><i data-lucide="calendar" class="w-3.5 h-3.5 inline mr-1 text-slate-400"></i> ${esc(h.formattedDate || (h.completedAt ? new Date(h.completedAt).toLocaleDateString() : 'Recent'))}</span>
        </div>
        
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs text-slate-700 pt-1">
          <div class="bg-white p-2.5 rounded-xl border border-slate-200/80">
            <span class="text-[10px] uppercase font-semibold text-slate-400 block">Overall Accuracy</span>
            <span class="font-bold text-slate-900">${accPercent}% (${h.totalCorrect || 0}/${h.totalQuestions || 0})</span>
          </div>
          <div class="bg-white p-2.5 rounded-xl border border-slate-200/80">
            <span class="text-[10px] uppercase font-semibold text-slate-400 block">Reading & Writing</span>
            <span class="font-bold text-indigo-700">${rwText}</span>
          </div>
          <div class="bg-white p-2.5 rounded-xl border border-slate-200/80">
            <span class="text-[10px] uppercase font-semibold text-slate-400 block">Math Section</span>
            <span class="font-bold text-emerald-700">${mathText}</span>
          </div>
          <div class="bg-white p-2.5 rounded-xl border border-slate-200/80">
            <span class="text-[10px] uppercase font-semibold text-slate-400 block">Total Exam Time</span>
            <span class="font-bold font-mono text-slate-900">${timeStr}</span>
          </div>
        </div>
      </div>

      <div class="flex flex-col sm:flex-row items-center lg:flex-col lg:items-end justify-between lg:justify-center gap-3 shrink-0 pt-2 lg:pt-0 border-t lg:border-t-0 border-slate-200">
        <div class="text-left lg:text-right">
          ${scoreBlock}
        </div>
        <button onclick="openParentExamReview('${h.examId}')" class="btn btn-sm btn-primary">
          <i data-lucide="file-search" class="w-4 h-4 mr-1.5"></i> Inspect Full Test Review &rarr;
        </button>
      </div>
    `;
    container.appendChild(div);
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderTroubleSpots() {
  const badge = document.getElementById('trouble-count-badge');
  const drillCount = document.getElementById('btn-drill-count');

  const progress = safeGetStorage('psat_progress', {});
  const examHistory = safeGetStorage('psat_exam_history', []);
  const questionsData = window.QUESTIONS_DATA || [];
  const qMap = {};
  questionsData.forEach(q => { qMap[q.id] = q; });

  // Aggregate mistakes
  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.buildTroubleSpots) {
    allTroubleList = PSAT_ENGINE.buildTroubleSpots(progress, examHistory, questionsData);
  } else {
    const troubleMap = {};
    Object.entries(progress).forEach(([qid, p]) => {
      if (p && p.answered && !p.isCorrect) {
        troubleMap[qid] = {
          questionId: qid,
          question: qMap[qid] || {},
          timesWrong: p.timesIncorrect || 1,
          timesCorrect: p.timesCorrect || 0,
          timesSeen: p.timesSeen || 1,
          lastUserAnswer: p.selectedAnswer || 'Unanswered',
          lastAttemptTime: p.timestamp || Date.now(),
          lastTimeSpentMs: p.timeSpentMs || 0
        };
      }
    });
    allTroubleList = Object.values(troubleMap);
  }

  const totalCount = allTroubleList.length;
  if (badge) badge.innerText = `${totalCount} Question${totalCount === 1 ? '' : 's'} Missed`;
  if (drillCount) drillCount.innerText = totalCount;

  renderTroubleDomainChips();
}

function renderTroubleDomainChips() {
  const chipsContainer = document.getElementById('trouble-domain-chips');
  if (!chipsContainer) return;

  const domainCounts = {};
  allTroubleList.forEach(t => {
    const dom = t.question?.domain || 'General';
    domainCounts[dom] = (domainCounts[dom] || 0) + 1;
  });

  const domainsSorted = Object.keys(domainCounts).sort((a, b) => domainCounts[b] - domainCounts[a]);

  chipsContainer.innerHTML = '';
  
  // All Domains chip
  const allLink = document.createElement('a');
  allLink.href = 'mistakes.html';
  allLink.className = 'btn btn-sm btn-primary is-active';
  allLink.innerHTML = `<i data-lucide="layers" class="w-3.5 h-3.5 mr-1.5"></i> All Missed (${allTroubleList.length})`;
  chipsContainer.appendChild(allLink);

  domainsSorted.forEach(dom => {
    const count = domainCounts[dom];
    const link = document.createElement('a');
    link.href = `mistakes.html`;
    link.className = 'btn btn-sm btn-secondary';
    link.innerHTML = `<span>${esc(dom)}</span>&nbsp;<span class="text-rose-600 font-bold">(${count})</span>`;
    chipsContainer.appendChild(link);
  });

  // Populate Root-Cause Error Tags & Longitudinal Trends
  const tagContainer = document.getElementById('trouble-tag-chips');
  if (tagContainer && typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.aggregateErrorTags && PSAT_ENGINE.ERROR_TAGS) {
    const progress = safeGetStorage('psat_progress', {});
    const examHistory = safeGetStorage('psat_exam_history', []);
    const tagSummary = PSAT_ENGINE.aggregateErrorTags(allTroubleList);
    const trends = typeof PSAT_ENGINE.calculateErrorTagTrends === 'function' ? PSAT_ENGINE.calculateErrorTagTrends(progress, examHistory) : null;
    tagContainer.innerHTML = '';
    Object.entries(PSAT_ENGINE.ERROR_TAGS).forEach(([key, info]) => {
      const count = tagSummary.counts[key] || 0;
      if (count > 0) {
        const curW = trends && trends.currentWeek ? (trends.currentWeek[key] || 0) : 0;
        const priW = trends && trends.priorWeek ? (trends.priorWeek[key] || 0) : 0;
        let trendBadge = '';
        if (curW < priW) {
          trendBadge = `<span class="ml-1.5 text-[10px] text-emerald-700 bg-emerald-100 px-1 py-0.5 rounded-sm font-bold">↓ ${priW - curW} this week</span>`;
        } else if (curW > priW && priW > 0) {
          trendBadge = `<span class="ml-1.5 text-[10px] text-rose-700 bg-rose-100 px-1 py-0.5 rounded-sm font-bold">↑ ${curW - priW} this week</span>`;
        }
        const span = document.createElement('span');
        span.className = 'px-2.5 py-1 rounded-lg border bg-rose-50 text-rose-900 border-rose-200 text-xs font-semibold flex items-center shadow-2xs';
        span.innerHTML = `<span>${esc(info.label)}</span>&nbsp;<strong>(${count})</strong>${trendBadge}`;
        tagContainer.appendChild(span);
      }
    });
    if (tagSummary.counts.untagged > 0) {
      const untaggedSpan = document.createElement('span');
      untaggedSpan.className = 'px-2.5 py-1 rounded-lg border bg-slate-50 text-slate-600 border-slate-200 text-xs font-semibold';
      untaggedSpan.innerHTML = `Untagged: <strong>(${tagSummary.counts.untagged})</strong>`;
      tagContainer.appendChild(untaggedSpan);
    }
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function openMistakeRationaleModal(qid) {
  const q = (window.QUESTIONS_DATA || []).find(item => item.id === qid);
  if (!q) {
    alert('Question details not found.');
    return;
  }
  const progress = safeGetStorage('psat_progress', {})[qid] || {};
  const isMath = (q.test === 'Math' || q.section === 'Math');
  const diffColor = q.difficulty === 'Hard' ? 'bg-rose-100 text-rose-800' : (q.difficulty === 'Medium' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800');

  document.getElementById('pmd-modal-id').innerText = `QID: ${q.id}`;
  document.getElementById('pmd-modal-title').innerText = `${q.domain || ''} &bull; ${q.skill || ''}`;

  const exBar = document.getElementById('pmd-explainer-link');
  if (exBar) {
    const ex = explainerFor(q.id);
    if (ex) {
      exBar.href = ex.url;
      exBar.classList.remove('hidden');
      exBar.classList.add('flex');
    } else {
      exBar.classList.add('hidden');
      exBar.classList.remove('flex');
    }
  }

  const content = document.getElementById('pmd-modal-content');
  let optionsHtml = '';
  if (Array.isArray(q.options) && q.options.length > 0) {
    optionsHtml = `
      <div class="space-y-2 pt-2">
        <h5 class="text-xs font-bold text-slate-700 uppercase tracking-wider">Answer Choices</h5>
        <div class="space-y-2">
          ${q.options.map(opt => {
            const isCorrect = String(opt.key).trim().toUpperCase() === String(q.correct_answer).trim().toUpperCase();
            const isUser = progress.selectedAnswer && String(opt.key).trim().toUpperCase() === String(progress.selectedAnswer).trim().toUpperCase();
            let borderClass = 'border-slate-200 bg-white';
            let icon = '';
            if (isCorrect) {
              borderClass = 'border-emerald-500 bg-emerald-50/70 font-semibold text-emerald-950';
              icon = '<span class="px-2 py-0.5 bg-emerald-600 text-white text-[10px] font-bold rounded-md ml-2">Correct Answer ✓</span>';
            } else if (isUser) {
              borderClass = 'border-rose-400 bg-rose-50/70 font-semibold text-rose-950';
              icon = '<span class="px-2 py-0.5 bg-rose-600 text-white text-[10px] font-bold rounded-md ml-2">Student Selected ❌</span>';
            }
            return `
              <div class="p-3.5 rounded-xl border ${borderClass} flex items-start justify-between text-xs">
                <div>
                  <span class="font-bold mr-2 text-slate-800">${esc(opt.key)}.</span>
                  <span class="text-slate-700">${esc(opt.text || '')}</span>
                </div>
                ${icon}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  let imageHtml = '';
  if (q.image_url || q.question_image) {
    const imgSrc = questionImageSrc(q);
    imageHtml = `<div class="p-3 bg-slate-50 rounded-xl border border-slate-200 flex justify-center"><img src="${esc(imgSrc)}" class="max-h-64 object-contain rounded-lg shadow-xs" alt="Question Diagram"></div>`;
  }

  content.innerHTML = `
    <div class="flex flex-wrap items-center gap-2 pb-2 border-b border-slate-100">
      <span class="px-2.5 py-0.5 rounded-md text-[11px] font-bold ${isMath ? 'bg-emerald-100 text-emerald-800' : 'bg-indigo-100 text-indigo-800'}">
        ${esc(q.test || 'Practice')}
      </span>
      <span class="px-2 py-0.5 rounded-md text-[10px] font-bold ${diffColor}">
        ${esc(q.difficulty || 'Medium')}
      </span>
      <span class="text-xs text-slate-500 font-medium">${esc(q.domain || '')} &bull; ${esc(q.skill || '')}</span>
    </div>

    <div class="space-y-3">
      <h5 class="text-xs font-bold text-slate-700 uppercase tracking-wider">Question Prompt</h5>
      <div class="p-4 bg-slate-50 rounded-2xl border border-slate-200 text-xs text-slate-800 leading-relaxed font-serif whitespace-pre-wrap">
        ${esc(q.question_text || q.prompt || '')}
      </div>
    </div>

    ${imageHtml}
    ${optionsHtml}

    ${(typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.renderRationale) ?
      PSAT_ENGINE.renderRationale(q, { userSelectedAnswer: t.lastUserAnswer }) :
      `<div class="p-5 rounded-2xl bg-amber-50/80 border border-amber-200 space-y-2">
        <h5 class="text-xs font-bold text-amber-900 uppercase tracking-wider flex items-center">
          <i data-lucide="book-open" class="w-4 h-4 mr-1.5 text-amber-700"></i> Official Step-by-Step Rationale &amp; Solution
        </h5>
        <div class="text-xs text-amber-950 leading-relaxed font-sans whitespace-pre-wrap">
          ${esc(q.rationale || 'No official explanation provided for this question.')}
        </div>
      </div>`
    }
  `;

  document.getElementById('parent-mistake-detail-modal').classList.remove('hidden');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeMistakeRationaleModal() {
  document.getElementById('parent-mistake-detail-modal').classList.add('hidden');
}

async function downloadCloudBackup() {
  const btn = event?.currentTarget;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(PARENT_API_BASE + '/sync?student_name=default_student');
    if (!res.ok) throw new Error(`HTTP ${res.status}: Cloud backup service unavailable`);
    const cloudData = await res.json();
    
    const backupEnvelope = {
      backupMetadata: {
        source: 'Azure Cosmos DB',
        student_name: 'default_student',
        exportedAt: new Date().toISOString(),
        version: '1.0'
      },
      data: cloudData
    };

    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(backupEnvelope, null, 2));
    const downloadAnchor = document.createElement('a');
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `psat_cosmos_backup_${dateStr}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    alert(`✓ Full Cosmos DB Cloud Backup downloaded successfully!\nFile: psat_cosmos_backup_${dateStr}.json`);
  } catch (err) {
    console.error('Cloud backup download failed:', err);
    alert('Could not download cloud backup: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function openParentExamReview(examId) {
  const history = safeGetStorage('psat_exam_history', []);
  const found = history.find(h => h.examId === examId);
  if (!found) {
    alert('Exam report not found in history.');
    return;
  }
  parentActiveExamReport = PSAT_ENGINE.rehydrateReport(found, window.QUESTIONS_DATA || []);
  
  const accPercent = (typeof found.overallAccuracyPercent === 'number') ? found.overallAccuracyPercent : ((found.totalQuestions && found.totalQuestions > 0) ? Math.round(((found.totalCorrect || 0) / found.totalQuestions) * 100) : 0);
  const hasScaled = (found.scores?.isScaledReady !== false && found.scores?.totalScaled !== null && found.scores?.totalScaled !== undefined);
  document.getElementById('pmod-exam-title').innerText = found.title || 'Practice Exam Score Report';
  document.getElementById('pmod-exam-date').innerText = found.formattedDate || (found.completedAt ? new Date(found.completedAt).toLocaleString() : 'Recent');
  document.getElementById('pmod-exam-score').innerHTML = hasScaled ?
    `${found.scores?.totalScaled} <span class="text-xs font-normal text-slate-400">/ 1440</span>` :
    `${found.totalCorrect || 0} / ${found.totalQuestions || 0} <span class="text-xs font-normal text-slate-400">(${accPercent}%)</span>`;
  document.getElementById('pmod-exam-stats').innerText = `Accuracy: ${accPercent}% (${found.totalCorrect || 0} / ${found.totalQuestions || 0})`;
  let modalRwTotal = 0, modalRwCorrect = 0, modalMathTotal = 0, modalMathCorrect = 0;
  if (Array.isArray(found.moduleReports)) {
    found.moduleReports.forEach(m => {
      (m.questions || []).forEach(q => {
        const qMeta = (window.QUESTIONS_DATA || []).find(item => item.id === (q.questionId || q.id)) || q;
        const isMath = (qMeta.test === 'Math' || qMeta.section === 'Math' || (m.section && m.section.indexOf('Math') !== -1));
        if (isMath) {
          modalMathTotal++;
          if (q.isCorrect) modalMathCorrect++;
        } else {
          modalRwTotal++;
          if (q.isCorrect) modalRwCorrect++;
        }
      });
    });
  }
  if (modalRwTotal === 0 && modalMathTotal === 0 && found.scores) {
    modalRwTotal = found.scores.rwTotal || 0;
    modalRwCorrect = found.scores.rwCorrect || 0;
    modalMathTotal = found.scores.mathTotal || 0;
    modalMathCorrect = found.scores.mathCorrect || 0;
  }
  const modalRwPct = modalRwTotal > 0 ? Math.round((modalRwCorrect / modalRwTotal) * 100) : 0;
  const modalMathPct = modalMathTotal > 0 ? Math.round((modalMathCorrect / modalMathTotal) * 100) : 0;

  document.getElementById('pmod-exam-rw').innerText = hasScaled ? `R&W: ${found.scores?.rwScaled} / 720` : (modalRwTotal > 0 ? `R&W: ${modalRwCorrect}/${modalRwTotal} Correct (${modalRwPct}%)` : 'R&W: —');
  document.getElementById('pmod-exam-math').innerText = hasScaled ? `Math: ${found.scores?.mathScaled} / 720` : (modalMathTotal > 0 ? `Math: ${modalMathCorrect}/${modalMathTotal} Correct (${modalMathPct}%)` : 'Math: —');

  filterParentExamQuestions('all');
  document.getElementById('parent-exam-review-modal').classList.remove('hidden');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeParentExamReview() {
  document.getElementById('parent-exam-review-modal').classList.add('hidden');
}

function filterParentExamQuestions(filter) {
  parentExamFilterMode = filter;
  if (!parentActiveExamReport) return;

  let allReviewedQs = [];
  if (Array.isArray(parentActiveExamReport.moduleReports)) {
    parentActiveExamReport.moduleReports.forEach(m => {
      allReviewedQs = allReviewedQs.concat(m.questions || []);
    });
  }

  const incorrectCount = allReviewedQs.filter(q => !q.isCorrect).length;
  const correctCount = allReviewedQs.filter(q => q.isCorrect).length;

  document.getElementById('pmod-cnt-all').innerText = allReviewedQs.length;
  document.getElementById('pmod-cnt-inc').innerText = incorrectCount;
  document.getElementById('pmod-cnt-cor').innerText = correctCount;

  ['all', 'incorrect', 'correct'].forEach(f => {
    const btn = document.getElementById(`pmod-rf-${f === 'incorrect' ? 'inc' : (f === 'correct' ? 'cor' : 'all')}`);
    if (btn) {
      btn.className = (f === filter) ?
        'px-3 py-1 rounded-lg bg-white text-indigo-700 shadow-xs font-bold transition-all' :
        'px-3 py-1 rounded-lg text-slate-600 hover:text-slate-900 font-semibold transition-all';
    }
  });

  const filteredList = allReviewedQs.filter(q => {
    if (filter === 'incorrect') return !q.isCorrect;
    if (filter === 'correct') return q.isCorrect;
    return true;
  });

  const container = document.getElementById('parent-exam-questions-list');
  container.innerHTML = '';

  if (filteredList.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center text-slate-400 text-xs font-medium">
        No questions matching the selected filter.
      </div>
    `;
    return;
  }

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
          <span class="font-bold block uppercase text-[10px] tracking-wider text-slate-500">Student Answer:</span>
          <span class="font-mono font-bold text-sm">${esc(q.userAnswer)}</span>
        </div>
        <div class="p-3 rounded-xl bg-slate-100 border border-slate-200 text-slate-900">
          <span class="font-bold block uppercase text-[10px] tracking-wider text-slate-500">Official Correct Answer:</span>
          <span class="font-mono font-bold text-sm text-indigo-600">${esc(q.correctAnswer)}</span>
        </div>
      </div>

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

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function switchBuilderTab(tab) {
  ['mini', 'gap', 'psat89'].forEach(t => {
    const view = document.getElementById('bview-' + t);
    const tabEl = document.getElementById('btab-' + t);
    if (view) view.classList.toggle('hidden', t !== tab);
    if (tabEl) tabEl.className = 'btn btn-sm ' + (t === tab ? 'btn-primary is-active' : 'btn-ghost');
  });
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// WI-14 five-tab top-level nav. Sections are tagged with data-ptab in
// parent.html; this shows the active tab's sections and hides the rest.
// Conditional alert banners (backup/demo) carry no data-ptab, so they stay
// visible across tabs. All sections still render on load (data populated even
// while hidden) — this only toggles visibility.
function switchParentTab(tab) {
  document.querySelectorAll('[data-ptab]').forEach(el => {
    el.classList.toggle('hidden', el.getAttribute('data-ptab') !== tab);
  });
  const active = 'tab-active inline-flex items-center px-1 py-3 text-sm font-medium transition-colors';
  const idle = 'text-slate-500 hover:text-slate-700 inline-flex items-center px-1 py-3 text-sm font-medium transition-colors';
  ['overview', 'scores', 'mistakes', 'builder', 'data'].forEach(t => {
    const btn = document.getElementById('ptab-' + t);
    if (btn) btn.className = (t === tab) ? active : idle;
  });
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function updateGapTestCalculations() {
  const questions = window.QUESTIONS_DATA || [];
  const progress = safeGetStorage('psat_progress', {});
  const srsState = safeGetStorage('psat_srs', {});
  const focusSelect = document.getElementById('gap-focus-type');
  const focusType = focusSelect ? focusSelect.value : 'all';

  const metrics = (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.calculateGapFocusMetrics) ?
    PSAT_ENGINE.calculateGapFocusMetrics(questions, progress, srsState, focusType) :
    {
      statLabel1: 'Due SRS Cards',
      statValue1: Object.values(srsState).filter(c => c.dueAt <= Date.now()).length,
      statLabel2: 'Weak Skills',
      statValue2: 0,
      matchingPoolCount: questions.length,
      focusDescription: 'Comprehensive Gap Drill across all question domains.',
      focusShortName: 'Gap Drill'
    };

  if (document.getElementById('gap-stat-label-1')) document.getElementById('gap-stat-label-1').innerText = metrics.statLabel1;
  if (document.getElementById('gap-due-srs')) document.getElementById('gap-due-srs').innerText = metrics.statValue1;
  if (document.getElementById('gap-stat-label-2')) document.getElementById('gap-stat-label-2').innerText = metrics.statLabel2;
  if (document.getElementById('gap-weak-skills')) document.getElementById('gap-weak-skills').innerText = metrics.statValue2;

  if (document.getElementById('gap-focus-desc')) document.getElementById('gap-focus-desc').innerText = metrics.focusDescription;
  if (document.getElementById('gap-focus-pool-badge')) document.getElementById('gap-focus-pool-badge').innerText = `${metrics.matchingPoolCount.toLocaleString()} in Pool`;
  if (document.getElementById('gap-est-time')) document.getElementById('gap-est-time').innerText = `${Math.round(currentGapCount * 1.5)} minutes`;

  const summaryBox = document.getElementById('gap-focus-summary-box');
  const focusIcon = document.getElementById('gap-focus-icon');
  const poolBadge = document.getElementById('gap-focus-pool-badge');

  if (summaryBox && focusIcon && poolBadge) {
    if (focusType === 'math_only') {
      summaryBox.className = 'p-4 bg-emerald-50 border border-emerald-200 rounded-xl flex flex-col gap-3 text-xs text-emerald-950 transition-all';
      focusIcon.setAttribute('data-lucide', 'calculator');
      applyClass(focusIcon, 'w-4 h-4 text-emerald-600 shrink-0');
      poolBadge.className = 'font-bold text-emerald-700 bg-white px-2.5 py-1 rounded-lg border border-emerald-200 shrink-0 text-center';
    } else if (focusType === 'rw_only') {
      summaryBox.className = 'p-4 bg-indigo-50 border border-indigo-200 rounded-xl flex flex-col gap-3 text-xs text-indigo-950 transition-all';
      focusIcon.setAttribute('data-lucide', 'book-open');
      applyClass(focusIcon, 'w-4 h-4 text-indigo-600 shrink-0');
      poolBadge.className = 'font-bold text-indigo-700 bg-white px-2.5 py-1 rounded-lg border border-indigo-200 shrink-0 text-center';
    } else if (focusType === 'srs_only') {
      summaryBox.className = 'p-4 bg-amber-50 border border-amber-200 rounded-xl flex flex-col gap-3 text-xs text-amber-950 transition-all';
      focusIcon.setAttribute('data-lucide', 'clock');
      applyClass(focusIcon, 'w-4 h-4 text-amber-600 shrink-0');
      poolBadge.className = 'font-bold text-amber-700 bg-white px-2.5 py-1 rounded-lg border border-amber-200 shrink-0 text-center';
    } else if (focusType === 'weak_only') {
      summaryBox.className = 'p-4 bg-rose-50 border border-rose-200 rounded-xl flex flex-col gap-3 text-xs text-rose-950 transition-all';
      focusIcon.setAttribute('data-lucide', 'alert-triangle');
      applyClass(focusIcon, 'w-4 h-4 text-rose-600 shrink-0');
      poolBadge.className = 'font-bold text-rose-700 bg-white px-2.5 py-1 rounded-lg border border-rose-200 shrink-0 text-center';
    } else {
      summaryBox.className = 'p-4 bg-indigo-50/70 border border-indigo-100 rounded-xl flex flex-col gap-3 text-xs text-indigo-950 transition-all';
      focusIcon.setAttribute('data-lucide', 'target');
      applyClass(focusIcon, 'w-4 h-4 text-indigo-600 shrink-0');
      poolBadge.className = 'font-bold text-indigo-700 bg-white px-2.5 py-1 rounded-lg border border-indigo-200 shrink-0 text-center';
    }
  }

  // Domain Breakdown Chips
  const chipsContainer = document.getElementById('gap-focus-domain-chips');
  if (chipsContainer) {
    chipsContainer.innerHTML = '';
    const matchingQuestions = (focusType === 'math_only') ? questions.filter(q => q.test === 'Math') :
      (focusType === 'rw_only') ? questions.filter(q => q.test === 'Reading and Writing') :
      (focusType === 'srs_only') ? questions.filter(q => srsState[q.id] && (srsState[q.id].repetitions > 0 || (srsState[q.id].dueAt && srsState[q.id].dueAt <= Date.now()))) :
      (focusType === 'weak_only') ? questions.filter(q => (progress[q.id] && progress[q.id].answered && !progress[q.id].isCorrect)) : questions;

    const domainCounts = {};
    matchingQuestions.forEach(q => {
      const dom = q.domain || (q.test === 'Math' ? 'Math' : 'Reading & Writing');
      domainCounts[dom] = (domainCounts[dom] || 0) + 1;
    });

    Object.entries(domainCounts).forEach(([dom, count]) => {
      const chip = document.createElement('span');
      chip.className = 'px-2 py-0.5 rounded-md bg-white/80 border border-current/20 text-[11px] font-semibold flex items-center';
      chip.innerText = `${dom} (${count.toLocaleString()})`;
      chipsContainer.appendChild(chip);
    });
  }

  const launchBtn = document.getElementById('btn-launch-gap');
  if (launchBtn) {
    launchBtn.innerHTML = `<i data-lucide="play" class="w-4 h-4 mr-1.5"></i> Launch ${metrics.focusShortName} (${currentGapCount} Qs) in Student App`;
  }

  // Also update the bottom top recommendation banner to match target focus
  const recTitle = document.getElementById('parent-rec-title');
  const recDesc = document.getElementById('parent-rec-desc');
  const recCta = document.getElementById('parent-rec-cta');
  if (recTitle && recDesc && recCta) {
    if (focusType === 'math_only') {
      recTitle.innerText = `Target Math Focus Drill (${currentGapCount} Qs)`;
      recDesc.innerText = `Focuses on ${metrics.statValue2} weak Math skills and ${metrics.statValue1} due cards across Algebra, Advanced Math, Problem Solving, and Geometry.`;
      recCta.innerText = 'Launch Math Drill →';
      recCta.href = `index.html?mode=gap_drill&count=${currentGapCount}&focus=math_only`;
    } else if (focusType === 'rw_only') {
      recTitle.innerText = `Target Reading & Writing Focus Drill (${currentGapCount} Qs)`;
      recDesc.innerText = `Focuses on ${metrics.statValue2} weak R&W skills and ${metrics.statValue1} due cards across Information & Ideas, Craft & Structure, and Grammar.`;
      recCta.innerText = 'Launch R&W Drill →';
      recCta.href = `index.html?mode=gap_drill&count=${currentGapCount}&focus=rw_only`;
    } else if (focusType === 'srs_only') {
      recTitle.innerText = `Clear Spaced Repetition Due Queue (${metrics.statValue1} Cards)`;
      recDesc.innerText = 'Clear overdue SM-2 spaced repetition review cards to prevent memory decay on difficult concepts.';
      recCta.innerText = 'Clear Due Cards →';
      recCta.href = `index.html?mode=gap_drill&count=${currentGapCount}&focus=srs_only`;
    } else if (focusType === 'weak_only') {
      recTitle.innerText = `Remediate Weak Skills & Error Patterns (${metrics.statValue1} Skills)`;
      recDesc.innerText = 'Target skills with <75% accuracy and previously missed items to turn weaknesses into strengths.';
      recCta.innerText = 'Remediate Weaknesses →';
      recCta.href = `index.html?mode=gap_drill&count=${currentGapCount}&focus=weak_only`;
    } else {
      recTitle.innerText = `Comprehensive Diagnostic Gap Drill (${currentGapCount} Qs)`;
      recDesc.innerText = 'Balanced practice module combining spaced repetition due cards, weak skills remediation, and unpracticed coverage.';
      recCta.innerText = 'Start Gap Drill →';
      recCta.href = `index.html?mode=gap_drill&count=${currentGapCount}&focus=all`;
    }
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function setGapCount(c) {
  currentGapCount = c;
  [10, 20, 30, 50].forEach(n => {
    const btn = document.getElementById(`gap-c-${n}`);
    if (btn) btn.className = 'btn btn-md ' + (n === c ? 'btn-primary is-active' : 'btn-secondary');
  });
  updateGapTestCalculations();
}

function launchGapDrill() {
  const questions = window.QUESTIONS_DATA || [];
  const progress = safeGetStorage('psat_progress', {});
  const srsState = safeGetStorage('psat_srs', {});
  const focusType = document.getElementById('gap-focus-type').value;
  const diffFilter = document.getElementById('gap-diff-filter') ? document.getElementById('gap-diff-filter').value : 'All';
  const typeFilter = document.getElementById('gap-type-filter') ? document.getElementById('gap-type-filter').value : 'all';

  const drill = PSAT_ENGINE.generateGapTargetedDrill(questions, progress, srsState, {
    count: currentGapCount,
    focus: focusType,
    difficulty: diffFilter,
    questionType: typeFilter
  });
  sessionStorage.setItem('psat_active_custom_test', JSON.stringify(drill));
  window.location.href = 'index.html?mode=custom';
}

function launchCustomTest() {
  launchGapDrill();
}

function launchStandardExamFromParent() {
  const isAdaptive = document.getElementById('std-adaptive-toggle') ? document.getElementById('std-adaptive-toggle').checked : true;
  const isHighYield = document.getElementById('std-highyield-toggle') ? document.getElementById('std-highyield-toggle').checked : true;
  window.location.href = `index.html?mode=psat89&adaptive=${isAdaptive}&highyield=${isHighYield}`;
}

function launchMiniExamFromParent() {
  const isAdaptive = document.getElementById('mini-adaptive-toggle') ? document.getElementById('mini-adaptive-toggle').checked : true;
  const isHighYield = document.getElementById('mini-highyield-toggle') ? document.getElementById('mini-highyield-toggle').checked : true;
  window.location.href = `index.html?mode=mini_psat89&adaptive=${isAdaptive}&highyield=${isHighYield}`;
}

function copyShareableTestLink(type) {
  let url = window.location.origin + window.location.pathname.replace('parent.html', 'index.html');
  if (type === 'mini_psat89' || type === 'mini') {
    const isAdaptive = document.getElementById('mini-adaptive-toggle') ? document.getElementById('mini-adaptive-toggle').checked : true;
    const isHighYield = document.getElementById('mini-highyield-toggle') ? document.getElementById('mini-highyield-toggle').checked : true;
    url += `?mode=mini_psat89&adaptive=${isAdaptive}&highyield=${isHighYield}`;
  } else if (type === 'psat89') {
    const isAdaptive = document.getElementById('std-adaptive-toggle') ? document.getElementById('std-adaptive-toggle').checked : true;
    const isHighYield = document.getElementById('std-highyield-toggle') ? document.getElementById('std-highyield-toggle').checked : true;
    url += `?mode=psat89&adaptive=${isAdaptive}&highyield=${isHighYield}`;
  } else if (type === 'gap') {
    url += `?mode=gap_drill&count=${currentGapCount}&focus=${document.getElementById('gap-focus-type').value}`;
  } else if (type === 'custom') {
    const diffVal = document.getElementById('cust-diff').value;
    const countVal = document.getElementById('cust-count').value;
    const skillsStr = Array.from(selectedSkillsSet).join(',');
    url += `?mode=custom_filter&diff=${encodeURIComponent(diffVal)}&count=${countVal}&skills=${encodeURIComponent(skillsStr)}`;
  }

  navigator.clipboard.writeText(url).then(() => {
    alert('Copied shareable test link to clipboard!\n' + url);
  }).catch(() => {
    prompt('Copy this shareable test link:', url);
  });
}

function loadSampleDiagnosticSession() {
  const isAlreadyActive = (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.isDemoModeActive) ? PSAT_ENGINE.isDemoModeActive() : (localStorage.getItem('psat_sample_data_active') === 'true');
  if (isAlreadyActive) {
    alert('Sample diagnostic data is already active.\n\nTo restore your real practice data, click the "Restore My Real Data" button in the demo banner.');
    return;
  }

  const msg = 'Load realistic sample diagnostic session data?\n\n' +
              '⚠️ NOTE: Your existing practice attempts and exam reports will be safely archived into a local backup, allowing you to restore your real data at any time with one click.';
  if (!confirm(msg)) return;

  const questions = window.QUESTIONS_DATA || [];
  if (questions.length === 0) return;

  // 1. Mandatory Pre-Action Safety Snapshot Guard
  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.createClientSnapshot) {
    const snap = PSAT_ENGINE.createClientSnapshot(localStorage, 'pre_sample_data_activation');
    if (!snap.success) {
      alert('❌ Action Cancelled: Could not create pre-sample safety snapshot (' + snap.error + '). Your real student records have not been modified.');
      return;
    }
  }

  const samplePayload = (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.generateSampleDiagnosticPayload) ?
    PSAT_ENGINE.generateSampleDiagnosticPayload(questions, PSAT_ENGINE.localDateKey()) :
    null;

  if (!samplePayload) {
    alert('Could not generate sample payload.');
    return;
  }

  const result = (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.runTransactionalAction) ?
    PSAT_ENGINE.runTransactionalAction(localStorage, 'load_sample_data', function(ctx) {
      if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.backupRealData) {
        PSAT_ENGINE.backupRealData(localStorage, safeGetStorage, safeSetStorage, window.location);
      }
      localStorage.setItem(APP_ENV.storagePrefix + 'psat_sample_data_active', 'true');
      const ok1 = safeSetStorage('psat_progress', samplePayload.progress);
      const ok2 = safeSetStorage('psat_srs', samplePayload.srsState);
      const ok3 = safeSetStorage('psat_sessions', samplePayload.sessionsState);
      const ok4 = safeSetStorage('psat_exam_history', samplePayload.examHistory);
      if (!ok1 || !ok2 || !ok3 || !ok4) {
        return { success: false, error: 'Storage write failed while loading sample data' };
      }
      return { success: true };
    }, window.location) :
    { success: false, error: 'Engine unavailable' };

  if (!result.success) {
    alert('❌ Action Cancelled: ' + (result.error || 'Failed to safely load sample data') + '. Your real student records have not been modified.');
    return;
  }

  location.reload();
}

function restoreRealStudentData() {
  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.restoreRealData) {
    const result = (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.runTransactionalAction) ?
      PSAT_ENGINE.runTransactionalAction(localStorage, 'restore_real_data', function(ctx) {
        const ok = PSAT_ENGINE.restoreRealData(localStorage, safeGetStorage, safeSetStorage, window.location);
        return { success: !!ok };
      }, window.location) :
      { success: false };

    if (!result.success) {
      // WI-11: restoreRealData now also returns false when the pre-demo backup is
      // missing or corrupt (it used to delete the four state keys in that case and
      // report success). Both failure causes are covered by this one message, and
      // the student page carries the identical wording.
      alert(
        '❌ Restore Cancelled: the saved copy of the real records could not be used ' +
        '(it is missing or unreadable), or the pre-restore safety snapshot could not be written. ' +
        'Nothing on this device has been modified.'
      );
      return;
    }
    location.reload();
  } else {
    alert('Restore is unavailable because the app engine did not load. Your backup is intact — please reload the page and try again.');
    return;
  }
}

function exportAuditTrail() {
  const progress = safeGetStorage('psat_progress', {});
  const srsState = safeGetStorage('psat_srs', {});
  const sessionsState = safeGetStorage('psat_sessions', {});
  const examHistory = safeGetStorage('psat_exam_history', []);
  const feedback = safeGetStorage('psat_uat_feedback', []);
  const questions = window.QUESTIONS_DATA || [];
  const scoreData = PSAT_ENGINE.calculateScaledScore(questions, progress);

  const auditSnapshot = {
    exportedAt: new Date().toISOString(),
    localTimestamp: new Date().toLocaleString(),
    userAgent: navigator.userAgent,
    summary: {
      totalQuestionsInBank: questions.length,
      totalAttempted: scoreData.totalAttempted,
      totalExamsCompleted: examHistory.length,
      estimatedScore: scoreData.isReady ? scoreData.totalScore : null,
      readingWritingScore: scoreData.isReady ? scoreData.rwScore : null,
      mathScore: scoreData.isReady ? scoreData.mathScore : null,
      overallAccuracyPercent: scoreData.overallAccuracyPercent,
      activeStreakDays: PSAT_ENGINE.calculateStreak(sessionsState),
      srsCardsTracked: Object.keys(srsState).length,
      isSampleData: (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.isDemoModeActive) ? PSAT_ENGINE.isDemoModeActive(localStorage, window.location) : false
    },
    questionAttempts: progress,
    spacedRepetitionCards: srsState,
    sessionsLog: sessionsState,
    examHistoryLog: examHistory,
    userFeedbackLog: feedback
  };

  const jsonStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(auditSnapshot, null, 2));
  const downloadAnchor = document.createElement('a');
  const filename = `PSAT_Audit_Trail_${new Date().toISOString().slice(0, 10)}.json`;
  downloadAnchor.setAttribute('href', jsonStr);
  downloadAnchor.setAttribute('download', filename);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

function importAuditTrail(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || typeof data !== 'object') {
        alert('❌ Invalid File: JSON structure could not be parsed.');
        return;
      }

      // Normalize input fields from different backup/audit formats
      const impProgress = data.questionAttempts || data.progress || null;
      const impSrs = data.spacedRepetitionCards || data.srsState || data.srs || null;
      const impSessions = data.sessionsLog || data.sessionsState || data.sessions || null;
      const impExams = data.examHistoryLog || data.examHistory || null;

      const hasValidContent = (impProgress && Object.keys(impProgress).length > 0) ||
                             (impSrs && Object.keys(impSrs).length > 0) ||
                             (impSessions && Object.keys(impSessions).length > 0) ||
                             (Array.isArray(impExams) && impExams.length > 0);

      if (!hasValidContent) {
        alert('❌ Invalid Import: The selected file does not contain recognized student attempts, SRS cards, or exam records.');
        return;
      }

      // 2. Interactive Merge vs Replace Prompt
      const isMerge = confirm(
        'Import Strategy Choice:\n\n' +
        '• Click "OK" to MERGE imported test records with current data (Safest — retains existing attempts).\n' +
        '• Click "Cancel" to REPLACE current student data entirely with this backup file.\n\n' +
        '(A safety recovery snapshot will be created before applying changes).'
      );

      const result = (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.runTransactionalAction) ?
        PSAT_ENGINE.runTransactionalAction(localStorage, isMerge ? 'merge_file_import' : 'replace_file_import', function(ctx) {
          if (isMerge && typeof PSAT_ENGINE !== 'undefined') {
            const currProg = safeGetStorage('psat_progress', {});
            const currSrs = safeGetStorage('psat_srs', {});
            const currSess = safeGetStorage('psat_sessions', {});
            const currHist = safeGetStorage('psat_exam_history', []);

            const mergedProg = PSAT_ENGINE.mergeProgress(impProgress, currProg);
            const mergedSrs = PSAT_ENGINE.mergeSrsState(impSrs, currSrs);
            const mergedSess = PSAT_ENGINE.mergeSessionsState(impSessions, currSess, mergedProg);
            const mergedHist = PSAT_ENGINE.mergeExamHistory(impExams, currHist, 15);

            const ok1 = safeSetStorage('psat_progress', mergedProg);
            const ok2 = safeSetStorage('psat_srs', mergedSrs);
            const ok3 = safeSetStorage('psat_sessions', mergedSess);
            const ok4 = safeSetStorage('psat_exam_history', mergedHist);
            if (!ok1 || !ok2 || !ok3 || !ok4) return { success: false, error: 'Storage write failed during merge' };
          } else {
            if (impProgress) safeSetStorage('psat_progress', impProgress);
            if (impSrs) safeSetStorage('psat_srs', impSrs);
            if (impSessions) safeSetStorage('psat_sessions', impSessions);
            if (impExams) safeSetStorage('psat_exam_history', impExams);
          }

          if (data.summary && data.summary.isSampleData) {
            localStorage.setItem(APP_ENV.storagePrefix + 'psat_sample_data_active', 'true');
          } else {
            localStorage.removeItem(APP_ENV.storagePrefix + 'psat_sample_data_active');
          }
          return { success: true };
        }, window.location) :
        { success: false, error: 'Engine unavailable' };

      if (!result.success) {
        alert('❌ Import Cancelled: ' + (result.error || 'Failed to safely import file') + '. Your existing data has not been modified.');
        return;
      }

      if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.pushToCloud) {
        PSAT_ENGINE.pushToCloud(localStorage, null, APP_ENV.studentName, window.location);
      }

      alert(isMerge ? '✓ Successfully MERGED imported data!' : '✓ Successfully REPLACED student data from backup file!');
      location.reload();
    } catch (err) {
      alert('Failed to import audit file: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// The markup's `onclick="launchMistakesDrill()"` is unchanged by WI-09; this
// zero-argument wrapper is what it calls, binding the shared launcher to this
// page's list (mistakes.html has the twin, bound to allMistakesList).
function launchMistakesDrill() {
  launchTargetedMistakeDrill(allTroubleList);
}

// ---------------------------------------------------------------------------
// Global handler surface.
//
// A classic <script> puts every top-level function declaration on `window`;
// an ES module does not. parent.html's markup (and the markup this module
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
  updateParentSyncStatusBadge,
  explainerFor,
  syncParentFromCloud,
  formatBackupAge,
  renderBackupStatus,
  refreshBackupStatus,
  renderParentMetrics,
  renderParentExamHistory,
  renderTroubleSpots,
  renderTroubleDomainChips,
  openMistakeRationaleModal,
  closeMistakeRationaleModal,
  downloadCloudBackup,
  openParentExamReview,
  closeParentExamReview,
  filterParentExamQuestions,
  switchBuilderTab,
  switchParentTab,
  updateGapTestCalculations,
  setGapCount,
  launchGapDrill,
  launchCustomTest,
  launchStandardExamFromParent,
  launchMiniExamFromParent,
  copyShareableTestLink,
  loadSampleDiagnosticSession,
  restoreRealStudentData,
  exportAuditTrail,
  importAuditTrail,
  launchMistakesDrill,
});
