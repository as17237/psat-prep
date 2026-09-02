/**
 * js/shared/dom.js — DOM shims needed because ES modules are strict mode.
 *
 * WI-09 CONTEXT (read this before "simplifying" the function below).
 *
 * The pages' JavaScript used to live in classic inline <script> blocks, which
 * run in SLOPPY mode. It now lives in ES modules, which are ALWAYS strict.
 * That is the one semantic difference the relocation cannot avoid, and it is
 * observable in exactly one place in this codebase:
 *
 *     focusIcon.className = 'w-4 h-4 text-indigo-600 shrink-0';
 *
 * in parent.js's updateGapTestCalculations(). `#gap-focus-icon` is authored as
 * `<i data-lucide="target">`, and lucide.createIcons() — called at the top of
 * parent.html's DOMContentLoaded handler, before this code runs — has already
 * swapped it for an `<svg>` carrying the same id. On an SVGElement,
 * `className` is a read-only SVGAnimatedString: in sloppy mode the assignment
 * silently does nothing, in strict mode it throws
 * "Cannot set property className of #<SVGElement> which has only a getter".
 *
 * Measured on the pre-refactor build (git 6d1c0e9, chromium): the lookup
 * returns an `svg` in the SVG namespace and the assignment is a silent no-op —
 * the icon never receives those classes today.
 *
 * WI-09 is behaviour-frozen, so setClassName() reproduces the sloppy-mode
 * outcome exactly: it assigns where `className` is writable and does nothing
 * where it is not. Making the class actually apply to the icon would be a real
 * (and probably desirable) change to what the parent portal renders; that
 * belongs to WI-14's rebuild of this page, not to a mechanical extraction.
 */

/**
 * Sloppy-mode-equivalent `el.className = value`.
 * @param {Element|null} el
 * @param {string} value
 * @returns {boolean} true if the class was actually applied
 */
export function setClassName(el, value) {
  if (!el) return false;
  // HTMLElement.className is a writable string. SVGElement.className is a
  // read-only SVGAnimatedString, so `typeof` distinguishes the two without
  // sniffing tag names or namespaces.
  if (typeof el.className === 'string') {
    el.className = value;
    return true;
  }
  return false;
}

/**
 * WI-14: actually apply a class string to an element that may be an SVG — e.g. a
 * lucide icon after createIcons() swapped its `<i>` for an `<svg>`. Unlike
 * setClassName() (a deliberate no-op on SVG to preserve WI-09's frozen
 * behaviour), this uses setAttribute('class', …), which is writable on both
 * HTMLElement and SVGElement. This is the "real change" the setClassName header
 * says belongs to WI-14: the parent portal's gap-focus icon now gets its colour.
 * @param {Element|null} el
 * @param {string} value
 * @returns {boolean} true if applied
 */
export function applyClass(el, value) {
  if (!el) return false;
  el.setAttribute('class', value);
  return true;
}
