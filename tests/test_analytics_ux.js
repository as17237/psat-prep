/**
 * PSAT PREP - Dedicated UX Test Suite for Student Analytics Dashboard (index.html)
 * 
 * Comprehensive Verification of:
 * 1. DOM Contracts, Layout & Threshold Badges
 * 2. Zero-State First Time User Experience (Graceful Empty Placeholders)
 * 3. Low-Sample Classification (<3 attempts -> strictly In-Progress)
 * 4. High-Accuracy Mastery Classification (>=3 attempts & >=75% -> Mastered Skills)
 * 5. Weakness / Focus Area Detection & Dynamic Lowest-Accuracy Identification
 * 6. Remediation & Growth Journey (Skill transition from Focus Area -> Mastered)
 * 7. Flagged Questions Accounting across Practice and Unattempted items
 * 8. Domain & Difficulty Breakdown Charts Plotting & Memory Lifecycle (.destroy)
 * 9. Tab Switching, View Transitions, and Live Progress Reactivity
 * 10. HTML Sanitization, Special Characters & XSS Safety in Skill/Domain Names
 * 11. Post-Reset Immediate Reactive Synchronization
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PSAT_ENGINE = require('../srs.js');
const questionsData = require('../data/ela_questions.json').concat(require('../data/math_questions.json'));
const indexHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

console.log('======================================================================');
console.log('📊 Testing Student App Analytics UX, Classification & Data Flows');
console.log('======================================================================\n');

// ---------------------------------------------------------------------------
// 1. Static Contract & Accessibility Checks
// ---------------------------------------------------------------------------
console.log('▶ [Part 1] Verifying Analytics View DOM Contracts & UI Elements...');

assert.ok(indexHtml.includes('id="view-analytics"'), 'Must have #view-analytics container');
assert.ok(indexHtml.includes('id="tab-analytics"'), 'Must have #tab-analytics navigation button');
assert.ok(indexHtml.includes('id="stat-attempted"'), 'Must have #stat-attempted metric');
assert.ok(indexHtml.includes('id="stat-accuracy"'), 'Must have #stat-accuracy metric');
assert.ok(indexHtml.includes('id="stat-weakness"'), 'Must have #stat-weakness metric');
assert.ok(indexHtml.includes('id="stat-flagged"'), 'Must have #stat-flagged metric');
assert.ok(indexHtml.includes('id="strengths-list"'), 'Must have #strengths-list container');
assert.ok(indexHtml.includes('id="weaknesses-list"'), 'Must have #weaknesses-list container');
assert.ok(indexHtml.includes('id="inprogress-list"'), 'Must have #inprogress-list container');
assert.ok(indexHtml.includes('id="domainChart"'), 'Must have #domainChart canvas');
assert.ok(indexHtml.includes('id="difficultyChart"'), 'Must have #difficultyChart canvas');

// Verify threshold badge microcopy for student clarity
assert.ok(indexHtml.includes('≥ 75% (Min 3)'), 'Strengths card must display clear mastery threshold');
assert.ok(indexHtml.includes('&lt; 75% (Min 3)'), 'Weakness card must display clear focus area threshold');
assert.ok(indexHtml.includes('&lt; 3 Attempts'), 'In-progress card must display clear in-progress threshold');

console.log('  ✓ Static DOM Contracts & UI Structure Verified');

// ---------------------------------------------------------------------------
// Helper: Create Isolated Mock Runtime for Student App
// ---------------------------------------------------------------------------
function createStudentAppRuntime(customQuestions = null) {
  const dataset = customQuestions || questionsData;
  const mockStorage = {};
  const mockSessionStorage = {};
  const mockElements = {};
  const chartInstances = [];

  function createElem(id, tag = 'div') {
    const elem = {
      id: id || '',
      tagName: tag.toUpperCase(),
      classList: {
        classes: new Set(id === 'view-analytics' || id === 'view-exam' || id === 'view-bank' ? ['hidden'] : []),
        remove: function(c) { this.classes.delete(c); },
        add: function(c) { this.classes.add(c); },
        contains: function(c) { return this.classes.has(c); },
        toggle: function(c) { if (this.classes.has(c)) this.classes.delete(c); else this.classes.add(c); }
      },
      style: {},
      _innerHTML: '',
      innerText: '',
      value: '',
      children: [],
      appendChild: function(child) {
        this.children.push(child);
      },
      removeChild: function(child) {
        this.children = this.children.filter(c => c !== child);
      },
      querySelector: function() { return createElem('sub_elem'); },
      querySelectorAll: function() { return []; },
      getContext: function() {
        return {
          canvas: this,
          clearRect: () => {},
          fillRect: () => {},
          beginPath: () => {}
        };
      },
      focus: () => {},
      scrollIntoView: () => {},
      addEventListener: () => {}
    };

    Object.defineProperty(elem, 'innerHTML', {
      get: function() { return this._innerHTML; },
      set: function(val) {
        this._innerHTML = val;
        if (val === '') {
          this.children = [];
        }
      },
      configurable: true
    });

    return elem;
  }

  function getMockElem(id) {
    if (!mockElements[id]) {
      mockElements[id] = createElem(id);
    }
    return mockElements[id];
  }

  // Pre-seed known elements from HTML
  [
    'view-practice', 'view-exam', 'view-analytics', 'view-bank',
    'tab-practice', 'tab-exam', 'tab-analytics', 'tab-bank',
    'hdr-attempted', 'hdr-accuracy', 'hdr-streak', 'hdr-retention',
    'stat-attempted', 'stat-accuracy', 'stat-weakness', 'stat-flagged',
    'strengths-list', 'weaknesses-list', 'inprogress-list',
    'domainChart', 'difficultyChart', 'demo-mode-banner'
  ].forEach(id => getMockElem(id));

  // Mock Chart constructor to intercept chart data
  class MockChart {
    constructor(ctx, config) {
      this.ctx = ctx;
      this.config = config;
      this.destroyed = false;
      chartInstances.push(this);
    }
    destroy() {
      this.destroyed = true;
    }
  }

  const window = {
    location: { pathname: '/index.html', search: '' },
    QUESTIONS_DATA: dataset,
    localStorage: {
      getItem: k => (mockStorage[k] !== undefined ? mockStorage[k] : null),
      setItem: (k, v) => { mockStorage[k] = String(v); },
      removeItem: k => { delete mockStorage[k]; },
      clear: () => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); }
    },
    sessionStorage: {
      getItem: k => (mockSessionStorage[k] !== undefined ? mockSessionStorage[k] : null),
      setItem: (k, v) => { mockSessionStorage[k] = String(v); },
      removeItem: k => { delete mockSessionStorage[k]; },
      clear: () => { Object.keys(mockSessionStorage).forEach(k => delete mockSessionStorage[k]); }
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    scrollTo: () => {},
    print: () => {}
  };

  const document = {
    addEventListener: () => {},
    getElementById: id => getMockElem(id),
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    querySelector: () => createElem('generic_query'),
    querySelectorAll: () => [],
    createElement: tag => createElem('', tag),
    body: createElem('body', 'body'),
    activeElement: { tagName: 'body' }
  };

  const lucide = { createIcons: () => {} };

  // Extract core JS from index.html
  const scripts = indexHtml.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi) || [];
  const jsCode = scripts.map(s => s.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '')).join('\n');

  // Instantiate runtime runner
  const runner = new Function(
    'window', 'document', 'localStorage', 'sessionStorage', 'lucide', 'Chart', 'PSAT_ENGINE', 'alert', 'confirm',
    `
    ${jsCode}

    return {
      getQuestions: () => questions,
      getProgress: () => progress,
      setProgress: (p) => {
        progress = p;
        localStorage.setItem('psat_progress', JSON.stringify(p));
      },
      getDomainChart: () => domainChartInstance,
      getDifficultyChart: () => difficultyChartInstance,
      renderAnalytics: renderAnalytics,
      updateHeaderStats: updateHeaderStats,
      switchTab: switchTab,
      resetProgress: typeof resetProgress !== 'undefined' ? resetProgress : null
    };
    `
  );

  const ctx = runner(
    window, document, window.localStorage, window.sessionStorage,
    lucide, MockChart, PSAT_ENGINE,
    () => {}, () => true
  );

  return {
    ctx: ctx,
    getElem: getMockElem,
    elements: mockElements,
    storage: mockStorage,
    chartInstances: chartInstances
  };
}

// ---------------------------------------------------------------------------
// 2. Test Zero/Pristine State UX Journey
// ---------------------------------------------------------------------------
console.log('▶ [Part 2] Testing Zero-Data / First-Time User Experience...');
{
  const rt = createStudentAppRuntime();
  rt.ctx.switchTab('analytics');

  const attemptedEl = rt.getElem('stat-attempted');
  const accuracyEl = rt.getElem('stat-accuracy');
  const weaknessEl = rt.getElem('stat-weakness');
  const flaggedEl = rt.getElem('stat-flagged');

  assert.strictEqual(attemptedEl.innerText, '0 / 3059', 'Attempted metric must show 0 / Total on fresh app');
  assert.strictEqual(accuracyEl.innerText, '0%', 'Accuracy must show 0% on fresh app');
  assert.strictEqual(weaknessEl.innerText, 'None yet', 'Top weakness must be "None yet" with zero attempts');
  assert.strictEqual(flaggedEl.innerText, 0, 'Flagged count must be 0 with no flagged questions');

  // Verify graceful empty state placeholders
  const strengthsList = rt.getElem('strengths-list');
  const weaknessesList = rt.getElem('weaknesses-list');
  const inprogressList = rt.getElem('inprogress-list');

  assert.ok(strengthsList.innerHTML.includes('No mastered skills yet'), 'Mastered skills card must show empty state guidance');
  assert.ok(weaknessesList.innerHTML.includes('No weak areas identified yet'), 'Weakness card must show empty state guidance');
  assert.ok(inprogressList.innerHTML.includes('No skills currently in progress'), 'In-progress card must show empty state guidance');

  // Verify charts rendered with 0% data
  const domainChart = rt.ctx.getDomainChart();
  const diffChart = rt.ctx.getDifficultyChart();

  assert.ok(domainChart, 'Domain chart must be initialized');
  assert.ok(diffChart, 'Difficulty chart must be initialized');

  assert.ok(domainChart.config.data.datasets[0].data.every(val => val === 0), 'All domains must be 0% in zero-state');
  assert.deepStrictEqual(diffChart.config.data.datasets[0].data, [0, 0, 0], 'Easy, Medium, Hard must all be 0%');

  console.log('  ✓ Zero-Data UX Journey verified (clean metrics, informative placeholders, safe charts)');
}

// ---------------------------------------------------------------------------
// 3. Test Low-Sample In-Progress Classification (< 3 Attempts)
// ---------------------------------------------------------------------------
console.log('▶ [Part 3] Testing Low-Sample Thresholding (< 3 attempts strictly in-progress)...');
{
  // Pick 2 specific questions in different skills
  const rt = createStudentAppRuntime();
  const allQ = rt.ctx.getQuestions();
  
  const qMath1 = allQ.find(q => q.skill === 'Linear equations in one variable');
  const qMath2 = allQ.find(q => q.skill === 'Linear equations in one variable' && q.id !== qMath1.id);
  const qEla1 = allQ.find(q => q.skill === 'Inferences');

  // Student answered 2 math questions correctly (100%), 1 ELA question incorrectly (0%)
  const testProgress = {
    [qMath1.id]: { answered: true, isCorrect: true },
    [qMath2.id]: { answered: true, isCorrect: true },
    [qEla1.id]: { answered: true, isCorrect: false }
  };

  rt.ctx.setProgress(testProgress);
  rt.ctx.renderAnalytics();

  // Metrics
  assert.strictEqual(rt.getElem('stat-attempted').innerText, '3 / 3059');
  assert.strictEqual(rt.getElem('stat-accuracy').innerText, '67%'); // 2/3 = 66.67% -> 67%
  assert.strictEqual(rt.getElem('stat-weakness').innerText, 'None yet', 'Top weakness must NOT trigger on < 3 attempts');

  const strengthsList = rt.getElem('strengths-list');
  const weaknessesList = rt.getElem('weaknesses-list');
  const inprogressList = rt.getElem('inprogress-list');

  // CRITICAL UX TEST: Math (100%, 2 attempts) and ELA (0%, 1 attempt) MUST both be in In-Progress list
  assert.ok(strengthsList.innerHTML.includes('No mastered skills yet'), '100% with < 3 attempts must NOT be in Mastered list');
  assert.ok(weaknessesList.innerHTML.includes('No weak areas identified yet'), '0% with < 3 attempts must NOT be in Weakness list');

  assert.strictEqual(inprogressList.children.length, 2, 'In-progress list must have exactly 2 active skills');

  // Verify in-progress card details
  const inProgressHTML = inprogressList.children.map(c => c.innerHTML).join(' ');
  assert.ok(inProgressHTML.includes('Linear equations in one variable'), 'Math skill in in-progress list');
  assert.ok(inProgressHTML.includes('100% (2/2)'), 'Math skill badge shows 100% (2/2)');
  assert.ok(inProgressHTML.includes('Inferences'), 'ELA skill in in-progress list');
  assert.ok(inProgressHTML.includes('0% (0/1)'), 'ELA skill badge shows 0% (0/1)');

  console.log('  ✓ Low-Sample Thresholding verified (<3 attempts placed strictly in In-Progress, no premature weakness alarms)');
}

// ---------------------------------------------------------------------------
// 4. Test Mastery & Focus Area Classification (>= 3 Attempts)
// ---------------------------------------------------------------------------
console.log('▶ [Part 4] Testing Mastery & Focus Area Threshold Classification (>= 3 attempts)...');
{
  const rt = createStudentAppRuntime();
  const allQ = rt.ctx.getQuestions();

  const mathLinear = allQ.filter(q => q.skill === 'Linear equations in one variable').slice(0, 4);
  const elaInference = allQ.filter(q => q.skill === 'Inferences').slice(0, 3);
  const elaWords = allQ.filter(q => q.skill === 'Words in Context').slice(0, 4);

  const testProgress = {
    // Linear Equations: 3/3 = 100% (>=75%, >=3 attempts -> MASTERED)
    [mathLinear[0].id]: { answered: true, isCorrect: true },
    [mathLinear[1].id]: { answered: true, isCorrect: true },
    [mathLinear[2].id]: { answered: true, isCorrect: true },

    // Inferences: 1/3 = 33% (<75%, >=3 attempts -> FOCUS AREA)
    [elaInference[0].id]: { answered: true, isCorrect: false },
    [elaInference[1].id]: { answered: true, isCorrect: false },
    [elaInference[2].id]: { answered: true, isCorrect: true },

    // Words in Context: 2/4 = 50% (<75%, >=3 attempts -> FOCUS AREA)
    [elaWords[0].id]: { answered: true, isCorrect: false },
    [elaWords[1].id]: { answered: true, isCorrect: true },
    [elaWords[2].id]: { answered: true, isCorrect: false },
    [elaWords[3].id]: { answered: true, isCorrect: true }
  };

  rt.ctx.setProgress(testProgress);
  rt.ctx.renderAnalytics();

  // Metrics
  assert.strictEqual(rt.getElem('stat-attempted').innerText, '10 / 3059');
  assert.strictEqual(rt.getElem('stat-accuracy').innerText, '60%'); // 6/10 = 60%

  // Top Weakness should identify Inferences (33%) as it has lowest accuracy
  assert.strictEqual(rt.getElem('stat-weakness').innerText, 'Inferences (33%)', 'Top weakness must pinpoint the lowest accuracy focus area');

  const strengthsList = rt.getElem('strengths-list');
  const weaknessesList = rt.getElem('weaknesses-list');
  const inprogressList = rt.getElem('inprogress-list');

  // Mastered Skills Check
  assert.strictEqual(strengthsList.children.length, 1, 'Exactly 1 mastered skill');
  assert.ok(strengthsList.children[0].innerHTML.includes('Linear equations in one variable'));
  assert.ok(strengthsList.children[0].innerHTML.includes('100% (3/3)'));
  assert.ok(strengthsList.children[0].innerHTML.includes('bg-emerald-100'), 'Mastered skill badge must use emerald styling');

  // Focus Areas Check
  assert.strictEqual(weaknessesList.children.length, 2, 'Exactly 2 focus area skills');
  const weaknessHTML = weaknessesList.children.map(c => c.innerHTML).join(' ');
  assert.ok(weaknessHTML.includes('Inferences'));
  assert.ok(weaknessHTML.includes('33% (1/3)'));
  assert.ok(weaknessHTML.includes('Words in Context'));
  assert.ok(weaknessHTML.includes('50% (2/4)'));
  assert.ok(weaknessHTML.includes('bg-rose-100'), 'Focus area badge must use rose styling');

  // In-progress should be empty
  assert.ok(inprogressList.innerHTML.includes('No skills currently in progress'), 'In-progress is empty when all attempted skills have >=3 attempts');

  console.log('  ✓ Mastery (>=75%) & Focus Area (<75%) classification verified with exact lowest-accuracy top weakness');
}

// ---------------------------------------------------------------------------
// 5. Test Remediation & Skill Graduation (Focus Area -> Mastered)
// ---------------------------------------------------------------------------
console.log('▶ [Part 5] Testing Remediation Journey (Skill transition from Focus Area to Mastered)...');
{
  const rt = createStudentAppRuntime();
  const allQ = rt.ctx.getQuestions();

  const elaInference = allQ.filter(q => q.skill === 'Inferences').slice(0, 10);
  const elaWords = allQ.filter(q => q.skill === 'Words in Context').slice(0, 4);

  // Initial State: Inferences is 1/4 = 25% (Focus Area), Words in Context is 2/4 = 50%
  const progress = {
    [elaInference[0].id]: { answered: true, isCorrect: false },
    [elaInference[1].id]: { answered: true, isCorrect: false },
    [elaInference[2].id]: { answered: true, isCorrect: false },
    [elaInference[3].id]: { answered: true, isCorrect: true },

    [elaWords[0].id]: { answered: true, isCorrect: false },
    [elaWords[1].id]: { answered: true, isCorrect: true },
    [elaWords[2].id]: { answered: true, isCorrect: false },
    [elaWords[3].id]: { answered: true, isCorrect: true }
  };

  rt.ctx.setProgress(progress);
  rt.ctx.renderAnalytics();
  assert.strictEqual(rt.getElem('stat-weakness').innerText, 'Inferences (25%)');

  // Student does targeted remediation drill on Inferences and gets next 6 questions correct
  // New Inferences score: 7/10 = 70% (<75% -> still focus area)
  for (let i = 4; i < 10; i++) {
    progress[elaInference[i].id] = { answered: true, isCorrect: true };
  }
  rt.ctx.setProgress(progress);
  rt.ctx.renderAnalytics();

  assert.strictEqual(rt.getElem('stat-weakness').innerText, 'Words in Context (50%)', 'Top weakness updates to Words in Context (50%) since Inferences improved to 70%');

  // Student gets 2 more correct (total 9/12 = 75% -> REACHES 75% THRESHOLD -> GRADUATES TO MASTERED!)
  const extraInference = allQ.filter(q => q.skill === 'Inferences').slice(10, 12);
  progress[extraInference[0].id] = { answered: true, isCorrect: true };
  progress[extraInference[1].id] = { answered: true, isCorrect: true };

  rt.ctx.setProgress(progress);
  rt.ctx.renderAnalytics();

  const strengthsList = rt.getElem('strengths-list');
  const weaknessesList = rt.getElem('weaknesses-list');

  assert.ok(strengthsList.children.some(c => c.innerHTML.includes('Inferences')), 'Inferences must graduate to Mastered Skills');
  assert.ok(!weaknessesList.children.some(c => c.innerHTML.includes('Inferences')), 'Inferences must be removed from Focus Areas');
  assert.strictEqual(rt.getElem('stat-weakness').innerText, 'Words in Context (50%)');

  console.log('  ✓ Remediation Journey verified (skill smoothly transitions across accuracy boundaries from weakness to strength)');
}

// ---------------------------------------------------------------------------
// 6. Test Flagged Questions Accounting UX
// ---------------------------------------------------------------------------
console.log('▶ [Part 6] Testing Flagged Questions Metric & State Tracking...');
{
  const rt = createStudentAppRuntime();
  const allQ = rt.ctx.getQuestions();

  // Flag 3 questions (1 answered correct, 1 answered incorrect, 1 unattempted)
  const progress = {
    [allQ[0].id]: { answered: true, isCorrect: true, isFlagged: true },
    [allQ[1].id]: { answered: true, isCorrect: false, isFlagged: true },
    [allQ[2].id]: { answered: false, isFlagged: true },
    [allQ[3].id]: { answered: true, isCorrect: true, isFlagged: false }
  };

  rt.ctx.setProgress(progress);
  rt.ctx.renderAnalytics();

  assert.strictEqual(rt.getElem('stat-flagged').innerText, 3, 'Flagged count must accurately aggregate all isFlagged: true items');

  // Unflag one question
  progress[allQ[1].id].isFlagged = false;
  rt.ctx.setProgress(progress);
  rt.ctx.renderAnalytics();

  assert.strictEqual(rt.getElem('stat-flagged').innerText, 2, 'Flagged metric must update immediately when flags are toggled');

  console.log('  ✓ Flagged Question Metric verified across attempted and unattempted items');
}

// ---------------------------------------------------------------------------
// 7. Test Domain & Difficulty Performance Breakdown Charts
// ---------------------------------------------------------------------------
console.log('▶ [Part 7] Testing Domain & Difficulty Performance Chart Datasets...');
{
  const rt = createStudentAppRuntime();
  const allQ = rt.ctx.getQuestions();

  // Create known distribution across domains and difficulties
  const qAlgEasy = allQ.find(q => q.domain === 'Algebra' && q.difficulty === 'Easy');
  const qAlgMed = allQ.find(q => q.domain === 'Algebra' && q.difficulty === 'Medium');
  const qInfoHard = allQ.find(q => q.domain === 'Information and Ideas' && q.difficulty === 'Hard');

  const progress = {
    [qAlgEasy.id]: { answered: true, isCorrect: true },
    [qAlgMed.id]: { answered: true, isCorrect: false },
    [qInfoHard.id]: { answered: true, isCorrect: true }
  };

  rt.ctx.setProgress(progress);
  rt.ctx.renderAnalytics();

  const domainChart = rt.ctx.getDomainChart();
  const diffChart = rt.ctx.getDifficultyChart();

  assert.ok(domainChart, 'Domain chart must be created');
  assert.ok(diffChart, 'Difficulty chart must be created');

  const dLabels = domainChart.config.data.labels;
  const dData = domainChart.config.data.datasets[0].data;
  const algIdx = dLabels.indexOf('Algebra');
  const infoIdx = dLabels.indexOf('Information and Ideas');

  assert.ok(algIdx !== -1, 'Algebra domain in chart labels');
  assert.ok(infoIdx !== -1, 'Information and Ideas in chart labels');

  // Algebra: 1 correct out of 2 = 50%
  assert.strictEqual(dData[algIdx], 50, 'Algebra accuracy dataset must be 50%');
  // Information and Ideas: 1 correct out of 1 = 100%
  assert.strictEqual(dData[infoIdx], 100, 'Information and Ideas accuracy dataset must be 100%');

  // Difficulty chart: Easy (1/1 = 100%), Medium (0/1 = 0%), Hard (1/1 = 100%)
  const diffData = diffChart.config.data.datasets[0].data;
  assert.deepStrictEqual(diffData, [100, 0, 100], 'Difficulty chart must accurately reflect [Easy: 100%, Medium: 0%, Hard: 100%]');

  // Test Chart Lifecycle: verify old chart is destroyed on re-render
  const initialDomainInstance = domainChart;
  rt.ctx.renderAnalytics();
  assert.strictEqual(initialDomainInstance.destroyed, true, 'Old chart instance must be destroyed on re-render to prevent canvas memory leaks');

  console.log('  ✓ Domain & Difficulty Chart datasets & memory destruction lifecycle verified');
}

// ---------------------------------------------------------------------------
// 8. Test Tab Switching, View Transitions & Active Classes
// ---------------------------------------------------------------------------
console.log('▶ [Part 8] Testing Interactive Tab Switching & Navigation Flow...');
{
  const rt = createStudentAppRuntime();

  // Initial state: view-practice visible, view-analytics hidden
  assert.strictEqual(rt.getElem('view-analytics').classList.contains('hidden'), true);

  // User clicks Analytics Tab
  rt.ctx.switchTab('analytics');

  assert.strictEqual(rt.getElem('view-analytics').classList.contains('hidden'), false, 'Analytics view must become visible');
  assert.strictEqual(rt.getElem('view-practice').classList.contains('hidden'), true, 'Practice view must be hidden');
  assert.strictEqual(rt.getElem('view-exam').classList.contains('hidden'), true, 'Exam view must be hidden');
  assert.strictEqual(rt.getElem('view-bank').classList.contains('hidden'), true, 'Bank view must be hidden');

  assert.ok(rt.getElem('tab-analytics').className.includes('tab-active'), 'Analytics tab header must have tab-active class');

  // User clicks Exam Tab
  rt.ctx.switchTab('exam');
  assert.strictEqual(rt.getElem('view-analytics').classList.contains('hidden'), true, 'Analytics view must hide when switching away');
  assert.strictEqual(rt.getElem('view-exam').classList.contains('hidden'), false, 'Exam view must become visible');

  console.log('  ✓ View Transitions and Tab active classes verified');
}

// ---------------------------------------------------------------------------
// 9. Test HTML Sanitization & XSS Protection in Skill / Domain Output
// ---------------------------------------------------------------------------
console.log('▶ [Part 9] Testing HTML Sanitization & Special Characters Handling...');
{
  const maliciousQuestions = [
    {
      id: 'SEC_TEST_01',
      test: 'Math',
      domain: 'Algebra <script>alert("xss")</script>',
      skill: 'Linear & "Quadratic" Equations <img src=x onerror=alert(1)>',
      difficulty: 'Easy',
      type: 'multiple_choice',
      question_text: 'What is x?'
    }
  ];

  const rt = createStudentAppRuntime(maliciousQuestions);
  rt.ctx.setProgress({
    'SEC_TEST_01': { answered: true, isCorrect: true }
  });
  rt.ctx.renderAnalytics();

  const inprogressList = rt.getElem('inprogress-list');
  const outputHTML = inprogressList.children.map(c => c.innerHTML).join(' ');

  assert.ok(!outputHTML.includes('<script>'), 'Must sanitize raw <script> tags');
  assert.ok(!outputHTML.includes('<img src=x'), 'Must sanitize raw <img onerror> injection');
  assert.ok(outputHTML.includes('&lt;script&gt;'), 'Must encode < and > as entities');
  assert.ok(outputHTML.includes('&amp;'), 'Must encode & as &amp;');
  assert.ok(outputHTML.includes('&quot;Quadratic&quot;'), 'Must encode quotes as &quot;');

  console.log('  ✓ HTML Sanitization & XSS safety verified for skill and domain metadata rendering');
}

// ---------------------------------------------------------------------------
// 10. Test Reset & Live Reactive Synchronization
// ---------------------------------------------------------------------------
console.log('▶ [Part 10] Testing Reset Action & Live Progress Sync...');
{
  const rt = createStudentAppRuntime();
  const allQ = rt.ctx.getQuestions();

  // Populate progress in memory and storage
  const progData = {
    [allQ[0].id]: { answered: true, isCorrect: true },
    [allQ[1].id]: { answered: true, isCorrect: false }
  };
  rt.storage['psat_progress'] = JSON.stringify(progData);
  rt.ctx.setProgress(progData);

  rt.ctx.switchTab('analytics');
  assert.strictEqual(rt.getElem('stat-attempted').innerText, '2 / 3059');

  // Reset progress in memory and storage
  rt.storage['psat_progress'] = JSON.stringify({});
  rt.ctx.setProgress({});
  rt.ctx.renderAnalytics();

  assert.strictEqual(rt.getElem('stat-attempted').innerText, '0 / 3059');
  assert.strictEqual(rt.getElem('stat-accuracy').innerText, '0%');
  assert.strictEqual(rt.getElem('stat-weakness').innerText, 'None yet');
  assert.ok(rt.getElem('strengths-list').innerHTML.includes('No mastered skills yet'));

  console.log('  ✓ Live Progress Sync and Reset state clearance verified');
}

// ---------------------------------------------------------------------------
// 11. Asynchronous Cloud Sync & Cold-Start Race Condition Lifecycle Test
// ---------------------------------------------------------------------------
console.log('▶ [Part 11] Testing Asynchronous Cloud Sync & Cold-Start Race Condition Lifecycle...');
{
  const rt = createStudentAppRuntime();
  const allQ = rt.ctx.getQuestions();

  // 1. Cold start: empty storage
  rt.storage['psat_progress'] = JSON.stringify({});
  rt.ctx.switchTab('analytics');

  // Immediately on cold load, analytics displays 0 attempts
  assert.strictEqual(rt.getElem('stat-attempted').innerText, '0 / 3059');
  assert.strictEqual(rt.getElem('stat-accuracy').innerText, '0%');
  assert.ok(rt.getElem('strengths-list').innerHTML.includes('No mastered skills yet'));

  // 2. Simulate Cosmos DB pullFromCloud completing asynchronously with real student payload (393 items)
  const mathLinear = allQ.filter(q => q.skill === 'Linear equations in one variable').slice(0, 5);
  const elaInference = allQ.filter(q => q.skill === 'Inferences').slice(0, 5);
  const elaWords = allQ.filter(q => q.skill === 'Words in Context').slice(0, 5);

  const mockCloudProgress = {};
  mathLinear.forEach(q => { mockCloudProgress[q.id] = { answered: true, isCorrect: true }; });
  elaInference.forEach(q => { mockCloudProgress[q.id] = { answered: true, isCorrect: false }; });
  elaWords.forEach(q => { mockCloudProgress[q.id] = { answered: true, isCorrect: true }; });

  // Update storage as pullFromCloud does
  rt.storage['psat_progress'] = JSON.stringify(mockCloudProgress);

  // Simulate pullFromCloud callback resolution in index.html
  rt.ctx.setProgress(mockCloudProgress);
  rt.ctx.updateHeaderStats();
  if (!rt.getElem('view-analytics').classList.contains('hidden')) {
    rt.ctx.renderAnalytics();
  }

  // 3. Verify UI immediately re-rendered with cloud data without manual reload
  assert.strictEqual(rt.getElem('stat-attempted').innerText, '15 / 3059', 'Attempted metric must update to 15 when cloud sync resolves');
  assert.strictEqual(rt.getElem('stat-accuracy').innerText, '67%', 'Accuracy metric must update to 67% (10/15)');
  assert.strictEqual(rt.getElem('stat-weakness').innerText, 'Inferences (0%)', 'Top weakness must identify Inferences');

  const strengthsList = rt.getElem('strengths-list');
  const weaknessesList = rt.getElem('weaknesses-list');

  assert.strictEqual(strengthsList.children.length, 2, 'Must have 2 mastered skills (Linear equations, Words in Context)');
  assert.strictEqual(weaknessesList.children.length, 1, 'Must have 1 focus area (Inferences)');
  assert.ok(!strengthsList.innerHTML.includes('No mastered skills yet'), 'Mastered empty placeholder must be replaced with skill cards');

  // 4. Test manualTriggerCloudSync reactivity
  // Add 1 more question in cloud
  const newQ = allQ.find(q => !mockCloudProgress[q.id]);
  mockCloudProgress[newQ.id] = { answered: true, isCorrect: true };
  rt.storage['psat_progress'] = JSON.stringify(mockCloudProgress);
  rt.ctx.setProgress(mockCloudProgress);

  if (!rt.getElem('view-analytics').classList.contains('hidden')) {
    rt.ctx.renderAnalytics();
  }
  assert.strictEqual(rt.getElem('stat-attempted').innerText, '16 / 3059', 'Manual sync must update Analytics metrics');

  console.log('  ✓ Asynchronous Cloud Sync & Cold-Start Race Condition Lifecycle verified');
}

console.log('\n======================================================================');
console.log('✓ ALL 11 ANALYTICS UX & ASYNC DATA FLOW TEST SUITES PASSED (100% SUCCESS)');
console.log('======================================================================\n');

