/**
 * js/components/progressBar.js — bounded numeric progress.
 *
 * CLAUDE.md mode 1 applies here exactly as it does to statCard: `value: null`
 * must never render as a 0%-filled bar that a reader could mistake for a
 * real "0 of N" measurement. `null` instead renders an empty (0-width,
 * neutral-colored) track plus an explicit "No data yet" caption — the bar
 * and the caption both say "no measurement", not "measured zero".
 */
import { esc } from '../shared/html.js';
import { formatMetric } from './format.js';

/**
 * @param {Object} props
 * @param {number|null} props.value - current amount. `null` -> empty track,
 *   "No data yet" caption, no fabricated percentage.
 * @param {number} [props.max=100]
 * @param {string} [props.label] - escaped, shown above the track.
 * @param {'primary'|'success'|'warning'|'danger'} [props.variant='primary']
 * @param {string} [props.testId]
 * @returns {string} HTML
 */
export function progressBar({ value, max = 100, label, variant = 'primary', testId } = {}) {
  const attr = (name, v) => (v ? ` ${name}="${esc(v)}"` : '');
  const isNull = value === null || value === undefined;
  const pct = isNull ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const barClass = isNull ? 'progress-bar is-empty' : `progress-bar${variant !== 'primary' ? ' is-' + variant : ''}`;
  const caption = isNull
    ? 'No data yet'
    : `${esc(formatMetric(value))} of ${esc(formatMetric(max))}`;

  return (
    `<div class="progress"${attr('data-testid', testId)}>` +
    (label ? `<div class="progress-caption">${esc(label)}</div>` : '') +
    `<div class="progress-track" role="progressbar"` +
    (isNull ? '' : ` aria-valuenow="${esc(String(value))}" aria-valuemin="0" aria-valuemax="${esc(String(max))}"`) +
    `>` +
    `<div class="${barClass}" style="width:${pct}%"></div>` +
    `</div>` +
    `<div class="progress-caption${isNull ? ' is-null' : ''}">${esc(caption)}</div>` +
    `</div>`
  );
}
