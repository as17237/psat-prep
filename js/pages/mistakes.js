/**
 * js/pages/mistakes.js — page controller for mistakes.html.
 *
 * WI-09: relocated out of mistakes.html's 654-line inline <script>. Pure
 * mechanical move — the only edits are the shared-module imports below
 * (replacing byte-identical local copies), the `launchMistakesDrill()`
 * wrapper that binds the shared drill launcher to this page's list, and the
 * explicit window bindings at the bottom.
 */
import { esc } from '../shared/html.js';
import { APP_ENV } from '../shared/env.js';
import { safeGetStorage, safeSetStorage, readSyncBadgeState, onPendingSyncCountChanged } from '../shared/storage.js';
import { cloneProdDataToBeta, resetBetaSandbox } from '../shared/beta_sandbox.js';
import { questionImageSrc } from '../shared/questions.js';
import { launchTargetedMistakeDrill } from '../shared/drill.js';

// safeSetStorage bumps the pending-sync counter; this is how it reaches this
// page's badge. Registered during module evaluation, before any write can
// happen -- the inline original called updateMistakesSyncBadge() directly.
onPendingSyncCountChanged(updateMistakesSyncBadge);

function updateMistakesSyncBadge() {
  const txt = document.getElementById('mistakes-sync-status-text');
  if (!txt) return;
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
    txt.innerText = `Cosmos DB: ${pending} Pending`;
  } else {
    txt.innerText = `Cosmos DB Synced${timeAgoStr}`;
  }
}

let allMistakesList = [];
let currentSubjectTab = 'all';
let currentDomainFilter = 'all';
let currentSearchQuery = '';
let currentSortMode = 'freq';
let currentPage = 1;
const pageSize = 8;

function syncMistakesFromCloud(isManual = false) {
  const txt = document.getElementById('mistakes-sync-status-text');
  if (txt) txt.innerText = 'Syncing...';

  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.pullFromCloud) {
    PSAT_ENGINE.pullFromCloud(localStorage, null, APP_ENV.studentName, safeSetStorage).then(res => {
      if (res && res.success) {
        loadMistakesData();
        renderMistakesFeed();
        localStorage.setItem(APP_ENV.storagePrefix + 'psat_last_cloud_sync_time', String(Date.now()));
        localStorage.setItem(APP_ENV.storagePrefix + 'psat_pending_sync_count', '0');
        updateMistakesSyncBadge();
        if (isManual) {
          if (res.updated) {
            alert(`Successfully synced latest student progress from Cosmos DB profile (${APP_ENV.studentName})! (${res.mergedHistoryCount} completed test/exam reports loaded).`);
          } else {
            alert('Cosmos DB is up to date — all attempts and reports are currently synchronized.');
          }
        }
      } else {
        updateMistakesSyncBadge();
      }
      lucide.createIcons();
    }).catch(err => {
      updateMistakesSyncBadge();
      console.warn('Sync failed:', err);
      if (isManual) alert('Sync failed: Could not reach Cosmos DB sync endpoint.');
    });
  } else {
    if (txt) txt.innerText = 'Cosmos DB Sync';
    if (isManual) alert('Engine is still loading. Please refresh and try again.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  if (APP_ENV.isBeta) {
    const banner = document.getElementById('beta-sandbox-banner');
    if (banner) banner.classList.remove('hidden');
  }
  loadMistakesData();
  
  // Support deep-linking to a specific question ID: mistakes.html?qid=63b013ca
  const params = new URLSearchParams(window.location.search);
  const qidParam = params.get('qid');
  if (qidParam) {
    currentSearchQuery = qidParam.toLowerCase().trim();
    const searchInput = document.getElementById('mistakes-search-input');
    if (searchInput) searchInput.value = qidParam;
  }
  
  renderMistakesFeed();
  syncMistakesFromCloud(false);
  updateMistakesSyncBadge();
});

