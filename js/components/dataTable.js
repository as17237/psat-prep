/**
 * js/components/dataTable.js — tabular data with an honest empty/error state.
 *
 * Any cell value of `null`/`undefined` renders as the shared em-dash glyph
 * (js/components/format.js), not a blank cell and not "0" — a missing
 * measurement inside a table row is exactly the case CLAUDE.md mode 1
 * warns about, and it is easy to lose track of in a grid of many cells.
 */
import { esc } from '../shared/html.js';
import { emptyState } from './emptyState.js';
import { formatMetric } from './format.js';

/**
 * @param {Object} props
 * @param {Array<{key: string, label: string}>} props.columns
 * @param {Array<Object>} [props.rows] - each row keyed by column `key`.
 * @param {'default'|'loading'|'empty'|'error'} [props.state='default']
 * @param {string} [props.emptyMessage='No data yet']
 * @param {string} [props.errorMessage='Could not load this data']
 * @param {string} [props.testId]
 * @returns {string} HTML
 */
export function dataTable({
  columns = [],
  rows = [],
  state = 'default',
  emptyMessage = 'No data yet',
  errorMessage = 'Could not load this data',
  testId,
} = {}) {
  const attr = (name, v) => (v ? ` ${name}="${esc(v)}"` : '');
  const colCount = columns.length || 1;
  const head = `<thead><tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>`;

  let bodyHtml;
  if (state === 'loading') {
    bodyHtml =
      `<tr><td class="table-empty-cell" colspan="${colCount}">` +
      `<div class="card is-loading" style="border:none;box-shadow:none;padding:1rem;">` +
      `<div class="skeleton-line"></div><div class="skeleton-line"></div>` +
      `</div></td></tr>`;
  } else if (state === 'error') {
    bodyHtml =
      `<tr><td class="table-empty-cell" colspan="${colCount}">` +
      emptyState({ variant: 'error', title: errorMessage }) +
      `</td></tr>`;
  } else if (state === 'empty' || rows.length === 0) {
    bodyHtml =
      `<tr><td class="table-empty-cell" colspan="${colCount}">` +
      emptyState({ variant: 'empty', title: emptyMessage }) +
      `</td></tr>`;
  } else {
    bodyHtml = rows
      .map((row) => {
        const cells = columns
          .map((c) => {
            const v = row[c.key];
            const display = v === null || v === undefined ? formatMetric(null) : String(v);
            return `<td>${esc(display)}</td>`;
          })
          .join('');
        return `<tr>${cells}</tr>`;
      })
      .join('');
  }

  return `<table class="table"${attr('data-testid', testId)}>${head}<tbody>${bodyHtml}</tbody></table>`;
}
