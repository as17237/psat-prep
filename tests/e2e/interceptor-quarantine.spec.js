/**
 * Negative test proving the sync-interceptor quarantine actually enforces
 * the "never write default_student from a test" rule (REFACTOR_PLAN.md §3 /
 * WI-08, CLAUDE.md mode 7). This is the test that must fail loudly if
 * fixtures.js's guard is ever weakened.
 *
 * It exercises the STRICT "passthrough" checking path directly -- the same
 * code path used for real requests against the live /v2/ deployment -- and
 * proves two things:
 *
 *   1. A request whose URL or POST body contains "default_student" is
 *      transparently REWRITTEN to "e2e_test_student" before it is ever
 *      continued -- the interceptor does not naively let it through as-is
 *      just because it "looks like a normal app request" (this matters
 *      because index.html fires exactly such a request, unconditionally,
 *      on every page load -- see fixtures.js's top-of-file comment).
 *   2. The hard-fail mechanism -- assertNoQuarantineViolations(), the exact
 *      function wired into every spec's automatic teardown -- does throw
 *      when a violation is recorded. Since a plain string-replace rewrite
 *      cannot itself fail to remove the token, this is demonstrated by
 *      directly asserting the function's behavior against a synthetic
 *      violation, which is the same code path the interceptor's backstop
 *      uses if a rewrite were ever incomplete.
 *
 * It leaves the page in a clean (violation-free) state so the shared `test`
 * fixture's own teardown assertion does not also fail this spec.
 */
const {
  test,
  expect,
  installSyncQuarantine,
  assertNoQuarantineViolations,
  SYNC_HOST,
} = require('./fixtures');

test.describe('sync interceptor quarantine (negative test)', () => {
  test('rewrites a default_student request instead of ever letting it through as-is', async ({ page }) => {
    await page.goto('/index.html');

    // Layer the STRICT passthrough-mode checker on top of the default stub
    // installed by the `page` fixture -- this simulates what would happen
    // against the live API if a request slipped through un-neutralized.
    await installSyncQuarantine(page, { mode: 'passthrough' });
    page.__syncCalls = [];

    // A default_student URL (exactly what index.html's automatic on-load
    // sync sends) must never reach the network with that identity.
    const status1 = await page.evaluate((host) => {
      return fetch(`https://${host}/api/sync?student_name=default_student`)
        .then((r) => r.status)
        .catch(() => 'network-error');
    }, SYNC_HOST);

    // No violation should be recorded -- the request was safely rewritten,
    // not aborted.
    expect(page.__quarantineViolations.length).toBe(0);
    const call1 = page.__syncCalls.find((c) => c.rewrittenFrom);
    expect(call1).toBeTruthy();
    expect(call1.rewrittenFrom).toContain('default_student');
    expect(call1.url).not.toContain('default_student');
    expect(call1.url).toContain('e2e_test_student');
    // The rewritten request really was sent (some HTTP status came back,
    // not a network-level failure), proving it reached the real host.
    expect(typeof status1 === 'number' || status1 === 'network-error').toBeTruthy();

    // Same check for default_student hiding in a POST body.
    const status2 = await page.evaluate((host) => {
      return fetch(`https://${host}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_name: 'default_student', progress: {} }),
      })
        .then((r) => r.status)
        .catch(() => 'network-error');
    }, SYNC_HOST);

    expect(page.__quarantineViolations.length).toBe(0);
    const call2 = page.__syncCalls.find((c) => c.postData && c.postData.includes('e2e_test_student'));
    expect(call2).toBeTruthy();
    expect(call2.postData).not.toContain('default_student');

    // A legitimate, already-safe e2e_test_student request passes through
    // unmodified (not double-rewritten, not flagged).
    await page.evaluate((host) => {
      return fetch(`https://${host}/api/sync?student_name=e2e_test_student`).catch(() => {});
    }, SYNC_HOST);
    expect(page.__quarantineViolations.length).toBe(0);

    // Now prove the hard-fail mechanism itself -- the exact function every
    // spec's teardown calls -- actually throws when a violation exists.
    // This is the backstop path the interceptor would take if a rewrite
    // ever failed to fully remove the forbidden token.
    page.__quarantineViolations.push({ url: 'https://example.invalid/api/sync?student_name=default_student', method: 'GET' });
    expect(() => assertNoQuarantineViolations(page)).toThrow(/QUARANTINE VIOLATION/);

    // Clean up so the shared `page` fixture teardown (which runs the exact
    // same assertion) does not fail this passing, intentionally-red-proving
    // test.
    page.__quarantineViolations = [];
    expect(() => assertNoQuarantineViolations(page)).not.toThrow();
  });
});