function loadMistakesData() {
  const progress = safeGetStorage('psat_progress', {});
  const examHistory = safeGetStorage('psat_exam_history', []);
  const questionsData = window.QUESTIONS_DATA || [];
  const qMap = {};
  questionsData.forEach(q => { qMap[q.id] = q; });

  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.buildTroubleSpots) {
    allMistakesList = PSAT_ENGINE.buildTroubleSpots(progress, examHistory, questionsData);
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
    allMistakesList = Object.values(troubleMap);
  }

  // Update counters
  const totalCount = allMistakesList.length;
  const mathCount = allMistakesList.filter(t => (t.question?.test === 'Math' || t.question?.section === 'Math')).length;
  const rwCount = allMistakesList.filter(t => (t.question?.test === 'Reading and Writing' || t.question?.section === 'Reading and Writing')).length;
  const recCount = allMistakesList.filter(t => t.timesWrong >= 2).length;

  document.getElementById('cnt-total').innerText = totalCount;
  document.getElementById('cnt-math').innerText = mathCount;
  document.getElementById('cnt-rw').innerText = rwCount;
  document.getElementById('cnt-recurring').innerText = recCount;
  const topDrill = document.getElementById('top-drill-count');
  if (topDrill) topDrill.innerText = totalCount;
  const sumDrill = document.getElementById('summary-drill-count');
  if (sumDrill) sumDrill.innerText = totalCount;
  document.getElementById('stat-total-missed-badge').innerText = `${totalCount} Questions Missed`;

  document.getElementById('t-all').innerText = totalCount;
  document.getElementById('t-math').innerText = mathCount;
  document.getElementById('t-rw').innerText = rwCount;
  document.getElementById('t-rec').innerText = recCount;

  const coachBox = document.getElementById('adaptive-coaching-box');
  if (coachBox) {
    if (totalCount >= 3) coachBox.classList.remove('hidden');
    else coachBox.classList.add('hidden');
  }

  renderDomainFilterChips();
}

function renderDomainFilterChips() {
  const container = document.getElementById('domain-filter-chips');
  if (!container) return;

  const domainCounts = {};
  allMistakesList.forEach(t => {
    const dom = t.question?.domain || 'General';
    domainCounts[dom] = (domainCounts[dom] || 0) + 1;
  });

  const sorted = Object.keys(domainCounts).sort((a, b) => domainCounts[b] - domainCounts[a]);
  container.innerHTML = '';

  const allBtn = document.createElement('button');
  const isAll = (currentDomainFilter === 'all');
  allBtn.className = 'btn btn-sm ' + (isAll ? 'btn-primary is-active' : 'btn-secondary');
  allBtn.innerText = `All Domains (${allMistakesList.length})`;
  allBtn.onclick = () => { currentDomainFilter = 'all'; currentPage = 1; renderDomainFilterChips(); renderMistakesFeed(); };
  container.appendChild(allBtn);

  sorted.forEach(dom => {
    const count = domainCounts[dom];
    const isActive = (currentDomainFilter === dom);
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm ' + (isActive ? 'btn-primary is-active' : 'btn-secondary');
    btn.innerText = `${dom} (${count})`;
    btn.onclick = () => { currentDomainFilter = dom; currentPage = 1; renderDomainFilterChips(); renderMistakesFeed(); };
    container.appendChild(btn);
  });
}

function setSubjectTab(tab) {
  currentSubjectTab = tab;
  ['all', 'math', 'rw', 'rec'].forEach(t => {
    const btn = document.getElementById(`tab-${t}`);
    if (!btn) return;
    const active = (t === tab || (t === 'rec' && tab === 'recurring'));
    btn.className = 'btn btn-sm ' + (active ? 'btn-primary is-active' : 'btn-secondary');
  });
  currentPage = 1;
  renderMistakesFeed();
}

function onSearchInput(val) {
  currentSearchQuery = (val || '').toLowerCase().trim();
  currentPage = 1;
  renderMistakesFeed();
}

function onSortChange(sortVal) {
  currentSortMode = sortVal;
  currentPage = 1;
  renderMistakesFeed();
}

function goToPage(p) {
  currentPage = p;
  renderMistakesFeed();
  window.scrollTo({ top: 250, behavior: 'smooth' });
}

