const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('Testing UI Page Script Executions & Trouble Spots Error Diagnostic Hub...');

const PSAT_ENGINE = require('../srs.js');
const questionsData = require('../data/ela_questions.json').concat(require('../data/math_questions.json'));

// 1. Test mistakes.html Script Execution & Rendering
function testMistakesPage() {
  const html = fs.readFileSync(path.join(__dirname, '../mistakes.html'), 'utf8');
  const scripts = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi) || [];

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

  const code = scripts.map(s => s.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '')).join('\n');
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

testMistakesPage();
console.log('✓ All UI Page rendering tests passed!\n');
