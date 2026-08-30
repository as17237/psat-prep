/**
 * tests/e2e/design-system.spec.js — WI-12 Playwright coverage for
 * design.html, the component-system reference page.
 *
 * Three things this spec proves against the real, rendered page (not a
 * unit-test sandbox):
 *   1. Every component and every documented state is actually present in
 *      the DOM (one data-testid per component/state — see design.html).
 *   2. Zero page errors — design.html loads and every js/components/*
 *      helper runs without throwing.
 *   3. The token pairs tokens.css documents as contrast-checked really do
 *      clear WCAG AA (4.5:1 body text, 3:1 large/bold text), computed with
 *      the same relative-luminance formula the spec runs live in the
 *      browser — not read from a comment and trusted.
 *
 * Screenshots are archived to test-results/design-system/ as the visual
 * baseline (test-results/ is gitignored — these are build artifacts, not
 * checked-in fixtures).
 *
 * Uses the shared fixtures module like every other spec in this directory
 * (REFACTOR_PLAN.md WI-08 / CLAUDE.md mode 7): design.html makes no /api/sync
 * calls and reads no localStorage, so the quarantine never has anything to
 * intercept here, but importing `test`/`expect` from here (rather than
 * '@playwright/test' directly) keeps the "every spec imports its page
 * fixture from fixtures.js" rule exceptionless.
 */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'test-results', 'design-system');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// One data-testid per component + state documented on the page (hand-written
// against design.html, not derived from it — CLAUDE.md mode 4).
const EXPECTED_TESTIDS = [
  'tokens-palette',
  'tokens-parent-accent',
  'tokens-type-scale',
  'tokens-spacing',
  'component-buttons',
  'hover-demo-button',
  'component-statcard-value',
  'component-statcard-null',
  'component-statcard-estimate',
  'component-statcard-loading',
  'component-card-default',
  'component-card-loading',
  'component-card-empty',
  'component-card-error',
  'component-banners',
  'component-badges',
  'component-progress-default',
  'component-progress-null',
  'component-progress-success',
  'component-progress-danger',
  'component-table-default',
  'component-table-loading',
  'component-table-empty',
  'component-table-error',
  'component-modal-default',
  'component-modal-danger',
  'component-navtabs-demo',
  'component-navtabs-page',
  'component-emptystate-empty',
  'component-emptystate-error',
  'component-emptystate-action',
  'component-questioncard-default',
  'component-questioncard-revealed',
  'component-questioncard-loading',
  'component-questioncard-empty',
  'component-chart',
];

// Contrast pairs to verify — the base (never-aliased, literal-hex) tokens
// from styles/tokens.css, matched to the pairs documented in that file's
// header comments. category 'body' requires >=4.5:1 (WCAG AA body text),
// 'large' requires >=3:1 (WCAG AA large/bold text, e.g. button labels).
const CONTRAST_PAIRS = [
  { fg: '--color-neutral-900', bg: '--color-surface', category: 'body', label: 'body text on surface' },
  { fg: '--color-neutral-600', bg: '--color-surface', category: 'body', label: 'muted text on surface' },
  { fg: '--color-neutral-500', bg: '--color-surface', category: 'body', label: 'subtle text (floor) on surface' },
  { fg: '--color-primary-700', bg: '--color-primary-50', category: 'body', label: 'primary badge text on primary tint' },
  { fg: '--color-accent-700', bg: '--color-accent-50', category: 'body', label: 'accent badge text on accent tint (student/cyan)' },
  { fg: '--color-success-700', bg: '--color-success-50', category: 'body', label: 'success badge text on success tint' },
  { fg: '--color-warning-800', bg: '--color-warning-50', category: 'body', label: 'warning badge text on warning tint' },
  { fg: '--color-danger-700', bg: '--color-danger-50', category: 'body', label: 'danger badge text on danger tint' },
  { fg: '#ffffff', bg: '--color-primary-600', category: 'large', label: 'white on primary-600 (button text)' },
];
const PARENT_SCOPE_CONTRAST_PAIRS = [
  { fg: '--color-accent-700', bg: '--color-accent-50', category: 'body', label: 'accent badge text on accent tint (parent/violet)' },
];
const THRESHOLD = { body: 4.5, large: 3 };

