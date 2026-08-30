/**
 * js/components/statCard.js — a single metric tile.
 *
 * CLAUDE.md mode 1 is the entire reason this file exists as a shared helper
 * rather than each page formatting its own numbers: `value: number|null` is
 * the API, and `null` renders the em dash BY CONSTRUCTION (see
 * js/components/format.js#formatMetric) — there is no branch a caller can
 * hit that turns "no data" into a displayed "0" or "N/A" typo. Every helper
 * in js/components returns an HTML string (documented once, here): the app
 * already builds markup with template literals and innerHTML (see
 * js/shared/html.js), so string-in/string-out matches the codebase's
 * existing rendering style and needs no DOM/jsdom dependency to unit test.
 */
import { esc } from '../shared/html.js';
import { formatMetric } from './format.js';

/**
 * @param {Object} props
 * @param {number|null} props.value - the measurement. `null` -> "—", never a
 *   fabricated number.
 * @param {string} props.label - short label under the value (escaped).
 * @param {boolean} [props.isEstimate] - when true, renders a visible
 *   "Estimate" badge next to the value so an estimate can never be mistaken
 *   for a measurement (CLAUDE.md mode 1: "never call an estimate Official/
 *   Actual/Projected... unless labelled").
 * @param {string} [props.suffix] - appended to a non-null value (e.g. "%").
 * @param {boolean} [props.isLoading] - renders a skeleton instead of value/label.
 * @param {string} [props.testId] - data-testid on the root element.
 * @returns {string} HTML
 */
export function statCard({ value, label, isEstimate = false, suffix = '', isLoading = false, testId } = {}) {
  const attr = (name, v) => (v ? ` ${name}="${esc(v)}"` : '');

  if (isLoading) {
    return (
      `<div class="stat card is-loading"${attr('data-testid', testId)}>` +
      `<div class="skeleton-line" style="width:4rem;height:2rem;"></div>` +
      `<div class="skeleton-line" style="width:6rem;"></div>` +
      `</div>`
    );
  }

  const isNull = value === null || value === undefined;
  const displayValue = formatMetric(typeof value === 'number' ? value : (isNull ? null : Number(value)), { suffix });
  const valueClass = isNull ? 'stat-value is-null' : 'stat-value';

  return (
    `<div class="stat"${attr('data-testid', testId)}>` +
    `<span class="${valueClass}"${attr('data-testid', testId && testId + '-value')}>${esc(displayValue)}</span>` +
    `<span class="stat-label">${esc(label)}</span>` +
    (isEstimate
      ? `<span class="badge badge-warning stat-estimate-badge"${attr('data-testid', testId && testId + '-estimate-badge')}>Estimate</span>`
      : '') +
    `</div>`
  );
}
