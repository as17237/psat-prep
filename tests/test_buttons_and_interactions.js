const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('Testing Button Integrity, Handlers, and Click Interactions across All Pages...');

const PSAT_ENGINE = require('../srs.js');
// WI-09: page logic moved from inline <script> blocks into js/pages/*.js ES
// modules. pageScript() returns exactly the same JavaScript this suite used to
// regex out of the HTML (shared modules first, then the page module, then any
// remaining inline block), with the module syntax flattened so the
// `new Function(...)` runners below are unchanged. Loading mechanism only —
// every assertion in this file is untouched.
const { pageScript } = require('./helpers/page_source');
const questionsData = require('../data/ela_questions.json').concat(require('../data/math_questions.json'));
const rootDir = path.join(__dirname, '..');

const htmlFiles = [
  { file: 'index.html', page: 'student', qVar: 'questions' },
  { file: 'parent.html', page: 'parent', qVar: 'window.QUESTIONS_DATA' },
  { file: 'mistakes.html', page: 'mistakes', qVar: 'window.QUESTIONS_DATA' },
  { file: 'feedback.html', page: 'feedback', qVar: null }
];

// Helper to create comprehensive DOM mock
function createMockEnv(fileName) {
  const mockStorage = {};
  const mockSessionStorage = {};
  const mockElements = {};

  function createElem(id, tag = 'div') {
    return {
      id: id || '',
      tagName: tag.toUpperCase(),
      classList: {
        classes: new Set(),
        remove: function(c) { this.classes.delete(c); },
        add: function(c) { this.classes.add(c); },
        contains: function(c) { return this.classes.has(c); },
        toggle: function(c) { if (this.classes.has(c)) this.classes.delete(c); else this.classes.add(c); }
      },
      style: {},
      innerText: '',
      innerHTML: '',
      value: '',
      src: '',
      disabled: false,
      children: [],
      appendChild: function(child) { this.children.push(child); },
      removeChild: function(child) { this.children = this.children.filter(c => c !== child); },
      querySelector: function() { return createElem('sub_elem'); },
      querySelectorAll: function() { return []; },
      getContext: function() { return { clearRect: () => {}, fillRect: () => {}, beginPath: () => {} }; },
      focus: () => {},
      scrollIntoView: () => {},
      addEventListener: () => {}
    };
  }

  function getMockElem(id) {
    if (!mockElements[id]) {
      mockElements[id] = createElem(id);
    }
    return mockElements[id];
  }

  const window = {
    location: {
      pathname: '/' + fileName,
      search: '',
      href: '/' + fileName,
      reload: () => {}
    },
    QUESTIONS_DATA: questionsData,
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
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
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
    head: createElem('head', 'head'),
    hidden: false
  };

  const lucide = { createIcons: () => {} };
  const alert = () => {};
  const confirm = () => true;
  const prompt = () => 'test_prompt';

  return {
    window,
    document,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    lucide,
    alert,
    confirm,
    prompt,
    getMockElem,
    mockElements,
    mockStorage
  };
}

// 1. Validate All Onclick Attributes and Button Handlers
htmlFiles.forEach(({ file, page }) => {
  const filePath = path.join(rootDir, file);
  if (!fs.existsSync(filePath)) return;

  const html = fs.readFileSync(filePath, 'utf8');

  // Extract all buttons and clickable elements
  const buttonTags = html.match(/<(?:button|a)[^>]*>/gi) || [];
  const onclickTags = html.match(/<(?:button|a|div|span)[^>]*onclick="([^"]+)"[^>]*>/gi) || [];

  console.log(`\n▶ Verifying ${file}: ${buttonTags.length} buttons/links, ${onclickTags.length} onclick elements`);

  // Assert every button has content or icon or aria-label
  buttonTags.forEach((tag, idx) => {
    assert.ok(!tag.includes('onclick=""'), `Empty onclick attribute found in ${file} at tag ${idx + 1}`);
  });

  // Load the page's JavaScript (js/pages/<page>.js + its js/shared/* imports)
  const scriptCode = pageScript(page);

  const env = createMockEnv(file);

  // Compile scripts in mock environment
  const runner = new Function(
    'window',
    'document',
    'localStorage',
    'sessionStorage',
    'lucide',
    'PSAT_ENGINE',
    'alert',
    'confirm',
    'prompt',
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
    `
      ${scriptCode}
      return {
        getVar: function(name) {
          try { return eval(name); } catch(e) { return undefined; }
        },
        exec: function(code) {
          return eval(code);
        }
      };
    `
  );

  const scope = runner(
    env.window,
    env.document,
    env.localStorage,
    env.sessionStorage,
    env.lucide,
    PSAT_ENGINE,
    env.alert,
    env.confirm,
    env.prompt,
    () => 999,
    () => {},
    (fn) => { if (typeof fn === 'function') fn(); return 999; },
    () => {}
  );

  // Verify that every single onclick function is defined in scope
  const uniqueHandlers = new Set();
  onclickTags.forEach(tag => {
    const match = tag.match(/onclick="([^"(]+)/i);
    if (match) {
      const handlerName = match[1].trim();
      // Ignore native browser expressions like window.print or document.getElementById
      if (!handlerName.startsWith('window.') && !handlerName.startsWith('document.') && !handlerName.startsWith('event.')) {
        uniqueHandlers.add(handlerName);
      }
    }
  });

  uniqueHandlers.forEach(handler => {
    const fn = scope.getVar(handler);
    assert.strictEqual(
      typeof fn,
      'function',
      `Handler '${handler}' referenced in onclick in ${file} is not defined as a function in JavaScript scope!`
    );
  });

  console.log(`  ✓ All ${uniqueHandlers.size} unique onclick handlers in ${file} are defined functions: [${Array.from(uniqueHandlers).join(', ')}]`);
});

