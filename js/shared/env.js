/**
 * js/shared/env.js — the app-environment descriptor every page reads.
 *
 * WI-09 duplication ledger: this exact `APP_ENV` initialiser was declared
 * verbatim in index.html, parent.html and mistakes.html. 3 sites -> 1 module.
 *
 * The `typeof PSAT_ENGINE !== 'undefined'` probe and the hand-rolled fallback
 * object are kept byte-for-byte from the inline originals: srs.js is a classic
 * <script> loaded before these modules, so PSAT_ENGINE is a plain global here,
 * and the fallback is what runs if the engine failed to load.
 */

export const APP_ENV = (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.getEnvironmentConfig) ?
  PSAT_ENGINE.getEnvironmentConfig() :
  { isBeta: (window.location.pathname.indexOf('/beta') !== -1 || window.location.search.indexOf('env=beta') !== -1), storagePrefix: (window.location.pathname.indexOf('/beta') !== -1 || window.location.search.indexOf('env=beta') !== -1) ? 'beta_' : '', studentName: 'default_student', envName: 'Production' };