function renderMistakesFeed() {
  const container = document.getElementById('mistakes-feed-container');
  const pageInfo = document.getElementById('mistakes-page-info');
  const pageButtons = document.getElementById('mistakes-page-buttons');
  const paginationContainer = document.getElementById('mistakes-pagination-container');
  if (!container) return;

  const progress = safeGetStorage('psat_progress', {});
  let filtered = allMistakesList;

  // 1. Subject filter
  if (currentSubjectTab === 'math') {
    filtered = filtered.filter(t => (t.question?.test === 'Math' || t.question?.section === 'Math'));
  } else if (currentSubjectTab === 'rw') {
    filtered = filtered.filter(t => (t.question?.test === 'Reading and Writing' || t.question?.section === 'Reading and Writing'));
  } else if (currentSubjectTab === 'recurring' || currentSubjectTab === 'rec') {
    filtered = filtered.filter(t => t.timesWrong >= 2);
  }

  // 2. Domain filter
  if (currentDomainFilter !== 'all') {
    filtered = filtered.filter(t => (t.question?.domain === currentDomainFilter));
  }

  // 3. Search query filter
  if (currentSearchQuery) {
    filtered = filtered.filter(t => {
      const qText = (t.question?.question_text || t.question?.prompt || '').toLowerCase();
      const dom = (t.question?.domain || '').toLowerCase();
      const skill = (t.question?.skill || '').toLowerCase();
      const qid = (t.questionId || '').toLowerCase();
      return qText.includes(currentSearchQuery) || dom.includes(currentSearchQuery) || skill.includes(currentSearchQuery) || qid.includes(currentSearchQuery);
    });
  }

  // 4. Sort
  if (currentSortMode === 'freq') {
    filtered.sort((a, b) => {
      if (b.timesWrong !== a.timesWrong) return b.timesWrong - a.timesWrong;
      return (b.lastAttemptTime || 0) - (a.lastAttemptTime || 0);
    });
  } else if (currentSortMode === 'recent') {
    filtered.sort((a, b) => (b.lastAttemptTime || 0) - (a.lastAttemptTime || 0));
  } else if (currentSortMode === 'hard') {
    const diffWeight = { 'Hard': 3, 'Medium': 2, 'Easy': 1 };
    filtered.sort((a, b) => (diffWeight[b.question?.difficulty] || 0) - (diffWeight[a.question?.difficulty] || 0));
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="bg-white p-12 rounded-3xl border border-slate-200 text-center space-y-3 shadow-xs">
        <i data-lucide="check-circle-2" class="w-12 h-12 mx-auto text-emerald-500"></i>
        <h3 class="text-base font-bold text-slate-800">No trouble questions found</h3>
        <p class="text-xs text-slate-500 max-w-md mx-auto">No mistakes match the selected filters. Great progress! Try clearing search filters or selecting "All Domains".</p>
      </div>
    `;
    if (paginationContainer) paginationContainer.classList.add('hidden');
    lucide.createIcons();
    return;
  }

  if (paginationContainer) paginationContainer.classList.remove('hidden');

  // Pagination calculation
  const totalPages = Math.ceil(filtered.length / pageSize) || 1;
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIdx = (currentPage - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, filtered.length);
  const pageItems = filtered.slice(startIdx, endIdx);

  if (pageInfo) {
    pageInfo.innerText = `Showing questions ${startIdx + 1}–${endIdx} of ${filtered.length} total mistake${filtered.length === 1 ? '' : 's'} (Page ${currentPage} of ${totalPages})`;
  }

  // Render pagination buttons
  if (pageButtons) {
    pageButtons.innerHTML = '';
    const prev = document.createElement('button');
    prev.className = `px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all ${currentPage > 1 ? 'bg-white hover:bg-slate-100 text-slate-700 border-slate-200' : 'bg-slate-50 text-slate-300 border-slate-100 cursor-not-allowed'}`;
    prev.innerHTML = '&larr; Prev';
    prev.disabled = (currentPage <= 1);
    prev.onclick = () => goToPage(currentPage - 1);
    pageButtons.appendChild(prev);

    for (let p = 1; p <= totalPages; p++) {
      if (totalPages > 7 && Math.abs(p - currentPage) > 2 && p !== 1 && p !== totalPages) {
        if (p === 2 || p === totalPages - 1) {
          const dots = document.createElement('span');
          dots.className = 'px-1 text-slate-400 font-bold';
          dots.innerText = '…';
          pageButtons.appendChild(dots);
        }
        continue;
      }
      const pBtn = document.createElement('button');
      const isCurr = (p === currentPage);
      pBtn.className = `w-8 h-8 rounded-xl text-xs font-bold transition-all ${isCurr ? 'bg-indigo-600 text-white shadow-xs' : 'bg-white hover:bg-slate-100 text-slate-700 border border-slate-200'}`;
      pBtn.innerText = p;
      pBtn.onclick = () => goToPage(p);
      pageButtons.appendChild(pBtn);
    }

    const next = document.createElement('button');
    next.className = `px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all ${currentPage < totalPages ? 'bg-white hover:bg-slate-100 text-slate-700 border-slate-200' : 'bg-slate-50 text-slate-300 border-slate-100 cursor-not-allowed'}`;
    next.innerHTML = 'Next &rarr;';
    next.disabled = (currentPage >= totalPages);
    next.onclick = () => goToPage(currentPage + 1);
    pageButtons.appendChild(next);
  }

  // Render spacious, high-contrast question cards
  container.innerHTML = '';
  pageItems.forEach((t, idx) => {
    const q = t.question || {};
    const isMath = (q.test === 'Math' || q.section === 'Math');
    const diffColor = q.difficulty === 'Hard' ? 'bg-rose-100 text-rose-800 border-rose-200' : (q.difficulty === 'Medium' ? 'bg-amber-100 text-amber-800 border-amber-200' : 'bg-emerald-100 text-emerald-800 border-emerald-200');
    const timeSec = Math.round((t.lastTimeSpentMs || 0) / 1000);
    const timeStr = timeSec > 0 ? `${timeSec}s` : '—';
    const dateStr = t.lastAttemptTime ? new Date(t.lastAttemptTime).toLocaleDateString() : 'Recent';

    // Options rendering
    let optionsHtml = '';
    if (Array.isArray(q.options) && q.options.length > 0) {
      optionsHtml = `
        <div class="space-y-2.5 pt-3 border-t border-slate-100">
          <span class="text-xs font-bold text-slate-500 uppercase tracking-wider block">Answer Choices &amp; Attempt Diagnostic</span>
          <div class="grid grid-cols-1 gap-2">
            ${q.options.map(opt => {
              const isCorrect = String(opt.key).trim().toUpperCase() === String(q.correct_answer).trim().toUpperCase();
              const isStudent = t.lastUserAnswer && String(opt.key).trim().toUpperCase() === String(t.lastUserAnswer).trim().toUpperCase();
              
              let borderBg = 'border-slate-200 bg-white hover:bg-slate-50';
              let statusTag = '';

              if (isCorrect) {
                borderBg = 'border-emerald-500 bg-emerald-50/80 ring-1 ring-emerald-500';
                statusTag = '<span class="px-2.5 py-1 bg-emerald-600 text-white text-xs font-bold rounded-lg shrink-0">Official Correct Answer ✓</span>';
              } else if (isStudent) {
                borderBg = 'border-rose-400 bg-rose-50/80 ring-1 ring-rose-400';
                statusTag = '<span class="px-2.5 py-1 bg-rose-600 text-white text-xs font-bold rounded-lg shrink-0">Student Selected ❌</span>';
              }

              return `
                <div class="p-3.5 rounded-2xl border ${borderBg} flex items-center justify-between gap-3 text-sm transition-all">
                  <div class="flex items-start space-x-3">
                    <span class="font-bold text-slate-900 bg-slate-100 px-2 py-0.5 rounded-md text-xs">${esc(opt.key)}</span>
                    <span class="text-slate-800 font-medium leading-relaxed">${esc(opt.text || '')}</span>
                  </div>
                  ${statusTag}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    // High-resolution diagram rendering
    let diagramHtml = '';
    if (q.image_url || q.question_image) {
      const imgSrc = questionImageSrc(q);
      diagramHtml = `
        <div class="p-4 bg-slate-50 rounded-2xl border border-slate-200 flex flex-col items-center justify-center space-y-2 group cursor-pointer" onclick="openImageLightbox('${esc(imgSrc)}')">
          <img src="${esc(imgSrc)}" class="max-h-72 max-w-full object-contain rounded-xl shadow-xs transition-transform group-hover:scale-[1.01]" alt="Question Diagram">
          <span class="text-xs text-indigo-600 font-semibold flex items-center group-hover:underline">
            <i data-lucide="zoom-in" class="w-3.5 h-3.5 mr-1"></i> Click diagram to inspect full screen
          </span>
        </div>
      `;
    }

    const card = document.createElement('div');
    card.id = `qcard-${t.questionId}`;
    card.className = 'bg-white p-6 sm:p-8 rounded-3xl border border-slate-200 shadow-sm space-y-5 hover:border-slate-300 transition-all';
    
    card.innerHTML = `
      <!-- Card Header & Metadata -->
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="px-3 py-1 rounded-xl text-xs font-bold ${isMath ? 'bg-emerald-100 text-emerald-800' : 'bg-indigo-100 text-indigo-800'}">
            ${isMath ? 'Math' : 'Reading & Writing'}
          </span>
          <span class="px-2.5 py-1 rounded-xl text-xs font-bold border ${diffColor}">
            ${esc(q.difficulty || 'Medium')}
          </span>
          <span class="px-3 py-1 rounded-xl text-xs font-bold ${t.timesWrong >= 2 ? 'bg-rose-600 text-white' : 'bg-rose-100 text-rose-800'}">
            ${t.timesWrong >= 2 ? `⚠️ Missed ${t.timesWrong}× (Recurring)` : 'Missed 1×'}
          </span>
          <span class="text-xs font-mono text-slate-400 font-medium">QID: ${esc(t.questionId)}</span>
        </div>

        <div class="flex items-center space-x-3 text-xs text-slate-500">
          <span>Time spent: <strong class="text-slate-800 font-mono">${timeStr}</strong></span>
          <span>&bull;</span>
          <span>Last missed: <strong class="text-slate-800">${esc(dateStr)}</strong></span>
        </div>
      </div>

      <!-- Domain & Skill -->
      <div>
        <span class="text-xs font-bold text-indigo-700 uppercase tracking-wider">${esc(q.domain || 'Domain')}</span>
        <h3 class="text-base sm:text-lg font-bold text-slate-900 mt-0.5">${esc(q.skill || 'Skill Area')}</h3>
      </div>

      <!-- Question Prompt (Large, High Contrast Typography) -->
      <div class="p-5 bg-slate-50/90 rounded-2xl border border-slate-200/80 text-sm sm:text-base text-slate-900 leading-relaxed font-serif whitespace-pre-wrap">
        ${esc(q.question_text || q.prompt || 'No question prompt available.')}
      </div>

      <!-- High Resolution Diagram (if any) -->
      ${diagramHtml}

      <!-- Answer Choices -->
      ${optionsHtml}

      <!-- Mistake Root-Cause Error Tagging -->
      <div class="p-4 bg-rose-50/60 rounded-2xl border border-rose-200/60 space-y-2 text-xs">
        <div class="flex items-center justify-between">
          <span class="font-bold text-rose-900 flex items-center">
            <i data-lucide="tag" class="w-4 h-4 mr-1.5 text-rose-600"></i> Why did you miss this? (Select Error Tag)
          </span>
          <span class="text-[11px] text-slate-500 font-medium">Categorizes learning gap in Parent Dashboard</span>
        </div>
        <div class="flex flex-wrap gap-1.5 pt-1" id="mtag-bar-${esc(t.questionId)}">
          ${Object.values(PSAT_ENGINE.ERROR_TAGS || {}).map(tg => {
            const isActive = (t.errorTag === tg.id || (progress[t.questionId] && progress[t.questionId].errorTag === tg.id));
            return `
              <button type="button" onclick="setMistakeErrorTag('${esc(t.questionId)}', '${tg.id}')"
                class="btn btn-sm ${isActive ? 'btn-danger is-active' : 'btn-secondary'}">
                ${tg.label}
              </button>
            `;
          }).join('')}
        </div>
      </div>

      <!-- Structured Step-by-Step Rationale & Trap Analysis -->
      ${(typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.renderRationale) ?
        PSAT_ENGINE.renderRationale(q, { userSelectedAnswer: t.lastUserAnswer }) :
        `<div class="p-6 rounded-2xl bg-amber-50/90 border border-amber-200 space-y-2.5">
          <div class="flex items-center space-x-2 text-amber-900 font-bold text-xs uppercase tracking-wider">
            <i data-lucide="book-open" class="w-4 h-4 text-amber-700"></i>
            <span>Official College Board Step-by-Step Solution &amp; Trap Rationale</span>
          </div>
          <div class="text-xs sm:text-sm text-amber-950 leading-relaxed font-sans whitespace-pre-wrap">
            ${esc(q.rationale || 'No official explanation provided for this question.')}
          </div>
        </div>`
      }
    `;

    container.appendChild(card);
  });

  lucide.createIcons();
  if (window.MathJax && window.MathJax.typesetPromise) {
    window.MathJax.typesetPromise();
  }
}

function openImageLightbox(imgSrc) {
  const modal = document.getElementById('image-lightbox-modal');
  const img = document.getElementById('lightbox-img');
  if (modal && img) {
    img.src = imgSrc;
    modal.classList.remove('hidden');
    lucide.createIcons();
  }
}

function closeImageLightbox() {
  const modal = document.getElementById('image-lightbox-modal');
  if (modal) modal.classList.add('hidden');
}

function launchTagCoaching(tagId) {
  const questionsData = window.QUESTIONS_DATA || [];
  const progress = safeGetStorage('psat_progress', {});
  if (typeof PSAT_ENGINE === 'undefined' || !PSAT_ENGINE.generateTagCoachingDrill) {
    alert('Coaching engine is not ready.');
    return;
  }
  const drill = PSAT_ENGINE.generateTagCoachingDrill(questionsData, progress, tagId, { count: 10 });
  if (!drill || !drill.questions || drill.questions.length === 0) {
    alert('No questions found matching this coaching focus.');
    return;
  }
  try {
    sessionStorage.setItem('psat_active_custom_test', JSON.stringify(drill));
    window.location.href = 'index.html?mode=custom';
  } catch (e) {
    alert('Error preparing coaching session: ' + e.message);
  }
}

function setMistakeErrorTag(qid, tagId) {
  const progress = safeGetStorage('psat_progress', {});
  if (!progress[qid]) {
    progress[qid] = { answered: true, isCorrect: false, timestamp: Date.now() };
  }
  progress[qid].errorTag = tagId;
  safeSetStorage('psat_progress', progress);

  // Update in-memory item
  const item = allMistakesList.find(t => t.questionId === qid);
  if (item) item.errorTag = tagId;

  if (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.pushToCloud) {
    PSAT_ENGINE.pushToCloud(localStorage);
  }

  // Re-render tag buttons for this question card
  const bar = document.getElementById(`mtag-bar-${qid}`);
  if (bar && PSAT_ENGINE.ERROR_TAGS) {
    bar.innerHTML = Object.values(PSAT_ENGINE.ERROR_TAGS).map(tg => {
      const isActive = (tagId === tg.id);
      return `
        <button type="button" onclick="setMistakeErrorTag('${qid}', '${tg.id}')"
          class="btn btn-sm ${isActive ? 'btn-danger is-active' : 'btn-secondary'}">
          ${tg.label}
        </button>
      `;
    }).join('');
  }
}

// The markup's `onclick="launchMistakesDrill()"` is unchanged by WI-09; this
// zero-argument wrapper is what it calls, binding the shared launcher to this
// page's list (parent.html has the twin, bound to allTroubleList).
function launchMistakesDrill() {
  launchTargetedMistakeDrill(allMistakesList);
}

// ---------------------------------------------------------------------------
// Global handler surface.
//
// A classic <script> puts every top-level function declaration on `window`;
// an ES module does not. mistakes.html's markup (and the markup this module
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
  // page functions
  updateMistakesSyncBadge,
  syncMistakesFromCloud,
  loadMistakesData,
  renderDomainFilterChips,
  setSubjectTab,
  onSearchInput,
  onSortChange,
  goToPage,
  renderMistakesFeed,
  openImageLightbox,
  closeImageLightbox,
  launchTagCoaching,
  setMistakeErrorTag,
  launchMistakesDrill,
});
