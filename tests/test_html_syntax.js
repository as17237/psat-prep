const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('Testing HTML inline scripts syntax validity...');

const root = path.join(__dirname, '..');
const htmlFiles = ['index.html', 'parent.html', 'mistakes.html', 'feedback.html'];

htmlFiles.forEach(file => {
  const filePath = path.join(root, file);
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const scripts = content.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi) || [];
  
  scripts.forEach((scriptTag, idx) => {
    const code = scriptTag.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
    assert.doesNotThrow(() => {
      new Function(code);
    }, `Syntax error found in ${file} (script block ${idx + 1})`);
  });
  console.log(`✓ ${file} passed syntax validation (${scripts.length} script blocks checked)`);
});

console.log('✓ All HTML inline scripts are 100% valid JavaScript!\n');
