/**
 * js/shared/html.js — HTML-escaping used by every page that builds markup
 * with template literals.
 *
 * WI-09 duplication ledger: `esc()` existed verbatim in index.html,
 * parent.html and mistakes.html, and feedback.html carried a near-identical
 * `escapeHtml()`. 4 sites -> 1 module.
 *
 * The feedback.html variant guarded with `if (!s) return ''` instead of an
 * explicit null/undefined check, so it also mapped `0` and `false` to ''.
 * Every one of its call sites passes a string taken from a form field
 * (category / qid / title / desc / tester, with qid defaulting to 'N/A'), so
 * the two behave identically on all reachable inputs; the explicit
 * null/undefined form is the one kept because it does not silently eat a
 * legitimate `0`.
 */

export function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
