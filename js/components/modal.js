/**
 * js/components/modal.js — dialog overlay.
 *
 * All text content (title, body, button labels) is escaped. No inline
 * onclick is ever emitted; buttons carry data-testid only, and the page
 * wires behaviour with addEventListener — same convention as
 * js/components/navTabs.js and js/components/emptyState.js, and consistent
 * with how the pages already attach listeners (see js/pages/*.js).
 */
import { esc } from '../shared/html.js';

/**
 * @param {Object} props
 * @param {string} props.title - escaped.
 * @param {string} props.body - escaped.
 * @param {Array<{label: string, variant?: 'primary'|'secondary'|'danger'|'ghost', testId?: string}>} [props.buttons]
 * @param {string} [props.testId]
 * @returns {string} HTML (includes the backdrop wrapper)
 */
export function modal({ title, body, buttons = [], testId } = {}) {
  const attr = (name, v) => (v ? ` ${name}="${esc(v)}"` : '');
  const footerButtons = buttons
    .map(
      (b) =>
        `<button type="button" class="btn btn-${esc(b.variant || 'secondary')} btn-md"${attr('data-testid', b.testId)}>${esc(
          b.label
        )}</button>`
    )
    .join('');
  return (
    `<div class="modal-backdrop"${attr('data-testid', testId && testId + '-backdrop')}>` +
    `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="${esc(testId || 'modal')}-title"${attr(
      'data-testid',
      testId
    )}>` +
    `<div class="modal-header">` +
    `<h2 class="modal-title" id="${esc(testId || 'modal')}-title">${esc(title)}</h2>` +
    `<button type="button" class="modal-close" aria-label="Close"${attr('data-testid', testId && testId + '-close')}>&times;</button>` +
    `</div>` +
    `<div class="modal-body">${esc(body)}</div>` +
    (footerButtons ? `<div class="modal-footer">${footerButtons}</div>` : '') +
    `</div>` +
    `</div>`
  );
}
