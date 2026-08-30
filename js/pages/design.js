/**
 * js/pages/design.js — controller for design.html, the WI-12 component
 * reference page. Renders every js/components/* helper in every state it
 * documents (default, loading, empty, error, plus statCard's null/estimate
 * affordances) using real PSAT-domain content — never lorem ipsum.
 *
 * This page reads no student data and writes nothing to storage or sync; it
 * is presentation-only, matching WI-12's scope (REFACTOR_PLAN.md).
 */
import { statCard } from '../components/statCard.js';
import { banner } from '../components/banner.js';
import { modal } from '../components/modal.js';
import { progressBar } from '../components/progressBar.js';
import { questionCard } from '../components/questionCard.js';
import { navTabs } from '../components/navTabs.js';
import { emptyState } from '../components/emptyState.js';
import { dataTable } from '../components/dataTable.js';

// ---------------------------------------------------------------------------
// Real content. The question record below is data/ela_questions.json id
// "09322f3e" verbatim (CLAUDE.md mode 3: never invent a record shape or its
// content) — confirmed against the live dataset 2026-08-30:
//   python3 -c "import json; d=json.load(open('data/ela_questions.json')); \
//     print([q for q in d if q['id']=='09322f3e'][0])"
// The domain counts below are the real, frozen composition of the full
// question bank (data/ela_questions.json + data/math_questions.json,
// 3,059 questions total, counted the same day) — a real measurement, not a
// per-student estimate, so it is safe to chart without an "Estimate" label.
// ---------------------------------------------------------------------------
const SAMPLE_QUESTION = {
  question_text:
    'Video Game Availability by Initial Release Years\nInitial release years Percentage of games still available\n' +
    '1975–1979 0.89\n1980–1984 3.65\n1985–1989 15.38\n1990–1994 19.33\n1995–1999 14.22\n' +
    'In a recent study, researchers found that relatively few video games released over the decades remain ' +
    'available today. For example, only 14.22 percent of games are still available that were initially ' +
    'released in ______\nWhich choice most effectively uses data from the table to complete the statement?',
  domain: 'Information and Ideas',
  skill: 'Command of Evidence',
  difficulty: 'Easy',
  type: 'multiple_choice',
  options: [
    { key: 'A', text: '2000–2004.' },
    { key: 'B', text: '1995–1999.' },
    { key: 'C', text: '1970–1974.' },
    { key: 'D', text: '1985–1989.' },
  ],
  correct_answer: 'B',
  has_image: false, // image omitted on this reference page: it is a screenshot
  // of the table above the question, and the page already renders that table
  // as the question text itself; showing the image too would duplicate it.
};

const DOMAIN_COUNTS = [
  { domain: 'Algebra', count: 577 },
  { domain: 'Information and Ideas', count: 452 },
  { domain: 'Craft and Structure', count: 387 },
  { domain: 'Advanced Math', count: 375 },
  { domain: 'Standard English Conventions', count: 372 },
  { domain: 'Problem-Solving and Data Analysis', count: 361 },
  { domain: 'Expression of Ideas', count: 343 },
  { domain: 'Geometry and Trigonometry', count: 192 },
];

function mount(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function renderStats() {
  mount('ds-stat-value', statCard({ value: 24, label: 'Questions answered today', testId: 'statcard-value' }));
  mount('ds-stat-null', statCard({ value: null, label: 'Adaptive score projection', testId: 'statcard-null' }));
  mount(
    'ds-stat-estimate',
    statCard({ value: 1180, label: 'Projected PSAT score', isEstimate: true, testId: 'statcard-estimate' })
  );
  mount('ds-stat-loading', statCard({ isLoading: true, testId: 'statcard-loading' }));
}

function renderCards() {
  mount(
    'ds-card-default',
    `<div class="card"><h3 class="card-title">Skill focus</h3><p class="card-subtitle">Command of Evidence</p>` +
      `<p style="font-size:var(--text-sm)">Accuracy is trending up this week.</p></div>`
  );
  mount('ds-card-empty', emptyState({ title: 'No sessions yet', description: 'Complete a practice set to see this card fill in.' }));
  mount('ds-card-error', emptyState({ variant: 'error', title: 'Could not load this card', description: 'Try refreshing the page.' }));
}

function renderBanners() {
  const items = [
    { variant: 'info', title: 'Heads up', message: 'Your next SRS review batch is ready.' },
    { variant: 'success', title: 'Backup healthy', message: 'Last backup completed 2 hours ago.' },
    { variant: 'warning', title: 'Backup overdue', message: 'Last successful backup was 40 hours ago.' },
    { variant: 'danger', title: 'Sync failed', message: 'Your last session was not saved to the cloud.' },
  ];
  mount('ds-banners', items.map((b) => banner(Object.assign({ testId: 'banner-' + b.variant }, b))).join(''));
}

function renderProgress() {
  mount('ds-progress-default', progressBar({ value: 12, max: 20, label: 'SRS reviews due today', testId: 'progress-default' }));
  mount('ds-progress-null', progressBar({ value: null, max: 20, label: 'SRS reviews due today', testId: 'progress-null' }));
  mount('ds-progress-success', progressBar({ value: 19, max: 20, label: 'Domain mastery — Algebra', variant: 'success', testId: 'progress-success' }));
  mount('ds-progress-danger', progressBar({ value: 3, max: 20, label: 'Domain mastery — Geometry', variant: 'danger', testId: 'progress-danger' }));
}

function renderTables() {
  const columns = [
    { key: 'skill', label: 'Skill' },
    { key: 'attempted', label: 'Attempted' },
    { key: 'accuracy', label: 'Accuracy %' },
  ];
  mount(
    'ds-table-default',
    dataTable({
      columns,
      rows: [
        { skill: 'Command of Evidence', attempted: 18, accuracy: 78 },
        { skill: 'Transitions', attempted: 12, accuracy: 91 },
        { skill: 'Linear functions', attempted: 4, accuracy: null }, // below the reporting floor — null, not 0%
      ],
      testId: 'table-default',
    })
  );
  mount('ds-table-loading', dataTable({ columns, state: 'loading', testId: 'table-loading' }));
  mount('ds-table-empty', dataTable({ columns, rows: [], testId: 'table-empty' }));
  mount('ds-table-error', dataTable({ columns, rows: [], state: 'error', testId: 'table-error' }));
}

function renderModals() {
  mount(
    'ds-modal-default',
    modal({
      title: 'Resume exam?',
      body: 'You have an exam in progress from earlier today. Resume where you left off, or start a new one.',
      buttons: [
        { label: 'Start new', variant: 'secondary', testId: 'modal-default-secondary' },
        { label: 'Resume', variant: 'primary', testId: 'modal-default-primary' },
      ],
      testId: 'modal-default',
    })
  );
  mount(
    'ds-modal-danger',
    modal({
      title: 'Delete this attempt?',
      body: 'This removes the attempt from your history. This cannot be undone.',
      buttons: [
        { label: 'Cancel', variant: 'secondary', testId: 'modal-danger-cancel' },
        { label: 'Delete', variant: 'danger', testId: 'modal-danger-confirm' },
      ],
      testId: 'modal-danger',
    })
  );
}

function renderTabsDemo() {
  const tabs = [
    { id: 'practice', label: 'Practice', isActive: true },
    { id: 'review', label: 'Review' },
    { id: 'exams', label: 'Exams' },
    { id: 'progress', label: 'My Progress' },
  ];
  mount('ds-tabs-demo', navTabs({ tabs, testId: 'navtabs-demo' }));
  const root = document.getElementById('ds-tabs-demo');
  if (root) {
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab-id]');
      if (!btn || !root.contains(btn)) return;
      root.querySelectorAll('.tab').forEach((t) => {
        t.classList.toggle('is-active', t === btn);
        t.setAttribute('aria-selected', String(t === btn));
      });
    });
  }
}

