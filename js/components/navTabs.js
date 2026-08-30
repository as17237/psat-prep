/**
 * js/components/navTabs.js — top-level tab navigation.
 * Renders plain <button> elements (no inline onclick); the page attaches one
 * delegated click listener keyed off data-tab-id.
 */
import { esc } from '../shared/html.js';

/**
 * @param {Object} props
 * @param {Array<{id: string, label: string, isActive?: boolean}>} props.tabs
 * @param {string} [props.testId]
 * @returns {string} HTML
 */
export function navTabs({ tabs = [], testId } = {}) {
  const attr = (name, v) => (v ? ` ${name}="${esc(v)}"` : '');
  const items = tabs
    .map((t) => {
      const active = !!t.isActive;
      return (
        `<button type="button" class="tab${active ? ' is-active' : ''}" role="tab" aria-selected="${active}" ` +
        `data-tab-id="${esc(t.id)}"${attr('data-testid', testId && testId + '-' + t.id)}>` +
        `${esc(t.label)}</button>`
      );
    })
    .join('');
  return `<div class="tabs" role="tablist"${attr('data-testid', testId)}>${items}</div>`;
}
