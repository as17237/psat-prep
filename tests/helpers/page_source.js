/**
 * WI-09 test-loading helper.
 *
 * BEFORE WI-09 every string-level suite in tests/ obtained the page's
 * JavaScript by regex-extracting the inline <script> blocks out of the HTML:
 *
 *     const scripts = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi) || [];
 *     const code = scripts.map(s => s.replace(...)).join('\n');
 *
 * WI-09 moved that code into native ES modules under js/pages/ and js/shared/,
 * so the regex now returns (almost) nothing. This helper relocates WHAT the
 * suites read; it deliberately does not change WHAT they assert. Every caller
 * gets back a single string containing exactly the same JavaScript it used to
 * get, in dependency order, with the ES-module syntax removed so the existing
 * `new Function(code)` sandbox runners keep working unchanged.
 *
 * Import stripping is safe because the page modules are written in one
 * canonical style (see js/pages/*.js):
 *   - every import is a single-line `import { a, b } from '../shared/x.js';`
 *   - every export is an `export function` / `export const` / `export let`
 *     declaration prefix (never an `export { ... }` list, never a default)
 * assertCanonicalModuleStyle() below hard-fails if that ever stops being true,
 * so this helper can never silently drop a declaration a suite depends on.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

const PAGES = {
  feedback: { html: 'feedback.html', entry: 'js/pages/feedback.js' },
  mistakes: { html: 'mistakes.html', entry: 'js/pages/mistakes.js' },
  parent: { html: 'parent.html', entry: 'js/pages/parent.js' },
  student: { html: 'index.html', entry: 'js/pages/student.js' },
};

const IMPORT_RE = /^\s*import\s+(?:\{[^}]*\}|[\w$]+|\*\s+as\s+[\w$]+)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/;
const BARE_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/;

function assertCanonicalModuleStyle(file, src) {
  const bad = [];
  src.split('\n').forEach((line, i) => {
    if (/^\s*export\s+default\b/.test(line)) bad.push(`${i + 1}: export default`);
    if (/^\s*export\s*\{/.test(line)) bad.push(`${i + 1}: export { ... } list`);
    if (/^\s*import\b/.test(line) && !IMPORT_RE.test(line) && !BARE_IMPORT_RE.test(line)) {
      bad.push(`${i + 1}: non-canonical import -> ${line.trim()}`);
    }
  });
  if (bad.length) {
    throw new Error(
      `tests/helpers/page_source.js: ${file} uses module syntax this helper cannot flatten:\n  ` +
        bad.join('\n  ') +
        '\nEither rewrite it in the canonical style or extend the helper -- do NOT let a suite ' +
        'silently read a truncated copy of the page code.'
    );
  }
}

/** Reads one module, returns { deps: [absolute paths], code: <import/export-stripped source> }. */
function readModule(absPath) {
  const src = fs.readFileSync(absPath, 'utf8');
  assertCanonicalModuleStyle(path.relative(REPO_ROOT, absPath), src);

  const deps = [];
  const out = [];
  src.split('\n').forEach((line) => {
    const m = IMPORT_RE.exec(line) || BARE_IMPORT_RE.exec(line);
    if (m) {
      deps.push(path.resolve(path.dirname(absPath), m[1]));
      out.push(''); // keep line numbering stable
      return;
    }
    out.push(line.replace(/^(\s*)export\s+(?=(async\s+)?function\b|const\b|let\b|var\b|class\b)/, '$1'));
  });
  return { deps, code: out.join('\n') };
}

/** Post-order flatten of the module graph rooted at `entry` (dependencies first). */
function flatten(entryAbs, seen, chunks) {
  if (seen.has(entryAbs)) return;
  seen.add(entryAbs);
  const { deps, code } = readModule(entryAbs);
  deps.forEach((d) => flatten(d, seen, chunks));
  chunks.push(`/* ==== ${path.relative(REPO_ROOT, entryAbs)} ==== */\n${code}`);
}

/**
 * Inline <script> bodies still present in an HTML file (src-less scripts).
 * After WI-09 this is only the per-page bootstrap / config data, never logic;
 * it is appended to the page source so suites see the exact same total
 * JavaScript surface they saw before the extraction.
 */
function inlineScripts(htmlAbsPath) {
  const html = fs.readFileSync(htmlAbsPath, 'utf8');
  const scripts = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi) || [];
  return scripts.map((s) => s.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '')).join('\n');
}

/** Absolute path of a page's HTML file. */
function htmlPath(pageName) {
  if (!PAGES[pageName]) throw new Error(`page_source: unknown page "${pageName}"`);
  return path.join(REPO_ROOT, PAGES[pageName].html);
}

/** Absolute path of a page's ES-module entry point. */
function entryPath(pageName) {
  if (!PAGES[pageName]) throw new Error(`page_source: unknown page "${pageName}"`);
  return path.join(REPO_ROOT, PAGES[pageName].entry);
}

/**
 * The page's complete JavaScript as one evaluable string: every shared module
 * it imports (dependencies first), then the page module, then whatever inline
 * <script> content is still in the HTML.
 *
 * Drop-in replacement for the old inline-script regex extraction.
 */
function pageScript(pageName) {
  const entry = entryPath(pageName);
  if (!fs.existsSync(entry)) {
    // Page not migrated to modules yet (WI-09 lands one page per commit):
    // fall back to the inline scripts so mixed states stay testable.
    return inlineScripts(htmlPath(pageName));
  }
  const chunks = [];
  flatten(entry, new Set(), chunks);
  chunks.push(`/* ==== inline <script> in ${PAGES[pageName].html} ==== */\n${inlineScripts(htmlPath(pageName))}`);
  return chunks.join('\n');
}

/** Every .js file under js/ (used by the syntax suite). */
function allModuleFiles() {
  const root = path.join(REPO_ROOT, 'js');
  if (!fs.existsSync(root)) return [];
  const out = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    });
  })(root);
  return out.sort();
}

module.exports = { PAGES, REPO_ROOT, pageScript, inlineScripts, htmlPath, entryPath, allModuleFiles };
