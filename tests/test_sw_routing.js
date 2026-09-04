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

console.log(`✓ sw routing classifier: ${checks} checks`);
