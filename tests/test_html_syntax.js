const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { allModuleFiles } = require('./helpers/page_source');

console.log('Testing page JavaScript syntax validity...');

const root = path.join(__dirname, '..');
const htmlFiles = ['index.html', 'parent.html', 'mistakes.html', 'feedback.html'];

// ---------------------------------------------------------------------------
// 1. Inline <script> blocks still in the HTML.
//
// WI-09 moved every page's logic into js/pages/*.js, so what remains here is
// only bootstrap/config data (e.g. mistakes.html's window.MathJax block). This
// check is deliberately KEPT rather than deleted: an inline block is still
// shipped to the browser, and a syntax error in one is still fatal.
// ---------------------------------------------------------------------------
let inlineBlocksChecked = 0;
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
  inlineBlocksChecked += scripts.length;
  console.log(`✓ ${file} passed syntax validation (${scripts.length} inline script block(s) checked)`);
});

// ---------------------------------------------------------------------------
// 2. The ES modules the pages now load (WI-09).
//
// `new Function(code)` cannot parse `import`/`export`, so these are checked
// with `node --check`, which parses a file as an ES module when it contains
// module syntax. Verified to fail (exit 1) on a deliberate syntax error.
// ---------------------------------------------------------------------------
const moduleFiles = allModuleFiles();
assert.ok(
  moduleFiles.length > 0,
  'Expected at least one ES module under js/ — WI-09 moved the page logic there. ' +
  'Finding none means this suite would silently check nothing.'
);

moduleFiles.forEach(file => {
  const rel = path.relative(root, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    assert.fail(`Syntax error in ${rel}:\n${(e.stderr || '').toString()}`);
  }
});
console.log(`✓ ${moduleFiles.length} ES module(s) under js/ passed syntax validation`);
moduleFiles.forEach(f => console.log(`    • ${path.relative(root, f)}`));

// ---------------------------------------------------------------------------
// 3. WI-09 structural rule: no logic left in an inline <script>.
//
// The work item allows a bootstrap of at most 5 lines per page and no function
// declarations at all. This pins that so logic cannot creep back into the HTML.
// ---------------------------------------------------------------------------
const { PAGES, entryPath } = require('./helpers/page_source');
const migratedPages = Object.keys(PAGES).filter(p => fs.existsSync(entryPath(p)));
const migratedHtml = migratedPages.map(p => PAGES[p].html);

migratedHtml.forEach(file => {
  const filePath = path.join(root, file);
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const scripts = content.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi) || [];
  scripts.forEach((scriptTag, idx) => {
    const code = scriptTag.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
    assert.ok(
      !/\bfunction\b/.test(code),
      `${file} inline script block ${idx + 1} declares a function — WI-09 requires page logic to live in js/pages/*.js`
    );
    const lines = code.split('\n').filter(l => l.trim().length > 0).length;
    assert.ok(
      lines <= 5,
      `${file} inline script block ${idx + 1} has ${lines} non-blank lines; WI-09 allows a bootstrap of at most 5`
    );
  });
});
console.log(`✓ No logic in any inline <script> across ${migratedHtml.length} migrated page(s) (${inlineBlocksChecked} block(s) inspected)`);

console.log('✓ All page JavaScript is 100% valid JavaScript!\n');
