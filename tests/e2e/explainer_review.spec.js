/**
 * tests/e2e/explainer_review.spec.js — WI-21 explainer links, in a real browser.
 *
 * Two things a student depends on, proven against the real app:
 *
 *  1. The per-question link (under the rationale, and therefore inside the SRS
 *     review and drill flows, which reuse the same renderer) points at the
 *     MODEL-FIRST cluster page — not the older page it supersedes, and not
 *     nothing. An unmapped question shows no link at all.
 *
 *  2. The Review tab lists the walkthroughs as real, openable links, and never
 *     offers a superseded dead-end page.
 *
 * We drive the real window.showExplainerLink() / switchTab() and read the DOM
 * they produce, so this is the actual code path rather than a mock.
 */
const { test, expect, seedEmpty } = require('./fixtures');

const COE_ID = '1b9fa866';        // covered by the primary CoE cluster page
const DRILL_ID = '987887cd';      // owned only by the nonlinear cluster page
const UNMAPPED_ID = 'ffffffff';   // no explainer anywhere

async function waitIndexReady(page) {
  await page.waitForFunction((id) => {
    if (typeof window.showExplainerLink !== 'function') return false;
    window.showExplainerLink(id);
    const el = document.getElementById('explainer-link');
    return !!el && !el.classList.contains('hidden');
  }, COE_ID, { timeout: 20000 });
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

test.describe('explainer links (WI-21)', () => {
  test('per-question link points at the primary cluster page, and hides when unmapped', async ({ page }) => {
    await page.goto('/index.html');
    await waitIndexReady(page);

    const coe = await linkState(page, COE_ID);
    expect(coe.hidden).toBe(false);
    expect(coe.href).toContain('command-of-evidence-graphs.html');   // model-first page wins
    expect(coe.href).toContain(`#q-${COE_ID}`);                       // deep-linked to the question
    expect(coe.skill).not.toContain('Beta');                          // verified content, no badge

    const drill = await linkState(page, DRILL_ID);
    expect(drill.hidden).toBe(false);
    expect(drill.href).toContain('nonlinear-functions-model.html');

    const none = await linkState(page, UNMAPPED_ID);
    expect(none.hidden).toBe(true);                                   // no link invented
  });

  test('Review tab lists the walkthroughs and no superseded page', async ({ page }) => {
    await page.goto('/index.html');
    await seedEmpty(page);
    await waitIndexReady(page);

    await page.click('#tab-review', { force: true });
    const card = page.locator('#view-review');
    await expect(card).toContainText('Visual skill walkthroughs', { timeout: 10000 });

    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#view-review a[target="_blank"]'))
        .map(a => a.getAttribute('href')));

    // The two model-first pages are offered...
    expect(hrefs.some(h => h && h.includes('command-of-evidence-graphs.html'))).toBe(true);
    expect(hrefs.some(h => h && h.includes('nonlinear-functions-model.html'))).toBe(true);
    // ...and the superseded slow versions are NOT dead-end entries in the list.
    expect(hrefs.some(h => h && /\/command-of-evidence\.html/.test(h))).toBe(false);
    expect(hrefs.some(h => h && /\/nonlinear-functions\.html/.test(h))).toBe(false);
  });
});
