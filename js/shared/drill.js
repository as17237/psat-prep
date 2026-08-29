/**
 * js/shared/drill.js — launching a targeted drill of missed questions into
 * the student app.
 *
 * WI-09 duplication ledger: `launchMistakesDrill()` existed in mistakes.html
 * and parent.html. The two bodies were identical apart from the name of the
 * page-level array they read (`allMistakesList` vs `allTroubleList`), so the
 * list is now passed in. 2 sites -> 1.
 *
 * It is exported under a DIFFERENT name than the pages' handler: each page
 * keeps a zero-argument `launchMistakesDrill()` bound to its own list, which
 * is what its markup's onclick attribute (unchanged by WI-09) calls.
 *
 * Everything else — the sessionStorage key, the drill object's fields, the
 * 1.5-minutes-per-question time limit, the alert copy and the
 * `index.html?mode=custom` hand-off — is byte-identical to both originals.
 */

export function launchTargetedMistakeDrill(troubleList) {
  const list = troubleList || [];
  if (list.length === 0) {
    alert('Great news: There are no missed questions to drill right now!');
    return;
  }
  const questionsData = window.QUESTIONS_DATA || [];
  const troubleQIds = new Set(list.map(t => t.questionId));
  const targetQuestions = questionsData.filter(q => troubleQIds.has(q.id));

  if (targetQuestions.length === 0) {
    alert('Could not find question data for missed items.');
    return;
  }

  const drill = {
    id: 'drill_mistakes_' + Date.now(),
    title: `Targeted Mistake Drill (${targetQuestions.length} Missed Questions)`,
    type: 'mistakes_targeted_drill',
    totalQuestions: targetQuestions.length,
    timeLimitMinutes: Math.round(targetQuestions.length * 1.5),
    createdAt: Date.now(),
    questions: targetQuestions
  };

  try {
    sessionStorage.setItem('psat_active_custom_test', JSON.stringify(drill));
    window.location.href = 'index.html?mode=custom';
  } catch (e) {
    alert('Error preparing mistake drill: ' + e.message);
  }
}
