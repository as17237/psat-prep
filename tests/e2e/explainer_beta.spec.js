/**
 * tests/e2e/explainer_beta.spec.js — WI-21 beta explainer gate, in a real browser.
 *
 * Proves the one safety property that keeps unverified explainer numbers off the
 * real student's screen (CLAUDE.md failure mode 1): a page registered in
 * `betaQuestions` surfaces ONLY in the beta lane (?env=beta), badged; in the
 * normal lane it is invisible, and a question that ALSO has a verified page still
 * links to that verified page with no beta badge.
 *
 *   987887cd  — beta-only (a sibling drill on nonlinear-functions-model.html);
 *               not covered by any verified page.
 *   1b9fa866  — dual: verified command-of-evidence.html (artifact URL) AND beta
 *               command-of-evidence-graphs.html.
 *
 * The link element (#explainer-link) always exists but starts hidden; we drive
 * the real window.showExplainerLink() and read its resulting DOM state, so this
 * is the actual app code path, not a mock.
 */
const { test, expect } = require('./fixtures');

const BETA_ONLY = '987887cd';
const DUAL = '1b9fa866';

// explainerIndex loads via fetch after DOMContentLoaded; poll the real function
// until the index is in and a known-linkable id becomes visible.
async function waitIndexReady(page) {
  await page.waitForFunction((id) => {
    if (typeof window.showExplainerLink !== 'function') return false;
    window.showExplainerLink(id);
    const el = document.getElementById('explainer-link');
    return !!el && !el.classList.contains('hidden');
  }, DUAL, { timeout: 20000 });
}

function linkState(page, id) {
  return page.evaluate((qid) => {
    window.showExplainerLink(qid);
    const el = document.getElementById('explainer-link');
    const skill = document.getElementById('explainer-link-skill');
    return {
      hidden: !el || el.classList.contains('hidden'),
      href: el ? el.getAttribute('href') : null,
      skill: skill ? skill.innerText : '',
    };
  }, id);
}

test.describe('explainer beta gate (WI-21)', () => {
  test('beta lane: beta-only links appear, badged; dual id prefers the beta page', async ({ page }) => {
    await page.goto('/index.html?env=beta');
    await waitIndexReady(page);

    const betaOnly = await linkState(page, BETA_ONLY);
    expect(betaOnly.hidden).toBe(false);                              // beta-only IS shown in beta
    expect(betaOnly.href).toContain('nonlinear-functions-model.html');
    expect(betaOnly.skill).toContain('Beta');

    const dual = await linkState(page, DUAL);
    expect(dual.hidden).toBe(false);
    expect(dual.href).toContain('command-of-evidence-graphs.html');   // beta page wins in beta
    expect(dual.skill).toContain('Beta');
  });

  test('normal lane: beta-only is invisible; dual id shows the verified page, no badge', async ({ page }) => {
    await page.goto('/index.html');
    await waitIndexReady(page);

    const betaOnly = await linkState(page, BETA_ONLY);
    expect(betaOnly.hidden).toBe(true);                               // beta-only is NEVER shown in prod

    const dual = await linkState(page, DUAL);
    expect(dual.hidden).toBe(false);
    expect(dual.href).toContain('claude.ai/code/artifact');          // verified page, not the beta one
    expect(dual.href).not.toContain('command-of-evidence-graphs.html');
    expect(dual.skill).not.toContain('Beta');
  });
});
