/**
 * js/shared/beta_sandbox.js — the beta-lane data conveniences shown only when
 * APP_ENV.isBeta is true.
 *
 * WI-09 duplication ledger:
 *   cloneProdDataToBeta  3 sites (index.html, parent.html, mistakes.html) -> 1
 *   resetBetaSandbox     3 sites (index.html, parent.html, mistakes.html) -> 1
 * All three copies of each were byte-identical (verified by normalised-source
 * hash across the three inline scripts), so this is a pure relocation.
 *
 * CLAUDE.md failure mode 7 (destructive actions) applies here and is
 * unchanged: both actions are hard-gated on APP_ENV.isBeta, only ever touch
 * `beta_`-prefixed keys, and the reset routes through
 * PSAT_ENGINE.runTransactionalAction so a failed pre-reset snapshot aborts the
 * whole operation instead of deleting anything.
 */
import { APP_ENV } from './env.js';

export function cloneProdDataToBeta() {
  if (!APP_ENV.isBeta) return;
  if (!confirm('Copy Production Data into Beta Sandbox?\n\nThis will snapshot the current live student profile into your Beta sandbox so you can test realistic data. Production data will NOT be modified.')) return;

  const prodProgress = localStorage.getItem('psat_progress');
  const prodSrs = localStorage.getItem('psat_srs');
  const prodSessions = localStorage.getItem('psat_sessions');
  const prodHistory = localStorage.getItem('psat_exam_history');

  if (prodProgress) localStorage.setItem('beta_psat_progress', prodProgress);
  if (prodSrs) localStorage.setItem('beta_psat_srs', prodSrs);
  if (prodSessions) localStorage.setItem('beta_psat_sessions', prodSessions);
  if (prodHistory) localStorage.setItem('beta_psat_exam_history', prodHistory);

  alert('✓ Production data snapshot copied into Beta Sandbox! Reloading...');
  location.reload();
}

export function resetBetaSandbox() {
  if (!APP_ENV.isBeta) return;
  if (!confirm('Reset Beta Sandbox data to fresh state?')) return;

  const result = (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.runTransactionalAction) ?
    PSAT_ENGINE.runTransactionalAction(localStorage, 'reset_beta_sandbox', function(ctx) {
      localStorage.removeItem('beta_psat_progress');
      localStorage.removeItem('beta_psat_srs');
      localStorage.removeItem('beta_psat_sessions');
      localStorage.removeItem('beta_psat_exam_history');
      localStorage.removeItem('beta_psat_sample_data_active');
      localStorage.removeItem('beta_psat_pre_sample_backup');
      localStorage.removeItem('beta_psat_pending_sync_count');
      localStorage.removeItem('beta_psat_last_cloud_sync_time');
      localStorage.removeItem('beta_psat_sync_outbox');
      localStorage.removeItem('beta_psat_active_exam_state');
      return { success: true };
    }, window.location) :
    { success: false, error: 'Engine unavailable' };

  if (!result.success) {
    alert('❌ Reset Cancelled: Could not create pre-reset safety snapshot (' + (result.error || 'Storage error') + '). Beta sandbox data has not been modified.');
    return;
  }

  alert('✓ Beta Sandbox reset to clean state! Reloading...');
  location.reload();
}
