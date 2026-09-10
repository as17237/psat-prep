/* eslint-disable no-restricted-globals */
/**
 * sw.js — offline service worker for the PSAT 8/9 Prep app (WI-20).
 *
 * WHY: the app already generates, takes, scores and stores an exam entirely
 * client-side, and its cloud sync is offline-safe (durable outbox + idempotent,
 * non-destructive server merge). The one thing missing for "take the exam on a
 * plane" was reliable OFFLINE LOADING: without a service worker the app depends
 * on the browser HTTP cache, which is evicted unpredictably and never serves a
 * cold navigation offline. This worker precaches the app shell and serves it
 * cache-first, and caches question images on demand (the "Prepare for offline"
 * button prefetches exactly one exam's images — the full 324 MB bank is never
 * cached).
 *
 * SCOPE: registered with the relative path 'sw.js', so it is automatically
 * scoped to the directory it is served from — '/' in production, '/v2/' in the
 * soak lane. Each lane gets its own worker and its own caches; they never mix.
 *
 * CACHES:
 *   psat-shell-<VERSION>  app shell (HTML/JS/CSS/bundle). Versioned; old shells
 *                         are deleted on activate so a deploy takes effect.
 *   psat-images           question images. NOT versioned, so images a student
 *                         prefetched before a flight survive a shell update.
 *   psat-ext              cross-origin CDN assets (icons/fonts), best effort.
 *
 * The request-routing decision is in js/shared/sw_routing.js (pure, unit-tested
 * in tests/test_sw_routing.js) so the branching logic is not written twice.
 */

importScripts('js/shared/sw_routing.js');

var VERSION = '20260910-sync-reports-1';
var SHELL_CACHE = 'psat-shell-' + VERSION;
var IMAGE_CACHE = 'psat-images';
var EXT_CACHE = 'psat-ext';

// The complete same-origin dependency chain of index.html's exam flow. Relative
// paths resolve against the worker's scope, so this is lane-correct as-is. Query
// cache-busters (?v=…) are matched with ignoreSearch below, so bare paths are
// precached here. Every entry must be a real, fetchable URL or its precache is
// skipped (logged, never fatal — a partial shell beats no shell).
var SHELL_ASSETS = [
  'index.html',
  'srs.js',
  'data/questions_data.js',
  'js/engine/adaptive_config.js',
  'js/engine/grading.js',
  'js/engine/scheduler.js',
  'js/engine/scoring.js',
  'js/engine/storage.js',
  'js/engine/examgen.js',
  'js/engine/sync.js',
  'js/engine/exam_state.js',
  'js/engine/attempt.js',
  'js/engine/import_validate.js',
  'js/engine/test_planner.js',
  'js/engine/persistence.js',
  'js/engine/gap_summary.js',
  'js/shared/focused_builder.js',
  'js/shared/import_dialog.js',
  'styles/builder.css',
  'js/shared/html.js',
  'js/shared/dom.js',
  'js/shared/env.js',
  'js/shared/storage.js',
  'js/shared/sync.js',
  'js/shared/beta_sandbox.js',
  'js/shared/questions.js',
  'js/shared/drill.js',
  'js/shared/math_tools.js',
  'js/shared/sw_routing.js',
  'js/components/format.js',
  'js/components/statCard.js',
  'js/components/banner.js',
  'js/components/modal.js',
  'js/components/progressBar.js',
  'js/components/questionCard.js',
  'js/components/navTabs.js',
  'js/components/emptyState.js',
  'js/components/dataTable.js',
  'js/pages/student.js',
  'styles/tokens.css',
  'styles/components.css',
  'styles/buttons.css',
  'styles/utilities.css',
  'styles/tw-extras.css',
  'vendor/chart.min.js'
];

