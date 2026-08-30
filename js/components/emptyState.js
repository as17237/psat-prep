/**
 * js/components/emptyState.js — "there is genuinely nothing here" block.
 *
 * CLAUDE.md mode 1: "empty state means empty: with localStorage cleared, no
 * non-zero number may appear on any page." This component is the shared
 * shape that makes it easy to render an honest empty state instead of a
 * stat/table/card quietly showing 0. It also serves as the error-state body
 * (icon + title + description) via `variant: 'error'`.
 */
import { esc } from '../shared/html.js';

/**
 * @param {Object} props
 * @param {string} [props.icon='📭'] - a single glyph/emoji, not escaped
 *   (author-controlled, not user content) but kept to a short fixed set by
 *   convention.
 * @param {string} props.title - escaped.
 * @param {string} [props.description] - escaped.
 * @param {'empty'|'error'} [props.variant='empty']
 * @param {string} [props.actionLabel] - escaped; renders a button the page
 *   wires a click handler to via data-testid (no inline onclick).
 * @param {string} [props.testId]
 * @returns {string} HTML
 */
export function emptyState({ icon = '📭', title, description, variant = 'empty', actionLabel, testId } = {}) {
  const attr = (name, v) => (v ? ` ${name}="${esc(v)}"` : '');
  const isError = variant === 'error';
  return (
    `<div class="empty-state${isError ? ' is-error' : ''}"${attr('data-testid', testId)}>` +
    `<span class="empty-state-icon" aria-hidden="true">${esc(isError ? '⚠' : icon)}</span>` +
    `<p class="empty-state-title">${esc(title || (isError ? 'Something went wrong' : 'Nothing here yet'))}</p>` +
    (description ? `<p class="empty-state-desc">${esc(description)}</p>` : '') +
    (actionLabel
      ? `<button type="button" class="btn btn-secondary btn-sm"${attr('data-testid', testId && testId + '-action')}>${esc(actionLabel)}</button>`
      : '') +
    `</div>`
  );
}
