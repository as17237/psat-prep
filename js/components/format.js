/**
 * js/components/format.js — the one place a metric turns into displayed text.
 *
 * CLAUDE.md mode 1 ("inventing a number and showing it as a measurement"):
 * a `null` metric must render as an explicit non-number, never a fabricated
 * 0 or empty string that could be mistaken for a real zero. This module is
 * imported by every js/components/* helper that displays a number
 * (statCard, progressBar, dataTable) so that rule is enforced in one place
 * instead of re-implemented per component (CLAUDE.md mode 2).
 */

/** The single glyph used everywhere a metric has no real value. */
export const NULL_METRIC_GLYPH = '—'; // em dash — never a bare '-' or '0'

/**
 * Formats a metric for display. `null`/`undefined` ALWAYS render as the
 * em dash, by construction — there is no code path that turns a missing
 * value into a number.
 * @param {number|null|undefined} value
 * @param {{suffix?: string}} [opts]
 * @returns {string}
 */
export function formatMetric(value, opts) {
  const suffix = (opts && opts.suffix) || '';
  if (value === null || value === undefined || Number.isNaN(value)) {
    return NULL_METRIC_GLYPH;
  }
  return String(value) + suffix;
}
