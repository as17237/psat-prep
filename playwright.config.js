// Dev-only Playwright harness for the PSAT prep static app (WI-08).
// The app itself stays dependency-free -- this config and its devDependency
// (@playwright/test) exist purely to drive browser-truth regression tests
// against the CURRENT app before any refactor touches it.
//
// SAFETY: every spec MUST import its page fixture from tests/e2e/fixtures.js,
// which installs the sync-interceptor quarantine described in REFACTOR_PLAN.md
// WI-08 / CLAUDE.md. Never construct a raw `page` outside that fixture.
const { defineConfig, devices } = require('@playwright/test');

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: BASE_URL,
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 8000,
    navigationTimeout: 15000,
  },
  projects: [
    {
      name: 'chromium-desktop',
      testIgnore: /v2-smoke\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: 'chromium-mobile',
      testIgnore: /v2-smoke\.spec\.js/,
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
        userAgent:
          'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      },
    },
    {
      name: 'v2smoke',
      testMatch: /v2-smoke\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        // The v2 smoke project talks to the live deployed site, not the
        // local webServer -- baseURL is overridden inside the spec.
      },
    },
  ],
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 20000,
  },
});