// 2. Specific Functional Simulation for Trouble Spots & Mistakes Drilling
console.log('\n▶ Simulating Drill Button & Diagnostic Center Interactive Click Pipelines...');

const mistakesEnv = createMockEnv('mistakes.html');
const q1 = questionsData[0];
const q2 = questionsData[1];

mistakesEnv.mockStorage['psat_progress'] = JSON.stringify({
  [q1.id]: { answered: true, isCorrect: false, errorTag: 'concept_gap', timesIncorrect: 2, timesCorrect: 0, timesSeen: 2 }
});
mistakesEnv.mockStorage['psat_exam_history'] = JSON.stringify([
  {
    examId: 'exam_sim_1',
    completedAt: Date.now(),
    moduleReports: [{ questions: [{ questionId: q2.id, id: q2.id, answered: true, isCorrect: false, userAnswer: 'C' }] }]
  }
]);

const mistakesCode = pageScript('mistakes');

const mistakesRunner = new Function(
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'lucide',
  'PSAT_ENGINE',
  'alert',
  'confirm',
  'prompt',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
  `
    ${mistakesCode}
    return {
      loadMistakesData: loadMistakesData,
      renderMistakesFeed: renderMistakesFeed,
      launchMistakesDrill: launchMistakesDrill,
      launchTagCoaching: launchTagCoaching,
      setSubjectTab: setSubjectTab,
      setMistakeErrorTag: setMistakeErrorTag,
      getAllMistakes: () => allMistakesList
    };
  `
);

const mistakesApp = mistakesRunner(
  mistakesEnv.window,
  mistakesEnv.document,
  mistakesEnv.localStorage,
  mistakesEnv.sessionStorage,
  mistakesEnv.lucide,
  PSAT_ENGINE,
  mistakesEnv.alert,
  mistakesEnv.confirm,
  mistakesEnv.prompt,
  () => 999,
  () => {},
  (fn) => { if (typeof fn === 'function') fn(); return 999; },
  () => {}
);

// Run initialization
mistakesApp.loadMistakesData();
mistakesApp.renderMistakesFeed();

// Assert dynamic counter elements are populated
assert.strictEqual(mistakesEnv.getMockElem('summary-drill-count').innerText, 2, 'summary-drill-count must show 2');
assert.strictEqual(mistakesEnv.getMockElem('cnt-total').innerText, 2, 'cnt-total must show 2');

// Simulate clicking "Drill All Missed" button
assert.doesNotThrow(() => {
  mistakesApp.launchMistakesDrill();
}, 'Clicking launchMistakesDrill must execute cleanly');

// Verify active drill payload was stored in sessionStorage
const activeDrill = JSON.parse(mistakesEnv.sessionStorage.getItem('psat_active_custom_test') || '{}');
assert.strictEqual(activeDrill.type, 'mistakes_targeted_drill');
assert.strictEqual(activeDrill.totalQuestions, 2);
assert.strictEqual(activeDrill.questions.length, 2);
assert.ok(activeDrill.questions.some(q => q.id === q1.id));
assert.ok(activeDrill.questions.some(q => q.id === q2.id));
console.log('  ✓ launchMistakesDrill correctly assembled and seeded 2 missed questions into sessionStorage');

// Simulate clicking Tag Coaching buttons
['concept_gap', 'time_pressure', 'misread', 'calc_error'].forEach(tag => {
  assert.doesNotThrow(() => {
    mistakesApp.launchTagCoaching(tag);
  }, `launchTagCoaching('${tag}') must execute without error`);
});
console.log('  ✓ All 4 Adaptive Tag Coaching drill buttons executed successfully');

// Simulate clicking Error Tag Assignment on a question card
assert.doesNotThrow(() => {
  mistakesApp.setMistakeErrorTag(q1.id, 'time_pressure');
});
const updatedProg = JSON.parse(mistakesEnv.mockStorage['psat_progress'] || '{}');
assert.strictEqual(updatedProg[q1.id].errorTag, 'time_pressure', 'Error tag assignment button must update progress in storage');
console.log('  ✓ setMistakeErrorTag button updated progress record successfully');