// ---- install: precache the shell (best effort per file) --------------------
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return Promise.all(SHELL_ASSETS.map(function (asset) {
        // {cache:'reload'} bypasses the HTTP cache so we store fresh bytes.
        return cache.add(new Request(asset, { cache: 'reload' })).catch(function (e) {
          // Report, don't swallow (CLAUDE.md failure mode 5). One missing file
          // must not abort the whole precache (cache.addAll would).
          console.warn('[sw] precache skipped for', asset, e && e.message);
        });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// ---- activate: drop stale shell caches, take control now -------------------
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        // Delete only OLD shell caches; keep psat-images / psat-ext across deploys.
        if (k.indexOf('psat-shell-') === 0 && k !== SHELL_CACHE) {
          return caches.delete(k);
        }
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function cacheFirst(request, cacheName) {
  return caches.match(request, { ignoreSearch: true }).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(cacheName).then(function (c) { c.put(request, copy); });
      }
      return res;
    }).catch(function () {
      // Offline and not cached: return the cached copy if any (there isn't one
      // here), else let the failure surface as a normal network error.
      return caches.match(request, { ignoreSearch: true });
    });
  });
}

// WI-24 — bounded network waits. Hard offline (radio off) was never the problem:
// fetch rejects instantly and the cache serves. SOFT offline — plane wifi, captive
// portal — leaves navigator.onLine TRUE and makes fetches HANG, so all 44
// network-first shell assets and the navigation each waited on the browser default
// timeout while the exam clock ran.
var NETWORK_DEADLINE_MS = self.SW_ROUTING.NETWORK_DEADLINE_MS;
var EXTERNAL_DEADLINE_MS = self.SW_ROUTING.EXTERNAL_DEADLINE_MS;
var raceDeadline = self.SW_ROUTING.raceDeadline;

/** fetch() that resolves to null instead of rejecting, refreshing `cacheName`. */
function fetchAndCache(request, cacheName) {
  return fetch(request).then(function (res) {
    if (res && (res.ok || res.type === 'opaque')) {
      var copy = res.clone();
      caches.open(cacheName).then(function (c) { c.put(request, copy); });
    }
    return res;
  }).catch(function () { return null; });
}

function networkFirst(request, cacheName) {
  // Online and responsive: the fresh copy still wins, so a deploy is never masked by
  // a stale asset. Hanging: the cached copy is served at the deadline while the
  // in-flight request keeps going and refreshes the cache for next time.
  var network = fetchAndCache(request, cacheName);
  return caches.match(request, { ignoreSearch: true }).then(function (cached) {
    return raceDeadline(network, cached, NETWORK_DEADLINE_MS).then(function (res) {
      return res || cached;
    });
  });
}

function staleWhileRevalidate(request, cacheName) {
  return caches.match(request).then(function (cached) {
    var network = fetchAndCache(request, cacheName);
    if (cached) return cached;
    // Nothing cached and the resource is OPTIONAL (CDN icons/fonts). A hanging CDN
    // must not hold the page open, so this one bounds even without a fallback —
    // resolving null, which the browser surfaces as a normal failed subresource.
    return raceDeadline(network, null, EXTERNAL_DEADLINE_MS, null, true);
  });
}

// ---- fetch: route by the pure classifier -----------------------------------
self.addEventListener('fetch', function (event) {
  var request = event.request;
  var url;
  try { url = new URL(request.url); } catch (e) { return; }

  var decision = self.SW_ROUTING.classifyRequest({
    method: request.method,
    mode: request.mode,
    urlPath: url.pathname,
    sameOrigin: url.origin === self.location.origin
  });

  if (decision === 'passthrough') return; // sync API + non-GET: untouched

  if (decision === 'navigate') {
    event.respondWith(
      caches.match('index.html', { ignoreSearch: true }).then(function (cached) {
        // The navigation decides whether the app appears at all, so it gets the same
        // bounded wait as the shell it pulls in.
        var network = fetch(request).catch(function () { return null; });
        return raceDeadline(network, cached, NETWORK_DEADLINE_MS).then(function (res) {
          return res || cached || caches.match('index.html', { ignoreSearch: true });
        });
      })
    );
    return;
  }

  if (decision === 'image') {
    event.respondWith(cacheFirst(request, IMAGE_CACHE));
    return;
  }

  if (decision === 'shell') {
    // Network-first (not cache-first): online stays fresh, offline falls back to
    // the precached shell. Question images stay cache-first below — they are
    // immutable and are the bytes we most want served instantly from cache.
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  // external (CDN icons/fonts): best effort, never blocks the page offline.
  event.respondWith(staleWhileRevalidate(request, EXT_CACHE));
});
