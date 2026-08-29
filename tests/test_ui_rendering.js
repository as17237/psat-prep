const fs = require('fs');
const path = require('path');
const assert = require('assert');
// WI-09: page logic now lives in js/pages/*.js ES modules. pageScript() returns
// the same JavaScript this suite previously regex-extracted from the page's
// inline <script> blocks (shared modules first, then the page module).
// Loading mechanism only — every assertion below is unchanged.
const { pageScript } = require('./helpers/page_source');

console.log('Testing UI Page Script Executions & Trouble Spots Error Diagnostic Hub...');

const PSAT_ENGINE = require('../srs.js');
const questionsData = require('../data/ela_questions.json').concat(require('../data/math_questions.json'));

// 1. Test mistakes.html Script Execution & Rendering
function testMistakesPage() {
  const html = fs.readFileSync(path.join(__dirname, '../mistakes.html'), 'utf8');

  const mockStorage = {};
  const mockElements = {};
  
  function getMockElem(id) {
    if (!mockElements[id]) {
      mockElements[id] = {
        id: id,
        classList: {
          classes: new Set(),
          remove: function(c) { this.classes.delete(c); },
          add: function(c) { this.classes.add(c); },
          contains: function(c) { return this.classes.has(c); }
        },
        innerText: '',
        innerHTML: '',
        value: '',
        children: [],
        appendChild: function(child) { this.children.push(child); }
      };
    }
    return mockElements[id];
  }

  const window = {
    location: { pathname: '/mistakes.html', search: '' },
    QUESTIONS_DATA: questionsData,
    localStorage: {
      getItem: k => (mockStorage[k] !== undefined ? mockStorage[k] : null),
      setItem: (k, v) => { mockStorage[k] = String(v); },
      removeItem: k => { delete mockStorage[k]; }
    },
    scrollTo: () => {}
  };
  const localStorage = window.localStorage;
  const document = {
    addEventListener: () => {},
    getElementById: id => getMockElem(id),
    createElement: tag => ({
      tagName: tag,
      classList: {
        classes: new Set(),
        remove: function(c) { this.classes.delete(c); },
        add: function(c) { this.classes.add(c); }
      },
      appendChild: function() {},
      className: '',
      innerHTML: '',
      innerText: ''
    })
  };
  const lucide = { createIcons: () => {} };

  // Setup mock student with 5 mistakes across Math & RW
  const q1 = questionsData.find(q => q.test === 'Math');
  const q2 = questionsData.find(q => q.test === 'Reading and Writing');
  const q3 = questionsData.find(q => q.test === 'Math' && q.id !== q1.id);
  
  mockStorage['psat_progress'] = JSON.stringify({
    [q1.id]: { answered: true, isCorrect: false, errorTag: 'concept_gap', timesIncorrect: 2, timesCorrect: 0, timesSeen: 2 },
    [q2.id]: { answered: true, isCorrect: false, errorTag: 'time_pressure', timesIncorrect: 1, timesCorrect: 0, timesSeen: 1 },
    [q3.id]: { answered: true, isCorrect: false, errorTag: 'misread', timesIncorrect: 1, timesCorrect: 0, timesSeen: 1 }
  });

  const code = pageScript('mistakes');
  const runner = new Function('window', 'document', 'localStorage', 'lucide', 'PSAT_ENGINE', 'alert', 'confirm', `
    ${code}
    loadMistakesData();
    renderDomainFilterChips();
    renderMistakesFeed();
    return {
      allMistakesList: allMistakesList,
      currentSubjectTab: currentSubjectTab,
      setSubjectTab: setSubjectTab,
      launchTagCoaching: launchTagCoaching
    };
  `);

  const ctx = runner(window, document, localStorage, lucide, PSAT_ENGINE, () => {}, () => true);

  assert.strictEqual(ctx.allMistakesList.length, 3, 'Must aggregate exactly 3 mistakes');
  assert.strictEqual(getMockElem('cnt-total').innerText, 3);
  assert.strictEqual(getMockElem('cnt-math').innerText, 2);
  assert.strictEqual(getMockElem('cnt-rw').innerText, 1);
  assert.strictEqual(getMockElem('cnt-recurring').innerText, 1);

  // Test filter switching
  ctx.setSubjectTab('math');

  // Test Tag Coaching Launcher
  assert.doesNotThrow(() => {
    ctx.launchTagCoaching('concept_gap');
  });

  console.log('✓ mistakes.html Error Diagnostic Center pipeline verified');
}

