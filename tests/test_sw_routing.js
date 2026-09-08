/**
 * tests/test_sw_routing.js — WI-20. The service worker's caching decision.
 *
 * classifyRequest() is the one branching piece of sw.js that carries real risk
 * (send the sync API to a cache and you get exactly the silent data desync this
 * app guards against). It is factored into js/shared/sw_routing.js so it can be
 * tested here in Node. Every branch has a hand-written expectation; flip any
 * rule in the source and a line below goes red.
 */
const assert = require('assert');
const { classifyRequest } = require('../js/shared/sw_routing.js');

let checks = 0;
const eq = (a, b, m) => { assert.strictEqual(a, b, m); checks++; };

// Non-GET (the sync POST) is never intercepted.
eq(classifyRequest({ method: 'POST', urlPath: '/api/sync', sameOrigin: false }), 'passthrough', 'POST passes through');
eq(classifyRequest({ method: 'PUT', urlPath: '/x', sameOrigin: true }), 'passthrough', 'PUT passes through');

// The live sync API is never cached — even a GET pull must be fresh.
eq(classifyRequest({ method: 'GET', urlPath: '/api/sync', sameOrigin: false }), 'passthrough', 'GET /api/sync passes through');
eq(classifyRequest({ method: 'GET', urlPath: '/api/anything', sameOrigin: true }), 'passthrough', 'any /api/ path passes through');

// Navigation -> serve the cached shell (this is the offline cold-load).
eq(classifyRequest({ method: 'GET', mode: 'navigate', urlPath: '/v2/', sameOrigin: true }), 'navigate', 'directory navigation -> navigate');
eq(classifyRequest({ method: 'GET', mode: 'navigate', urlPath: '/index.html', sameOrigin: true }), 'navigate', 'index navigation -> navigate');

// Question images (served at the site root under every lane) -> image cache.
eq(classifyRequest({ method: 'GET', urlPath: '/data/images/abc_question.png', sameOrigin: true }), 'image', 'root image path -> image');
eq(classifyRequest({ method: 'GET', urlPath: '/v2/data/images/x.png', sameOrigin: true }), 'image', 'lane-prefixed image path -> image');

// Other same-origin GET -> shell. The bundle contains "/data/" but not
// "/data/images/", so it must classify as shell, not image.
eq(classifyRequest({ method: 'GET', urlPath: '/js/engine/grading.js', sameOrigin: true }), 'shell', 'engine js -> shell');
eq(classifyRequest({ method: 'GET', urlPath: '/data/questions_data.js', sameOrigin: true }), 'shell', 'question bundle -> shell (not image)');
eq(classifyRequest({ method: 'GET', urlPath: '/styles/tokens.css', sameOrigin: true }), 'shell', 'css -> shell');
eq(classifyRequest({ method: 'GET', urlPath: '/srs.js', sameOrigin: true }), 'shell', 'srs.js -> shell');

// Cross-origin GET -> external (best effort, never blocks the page).
eq(classifyRequest({ method: 'GET', urlPath: '/npm/lucide@latest', sameOrigin: false }), 'external', 'CDN script -> external');
eq(classifyRequest({ method: 'GET', urlPath: '/css2', sameOrigin: false }), 'external', 'google fonts -> external');

// Junk input degrades safely to passthrough.
eq(classifyRequest(null), 'passthrough', 'null -> passthrough');
eq(classifyRequest(undefined), 'passthrough', 'undefined -> passthrough');
eq(classifyRequest({}), 'passthrough', 'no method -> passthrough');

