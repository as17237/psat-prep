const fs = require('fs');
const assert = require('assert');
const PSAT_ENGINE = require('../srs.js');

const jsContent = fs.readFileSync('data/questions_data.js', 'utf8');
const jsonStr = jsContent.replace(/^window\.QUESTIONS_DATA\s*=\s*/, '').replace(/;\s*$/, '');
const questions = JSON.parse(jsonStr);

let frCount = 0;
let multiFormCount = 0;
let formChecks = 0;

questions.forEach(q => {
  if (q.type === 'free_response') {
    frCount++;
    const key = q.correct_answer;
    const forms = PSAT_ENGINE.extractAcceptedForms(key);
    
    assert(forms.length > 0, `Question ${q.id}: key '${key}' failed to extract accepted forms`);
    
    // Assert at least one numeric form exists
    const hasNumeric = forms.some(f => PSAT_ENGINE.parseNumeric(f) !== null);
    assert(hasNumeric, `Question ${q.id}: key '${key}' does not parse to any numeric form`);

    if (forms.length > 1) {
      multiFormCount++;
    }
    forms.forEach(form => {
      formChecks++;
      const passed = PSAT_ENGINE.gradeFreeResponse(form, key);
      assert.strictEqual(passed, true, `Question ${q.id}: form '${form}' should match key '${key}'`);
    });
  }
});

console.log(`✓ Tested ${frCount} free-response items (${multiFormCount} multi-form keys, ${formChecks} individual forms checked). All passed!`);