// 2. Browser-level regression test: Seed 1 practice miss + 1 exam miss -> Trouble Spots displays both
function testTroubleSpotsPracticeAndExamIntegration() {
  const html = fs.readFileSync(path.join(__dirname, '../mistakes.html'), 'utf8');

  const mockStorage = {};
  const mockElements = {};
  
  function getMockElem(id) {
    if (!mockElements[id]) {
      mockElements[id] = {
        id: id,
        classList: {
          classes: new Set(),
          remove: function(c) { this.classes.delete(c); },
          add: function(c) { this.classes.add(c); },
          contains: function(c) { return this.classes.has(c); }
        },
        innerText: '',
        innerHTML: '',
        value: '',
        children: [],
        appendChild: function(child) { this.children.push(child); }
      };
    }
    return mockElements[id];
  }

  const window = {
    location: { pathname: '/mistakes.html', search: '' },
    QUESTIONS_DATA: questionsData,
    localStorage: {
      getItem: k => (mockStorage[k] !== undefined ? mockStorage[k] : null),
      setItem: (k, v) => { mockStorage[k] = String(v); },
      removeItem: k => { delete mockStorage[k]; }
    },
    scrollTo: () => {}
  };
  const localStorage = window.localStorage;
  const document = {
    addEventListener: () => {},
    getElementById: id => getMockElem(id),
    createElement: tag => ({
      tagName: tag,
      id: '',
      classList: {
        classes: new Set(),
        remove: function(c) { this.classes.delete(c); },
        add: function(c) { this.classes.add(c); }
      },
      appendChild: function() {},
      className: '',
      innerHTML: '',
      innerText: ''
    })
  };
  const lucide = { createIcons: () => {} };

  // 1. Seed ONE incorrect practice attempt
  const qPractice = questionsData[0];
  mockStorage['psat_progress'] = JSON.stringify({
    [qPractice.id]: {
      answered: true,
      selectedAnswer: 'A',
      isCorrect: false,
      timesIncorrect: 1,
      timesCorrect: 0,
      timesSeen: 1,
      timestamp: Date.now() - 7200000,
      errorTag: 'concept_gap'
    }
  });

  // 2. Seed ONE incorrect completed-exam question
  const qExam = questionsData[1];
  mockStorage['psat_exam_history'] = JSON.stringify([
    {
      examId: 'exam_standard_benchmark_test_1',
      completedAt: Date.now() - 3600000,
      moduleReports: [
        {
          moduleName: 'Reading and Writing Module 1',
          questions: [
            {
              questionId: qExam.id,
              id: qExam.id,
              answered: true,
              isCorrect: false,
              userAnswer: 'D',
              timeSpentMs: 42000
            }
          ]
        }
      ]
    }
  ]);

  const code = pageScript('mistakes');
  const runner = new Function('window', 'document', 'localStorage', 'lucide', 'PSAT_ENGINE', 'alert', 'confirm', `
    ${code}
    loadMistakesData();
    renderDomainFilterChips();
    renderMistakesFeed();
    return {
      allMistakesList: allMistakesList,
      currentSubjectTab: currentSubjectTab,
      setSubjectTab: setSubjectTab
    };
  `);

  const ctx = runner(window, document, localStorage, lucide, PSAT_ENGINE, () => {}, () => true);

  // Assertions
  assert.strictEqual(ctx.allMistakesList.length, 2, 'Trouble spots must contain both the practice attempt miss and the exam miss');
  assert.strictEqual(getMockElem('cnt-total').innerText, 2, 'Total missed counter must display 2');
  
  const questionIdsInFeed = ctx.allMistakesList.map(t => t.questionId);
  assert.ok(questionIdsInFeed.includes(qPractice.id), `Trouble spots must include the practice missed question (${qPractice.id})`);
  assert.ok(questionIdsInFeed.includes(qExam.id), `Trouble spots must include the completed exam missed question (${qExam.id})`);

  // Verify container rendered both question cards
  const container = getMockElem('mistakes-feed-container');
  assert.strictEqual(container.children.length, 2, 'Feed container must render exactly 2 question cards');
  assert.strictEqual(container.children[0].id, `qcard-${ctx.allMistakesList[0].questionId}`);
  assert.strictEqual(container.children[1].id, `qcard-${ctx.allMistakesList[1].questionId}`);

  // Assert card HTML includes question IDs and structured rationale sections
  assert.ok(container.children.some(c => c.innerHTML.includes(qPractice.id)), 'DOM must contain practice question card');
  assert.ok(container.children.some(c => c.innerHTML.includes(qExam.id)), 'DOM must contain exam question card');
  assert.ok(container.children.some(c => c.innerHTML.includes('Choice') && (c.innerHTML.includes('Correct Answer ✓') || c.innerHTML.includes('Extracted Explanation'))), 'Card must render structured rationale blocks');

  console.log(`✓ Browser-level regression verified: Trouble Spots successfully loaded & rendered both practice miss (${qPractice.id}) and completed exam miss (${qExam.id}) with structured rationales`);
}