// ---------------------------------------------------------------------------
// WI-24 — raceDeadline, the SOFT-offline fix.
//
// The offline exam failed on a real flight even though tests/e2e/offline_exam.spec.js
// passes. The reason is that Playwright's context.setOffline(true) makes fetches FAIL
// IMMEDIATELY — airplane MODE. Airplane WIFI is the opposite: navigator.onLine stays
// true and fetches HANG. With no deadline, all 44 network-first shell assets and the
// navigation each waited on the browser's default timeout, and the exam clock ran
// while nothing rendered.
//
// Timers are injected so these assertions are instant and deterministic — never a
// real sleep, never a patched global (CLAUDE.md mode 4).
// ---------------------------------------------------------------------------
{
  const { raceDeadline, NETWORK_DEADLINE_MS, EXTERNAL_DEADLINE_MS } = require('../js/shared/sw_routing.js');

  // A completion watchdog, because the obvious version of this suite CANNOT FAIL.
  // Every check below awaits a promise. Break raceDeadline so it stops applying the
  // deadline and case 2 awaits a promise that never settles — node then drains its
  // event loop and exits 0 with no output, which reads exactly like success. This
  // flag is checked on exit so a suite that silently stopped is a failure, not a
  // pass (CLAUDE.md: a run that produced no output has verified nothing).
  let raceChecksDone = false;
  process.on('exit', function (code) {
    if (code === 0 && !raceChecksDone) {
      console.error('\nTEST FAILURE: the raceDeadline checks never completed — a promise ' +
        'never settled, most likely because the deadline is not being applied.');
      process.exitCode = 1;
    }
  });

  // A controllable clock: nothing fires until we advance it by hand.
  function fakeTimers() {
    let seq = 0;
    const pending = new Map();
    return {
      setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { fn, ms }); return id; },
      clearTimeout: (id) => { pending.delete(id); },
      fire: () => { const all = [...pending.values()]; pending.clear(); all.forEach((p) => p.fn()); },
      pendingCount: () => pending.size
    };
  }
  const settle = () => new Promise((r) => setImmediate(r));

  assert.strictEqual(NETWORK_DEADLINE_MS, 2500, 'shell/navigation deadline is frozen at 2.5s');
  assert.strictEqual(EXTERNAL_DEADLINE_MS, 2000, 'CDN deadline is frozen at 2s');

  (async () => {
    // 1. Network answers before the deadline -> fresh response wins, cache untouched.
    {
      const t = fakeTimers();
      const out = await raceDeadline(Promise.resolve('FRESH'), 'CACHED', 2500, t);
      assert.strictEqual(out, 'FRESH', 'a responsive network must still win — no staleness while online');
      assert.strictEqual(t.pendingCount(), 0, 'the deadline timer must be cleared, not leaked');
    }

    // 2. THE PLANE CASE: the network hangs forever and a cached copy exists.
    {
      const t = fakeTimers();
      // A fetch that NEVER settles — exactly what plane wifi does. No real timer, so
      // the suite cannot hang on it.
      let hangSettled = false;
      const hanging = new Promise(() => {}).then(() => { hangSettled = true; });
      const p = raceDeadline(hanging, 'CACHED', 2500, t);
      await settle();
      t.fire();                                   // deadline elapses
      const out = await p;
      assert.strictEqual(out, 'CACHED',
        'SOFT OFFLINE: a hanging fetch must yield to the cached copy at the deadline, ' +
        'not block for the browser default timeout');
      assert.strictEqual(hangSettled, false, 'and it must not have waited for the hang to finish');
    }

    // 3. Nothing cached: the deadline must NOT apply — there is nothing better to
    //    serve, and inventing a failure would be worse than waiting.
    {
      const t = fakeTimers();
      const out = await raceDeadline(Promise.resolve('FRESH'), null, 2500, t);
      assert.strictEqual(out, 'FRESH');
      assert.strictEqual(t.pendingCount(), 0, 'no timer is armed when there is no fallback');
    }

    // 4. A rejecting network with a cached copy resolves to cache, never rejects.
    {
      const t = fakeTimers();
      const out = await raceDeadline(Promise.reject(new Error('offline')), 'CACHED', 2500, t);
      assert.strictEqual(out, 'CACHED', 'hard offline still falls back, and raceDeadline never rejects');
    }

    // 5. A null network result (fetchAndCache swallows failures) falls back to cache.
    {
      const t = fakeTimers();
      const out = await raceDeadline(Promise.resolve(null), 'CACHED', 2500, t);
      assert.strictEqual(out, 'CACHED');
    }

    // 6. The late response must not overwrite an already-served cached copy.
    {
      const t = fakeTimers();
      let resolveLate;
      const late = new Promise((res) => { resolveLate = res; });
      const p = raceDeadline(late, 'CACHED', 2500, t);
      await settle();
      t.fire();
      assert.strictEqual(await p, 'CACHED');
      resolveLate('LATE');                        // arrives after the fact
      await settle();
      assert.strictEqual(await p, 'CACHED', 'the resolved value must not change after settling');
    }

    raceChecksDone = true;
    console.log('  ✓ raceDeadline: 6 soft-offline checks');
  })().catch((e) => { console.error('\nTEST FAILURE: ' + e.message); process.exit(1); });
}

console.log(`✓ sw routing classifier: ${checks} checks`);