test.describe('design system reference page (WI-12)', () => {
  test('every component + state renders, zero page errors', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    const response = await page.goto('/design.html');
    expect(response.status()).toBe(200);
    await page.waitForLoadState('networkidle');

    for (const testId of EXPECTED_TESTIDS) {
      const locator = page.locator(`[data-testid="${testId}"]`);
      await expect(locator, `expected [data-testid="${testId}"] to be present`).toHaveCount(1);
    }

    // statCard null-value contract, verified against the real DOM (not just
    // the unit test): the null stat renders the em dash, never "0".
    const nullValueText = await page.locator('[data-testid="component-statcard-null"] .stat-value').innerText();
    expect(nullValueText.trim()).toBe('—');

    const estimateBadge = page.locator('[data-testid="component-statcard-estimate"] .stat-estimate-badge');
    await expect(estimateBadge).toHaveText(/Estimate/);

    // dataTable null-cell contract in the real DOM.
    const tableHtml = await page.locator('[data-testid="component-table-default"]').innerHTML();
    expect(tableHtml).toMatch(/>—</);

    expect(pageErrors, `design.html must load with zero page errors, got: ${pageErrors.join(' | ')}`).toEqual([]);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'full-page.png'), fullPage: true });
  });

  test('hover state is real, not simulated: primary button and inactive tab', async ({ page }, testInfo) => {
    // The chromium-mobile project sets hasTouch:true (REFACTOR_PLAN WI-08
    // baseline), which real touch devices also set — and real touch
    // browsers do not raise a stable, timed :hover state from a tap the way
    // a desktop pointer does (Chromium's own hit-testing under this
    // emulation profile is what timed out here, confirmed by repeated
    // "intercepts pointer events" reports against unrelated, non-overlapping
    // elements rather than a real layout collision). Hover is a desktop-only
    // interaction in this app; the desktop project is what actually proves it.
    testInfo.skip(testInfo.project.name === 'chromium-mobile', 'hover is not a meaningful/stable interaction under hasTouch:true emulation; covered by chromium-desktop');

    await page.goto('/design.html');
    await page.waitForLoadState('networkidle');

    // buttons.css transitions background-color over 0.15s; poll rather than
    // reading the computed style in the same tick as hover() so the assertion
    // isn't racing the transition (a real, not simulated, state change still
    // has to actually finish before we can observe it).
    const button = page.locator('[data-testid="hover-demo-button"]');
    const before = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
    await button.hover();
    await expect
      .poll(() => button.evaluate((el) => getComputedStyle(el).backgroundColor), {
        message: 'hovering the primary button must change its background-color (real :hover, not a static screenshot)',
      })
      .not.toBe(before);

    const inactiveTab = page.locator('[data-testid="navtabs-demo-exams"]');
    const tabBefore = await inactiveTab.evaluate((el) => getComputedStyle(el).color);
    await inactiveTab.hover();
    await expect
      .poll(() => inactiveTab.evaluate((el) => getComputedStyle(el).color), {
        message: 'hovering an inactive tab must change its text color (real :hover)',
      })
      .not.toBe(tabBefore);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'hover-states.png') });
  });

  test('navTabs interaction: clicking a page-nav tab marks it active and scrolls to the section', async ({ page }) => {
    await page.goto('/design.html');
    await page.waitForLoadState('networkidle');

    const cardTab = page.locator('[data-testid="navtabs-page-sec-card"]');
    await cardTab.click();
    await expect(cardTab).toHaveClass(/is-active/);
    await expect(cardTab).toHaveAttribute('aria-selected', 'true');
  });

  test('modal demo renders a real dialog with escaped, real copy', async ({ page }) => {
    await page.goto('/design.html');
    await page.waitForLoadState('networkidle');

    const dangerModal = page.locator('[data-testid="component-modal-danger"] [role="dialog"]');
    await expect(dangerModal).toBeVisible();
    await expect(dangerModal.locator('.modal-title')).toHaveText('Delete this attempt?');
    await expect(page.locator('[data-testid="modal-danger-confirm"]')).toHaveClass(/btn-danger/);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'modal.png') });
  });

  test('WCAG AA contrast — every documented token pair', async ({ page }) => {
    await page.goto('/design.html');
    await page.waitForLoadState('networkidle');

    // Relative-luminance / contrast-ratio formula computed IN-PAGE (no
    // external axe-core dependency — per the WI-12 brief, a hand-rolled
    // check over the tokens is sufficient and keeps this offline/CDN-free).
    const results = await page.evaluate(
      ({ pairs, parentPairs }) => {
        function resolveColor(rootEl, token) {
          if (token.startsWith('#')) return token;
          return getComputedStyle(rootEl).getPropertyValue(token).trim();
        }
        function hexToRgb(hex) {
          const h = hex.replace('#', '');
          const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
          return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        }
        function srgbToLin(c) {
          const cs = c / 255;
          return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
        }
        function luminance(hex) {
          const [r, g, b] = hexToRgb(hex).map(srgbToLin);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
        function contrast(a, b) {
          const L1 = luminance(a);
          const L2 = luminance(b);
          const lighter = Math.max(L1, L2);
          const darker = Math.min(L1, L2);
          return (lighter + 0.05) / (darker + 0.05);
        }

        const docEl = document.documentElement;
        const out = pairs.map((p) => {
          const fgHex = resolveColor(docEl, p.fg);
          const bgHex = resolveColor(docEl, p.bg);
          return Object.assign({}, p, { fgHex, bgHex, ratio: contrast(fgHex, bgHex) });
        });

        const parentEl = document.querySelector('[data-portal="parent"]');
        parentPairs.forEach((p) => {
          const fgHex = resolveColor(parentEl, p.fg);
          const bgHex = resolveColor(parentEl, p.bg);
          out.push(Object.assign({}, p, { fgHex, bgHex, ratio: contrast(fgHex, bgHex), scope: 'parent' }));
        });

        return out;
      },
      { pairs: CONTRAST_PAIRS, parentPairs: PARENT_SCOPE_CONTRAST_PAIRS }
    );

    let report = 'WI-12 contrast results (WCAG AA):\n';
    let anyFail = false;
    results.forEach((r) => {
      const min = THRESHOLD[r.category];
      const pass = r.ratio >= min;
      if (!pass) anyFail = true;
      report += `  ${pass ? 'PASS' : 'FAIL'}  ${r.label.padEnd(55)} ${r.fgHex} on ${r.bgHex}  ratio=${r.ratio.toFixed(2)}  min=${min}\n`;
    });
    console.log(report);

    results.forEach((r) => {
      const min = THRESHOLD[r.category];
      expect(r.ratio, `${r.label}: ${r.fgHex} on ${r.bgHex} must be >= ${min}:1, got ${r.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
    });
    expect(anyFail).toBe(false);
  });
});
