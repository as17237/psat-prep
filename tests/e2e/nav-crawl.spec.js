/**
 * Nav crawl: from each of the 4 pages, click every internal link that
 * navigates to another page; assert no 404s (or any other >=400 response,
 * for any resource on the destination page) and no unexpected uncaught
 * page errors.
 *
 * ALLOWLIST: EMPTY. WI-08 had to allowlist three real, pre-existing page
 * errors here (loadQuestion's null '#text-mode-warning', updateHeaderStats's
 * null '#hdr-attempted', and parent.html's `attemptedCount is not defined`).
 * WI-08.5 fixed all three -- plus a fourth, `initCustomDomainSkills is not
 * defined`, that the third one was masking -- so every page must now load
 * with ZERO uncaught page errors. Do not re-add entries here to make a
 * failing crawl green: an entry in this list is a shipped crash.
 */
const { test, expect, seedEmpty } = require('./fixtures');

const ALLOWED_PAGE_ERRORS = [];

function isAllowedError(message) {
  return ALLOWED_PAGE_ERRORS.some((re) => re.test(message));
}

const PAGES = ['index.html', 'parent.html', 'mistakes.html', 'feedback.html'];

async function collectInternalLinks(page) {
  const hrefs = await page.$$eval('a[href]', (as) =>
    as
      .map((a) => a.getAttribute('href'))
      .filter((h) => h && /^[a-zA-Z0-9_.-]+\.html(\?.*)?$/.test(h))
  );
  // De-duplicate by target file (ignore query string) so we test each
  // destination page once per source page.
  const seenFiles = new Set();
  const unique = [];
  hrefs.forEach((h) => {
    const file = h.split('?')[0];
    if (!seenFiles.has(file)) {
      seenFiles.add(file);
      unique.push(h);
    }
  });
  return unique;
}

test.describe('nav crawl', () => {
  for (const sourcePage of PAGES) {
    test(`links from ${sourcePage} resolve with no 404s and no unexpected page errors`, async ({ page }) => {
      await page.goto(`/${sourcePage}`);
      await seedEmpty(page);

      const links = await collectInternalLinks(page);
      expect(links.length).toBeGreaterThan(0);

      for (const href of links) {
        const badResponses = [];
        const pageErrors = [];
        const onResponse = (res) => {
          if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url()}`);
        };
        const onPageError = (err) => {
          if (!isAllowedError(err.message)) pageErrors.push(err.message);
        };
        page.on('response', onResponse);
        page.on('pageerror', onPageError);

        await page.goto(`/${sourcePage}`);
        await seedEmpty(page);
        await page.click(`a[href="${href}"]`, { force: true });
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(300); // let async DOMContentLoaded handlers finish

        const expectedFile = href.split('?')[0];
        expect(page.url()).toContain(`/${expectedFile}`);
        expect(badResponses, `unexpected >=400 responses navigating ${sourcePage} -> ${href}`).toEqual([]);
        expect(pageErrors, `unexpected uncaught page errors navigating ${sourcePage} -> ${href}`).toEqual([]);

        page.off('response', onResponse);
        page.off('pageerror', onPageError);
      }
    });
  }
});