function renderEmptyStates() {
  mount('ds-empty-default', emptyState({ title: 'No SRS reviews due', description: 'Come back tomorrow, or start a fresh practice set.', testId: 'emptystate-empty' }));
  mount('ds-empty-error', emptyState({ variant: 'error', title: 'Could not load your exam history', description: 'Check your connection and try again.', testId: 'emptystate-error' }));
  mount(
    'ds-empty-action',
    emptyState({ title: 'No mistakes logged yet', description: 'Answer a few questions to build your review queue.', actionLabel: 'Start practicing', testId: 'emptystate-action' })
  );
}

function renderQuestionCard() {
  mount('ds-question-default', questionCard({ question: SAMPLE_QUESTION, testId: 'questioncard-default' }));
  mount(
    'ds-question-revealed',
    questionCard({ question: SAMPLE_QUESTION, selectedKey: 'A', revealAnswer: true, testId: 'questioncard-revealed' })
  );
  mount('ds-question-loading', questionCard({ state: 'loading', testId: 'questioncard-loading' }));
  mount('ds-question-empty', questionCard({ state: 'empty', testId: 'questioncard-empty' }));
}

function renderPageNav() {
  const sections = [
    ['sec-tokens', 'Tokens'],
    ['sec-buttons', 'Buttons'],
    ['sec-stat', 'Stat'],
    ['sec-card', 'Card'],
    ['sec-banner', 'Banner'],
    ['sec-badge', 'Badge'],
    ['sec-progress', 'Progress'],
    ['sec-table', 'Table'],
    ['sec-modal', 'Modal'],
    ['sec-tabs', 'Tabs'],
    ['sec-empty', 'Empty state'],
    ['sec-question', 'Question card'],
    ['sec-chart', 'Charts'],
  ];
  const tabs = sections.map(([id, label], i) => ({ id, label, isActive: i === 0 }));
  mount('ds-nav', navTabs({ tabs, testId: 'navtabs-page' }));
  const root = document.getElementById('ds-nav');
  if (root) {
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab-id]');
      if (!btn) return;
      root.querySelectorAll('.tab').forEach((t) => {
        t.classList.toggle('is-active', t === btn);
        t.setAttribute('aria-selected', String(t === btn));
      });
      const target = document.getElementById(btn.getAttribute('data-tab-id'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

function renderChart() {
  const canvas = document.getElementById('ds-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const style = getComputedStyle(document.documentElement);
  const tokenColors = [1, 2, 3, 4, 5, 6].map((n) => style.getPropertyValue(`--chart-series-${n}`).trim());
  const colors = DOMAIN_COUNTS.map((_, i) => tokenColors[i % tokenColors.length]);
  new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: DOMAIN_COUNTS.map((d) => d.domain),
      datasets: [{ label: 'Questions in bank', data: DOMAIN_COUNTS.map((d) => d.count), backgroundColor: colors }],
    },
    options: {
      responsive: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: style.getPropertyValue('--chart-axis-text').trim() }, grid: { color: style.getPropertyValue('--chart-grid-line').trim() } },
        y: { ticks: { color: style.getPropertyValue('--chart-axis-text').trim() }, grid: { color: style.getPropertyValue('--chart-grid-line').trim() } },
      },
    },
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderPageNav();
  renderStats();
  renderCards();
  renderBanners();
  renderProgress();
  renderTables();
  renderModals();
  renderTabsDemo();
  renderEmptyStates();
  renderQuestionCard();
  renderChart();
});
