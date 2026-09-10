import { createPageSync, syncStatusText } from '../shared/sync.js';
import { mountFocusedBuilder } from '../shared/focused_builder.js';
/**
 * js/pages/student.js — page controller for index.html.
 *
 * WI-09: relocated out of index.html's 2,713-line inline <script>. Pure
 * mechanical move. The only edits are the shared-module imports below
 * (replacing byte-identical local copies, including the ~360-line math-tools
 * block that was duplicated with parent.html) and the explicit window
 * bindings at the bottom.
 *
 * WI-09 left one open twin here: restoreRealStudentData() called
 * PSAT_ENGINE.restoreRealData directly while parent.js wrapped it in
 * PSAT_ENGINE.runTransactionalAction. WI-11 owns storage semantics and has
 * RESOLVED it — both pages now use the transactional form, which snapshots
 * first and aborts if the snapshot fails. The duplication ledger has no open
 * twins left on this page.
 */
import { esc } from '../shared/html.js';
import { APP_ENV } from '../shared/env.js';
import { safeGetStorage, safeSetStorage, offerSaveRecovery, onPendingSyncCountChanged } from '../shared/storage.js';
import { cloneProdDataToBeta, resetBetaSandbox } from '../shared/beta_sandbox.js';
import { questionImageSrc } from '../shared/questions.js';
import { setClassName } from '../shared/dom.js';
import { toggleDesmosCalculator, initDesmosCalculator, fallbackDesmosIframe, toggleDesmosSize, toggleScientificCalculator, toggleScientificAngleMode, sciCalcInput, sciCalcClear, sciCalcBackspace, sciCalcEvaluate, updateSciCalcDisplay, toggleReferenceSheet, setFormulaTab, makeDraggable } from '../shared/math_tools.js';

// safeSetStorage bumps the pending-sync counter; this is how it reaches this
// page's badge. Registered during module evaluation, before any write can
// happen -- the inline original called updateSyncStatusBadge() directly.
onPendingSyncCountChanged(updateSyncStatusBadge);

// WI-20: register the offline service worker from the module (WI-09 keeps page
// logic out of inline <script>). Relative 'sw.js' scopes it to this page's
// directory automatically ('/' in prod, '/v2/' in the soak lane), so each lane
// gets its own worker and caches. A failed registration never breaks the app.
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => {
    console.warn('[psat] service worker registration failed:', e && e.message);
  });
}

function updateSyncStatusBadge() {
  const badge = document.getElementById('hdr-save-status') || document.getElementById('hdr-cloud-badge');
  const state = pageSync.getState();
  if (badge) badge.textContent = syncStatusText(state);
  const button = document.getElementById('cloud-sync-btn-text');
  if (button) button.textContent = state.status === 'syncing' ? 'Syncing…' : 'Sync';
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
const reviewAttempts = new Map();
let currentAttempt = null;
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

// WI-13 Perf: lazy-load Chart.js only when the My Progress tab is opened.
// The eager <script> tag was removed from index.html <head> (−205 KB off first paint).
let chartLoading = null;
function loadChartJs() {
  if (typeof Chart !== 'undefined') return Promise.resolve();
  if (chartLoading) return chartLoading;
  chartLoading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'vendor/chart.min.js?v=20260830-1';
    s.onload = () => resolve(); s.onerror = () => resolve();
    document.head.appendChild(s);
  });
  return chartLoading;
}

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
  if (typeof lucide !== 'undefined') lucide.createIcons();
  checkDemoModeBanner();
  applyFilters();
  updateHeaderStats();
  renderExamLobbyHistory();
  renderOfflineReadyStatus();
  // WI-20: auto-sync when the connection returns (e.g. the plane lands) and
  // reflect offline/online in the badge. Registered once, after initial render.
  updateSyncStatusBadge();
});

function checkDemoModeBanner() {
  const isDemo = (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.isDemoModeActive) ? PSAT_ENGINE.isDemoModeActive() : (localStorage.getItem('psat_sample_data_active') === 'true');
  const banner = document.getElementById('demo-mode-warning-banner');
  if (banner) {
    if (isDemo) banner.classList.remove('hidden');
    else banner.classList.add('hidden');
  }
}

/**
 * WI-11: this is now the SAME safe form parent.js uses (the WI-09 duplication
 * ledger's one open twin, resolved here).
 *
 * What changed on this page: the restore used to call PSAT_ENGINE.restoreRealData
 * directly, ignore its result, and reload unconditionally — so a restore that
 * failed looked identical to one that succeeded. It now goes through
 * runTransactionalAction, which takes a pre-action snapshot first and aborts if
 * that snapshot cannot be written, and it only reloads when the restore actually
 * happened.
 *
 * Paired engine change: restoreRealData no longer deletes the four state keys
 * when the pre-demo backup is missing or corrupt. It changes nothing and returns
 * false, which this wrapper turns into an explicit "nothing was modified" alert.
 */
function restoreRealStudentData() {
  if (typeof PSAT_ENGINE === 'undefined' || !PSAT_ENGINE.restoreRealData || !PSAT_ENGINE.runTransactionalAction) {
    alert('Restore is unavailable because the app engine did not load. Your backup is intact — please reload the page and try again.');
    return;
  }

  const result = PSAT_ENGINE.runTransactionalAction(localStorage, 'restore_real_data', function (ctx) {
    const ok = PSAT_ENGINE.restoreRealData(localStorage, safeGetStorage, safeSetStorage, window.location);
    return { success: !!ok };
  }, window.location);

  if (!result.success) {
    alert(
      '❌ Restore Cancelled: the saved copy of your real records could not be used ' +
      '(it is missing or unreadable), or the pre-restore safety snapshot could not be written. ' +
      'Nothing on this device has been modified.'
    );
    return;
  }
  location.reload();
}

function manualTriggerCloudSync(isManual = false) {
  return pageSync.requestSync('manual', isManual);
}


// Explainer index: question id -> step-by-step explainer.
// `questions` are the verified, always-on links. `betaQuestions` (the model-first
// cluster pages whose numbers are not yet card-verified) surface ONLY in the beta
// lane (APP_ENV.isBeta) and are badged — CLAUDE.md failure mode 1: unverified
// content is never presented to the real student as fact. Twin site with the same
// gate: parent.js explainerFor().
let explainerIndex = { questions: {}, betaQuestions: {}, pages: {} };
fetch('explanations/index.json')
  .then(r => r.ok ? r.json() : null)
  .then(d => {
    explainerIndex = {
      questions: (d && d.questions) || {},
      betaQuestions: (d && d.betaQuestions) || {},
      pages: (d && d.pages) || {},
    };
    refreshReviewWalkthroughs();
  })
  .catch(() => { explainerIndex = { questions: {}, betaQuestions: {}, pages: {} }; });

// The index arrives async. If the Review tab is already on screen when it lands,
// re-render so the walkthrough card appears without needing a tab switch.
function refreshReviewWalkthroughs() {
  const c = document.getElementById('view-review');
  if (c && c.innerHTML.trim()) renderReview();
}

function explainerHitFor(questionId) {
  const id8 = String(questionId).slice(0, 8);
  const verified = explainerIndex.questions[id8];
  const beta = APP_ENV.isBeta ? explainerIndex.betaQuestions[id8] : null;
  return beta || verified || null;   // in beta the model-first page wins; otherwise verified only
}