function testParentDashboardTargetFocusAreaReaction() {
  console.log('Testing Parent Dashboard "Target Focus Area" Dynamic Reactivity...');

  const html = fs.readFileSync(path.join(__dirname, '..', 'parent.html'), 'utf8');

  const mockDOM = {};
  function getMockElem(id) {
    if (!mockDOM[id]) {
      mockDOM[id] = {
        id: id,
        innerText: '',
        innerHTML: '',
        className: '',
        value: (id === 'gap-focus-type' ? 'all' : (id === 'cust-diff' ? 'All' : (id === 'cust-qtype' ? 'all' : (id === 'cust-count' ? '20' : (id === 'cust-time' ? '30' : ''))))),
        checked: false,
        style: {},
        classList: {
          contains: () => false,
          add: () => {},
          remove: () => {},
          toggle: () => {}
        },
        children: [],
        appendChild: function(c) { this.children.push(c); },
        setAttribute: () => {},
        getAttribute: () => null,
        addEventListener: () => {}
      };
    }
    return mockDOM[id];
  }

  const document = {
    getElementById: (id) => getMockElem(id),
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      innerText: '',
      innerHTML: '',
      className: '',
      style: {},
      children: [],
      appendChild: function(c) { this.children.push(c); },
      setAttribute: () => {},
      getAttribute: () => null,
      classList: { add: () => {}, remove: () => {}, toggle: () => {} }
    }),
    querySelectorAll: () => [],
    addEventListener: () => {}
  };

  const mockStorage = {};
  const localStorage = {
    getItem: (k) => mockStorage[k] || null,
    setItem: (k, v) => { mockStorage[k] = String(v); },
    removeItem: (k) => { delete mockStorage[k]; },
    clear: () => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); }
  };

  const window = {
    location: { href: 'parent.html', origin: 'http://localhost:8000', pathname: '/parent.html' },
    localStorage: localStorage,
    sessionStorage: { setItem: () => {}, getItem: () => null },
    document: document,
    MathJax: { typesetPromise: () => Promise.resolve() },
    QUESTIONS_DATA: [
      { id: 'q_m1', test: 'Math', skill: 'Linear equations in one variable', domain: 'Algebra', difficulty: 'Easy' },
      { id: 'q_m2', test: 'Math', skill: 'Linear equations in one variable', domain: 'Algebra', difficulty: 'Medium' },
      { id: 'q_m3', test: 'Math', skill: 'Nonlinear functions', domain: 'Advanced Math', difficulty: 'Hard' },
      { id: 'q_rw1', test: 'Reading and Writing', skill: 'Boundaries', domain: 'Standard English Conventions', difficulty: 'Easy' },
      { id: 'q_rw2', test: 'Reading and Writing', skill: 'Boundaries', domain: 'Standard English Conventions', difficulty: 'Medium' },
      { id: 'q_rw3', test: 'Reading and Writing', skill: 'Central Ideas and Details', domain: 'Information and Ideas', difficulty: 'Hard' }
    ]
  };

  localStorage.clear();
  localStorage.setItem('psat_progress', JSON.stringify({
    'q_m1': { answered: true, isCorrect: false },
    'q_m2': { answered: true, isCorrect: false }, // Linear equations: 0/2 => weak skill in Math
    'q_rw1': { answered: true, isCorrect: false },
    'q_rw2': { answered: true, isCorrect: false }  // Boundaries: 0/2 => weak skill in RW
  }));
  localStorage.setItem('psat_srs', JSON.stringify({
    'q_m3': { repetitions: 2, dueAt: Date.now() - 5000 }, // Math SRS due
    'q_rw3': { repetitions: 3, dueAt: Date.now() - 5000 }  // RW SRS due
  }));

  const code = pageScript('parent');
  const runner = new Function('window', 'document', 'localStorage', 'lucide', 'PSAT_ENGINE', 'alert', 'confirm', `
    ${code}
    updateGapTestCalculations();
    return {
      updateGapTestCalculations: updateGapTestCalculations,
      setGapCount: setGapCount,
      launchGapDrill: launchGapDrill
    };
  `);

  const lucide = { createIcons: () => {} };
  const ctx = runner(window, document, localStorage, lucide, PSAT_ENGINE, () => {}, () => true);

  // 1. Initial 'all' Focus State
  assert.strictEqual(getMockElem('gap-stat-label-1').innerText, 'Due SRS Cards');
  assert.strictEqual(getMockElem('gap-due-srs').innerText, 2);
  assert.strictEqual(getMockElem('gap-stat-label-2').innerText, 'Weak Skills');
  assert.strictEqual(getMockElem('gap-weak-skills').innerText, 2);
  assert.ok(getMockElem('btn-launch-gap').innerHTML.includes('Launch Gap Drill (20 Qs)'), 'Must show default Gap Drill CTA');

  // 2. Switch to 'math_only' Focus
  getMockElem('gap-focus-type').value = 'math_only';
  ctx.updateGapTestCalculations();

  assert.strictEqual(getMockElem('gap-stat-label-1').innerText, 'Due Math Cards');
  assert.strictEqual(getMockElem('gap-due-srs').innerText, 1, 'Must show 1 due math card');
  assert.strictEqual(getMockElem('gap-stat-label-2').innerText, 'Weak Math Skills');
  assert.strictEqual(getMockElem('gap-weak-skills').innerText, 1, 'Must show 1 weak math skill');
  assert.ok(getMockElem('gap-focus-desc').innerText.includes('Math Mastery Focus'), 'Must update focus description for Math');
  assert.strictEqual(getMockElem('gap-focus-pool-badge').innerText, '3 in Pool');
  assert.ok(getMockElem('btn-launch-gap').innerHTML.includes('Launch Math Drill (20 Qs)'), 'Must update CTA text for Math Drill');

  // 3. Switch to 'rw_only' Focus
  getMockElem('gap-focus-type').value = 'rw_only';
  ctx.updateGapTestCalculations();

  assert.strictEqual(getMockElem('gap-stat-label-1').innerText, 'Due R&W Cards');
  assert.strictEqual(getMockElem('gap-due-srs').innerText, 1, 'Must show 1 due R&W card');
  assert.strictEqual(getMockElem('gap-stat-label-2').innerText, 'Weak R&W Skills');
  assert.strictEqual(getMockElem('gap-weak-skills').innerText, 1, 'Must show 1 weak R&W skill');
  assert.ok(getMockElem('gap-focus-desc').innerText.includes('Reading & Writing Focus'));
  assert.strictEqual(getMockElem('gap-focus-pool-badge').innerText, '3 in Pool');
  assert.ok(getMockElem('btn-launch-gap').innerHTML.includes('Launch R&W Drill (20 Qs)'));

  // 4. Switch to 'srs_only' Focus
  getMockElem('gap-focus-type').value = 'srs_only';
  ctx.updateGapTestCalculations();

  assert.strictEqual(getMockElem('gap-stat-label-1').innerText, 'Due SRS Cards');
  assert.strictEqual(getMockElem('gap-due-srs').innerText, 2);
  assert.strictEqual(getMockElem('gap-stat-label-2').innerText, 'Total SRS Cards');
  assert.strictEqual(getMockElem('gap-weak-skills').innerText, 2);
  assert.ok(getMockElem('gap-focus-desc').innerText.includes('Spaced Repetition Review'));
  assert.ok(getMockElem('btn-launch-gap').innerHTML.includes('Launch SRS Review (20 Qs)'));

  // 5. Switch to 'weak_only' Focus
  getMockElem('gap-focus-type').value = 'weak_only';
  ctx.updateGapTestCalculations();

  assert.strictEqual(getMockElem('gap-stat-label-1').innerText, 'Weak Skills (<75%)');
  assert.strictEqual(getMockElem('gap-due-srs').innerText, 2);
  assert.strictEqual(getMockElem('gap-stat-label-2').innerText, 'Missed & Weak Qs');
  assert.strictEqual(getMockElem('gap-weak-skills').innerText, 4);
  assert.ok(getMockElem('gap-focus-desc').innerText.includes('Weakness Remediation Focus'));
  assert.ok(getMockElem('btn-launch-gap').innerHTML.includes('Launch Weakness Drill (20 Qs)'));

  // 6. Test Question Count Adjustment (e.g. 30 Qs)
  ctx.setGapCount(30);
  assert.strictEqual(getMockElem('gap-est-time').innerText, '45 minutes');
  assert.ok(getMockElem('btn-launch-gap').innerHTML.includes('Launch Weakness Drill (30 Qs)'));

  console.log('✓ Target Focus Area reactivity verified: All 5 focus area options dynamically recompute metrics, stat cards, descriptions, pool counts, and CTA buttons');
}

testMistakesPage();
testTroubleSpotsPracticeAndExamIntegration();
testParentDashboardTargetFocusAreaReaction();
console.log('✓ All UI Page rendering and browser-level regression tests passed!\n');
process.exit(0);
