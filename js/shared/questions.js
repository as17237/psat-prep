/**
 * js/shared/questions.js — question-record helpers shared by the pages.
 *
 * WI-09 duplication ledger: the "where is this question's diagram" expression
 * appeared at 4 inline sites — index.html:1463, index.html:2283,
 * parent.html:1425 and mistakes.html:654. Two spelled the relative prefix with
 * a template literal and two with string concatenation, and the parent /
 * mistakes pair omitted the ternary because both were only ever reached inside
 * an `if (q.image_url || q.question_image)` guard. Folding them into the one
 * function below is behaviour-preserving at every site: with both fields empty
 * every original either could not run or already produced ''. 4 sites -> 1.
 *
 * (srs.js holds three more copies of the same expression. srs.js is
 * byte-frozen for WI-09 and belongs to WI-10, so those stay where they are.)
 *
 * NOTE FOR scripts/deploy_v2.sh: the relative prefix below is what the staging
 * step rewrites to an absolute one so the /v2/ lane shares the image set served
 * at the site root. Keep it on ONE line, in the concatenation shape the
 * script's sed pattern matches, and keep that literal out of this comment —
 * the script counts matching lines per file.
 */

export function questionImageSrc(q) {
  if (!q) return '';
  return q.image_url || (q.question_image ? 'data/' + q.question_image : '');
}