function showExplainerLink(questionId) {
  const el = document.getElementById('explainer-link');
  if (!el) return;
  const hit = explainerHitFor(questionId);
  if (hit && hit.url) {
    el.href = hit.url;
    const skillEl = document.getElementById('explainer-link-skill');
    if (skillEl) skillEl.innerText = (hit.skill || '') + (hit.beta ? ' · 🧪 Beta' : '');
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
    // WI-26: route the post-write push through the coordinator, so a failure here
    // retries on its own instead of waiting for the student's next answer. It also
    // removes a second copy of the badge-rendering logic — these two branches wrote
    // their own markup to an element that no longer existed, so they rendered nothing
    // AND could contradict updateSyncStatusBadge (CLAUDE.md mode 2).
    requestSync('write');
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
  ['practice', 'review', 'exam', 'analytics', 'bank'].forEach(t => {
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
      requestSync('analytics');
    }
  } else if (tab === 'bank') {
    renderBankTable();
  } else if (tab === 'review') {
    renderReview();
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ---------------------------------------------------------------------------
// WI-13 Review tab: a first-class home for the two review-oriented study
// flows that were previously buried (SRS due cards were only a Practice
// filter option; the high-yield drill only launched from the exam lobby).
// Rendered with the WI-12 design system (styles/components.css owns .card /
// .badge / .btn / .empty-state); every number shown is a real measurement
// off srsState, and the empty case shows an em-dash-free empty state, never
// a fabricated zero (CLAUDE.md mode 1).
// ---------------------------------------------------------------------------
function renderReview() {
  const container = document.getElementById('view-review');
  if (!container) return;
  srsState = safeGetStorage('psat_srs', {});
  const now = Date.now();
  const ids = Object.keys(srsState);
  const dueCount = ids.filter(id => srsState[id] && srsState[id].dueAt <= now).length;
  const totalCards = ids.length;

  const dueSection = dueCount > 0
    ? `<div class="card space-y-3">
         <div class="question-meta">
           <span class="badge badge-danger">${dueCount} due now</span>
           <span class="badge badge-neutral">${totalCards} card${totalCards === 1 ? '' : 's'} tracked</span>
         </div>
         <h3 class="card-title">Spaced-repetition review</h3>
         <p class="card-subtitle">Grading each card reschedules it with SM-2, so the ones you find hard come back sooner.</p>
         <button type="button" class="btn btn-md btn-primary" onclick="startSrsReview()">Start review (${dueCount})</button>
       </div>`
    : `<div class="card">
         <div class="empty-state">
           <span class="empty-state-icon" aria-hidden="true">✅</span>
           <p class="empty-state-title">Nothing due for review</p>
           <p class="empty-state-desc">${totalCards > 0
             ? 'Your scheduled cards are all caught up — check back tomorrow.'
             : 'Answer questions in Practice to start building your review queue.'}</p>
         </div>
       </div>`;

  const drillSection = `<div class="card space-y-3">
       <div class="question-meta"><span class="badge badge-accent">Adaptive</span></div>
       <h3 class="card-title">High-yield drill</h3>
       <p class="card-subtitle">A 20-question set aimed at the skills you miss most, built from your own history.</p>
       <button type="button" class="btn btn-md btn-secondary" onclick="startGapDrillFromLobby()">Start high-yield drill</button>
     </div>`;

  // WI-21: the skill walkthroughs, listed straight from explanations/index.json.
  // Only pages that still OWN at least one question id are offered — a page whose
  // ids were all superseded by a `primary` cluster page is a dead end the student
  // should never be sent to, and the cluster page links to it as the slow version
  // anyway. A beta page passes the same isBeta gate as the per-question link, so
  // unverified content cannot appear here either (CLAUDE.md mode 2: same rule,
  // both sites). No page in the index -> the card is omitted entirely, never an
  // empty shell.
  const liveFiles = new Set(Object.values(explainerIndex.questions || {})
    .filter(e => e && e.url && (!e.beta || APP_ENV.isBeta))
    .map(e => e.file));
  if (APP_ENV.isBeta) {
    Object.values(explainerIndex.betaQuestions || {})
      .forEach(e => { if (e && e.url) liveFiles.add(e.file); });
  }
  const walkthroughs = Object.keys(explainerIndex.pages || {})
    .map(file => [file, explainerIndex.pages[file]])
    .filter(([file, p]) => p && p.url && liveFiles.has(file))
    .sort((a, b) => (b[1].questionCount || 0) - (a[1].questionCount || 0));

  const walkSection = walkthroughs.length ? `<div class="card space-y-3">
       <div class="question-meta"><span class="badge badge-accent">Walkthroughs</span></div>
       <h3 class="card-title">Visual skill walkthroughs</h3>
       <p class="card-subtitle">One page per skill: the mental model first, then worked misses, then practice. Opens in a new tab.</p>
       <div class="space-y-2">
         ${walkthroughs.map(([, p]) => `<a href="${esc(p.url)}" target="_blank" rel="noopener"
              class="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl border border-teal-200 bg-teal-50 hover:bg-teal-100 text-teal-900 font-semibold text-sm transition-colors">
              <span class="flex items-center">
                <i data-lucide="lightbulb" class="w-4 h-4 mr-2 text-teal-600"></i>${esc(p.title)}
              </span>
              <span class="text-xs font-normal text-teal-700">${p.questionCount} question${p.questionCount === 1 ? '' : 's'}${p.beta ? ' · 🧪 Beta' : ''}</span>
            </a>`).join('')}
       </div>
     </div>` : '';

  container.innerHTML = dueSection + drillSection + walkSection;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Review happens in the familiar Practice question UI, filtered to the SRS
// due set — no duplicate question loop. recordAttempt() already reschedules
// via PSAT_ENGINE.scheduleNext, so grading a card here updates its SM-2 state.
function startSrsReview() {
  document.getElementById('filter-subject').value = 'all';
  document.getElementById('filter-difficulty').value = 'all';
  document.getElementById('filter-status').value = 'due';
  applyFilters();
  switchTab('practice');
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
  if (typeof lucide !== 'undefined') lucide.createIcons();
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
  const storedProgress = progress[q.id] || {};
  const card = srsState[q.id];
  const status = document.getElementById('filter-status').value;
  let attempt = reviewAttempts.get(q.id);
  const mode = PSAT_ENGINE.resolveAttemptMode(storedProgress, card, status, Date.now());
  if (!attempt || (attempt.mode === 'practice' && mode === 'srs_review')) {
    attempt = PSAT_ENGINE.startAttempt({questionId:q.id, mode, progressEntry:storedProgress, srsCard:card, now:Date.now()});
    attempt.attemptId += '_' + crypto.randomUUID();
    if (mode === 'practice') attempt.status = 'graded';
    reviewAttempts.set(q.id, attempt);
  }
  currentAttempt = attempt;
  const qProg = attempt.status === 'open' ? {...storedProgress, answered:false} : storedProgress;

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
  // WI-13: design-system .badge variants (styling owned by components.css)
  diffBadge.className = 'badge ' + (q.difficulty === 'Easy' ? 'badge-success' :
                       (q.difficulty === 'Medium' ? 'badge-warning' : 'badge-danger'));

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
    srsBadge.className = isDue ? 'badge badge-danger' : 'badge badge-primary';
  } else {
    srsBadge.innerText = 'SRS: New Card';
    srsBadge.className = 'badge badge-neutral';
  }

  // Visual Image
  const imgPath = questionImageSrc(q);
  document.getElementById('q-image').src = imgPath;

  // Text View Warnings (#text-mode-warning was removed in 7b22ff6 -- guard it)
  const textWarning = document.getElementById('text-mode-warning');
  // WI-23: `text_complete` covers the question STEM only — it is true for every one
  // of the 917 records whose OPTIONS are unusable, which is why nothing caught this.
  if (q.text_complete === false || (PSAT_ENGINE.optionTextIssue(q) || {}).useless) {
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
  document.querySelector('#free-response-container button').disabled = qProg.answered;

  if (q.type === 'multiple_choice') {
    optContainer.classList.remove('hidden');
    // WI-13: options now use the WI-12 design-system .question-option markup
    // (same classes js/components/questionCard.js emits: .question-option +
    // .question-option-key, is-correct/is-incorrect post-answer, keyed by
    // data-option-key). components.css owns the styling — no inline utilities.
    optContainer.classList.add('question-options');
    frContainer.classList.add('hidden');

    // WI-23: 917 of 2,694 MC records have option text the student cannot use
    // (876 literal "Option A" placeholders, 17 all-identical, 24 duplicated).
    // One rule and one wording, in the engine, so this view, the exam view and
    // js/components/questionCard.js cannot drift (CLAUDE.md mode 2).
    const optIssue = PSAT_ENGINE.optionTextIssue(q);
    renderOptionTextNotice(optIssue);

    q.options.forEach(opt => {
      const btn = document.createElement('button');
      btn.type = 'button';
      let cls = 'question-option';
      if (qProg.answered) {
        if (opt.key === q.correct_answer) {
          cls += ' is-correct';
        } else if (opt.key === qProg.selectedAnswer) {
          cls += ' is-incorrect';
        }
      }
      btn.className = cls;
      btn.setAttribute('data-option-key', opt.key);

      const keySpan = document.createElement('span');
      keySpan.className = 'question-option-key';
      keySpan.textContent = opt.key;

      const textSpan = document.createElement('span');
      // When the extracted text says nothing ("Option A", "and"), showing it
      // invites a blind click. The letter is the honest label; the choices are
      // on the official card, which every affected record has.
      textSpan.textContent = (optIssue && optIssue.useless) ? '' : opt.text;

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
      feedbackBanner.className = 'banner banner-success';
      document.getElementById('feedback-icon').innerHTML = `<i data-lucide="check-circle" class="w-6 h-6 text-emerald-600"></i>`;
      document.getElementById('feedback-title').innerText = `Correct!${timeSec}`;
      document.getElementById('feedback-desc').innerText = `Your answer: ${qProg.selectedAnswer}`;
    } else {
      feedbackBanner.className = 'banner banner-danger';
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
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

/**
 * WI-23 — renders (or clears) the answer-choice-quality notice above the options.
 *
 * The element is created on demand rather than added to index.html: the UI
 * simplification pass (7b22ff6) deleted #text-mode-warning and #mismatch-notice and
 * left the JS reading them, which threw and aborted the rest of loadQuestion. Owning
 * the node here means there is nothing for a future markup change to delete out from
 * under us.
 *
 * @param {null|{message:string, code:string}} issue from PSAT_ENGINE.optionTextIssue
 */
function renderOptionTextNotice(issue) {
  const optContainer = document.getElementById('options-container');
  let el = document.getElementById('option-text-notice');
  if (!issue) {
    if (el) el.classList.add('hidden');
    return;
  }
  if (!el) {
    if (!optContainer || !optContainer.parentNode) return;
    el = document.createElement('div');
    el.id = 'option-text-notice';
    optContainer.parentNode.insertBefore(el, optContainer);
  }
  el.className = 'banner banner-warning';
  el.setAttribute('data-issue', issue.code);
  el.textContent = issue.message;
  el.classList.remove('hidden');
}

function recordAttempt(selectedAnswer, isCorrect) {
  if (window.__PSAT_WRITE_BLOCKED__ || !PSAT_ENGINE.canSubmitAttempt(currentAttempt, Date.now()).allowed) return;
  const q = filteredQuestions[currentIndex];
  
  // Calculate elapsed time
  let timeSpentMs = null;
  let timingReliable = false;

  if (questionShownAt !== null) {
    const currentForeground = document.hidden ? 0 : (Date.now() - lastVisibilityTimestamp);
    const totalRaw = accumulatedForegroundTimeMs + currentForeground;
    // WI-22: one rule, in the engine (PSAT_ENGINE.isTimingReliable). This used to
    // be an inline copy whose exam-path twin read `> 0` and graded a 1 ms answer 5.
    if (PSAT_ENGINE.isTimingReliable(totalRaw)) {
      timeSpentMs = totalRaw;
      timingReliable = true;
    }
  }

  // WI-11: the stored-attempt record shape lives in the engine
  // (PSAT_ENGINE.buildProgressEntry) so this page and the exam-submission handler
  // below cannot drift apart again. `at` is passed explicitly rather than read from
  // the clock inside the builder.
  const attemptAt = Date.now();
  const closed = PSAT_ENGINE.closeAttempt(currentAttempt, {selectedAnswer,isCorrect,timeSpentMs,timingReliable}, attemptAt);
  currentAttempt = closed.attempt;
  reviewAttempts.set(q.id, currentAttempt);
  progress[q.id] = PSAT_ENGINE.buildProgressEntry(progress[q.id], {
    attemptId: currentAttempt.attemptId,
    selectedAnswer: selectedAnswer,
    isCorrect: isCorrect,
    timeSpentMs: timeSpentMs,
    timingReliable: timingReliable,
    at: attemptAt,
    source: currentAttempt.mode === 'srs_review' ? 'srs_review' : 'practice'
  });

  // Spaced Repetition SM-2 Update
  const grade = PSAT_ENGINE.gradeAttempt(isCorrect, timeSpentMs, timingReliable);
  const existingCard = srsState[q.id] || { questionId: q.id, repetitions: 0, intervalDays: 1, easeFactor: 2.5, history: [] };
  srsState[q.id] = PSAT_ENGINE.scheduleNext(existingCard, grade, Date.now(), timeSpentMs);

  // Update Daily Session Log
  sessionsState = PSAT_ENGINE.recordDailySession(sessionsState, isCorrect, timeSpentMs, null, timingReliable);

  const outbox = PSAT_ENGINE.getOutboxOps(localStorage, window.location);
  outbox.push({id:currentAttempt.attemptId,type:'question_attempt',timestamp:attemptAt,payload:{...closed.event,timestamp:attemptAt}});
  const values = {psat_progress:progress, psat_srs:srsState, psat_sessions:sessionsState, psat_sync_outbox:outbox};
  const result = window.__PSAT_ENGINE_PARTS.persistence.writeBatch(localStorage, APP_ENV.storagePrefix, values);
  if (!result.success) {
    offerSaveRecovery(values);
  } else {
    updateHeaderStats(); renderPalette(); triggerCloudSync();
  }
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
    progress[q.id] = { answered: false, isFlagged: true, flagUpdatedAt: Date.now() };
  } else {
    progress[q.id].isFlagged = !progress[q.id].isFlagged;
    // WI-32: stamp WHEN the bookmark changed. Deliberately not `timestamp` — that
    // feeds learning metrics and the delta cursor, and a bookmark is not an attempt.
    progress[q.id].flagUpdatedAt = Date.now();
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
    return loadChartJs().then(() => {
      if (typeof Chart !== 'undefined') {
        return renderCharts(domainStats, diffStats);
      } else {
        console.warn('Chart.js library not loaded; charts omitted.');
      }
    });
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
let examPhase = 'module';
// WI-35 pause state. pausedRemainingSeconds is the banked clock; totalPausedMs and
// examPauseCount are recorded so the report can say the exam was paused rather than
// quietly presenting it as a clean timed run.
let pausedRemainingSeconds = null;
let pausedAt = null;
let totalPausedMs = 0;
let examPauseCount = 0;
let submittedModules = [];
let breakDeadline = null;
let pendingCompletion = null;
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
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function canStartNewExam() {
  if (window.__PSAT_WRITE_BLOCKED__) {alert('Recover the pending save before starting another test.');return false;}
  if (safeGetStorage('psat_active_exam_state',null)) {
    switchTab('exam'); showExamSubview('exam-lobby'); checkActiveExamResume();
    alert('An unfinished test is saved. Resume it or explicitly archive it before starting another.');return false;
  }
  return true;
}

function startStandardExam(opts) {
  if (!canStartNewExam()) return;
  const mergedOpts = Object.assign({ progressMap: progress }, opts || {});
  activeExam = PSAT_ENGINE.generateStandardPSAT89Exam(questions, mergedOpts);
  initExamSession();
}

function startMiniExam(opts) {
  if (!canStartNewExam()) return;
  const mergedOpts = Object.assign({ progressMap: progress }, opts || {});
  activeExam = PSAT_ENGINE.generateMiniPSAT89Exam(questions, mergedOpts);
  initExamSession();
}

// ============================================================
// WI-20 — OFFLINE EXAM MODE ("take it on the plane, sync on landing")
// ============================================================
// The engine already generates/takes/scores/stores an exam with no network, and
// cloud sync is offline-safe. These controllers add the two missing pieces: (1)
// a pre-flight "Prepare for offline" that pins one exam and caches EXACTLY its
// question images (never the 324 MB bank), and (2) starting that pinned exam
// offline. Honest status only — every count shown is a real cache result, never
// an assumed number (CLAUDE.md failure mode 1).

const OFFLINE_PIN_KEY = 'psat_offline_prepared_exam';

function setOfflinePrepStatus(msg, kind) {
  const el = document.getElementById('offline-prep-status');
  if (!el) return;
  const colors = { busy: 'text-slate-600', ok: 'text-emerald-700', warn: 'text-amber-700', error: 'text-rose-700' };
  el.className = 'text-xs font-semibold mt-3 ' + (colors[kind] || 'text-slate-600');
  el.innerText = msg;
  el.classList.remove('hidden');
}

/**
 * Caches a list of image URLs into the SW's 'psat-images' cache directly via the
 * Cache Storage API (available on the page, no dependency on the SW controlling
 * this client yet). Returns the REAL success/failure tally — a failed add is
 * counted, never swallowed (failure mode 5).
 */
async function cacheImageUrls(urls, concurrency) {
  let ok = 0, fail = 0;
  let cache = null;
  try { cache = (typeof caches !== 'undefined') ? await caches.open('psat-images') : null; } catch (e) { cache = null; }
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const url = urls[i++];
      try {
        if (cache) { await cache.add(url); }
        else { const r = await fetch(url, { cache: 'reload' }); if (!r.ok) throw new Error('HTTP ' + r.status); }
        ok++;
      } catch (e) { fail++; }
      setOfflinePrepStatus(`Caching questions… ${ok + fail}/${urls.length}`, 'busy');
    }
  }
  const workers = [];
  for (let w = 0; w < Math.max(1, concurrency || 6); w++) workers.push(worker());
  await Promise.all(workers);
  return { ok, fail };
}

async function prepareOfflineExam(examToPrepare) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setOfflinePrepStatus('You appear to be offline. Connect to the internet first, then prepare the exam.', 'warn');
    return;
  }
  if (typeof PSAT_ENGINE === 'undefined' || !PSAT_ENGINE.generateStandardPSAT89Exam) {
    setOfflinePrepStatus('The app engine did not load. Reload the page and try again.', 'error');
    return;
  }
  setOfflinePrepStatus('Preparing… generating your exam and caching its questions. Keep this tab open.', 'busy');
  const btn = document.getElementById('offline-prep-btn');
  if (btn) btn.disabled = true;
  try {
    let swReady = false;
    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.ready; swReady = true; } catch (e) { swReady = false; }
    }
    // WI-27 (finding 5): prepare whatever test was ASKED for, not always a full
    // adaptive exam. A parent-built focused test (7 Craft and Structure questions, a
    // 15-minute session) could previously be built online and then come back offline
    // as a 98-question standard exam — a different test entirely.
    const exam = examToPrepare || PSAT_ENGINE.generateStandardPSAT89Exam(questions, { progressMap: progress, isAdaptive: true });
    const ids = PSAT_ENGINE.collectExamQuestionIds(exam);
    const qMap = {}; (window.QUESTIONS_DATA || questions).forEach(q => { qMap[q.id] = q; });
    const urls = [];
    ids.forEach(id => { const q = qMap[id]; if (q) { const s = questionImageSrc(q); if (s) urls.push(s); } });

    const { ok: cachedOk, fail } = await cacheImageUrls(urls, 6);

    // WI-28 finding 2: refuse to pin something with no questions. This reported
    // "Offline-ready" for a pin holding 0 modules and 0 images.
    const pinnedCount = (exam.modules || []).reduce(function (a, m) {
      return a + ((m.questions || []).length);
    }, 0);
    if (!pinnedCount) {
      setOfflinePrepStatus('That test has no questions to prepare, so nothing was pinned. ' +
        'Rebuild it and try again.', 'error');
      return;
    }
    const pin = PSAT_ENGINE.toOfflineExamPin(exam, { imageTotal: urls.length, imageCached: cachedOk, preparedAt: Date.now() });
    const stored = safeSetStorage(OFFLINE_PIN_KEY, pin);
    if (!stored) {
      setOfflinePrepStatus('Could not save the prepared exam — device storage is full. Nothing was pinned.', 'error');
      return;
    }

    renderOfflineReadyStatus();
    let msg, kind;
    if (!swReady) {
      msg = `Cached ${cachedOk}/${urls.length} question images, but this browser can't store the app for offline loading — keep this tab open (don't fully close it) during the flight.`;
      kind = 'warn';
    } else if (fail > 0) {
      msg = `Prepared, but ${fail} of ${urls.length} question images failed to cache; those questions may not display offline. Reconnect and prepare again to fix.`;
      kind = 'warn';
    } else {
      msg = `✓ Offline-ready: all ${cachedOk} question images cached and the app is stored for offline use. Safe to go offline — the exam appears in "Prepared offline exam" below.`;
      kind = 'ok';
    }
    setOfflinePrepStatus(msg, kind);
  } catch (e) {
    setOfflinePrepStatus('Preparation failed: ' + ((e && e.message) || 'unknown error') + '. Nothing was pinned.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * WI-27 — prepare the CURRENTLY configured focused/custom test for offline use.
 * Shares one prepare path with the full exam so the two cannot drift (mode 2).
 */
/**
 * WI-29 finding 3 — the UI entry point for focused offline preparation.
 *
 * prepareFocusedTestForOffline existed and worked, but NOTHING called it: the only
 * markup control invoked prepareOfflineExam() with no argument, so a parent-built
 * focused test could never be prepared through the interface. This resolves what the
 * student currently has selected — the assignment handed over in sessionStorage, or
 * the exam already loaded — and prepares exactly that.
 *
 * It reports honestly when there is nothing selected rather than silently preparing a
 * full exam the parent did not ask for.
 */
function getSelectedFocusedTest() {
  try {
    const stored = sessionStorage.getItem(APP_ENV.storagePrefix + 'psat_active_custom_test');
    if (stored) return JSON.parse(stored);
  } catch (e) {
    console.warn('Could not read the handed-over test:', e);
  }
  // Fall back to a non-adaptive test already loaded in this tab. It is ALREADY
  // normalised (modules with resolved questions), whereas buildCustomExamFromPlan
  // expects raw builder output (questions/questionIds). Feeding it straight through
  // produced "This test has missing or duplicate questions" and pinned nothing
  // (WI-30 finding 3), so flatten it back to the builder's shape here.
  if (activeExam && activeExam.isAdaptive === false) {
    const flat = (activeExam.modules || []).reduce(function (acc, m) {
      return acc.concat(m.questions || []);
    }, []);
    if (!flat.length) return null;
    return {
      id: activeExam.id,
      title: activeExam.title,
      type: activeExam.type,
      examCategory: activeExam.examCategory || 'focused_test',
      customPlan: activeExam.customPlan || null,
      isUntimed: activeExam.isUntimed === true,
      timeLimitMinutes: activeExam.timeLimitMinutes || activeExam.totalTimeMinutes || null,
      questions: flat
    };
  }
  return null;
}

function prepareSelectedTestForOffline() {
  const selected = getSelectedFocusedTest();
  if (!selected) {
    setOfflinePrepStatus('No focused test is selected. Open the assignment from the parent ' +
      'portal first, or use "Prepare for offline" to prepare a full practice exam.', 'warn');
    return Promise.resolve();
  }
  return prepareFocusedTestForOffline(selected);
}

function prepareFocusedTestForOffline(customTestData) {
  if (!customTestData) {
    setOfflinePrepStatus('Build or open a test first, then prepare it for offline use.', 'warn');
    return Promise.resolve();
  }
  const built = buildCustomExamFromPlan(customTestData);
  if (!built.ok) {
    setOfflinePrepStatus(built.error, 'error');
    return Promise.resolve();
  }
  return prepareOfflineExam(built.exam);
}

function startPreparedOfflineExam() {
  if (!canStartNewExam()) return;
  const pin = safeGetStorage(OFFLINE_PIN_KEY, null);
  if (!pin) {
    alert('No offline exam is prepared. Use "Prepare for offline" while connected first.');
    return;
  }
  const res = PSAT_ENGINE.rehydrateOfflineExamPin(pin, window.QUESTIONS_DATA || questions);
  if (!res.ok) {
    // Refuse rather than run a short exam scored as a full one (failure modes 3/5).
    alert('The prepared offline exam could not be fully loaded from the question bank (' +
      res.missingIds.length + ' question(s) missing), so it will not start. This prevents an ' +
      'incomplete exam being scored as full. Please prepare a new offline exam while connected.');
    return;
  }
  activeExam = res.exam;
  initExamSession();
}

function renderOfflineReadyStatus() {
  const wrap = document.getElementById('offline-prepared-panel');
  if (!wrap) return;
  const pin = safeGetStorage(OFFLINE_PIN_KEY, null);
  const meta = pin && pin.examMeta ? pin.examMeta : null;
  if (!meta) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const when = pin.preparedAt ? new Date(pin.preparedAt).toLocaleString() : 'earlier';
  const imgLine = (typeof pin.imageCached === 'number' && typeof pin.imageTotal === 'number')
    ? `${pin.imageCached}/${pin.imageTotal} question images cached`
    : 'question images cached';
  const detail = document.getElementById('offline-prepared-detail');
  if (detail) detail.innerText = `${meta.title || 'Prepared exam'} • prepared ${when} • ${imgLine}`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

const pageSync = createPageSync({
  onState: updateSyncStatusBadge,
  onPull: () => {
    progress = safeGetStorage('psat_progress', {});
    srsState = safeGetStorage('psat_srs', {});
    sessionsState = safeGetStorage('psat_sessions', {});
    updateHeaderStats(); renderPalette(); renderExamLobbyHistory();
    if (!document.getElementById('view-analytics').classList.contains('hidden')) renderAnalytics();
  }
});

function requestSync(reason, isManual = false) {
  return pageSync.requestSync(reason, isManual);
}

function requestManualSync() {
  return requestSync('manual', true);
}

function startGapDrillFromLobby() {
  const drill = PSAT_ENGINE.generateGapTargetedDrill(questions, progress, srsState, { count: 20 });
  startCustomTestDirect(drill);
}

function startSectionTest(testType) {
  if (!canStartNewExam()) return;
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

/**
 * WI-28 finding 2 — the ONE conversion from builder output to a runnable exam.
 *
 * The builder emits `questionIds`; generateCustomTest emits `questions`; the pinning
 * path needs `exam.modules`. That conversion lived only inside startCustomTestDirect,
 * so the offline-prepare path received raw builder data, found no modules, pinned
 * NOTHING, and still displayed "Offline-ready" — measured at 0 modules / 0 images for
 * a 7-question Craft and Structure test. Start and prepare now share this function so
 * they cannot disagree about what the test is (CLAUDE.md mode 2).
 *
 * @returns {{ok:boolean, exam:Object|null, error:string|null}}
 */
function buildCustomExamFromPlan(customTestData) {
  if (!customTestData) return { ok: false, exam: null, error: 'No test was provided.' };
  let data = customTestData;
  if (data.questionIds) {
    const byId = new Map(questions.map(q => [q.id, q]));
    data = { ...data, questions: data.questionIds.map(id => byId.get(id)) };
  }
  if (!Array.isArray(data.questions) || !data.questions.length ||
      data.questions.some(q => !q) ||
      new Set(data.questions.map(q => q.id)).size !== data.questions.length) {
    return { ok: false, exam: null,
      error: 'This test has missing or duplicate questions. Please return to the builder. Existing work is unchanged.' };
  }
  return {
    ok: true,
    error: null,
    exam: {
      id: data.id || 'custom_' + Date.now(),
      title: data.title || 'Custom Practice Test',
      type: data.type || 'custom_test',
      examCategory: data.examCategory || 'focused_test',
      customPlan: data.customPlan || null,
      isUntimed: data.isUntimed === true,
      isAdaptive: false,
      totalQuestions: data.questions.length,
      totalTimeMinutes: data.isUntimed ? null : (data.timeLimitMinutes || 30),
      timeLimitMinutes: data.isUntimed ? null : (data.timeLimitMinutes || 30),
      breakMinutes: 0,
      createdAt: Date.now(),
      modules: [
        {
          id: 'custom_m1',
          section: new Set(data.questions.map(q => q.test)).size > 1
            ? 'Mixed subjects' : (data.questions[0]?.test || 'Practice'),
          moduleNumber: 1,
          name: data.title || 'Custom Test Module',
          questionsCount: data.questions.length,
          timeLimitSeconds: (data.isUntimed ? 999999 : (data.timeLimitMinutes || 30) * 60),
          questions: data.questions
        }
      ]
    }
  };
}

function startCustomTestDirect(customTestData) {
  if (!canStartNewExam()) return;
  const built = buildCustomExamFromPlan(customTestData);
  if (!built.ok) { alert(built.error); return; }
  activeExam = built.exam;
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
  if (typeof lucide !== 'undefined') lucide.createIcons();
  setTimeout(() => {
    if (toast) toast.classList.add('hidden');
  }, 4500);
}

function initExamSession() {
  pausedRemainingSeconds = null; pausedAt = null; totalPausedMs = 0; examPauseCount = 0;
  document.getElementById('exam-paused-overlay').classList.add('hidden');
  examPhase = 'module'; submittedModules = []; breakDeadline = null; pendingCompletion = null;
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
  examPhase = 'module';
  currentModuleIndex = modIdx;
  currentExamQIndex = 0;
  examModuleExpired = false;
  examFiveMinAlertShown = false;

  const mod = activeExam.modules[currentModuleIndex];
  examModuleTimerSeconds = mod.timeLimitSeconds;
  examModuleDeadline = activeExam.isUntimed ? null : Date.now() + (mod.timeLimitSeconds * 1000);

  document.getElementById('exam-active-module-title').innerText = mod.name;

  startModuleClock();

  showExamSubview('exam-active');
  loadExamQuestion(0);
}

function moduleCanEdit() {
  // WI-35: a paused exam must not accept answers. Pausing stops the clock, so allowing
  // writes would be unlimited time on an open question.
  return !window.__PSAT_WRITE_BLOCKED__ && !pendingCompletion && examPhase !== 'break' &&
    examPhase !== 'paused' &&
    !submittedModules.includes(currentModuleIndex) && !examModuleExpired &&
    (activeExam?.isUntimed || (Number.isFinite(examModuleDeadline) && Date.now() < examModuleDeadline));
}

/**
 * WI-35 — the page's live exam state in the shape the engine's pause helpers read.
 *
 * The persisted snapshot uses this page's historical field names (examModuleDeadline,
 * phase), while exam_state.js works in its own vocabulary (moduleDeadline). Rather
 * than reshape a stored format that the resume path already depends on, this adapts
 * the handful of fields the pause arithmetic actually touches. The engine stays pure
 * and unaware of the page.
 */
function buildCurrentExamSnapshot() {
  return {
    phase: examPhase,
    moduleDeadline: examModuleDeadline,
    pausedAt: pausedAt,
    pausedRemainingSeconds: pausedRemainingSeconds,
    pauseCount: examPauseCount,
    totalPausedMs: totalPausedMs,
    resumePhase: 'module'
  };
}

/**
 * WI-35 — pause the running module. The clock stops; the banked remainder is what the
 * student gets back, however long they are away.
 *
 * The engine owns the arithmetic (PSAT_ENGINE.pauseExam); this only drives the DOM and
 * persists, so a reload during a pause resumes paused rather than silently expiring.
 */
function pauseExamNow() {
  if (!activeExam) return;
  if (activeExam.isUntimed) {
    showExamToast('This test is untimed — there is no clock to pause.');
    return;
  }
  const snap = buildCurrentExamSnapshot();
  const res = PSAT_ENGINE.pauseExam(snap, Date.now());
  if (!res.ok) { showExamToast(res.reason); return; }

  if (examTimerInterval) clearInterval(examTimerInterval);
  // Stop crediting time to the current question too, or the pause would inflate it.
  flushExamQuestionTime();
  examQuestionShownAt = null;

  examPhase = 'paused';
  pausedRemainingSeconds = res.snapshot.pausedRemainingSeconds;
  pausedAt = res.snapshot.pausedAt;
  examPauseCount = res.snapshot.pauseCount;
  examModuleDeadline = null;
  if (!persistActiveExamState()) {
    showExamToast('Pause needs saving. Use the recovery controls before continuing.');
    renderPausedOverlay();
    return;
  }
  renderPausedOverlay();
}

function resumeExamNow() {
  if (window.__PSAT_WRITE_BLOCKED__ || examPhase !== 'paused') return;
  const snap = buildCurrentExamSnapshot();
  const res = PSAT_ENGINE.resumeFromPause(snap, Date.now());
  if (!res.ok) { showExamToast(res.reason); return; }

  examPhase = 'module';
  examModuleDeadline = res.snapshot.moduleDeadline;
  totalPausedMs = res.snapshot.totalPausedMs;
  pausedRemainingSeconds = null;
  pausedAt = null;
  if (!persistActiveExamState(snap)) {
    examPhase = snap.phase;
    examModuleDeadline = snap.moduleDeadline;
    totalPausedMs = snap.totalPausedMs;
    pausedRemainingSeconds = snap.pausedRemainingSeconds;
    pausedAt = snap.pausedAt;
    return;
  }

  const overlay = document.getElementById('exam-paused-overlay');
  if (overlay) overlay.classList.add('hidden');
  // Restart question timing from now, so the pause is not charged to this question.
  examQuestionShownAt = Date.now();
  startModuleClock();
}

function renderPausedOverlay() {
  const overlay = document.getElementById('exam-paused-overlay');
  if (!overlay) return;
  const mins = Math.floor((pausedRemainingSeconds || 0) / 60);
  const secs = (pausedRemainingSeconds || 0) % 60;
  const left = document.getElementById('exam-paused-remaining');
  if (left) left.innerText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  const note = document.getElementById('exam-paused-note');
  if (note) {
    note.innerText = examPauseCount > 1
      ? `Pause ${examPauseCount} of this exam. Your time is held exactly where it was.`
      : 'Your time is held exactly where it was.';
  }
  overlay.classList.remove('hidden');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function startModuleClock() {
  if (examTimerInterval) clearInterval(examTimerInterval);
  const tick = () => {
    if (activeExam?.isUntimed) { examModuleTimerSeconds = 0; updateExamTimerDisplay(); return; }
    examModuleTimerSeconds = PSAT_ENGINE.computeRemainingSeconds(examModuleDeadline, Date.now());
    updateExamTimerDisplay();
    if (examModuleTimerSeconds <= 0) {
      clearInterval(examTimerInterval); examModuleExpired = true;
      flushExamQuestionTime(); examQuestionShownAt = null;
      showModuleReviewScreen();
    }
  };
  if (!activeExam?.isUntimed) examTimerInterval = setInterval(tick, 1000);
  tick();
}

function updateExamTimerDisplay() {
  const m = Math.floor(examModuleTimerSeconds / 60);
  const s = examModuleTimerSeconds % 60;
  const str = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  const el = document.getElementById('exam-timer-display');
  if (el) el.innerText = activeExam?.isUntimed ? 'Untimed' : (examTimerHidden ? '—:—' : str);
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
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderExamMcqOptions(q) {
  const container = document.getElementById('exam-mcq-options');
  container.innerHTML = '';
  const selected = examUserAnswers[q.id];

  // WI-23: same engine rule as the practice view. Inside a timed exam a blind click
  // is worse than anywhere else, because there is no going back to it.
  const examOptIssue = PSAT_ENGINE.optionTextIssue(q);
  const examNotice = document.getElementById('exam-option-text-notice');
  if (examNotice) {
    if (examOptIssue) {
      examNotice.className = 'banner banner-warning';
      examNotice.setAttribute('data-issue', examOptIssue.code);
      examNotice.textContent = examOptIssue.message;
      examNotice.classList.remove('hidden');
    } else {
      examNotice.classList.add('hidden');
    }
  }

  ['A', 'B', 'C', 'D'].forEach(letter => {
    const isSelected = (selected === letter);
    let optText = `Choice (${letter})`;

    if (Array.isArray(q.options)) {
      const found = q.options.find(o => o.key === letter);
      if (found && found.text) optText = found.text;
    } else if (q.options && q.options[letter]) {
      optText = q.options[letter];
    }
    if (examOptIssue && examOptIssue.useless) optText = '';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.onclick = () => selectExamMcqChoice(letter);
    // WI-13: same design-system .question-option markup as the practice options
    // (styling owned by components.css). The grid container (#exam-mcq-options)
    // keeps its two-column layout from the markup. Uses innerHTML (not
    // createElement/setAttribute) to stay compatible with the lightweight DOM
    // mock in tests/test_buttons_and_interactions.js.
    btn.className = 'question-option' + (isSelected ? ' is-selected' : '');
    btn.innerHTML =
      `<span class="question-option-key">${esc(letter)}</span>` +
      `<span>${esc(optText)}</span>`;
    container.appendChild(btn);
  });
}

function selectExamMcqChoice(choice) {
  if (!moduleCanEdit()) return;
  const q = activeExam.modules[currentModuleIndex].questions[currentExamQIndex];
  examUserAnswers[q.id] = choice;
  renderExamMcqOptions(q);
  renderExamPalettePills();
  persistActiveExamState();
}

function recordExamSprAnswer(val) {
  if (!moduleCanEdit()) return;
  const q = activeExam.modules[currentModuleIndex].questions[currentExamQIndex];
  examUserAnswers[q.id] = val.trim();
  renderExamPalettePills();
  persistActiveExamState();
}

function toggleExamMarkForReview() {
  if (!moduleCanEdit()) return;
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
  examPhase = 'review';
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
      if (!moduleCanEdit()) {
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
  persistActiveExamState();
}

function returnToActiveExamQuestion() {
  if (!moduleCanEdit()) {
    alert('Time for this module has expired. You cannot return to edit questions.');
    return;
  }
  showExamSubview('exam-active');
  loadExamQuestion(currentExamQIndex);
}

function submitCurrentExamModule() {
  if (window.__PSAT_WRITE_BLOCKED__ || pendingCompletion || submittedModules.includes(currentModuleIndex)) return;
  flushExamQuestionTime();
  const mod = activeExam.modules[currentModuleIndex];
  const unanswered = mod.questions.filter(q => !examUserAnswers[q.id]).length;
  let msg = 'Are you sure you want to submit this module? Once submitted, you cannot return to change answers in this module.';
  if (unanswered > 0) {
    msg = `You have ${unanswered} unanswered question(s) in this module.\n\n` + msg;
  }

  if (!confirm(msg)) return;

  submittedModules.push(currentModuleIndex);
  examQuestionShownAt = null;
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
      const isUpper = PSAT_ENGINE.routeAdaptiveTrack(m1Correct / mod.questions.length) === 'Hard'; // >= 16/27
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
      const isUpper = PSAT_ENGINE.routeAdaptiveTrack(mathM1Correct / mod.questions.length) === 'Hard'; // >= 13/22
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

function startBreakTimer(breakSecs, resume = false) {
  examPhase = 'break';
  examQuestionShownAt = null;
  if (!resume) breakDeadline = Date.now() + breakSecs * 1000;
  showExamSubview('exam-break');
  const isMini = activeExam?.type === 'mini_psat89';
  document.getElementById('break-title').innerText = isMini ? 'Scheduled Quick Break' : 'Scheduled 10-Minute Break';
  document.getElementById('break-description').innerText = 'Your completed modules are saved and locked. Math is next.';
  if (breakTimerInterval) clearInterval(breakTimerInterval);
  const tick = () => {
    const seconds = PSAT_ENGINE.computeRemainingSeconds(breakDeadline, Date.now());
    document.getElementById('break-timer-display').innerText = `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    if (seconds <= 0) {clearInterval(breakTimerInterval); resumeExamAfterBreak();}
  };
  if (!persistActiveExamState()) return;
  breakTimerInterval = setInterval(tick,1000); tick();
}

function resumeExamAfterBreak() {
  if (window.__PSAT_WRITE_BLOCKED__) return;
  if (breakTimerInterval) clearInterval(breakTimerInterval);
  if (activeExam && activeExam.type === 'mini_psat89') {
    loadExamModule(1); // Start Section 2: Math Module
  } else {
    loadExamModule(2); // Start Section 2: Math Module 1
  }
}

function finishExamAndShowReport() {
  if (window.__PSAT_WRITE_BLOCKED__) return;
  if (examTimerInterval) clearInterval(examTimerInterval);
  flushExamQuestionTime(); examQuestionShownAt = null;
  const recorded = safeGetStorage('psat_exam_history', []).find(r => r.examId === activeExam.id);
  currentExamReport = recorded || pendingCompletion || PSAT_ENGINE.scoreStandardExam(activeExam, examUserAnswers, examUserTimes);
  currentExamReport.title = activeExam.title || 'Practice Exam';
  currentExamReport.type = activeExam.type;
  currentExamReport.customPlan = activeExam.customPlan || null;
  if (!recorded && !pendingCompletion) {
    currentExamReport.pauseCount = examPauseCount;
    currentExamReport.totalPausedMs = totalPausedMs;
  }
  currentExamReport.shortTestEstimate = PSAT_ENGINE.summarizeExamReport(currentExamReport, questions).shortTestEstimate;
  currentExamReport.formattedDate ||= new Date(currentExamReport.completedAt).toLocaleString();
  const leanReport = PSAT_ENGINE.toLeanReport(currentExamReport);
  pendingCompletion = leanReport; examPhase = 'completed_pending_save';
  if (!persistActiveExamState()) return;

  // Build from persisted state, with a fixed per-exam question identity. Retrying
  // a completed report must never grade the same exam attempt twice.
  const nextProgress = safeGetStorage('psat_progress', {});
  const nextSrs = safeGetStorage('psat_srs', {});
  let nextSessions = safeGetStorage('psat_sessions', {});
  if (!recorded) currentExamReport.moduleReports.forEach(m => m.questions.forEach(q => {
    if (!q.answered) return;
    const id = 'exam_' + activeExam.id + '_' + q.questionId;
    if ((nextProgress[q.questionId]?.attempts || []).some(a=>a.attemptId===id)) return;
    const timeSpent = q.timeSpentMs || null;
    const reliable = PSAT_ENGINE.isTimingReliable(timeSpent);
    nextProgress[q.questionId] = PSAT_ENGINE.buildProgressEntry(nextProgress[q.questionId], {
      attemptId:id, selectedAnswer:q.userAnswer, isCorrect:q.isCorrect, timeSpentMs:timeSpent,
      timingReliable:reliable, at:currentExamReport.completedAt, source:activeExam.type
    });
    nextSrs[q.questionId] = PSAT_ENGINE.scheduleNext(nextSrs[q.questionId] || {questionId:q.questionId},
      PSAT_ENGINE.gradeAttempt(q.isCorrect,timeSpent,reliable),currentExamReport.completedAt,timeSpent);
    nextSessions = PSAT_ENGINE.recordDailySession(nextSessions,q.isCorrect,timeSpent,
      PSAT_ENGINE.localDateKey(currentExamReport.completedAt),reliable);
  }));
  const history = safeGetStorage('psat_exam_history', []);
  if (!recorded) history.unshift(leanReport);
  const outbox = PSAT_ENGINE.getOutboxOps(localStorage,window.location);
  if (!outbox.some(o=>o.id==='exam_'+activeExam.id)) outbox.push({id:'exam_'+activeExam.id,type:'exam_completed',timestamp:currentExamReport.completedAt,payload:leanReport});
  const values = {
    psat_progress:nextProgress,psat_srs:nextSrs,psat_sessions:nextSessions,
    psat_exam_history:history,psat_sync_outbox:outbox,psat_active_exam_state:null
  };
  const saved = window.__PSAT_ENGINE_PARTS.persistence.writeBatch(localStorage,APP_ENV.storagePrefix,values);
  if (!saved.success) {
    offerSaveRecovery(values); return;
  }
  clearActiveExamState();
  const pin = safeGetStorage(OFFLINE_PIN_KEY, null);
  if (pin?.examMeta?.id === activeExam.id) {
    try {localStorage.removeItem(APP_ENV.storagePrefix + OFFLINE_PIN_KEY);} catch(e) {console.warn('Completed offline pin retained:', e);}
    renderOfflineReadyStatus();
  }
  progress=nextProgress;srsState=nextSrs;sessionsState=nextSessions;pendingCompletion=null;
  updateHeaderStats(); triggerCloudSync();
  renderExamLobbyHistory();renderExamReport(currentExamReport);showExamSubview('exam-report');
}

function renderExamReport(report) {
  const fullReport = PSAT_ENGINE.rehydrateReport(report, window.QUESTIONS_DATA || questions);
  currentExamReport = fullReport;
  const summary = PSAT_ENGINE.summarizeExamReport(fullReport, questions);
  const est = summary.shortTestEstimate;
  document.getElementById('report-pause-note').textContent = summary.pauseText;

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
  } else if (est && est.isScored) {
    // WI-37: a focused test long enough to be measurable in both sections. Labelled as
    // an estimate from THIS test, never as an official or composite PSAT result, and
    // never folded into exam trends.
    document.getElementById('report-score-label').innerText = 'Estimated Score from this test (240–1440)';
    document.getElementById('report-total-score').innerText = est.totalScore;
    document.getElementById('report-scale-denom').innerText = '/ 1440 (estimate)';
    document.getElementById('report-rw-score').innerText =
      `${est.rwScore} / 720${est.rwRangeFormatted ? ` (${est.rwRangeFormatted})` : ''}`;
    document.getElementById('report-math-score').innerText =
      `${est.mathScore} / 720${est.mathRangeFormatted ? ` (${est.mathRangeFormatted})` : ''}`;
    document.getElementById('report-scaling-note').innerText =
      `${est.totalRangeFormatted ? `Score Range: ${est.totalRangeFormatted} (90% Confidence Interval). ` : ''}` +
      `Based on ${est.totalAttempted} answered questions (${est.rwAttempted} Reading and Writing, ` +
      `${est.mathAttempted} Math). ${est.disclosure}`;
  } else {
    document.getElementById('report-score-label').innerText = 'Practice Check Score (Raw)';
    document.getElementById('report-total-score').innerText = `${fullReport.totalCorrect} / ${fullReport.totalQuestions}`;
    document.getElementById('report-scale-denom').innerText = `(${fullReport.overallAccuracyPercent}%)`;
    document.getElementById('report-rw-score').innerText = `${fullReport.scores.rwCorrect} / ${fullReport.scores.rwTotal} Correct`;
    document.getElementById('report-math-score').innerText = `${fullReport.scores.mathCorrect} / ${fullReport.scores.mathTotal} Correct`;
    document.getElementById('report-scaling-note').innerText = fullReport.customPlan || fullReport.type === 'focused_custom_test'
      ? 'Focused practice measures these selected topics. It does not predict a PSAT score.'
      : 'This practice check reports raw accuracy. A longer, representative test is needed for a PSAT score estimate.';
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
  renderOfflineReadyStatus();
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
    if (typeof lucide !== 'undefined') lucide.createIcons();
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

  if (typeof lucide !== 'undefined') lucide.createIcons();
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
function persistActiveExamState(pauseOnFailure) {
  if (window.__PSAT_WRITE_BLOCKED__) return false;
  if (!activeExam) return false;

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
    lifecycleVersion: 2, phase:examPhase, submittedModules:[...submittedModules], breakDeadline, pendingCompletion,
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
      blueprintVersion:activeExam.blueprintVersion || null, isHighYield:activeExam.isHighYield,
      isUntimed:activeExam.isUntimed === true, customPlan:activeExam.customPlan || null,
      modules: leanModules
    },
    currentModuleIndex: currentModuleIndex,
    currentExamQIndex: currentExamQIndex,
    examModuleDeadline: examModuleDeadline,
    // WI-35: without these a reload during a pause would come back with no deadline
    // and no banked time — the module would look expired and the student would lose it.
    pausedRemainingSeconds: pausedRemainingSeconds,
    pausedAt: pausedAt,
    totalPausedMs: totalPausedMs,
    examPauseCount: examPauseCount,
    examUserAnswers: examUserAnswers,
    examUserTimes: examUserTimes,
    examMarkedForReview: examMarkedForReview,
    examViewMode: examViewMode,
    savedAt: Date.now()
  };
  const saved = safeSetStorage('psat_active_exam_state', snapshot);
  if (!saved) {
    // A failed resume must not spend the student's banked time during recovery.
    if (pauseOnFailure) Object.assign(snapshot, {
      phase: pauseOnFailure.phase,
      examModuleDeadline: pauseOnFailure.moduleDeadline,
      totalPausedMs: pauseOnFailure.totalPausedMs,
      pausedRemainingSeconds: pauseOnFailure.pausedRemainingSeconds,
      pausedAt: pauseOnFailure.pausedAt
    });
    offerSaveRecovery({psat_active_exam_state:snapshot});
  }
  return saved;
}

function clearActiveExamState() {
  try {
    localStorage.removeItem(APP_ENV.storagePrefix + 'psat_active_exam_state');
  } catch (e) {}
}

function checkActiveExamResume() {
  const saved = safeGetStorage('psat_active_exam_state', null);
  const banner = document.getElementById('exam-resume-banner');
  if (!banner) return;
  const meta = saved ? (saved.activeExamMeta || saved.activeExam) : null;
  if (saved && meta) {
    const titleEl = document.getElementById('resume-exam-title');
    const detailsEl = document.getElementById('resume-exam-details');
    if (titleEl) titleEl.innerText = meta.title || 'In-Progress Exam Available';
    const minsLeft = Math.max(0, Math.ceil((saved.examModuleDeadline - Date.now()) / 60000));
    const totalMods = (meta.modules && meta.modules.length) || 1;
    const status = saved.pendingCompletion ? 'Report awaiting save' : saved.phase === 'paused' ? 'Paused — remaining time is saved' : saved.phase === 'break' ? 'Section break — submitted answers are locked' : meta.isUntimed ? 'Untimed practice' : minsLeft > 0 ? `~${minsLeft} min remaining` : 'Time expired — resume to review and submit';
    if (detailsEl) detailsEl.innerText = `Module ${saved.currentModuleIndex + 1} of ${totalMods} • ${status}.`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');

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
      alert('Some saved questions are unavailable in this version of the question bank. Your saved test is retained. Export a backup before asking for recovery help.');
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

    if (meta.isAdaptive && (!meta.adaptivePools || Object.keys(rehydratedPools).some(key => rehydratedPools[key].length !== (meta.adaptivePools[key] || []).length))) {
      alert('The saved adaptive question pool could not be fully restored. Your saved test is retained; export a backup for recovery.'); return;
    }
    if (!rehydratedModules.length || !Number.isInteger(saved.currentModuleIndex) || !rehydratedModules[saved.currentModuleIndex]) {
      alert('The saved module position cannot be restored. Your saved test is retained.'); return;
    }
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
      blueprintVersion:meta.blueprintVersion, isHighYield:meta.isHighYield,
      isUntimed:meta.isUntimed === true, customPlan:meta.customPlan || null,
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
  examModuleDeadline = saved.examModuleDeadline ?? null;
  examViewMode = saved.examViewMode || 'card';
  examPhase = saved.phase || 'module';
  submittedModules = saved.submittedModules || Array.from({length:currentModuleIndex},(_,i)=>i);
  breakDeadline = saved.breakDeadline ?? null;
  pendingCompletion = saved.pendingCompletion || null;
  // WI-35: restore the pause carriers BEFORE deciding expiry. A paused module has no
  // deadline by design, and the generic expiry test below treats a missing deadline as
  // expired — so without this a reload during a pause would destroy the module.
  pausedRemainingSeconds = saved.pausedRemainingSeconds ?? null;
  pausedAt = saved.pausedAt ?? null;
  totalPausedMs = saved.totalPausedMs ?? 0;
  examPauseCount = saved.examPauseCount ?? 0;

  examModuleExpired = examPhase !== 'paused' && !activeExam.isUntimed &&
    (!Number.isFinite(examModuleDeadline) || Date.now() >= examModuleDeadline);
  examQuestionShownAt = null;
  if (pendingCompletion) {finishExamAndShowReport();return;}
  if (examPhase === 'break') {startBreakTimer(0,true);return;}
  if (examPhase === 'paused') {
    // Come back paused, with the banked time intact. The clock stays stopped until the
    // student resumes, so time spent closed is never charged to them.
    showExamSubview('exam-active');
    document.getElementById('exam-active-module-title').innerText = activeExam.modules[currentModuleIndex].name;
    loadExamQuestion(currentExamQIndex);
    examQuestionShownAt = null;
    examModuleTimerSeconds = pausedRemainingSeconds || 0;
    updateExamTimerDisplay();
    renderPausedOverlay();
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }
  if (submittedModules.includes(currentModuleIndex)) {
    if (currentModuleIndex < activeExam.modules.length-1) loadExamModule(currentModuleIndex+1);
    else finishExamAndShowReport();
    return;
  }
  showExamSubview('exam-active');
  document.getElementById('exam-active-module-title').innerText = activeExam.modules[currentModuleIndex].name;
  loadExamQuestion(currentExamQIndex);
  startModuleClock();
  if (examPhase === 'review' || examModuleExpired) showModuleReviewScreen();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function discardActiveExamState() {
  if (confirm('Are you sure you want to discard your unfinished exam session?')) {
    const backup = PSAT_ENGINE.createClientSnapshot(localStorage, 'archive_unfinished_exam', window.location);
    if (!backup.success) {alert('Archive failed. The unfinished test is retained.');return;}
    clearActiveExamState();
    checkActiveExamResume();
  }
}

window.addEventListener('beforeunload', function (e) {
  if (window.__PSAT_WRITE_BLOCKED__) {e.preventDefault();e.returnValue='A save needs recovery. Download recovery data or retry before leaving.';return e.returnValue;}
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

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function setQuestionErrorTag(qid, tagId) {
  if (!progress[qid]) {
    progress[qid] = { answered: true, isCorrect: false, timestamp: Date.now() };
  }
  progress[qid].errorTag = tagId;
  // WI-38: stamp the metadata revision so the delta push can SEE this change.
  // An error tag on an already-answered question moves no answer timestamp, so
  // without this the tag stayed on the device and never reached the server.
  progress[qid].metaUpdatedAt = Math.max(Date.now(), (progress[qid].metaUpdatedAt || 0) + 1);
  if (!safeSetStorage('psat_progress', progress)) {
    offerSaveRecovery({ psat_progress: progress });
    return;
  }
  // WI-28 finding 3: route every trigger through the one coordinator. A direct
  // pushToCloud here bypassed retry, single-flight and status entirely.
  requestSync('error-tag');
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

  if (mode === 'focused_setup') {
    switchTab('exam');showExamSubview('exam-lobby');
    const host=document.createElement('div');host.className='card';
    document.getElementById('exam-lobby').prepend(host);
    try {mountFocusedBuilder(host, startCustomTestDirect,JSON.parse(urlParams.get('setup')));}
    catch(e){host.textContent='Invalid test setup. No test was started: '+e.message;}
  } else if (mode === 'psat89' || mode === 'standard_psat89') {
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
    const stored = sessionStorage.getItem(APP_ENV.storagePrefix + 'psat_active_custom_test');
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

  // WI-29 finding 1: startup used to perform a standalone PULL only. Work queued
  // offline therefore survived a reload and then just sat there — measured as 0 POSTs
  // and 1 operation still queued five seconds after reopening with connectivity back.
  // It also stamped a sync time and zeroed the legacy pending count after the GET
  // alone, which is the same "download proves the upload" mistake as finding 4.
  // Startup now asks the ONE coordinator for a full drain, so queued work uploads and
  // a failure retries by itself.
  // WI-30 finding 2: startup asks the ONE coordinator for a full drain, so work
  // queued offline uploads on reopen instead of waiting for another trigger.
  //
  // Shipped on the third attempt. Both earlier rollbacks were misdiagnoses of my own
  // making, recorded here because the reasoning matters more than the outcome:
  //   WI-29 blamed offline_exam.spec.js seeing POSTs stay 1 -> 1 after reconnect. That
  //     was a false alarm — pushToCloud legitimately returns `no_changes` WITHOUT
  //     posting when the delta and the outbox are both empty (js/engine/sync.js:571),
  //     so a startup full-push that already drained everything correctly skips the
  //     reconnect request. Asserting request COUNT was the wrong proxy; that test now
  //     asserts queue STATE.
  //   WI-30's first attempt blamed a service worker that never took control. That was
  //     a stray pair of braces I had left in this file — a syntax error that killed
  //     module evaluation, so nothing registered. Nothing to do with startup at all.
  if (!window.__PSAT_WRITE_BLOCKED__ && typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.pullFromCloud) {
    requestSync('startup');
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
  renderReview,
  startSrsReview,
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
  prepareOfflineExam,
  moduleCanEdit,
  pauseExamNow,
  resumeExamNow,
  prepareFocusedTestForOffline,
  requestManualSync,
  requestSync,
  __coordState: () => pageSync.getState(),
  prepareSelectedTestForOffline,
  buildCustomExamFromPlan,
  startPreparedOfflineExam,
  renderOfflineReadyStatus,
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