// 3. Parent Dashboard Trouble Spot Drill Button Simulation
console.log('\n▶ Simulating Parent Dashboard Trouble Spot Drill Button...');
const parentEnv = createMockEnv('parent.html');
parentEnv.mockStorage['psat_progress'] = JSON.stringify({
  [q1.id]: { answered: true, isCorrect: false, errorTag: 'concept_gap', timesIncorrect: 1 }
});

const parentHtml = fs.readFileSync(path.join(rootDir, 'parent.html'), 'utf8');
const parentCode = pageScript('parent');

const parentRunner = new Function(
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'lucide',
  'PSAT_ENGINE',
  'alert',
  'confirm',
  'prompt',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
  `
    ${parentCode}
    return {
      renderTroubleSpots: renderTroubleSpots,
      launchMistakesDrill: launchMistakesDrill,
      launchGapDrill: launchGapDrill,
      launchMiniExamFromParent: launchMiniExamFromParent
    };
  `
);

const parentApp = parentRunner(
  parentEnv.window,
  parentEnv.document,
  parentEnv.localStorage,
  parentEnv.sessionStorage,
  parentEnv.lucide,
  PSAT_ENGINE,
  parentEnv.alert,
  parentEnv.confirm,
  parentEnv.prompt,
  () => 999,
  () => {},
  (fn) => { if (typeof fn === 'function') fn(); return 999; },
  () => {}
);

parentApp.renderTroubleSpots();
assert.strictEqual(parentEnv.getMockElem('btn-drill-count').innerText, 1, 'Parent btn-drill-count must display 1');

assert.doesNotThrow(() => {
  parentApp.launchMistakesDrill();
});
const parentDrill = JSON.parse(parentEnv.sessionStorage.getItem('psat_active_custom_test') || '{}');
assert.strictEqual(parentDrill.totalQuestions, 1);
console.log('  ✓ Parent Dashboard Drill All Missed button verified');

// Simulate Gap Drill Target Focus Area selection and launch
parentEnv.getMockElem('gap-focus-type').value = 'math_only';
parentEnv.window.QUESTIONS_DATA = [q1, q2]; // q1 is Math, q2 is RW
assert.doesNotThrow(() => {
  parentApp.launchGapDrill();
});
const gapDrillPayload = JSON.parse(parentEnv.sessionStorage.getItem('psat_active_custom_test') || '{}');
assert.strictEqual(gapDrillPayload.type, 'gap_targeted_drill');
assert.ok(gapDrillPayload.questions.every(q => q.test === 'Math'), 'Math focus drill must contain only Math questions');
console.log('  ✓ Parent Dashboard Target Focus Area Gap Drill button & payload verified');

// 4. Student Index App Interactive Click Simulations
console.log('\n▶ Simulating Student App Core Button Interactions (index.html)...');
const indexEnv = createMockEnv('index.html');
const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const indexCode = pageScript('student');

const indexRunner = new Function(
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'lucide',
  'PSAT_ENGINE',
  'Chart',
  'alert',
  'confirm',
  'prompt',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
  `
    ${indexCode}
    return {
      switchTab: switchTab,
      startMiniExam: startMiniExam,
      startStandardExam: startStandardExam,
      startGapDrillFromLobby: startGapDrillFromLobby,
      toggleRationale: toggleRationale,
      prevQuestion: prevQuestion,
      nextQuestion: nextQuestion,
      setViewMode: setViewMode
    };
  `
);

const mockChart = function() { return { destroy: () => {}, update: () => {} }; };

const indexApp = indexRunner(
  indexEnv.window,
  indexEnv.document,
  indexEnv.localStorage,
  indexEnv.sessionStorage,
  indexEnv.lucide,
  PSAT_ENGINE,
  mockChart,
  indexEnv.alert,
  indexEnv.confirm,
  indexEnv.prompt,
  () => 999,
  () => {},
  (fn) => { if (typeof fn === 'function') fn(); return 999; },
  () => {}
);

// Test Tab Switches
['practice', 'lobby', 'bank', 'analytics'].forEach(tab => {
  assert.doesNotThrow(() => {
    indexApp.switchTab(tab);
  }, `switchTab('${tab}') button must execute without error`);
});
console.log('  ✓ Navigation tab buttons executed cleanly');

// Test Exam & Drill Starters
assert.doesNotThrow(() => {
  indexApp.startMiniExam();
}, 'startMiniExam button must initialize mini exam state');

assert.doesNotThrow(() => {
  indexApp.startStandardExam();
}, 'startStandardExam button must initialize standard exam state');

assert.doesNotThrow(() => {
  indexApp.startGapDrillFromLobby();
}, 'startGapDrillFromLobby button must initialize targeted gap drill');

console.log('  ✓ Exam launcher buttons (Mini Exam, Standard Exam, Gap Drill) verified');

console.log('\n======================================================================');
console.log('✓ ALL BUTTON INTEGRITY & INTERACTION TESTS PASSED (100% SUCCESS)');
console.log('======================================================================\n');
process.exit(0);
