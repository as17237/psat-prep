/**
 * js/components/questionCard.js — a single practice/review question.
 *
 * `question` is the REAL record shape (CLAUDE.md mode 3 — verified against
 * data/ela_questions.json + data/math_questions.json, not remembered):
 *   { question_text, domain, skill, difficulty, type, options: [{key,text}],
 *     correct_answer, question_image, has_image }
 * `options` is an ARRAY looked up by `.key`, never `options['A']` — that
 * exact confusion is CLAUDE.md mode 3's root cause 4 (an 88-question exam
 * sold as 98 because of the analogous options-object assumption elsewhere).
 * Image src reuses js/shared/questions.js#questionImageSrc — the single
 * place the relative-image-path fallback expression lives (CLAUDE.md mode
 * 2) — rather than reimplementing it here (and rather than duplicating the
 * exact literal deploy_v2.sh's staging step pattern-matches on, which would
 * change that script's absolutised-path count for no functional reason).
 */
import { esc } from '../shared/html.js';
import { questionImageSrc } from '../shared/questions.js';

/**
 * @param {Object} props
 * @param {Object} [props.question] - real question record (see file header).
 * @param {'default'|'answered'|'loading'|'empty'} [props.state='default']
 * @param {string|null} [props.selectedKey] - the option key the student picked.
 * @param {boolean} [props.revealAnswer=false] - when true (post-answer),
 *   marks the correct option and, if wrong, the selected one.
 * @param {string} [props.testId]
 * @returns {string} HTML
 */
export function questionCard({ question, state = 'default', selectedKey = null, revealAnswer = false, testId } = {}) {
  const attr = (name, v) => (v ? ` ${name}="${esc(v)}"` : '');

  if (state === 'loading') {
    return (
      `<div class="card question-card is-loading"${attr('data-testid', testId)}>` +
      `<div class="skeleton-line" style="width:8rem;"></div>` +
      `<div class="skeleton-line" style="height:3rem;"></div>` +
      `<div class="skeleton-line"></div>` +
      `</div>`
    );
  }

  if (state === 'empty' || !question) {
    return (
      `<div class="card question-card"${attr('data-testid', testId)}>` +
      `<div class="empty-state">` +
      `<span class="empty-state-icon" aria-hidden="true">📭</span>` +
      `<p class="empty-state-title">No question queued</p>` +
      `<p class="empty-state-desc">Nothing matches the current filters yet.</p>` +
      `</div>` +
      `</div>`
    );
  }

  const options = Array.isArray(question.options) ? question.options : [];
  const optionsHtml = options
    .map((opt) => {
      const isSelected = selectedKey != null && opt.key === selectedKey;
      const isCorrectKey = opt.key === question.correct_answer;
      let cls = 'question-option';
      if (revealAnswer && isCorrectKey) cls += ' is-correct';
      else if (revealAnswer && isSelected && !isCorrectKey) cls += ' is-incorrect';
      else if (isSelected) cls += ' is-selected';
      return (
        `<button type="button" class="${cls}" data-option-key="${esc(opt.key)}"${attr(
          'data-testid',
          testId && testId + '-option-' + opt.key
        )}>` +
        `<span class="question-option-key">${esc(opt.key)}</span>` +
        `<span>${esc(opt.text)}</span>` +
        `</button>`
      );
    })
    .join('');

  const imgSrc = question.has_image ? questionImageSrc(question) : '';

  return (
    `<div class="card question-card"${attr('data-testid', testId)}>` +
    `<div class="question-meta">` +
    `<span class="badge badge-primary">${esc(question.domain || '')}</span>` +
    `<span class="badge badge-accent">${esc(question.skill || '')}</span>` +
    (question.difficulty ? `<span class="badge badge-neutral">${esc(question.difficulty)}</span>` : '') +
    `</div>` +
    (imgSrc ? `<img class="question-image" src="${esc(imgSrc)}" alt="Question diagram">` : '') +
    `<p class="question-text">${esc(question.question_text || '')}</p>` +
    (options.length ? `<div class="question-options">${optionsHtml}</div>` : '') +
    `</div>`
  );
}
