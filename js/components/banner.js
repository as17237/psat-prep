/**
 * js/components/banner.js — page/section-level message.
 * Returns an HTML string (see js/components/statCard.js header for the
 * string-vs-DOM convention this whole directory follows).
 */
import { esc } from '../shared/html.js';

const ICONS = { info: 'ℹ', success: '✓', warning: '⚠', danger: '✕' };
const ROLES = { info: 'status', success: 'status', warning: 'status', danger: 'alert' };

/**
 * @param {Object} props
 * @param {'info'|'success'|'warning'|'danger'} [props.variant='info']
 * @param {string} [props.title] - escaped.
 * @param {string} props.message - escaped.
 * @param {string} [props.testId]
 * @returns {string} HTML
 */
export function banner({ variant = 'info', title, message, testId } = {}) {
  const v = ICONS[variant] ? variant : 'info';
  const attr = (name, val) => (val ? ` ${name}="${esc(val)}"` : '');
  return (
    `<div class="banner banner-${v}" role="${ROLES[v]}"${attr('data-testid', testId)}>` +
    `<span class="banner-icon" aria-hidden="true">${ICONS[v]}</span>` +
    `<div>` +
    (title ? `<p class="banner-title">${esc(title)}</p>` : '') +
    `<p class="banner-message">${esc(message || '')}</p>` +
    `</div>` +
    `</div>`
  );
}
