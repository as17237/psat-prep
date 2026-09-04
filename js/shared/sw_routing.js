/**
 * js/shared/sw_routing.js — the pure request-routing decision for the offline
 * service worker (sw.js), factored out so it can be unit-tested in Node.
 *
 * WI-20 (offline exam mode). The service worker itself cannot be `require`d in a
 * Node test (it references `self`, caches, fetch events), so the one piece that
 * carries real branching risk — "which caching strategy does this request get?"
 * — lives here as a pure function with no I/O. sw.js loads it with
 * importScripts(); tests/test_sw_routing.js requires it. Single source of truth
 * for the decision (CLAUDE.md failure mode 2: don't write the rule twice).
 *
 * The five outcomes:
 *   'passthrough' — do NOT touch it; let it hit the network unchanged.
 *                   Non-GET (the sync POST) and anything under /api/ (the live
 *                   sync endpoint, GET pulls included — must always be fresh).
 *   'navigate'    — an HTML navigation; serve cached index.html so a cold load
 *                   works with no network (this is what makes "open the app on
 *                   the plane" work at all).
 *   'image'       — a question image under /data/images/; cache-first, populate
 *                   on success. This is what the "prepare for offline" prefetch
 *                   fills, and every offline exam question reads from it.
 *   'shell'       — any other same-origin GET (engine JS, srs.js, the question
 *                   bundle, CSS, the page controller); cache-first with
 *                   ignoreSearch so a ?v= cache-buster still matches.
 *   'external'    — a cross-origin GET (CDN icons/fonts); best-effort
 *                   stale-while-revalidate, never allowed to block the page.
 *
 * @param {{method:string, mode?:string, urlPath:string, sameOrigin:boolean}} r
 * @returns {'passthrough'|'navigate'|'image'|'shell'|'external'}
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;            // Node (tests)
  } else {
    root.SW_ROUTING = api;           // service worker (importScripts) / browser
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function classifyRequest(r) {
    if (!r || typeof r !== 'object') return 'passthrough';
    if (r.method !== 'GET') return 'passthrough';

    var path = typeof r.urlPath === 'string' ? r.urlPath : '';
    // The live sync API must never be served from a cache — a stale pull or a
    // swallowed push would be exactly the silent data desync this app guards
    // against. Anything under /api/ goes straight to the network.
    if (path.indexOf('/api/') !== -1) return 'passthrough';

    if (r.mode === 'navigate') return 'navigate';

    // Question images live at /data/images/... at the site root under every lane
    // (the /v2/ deploy absolutises the path; the local server serves it at root).
    // Match the leading-slash-free segment "data/images/" so both the root and
    // the lane-prefixed pathnames hit, and so this literal is not mistaken for
    // an absolutised image reference by scripts/deploy_v2.sh's path grep.
    if (path.indexOf('data/images/') !== -1) return 'image';

    if (r.sameOrigin === true) return 'shell';
    return 'external';
  }

  return { classifyRequest: classifyRequest };
});
