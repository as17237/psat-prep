/**
 * js/pages/feedback.js — page controller for feedback.html.
 *
 * WI-09: relocated verbatim out of feedback.html's inline <script>. No logic
 * change: the only edits are (a) `escapeHtml()` replaced by the shared
 * `esc()` from js/shared/html.js, and (b) the explicit window bindings at the
 * bottom, which reproduce exactly what a classic <script>'s top-level
 * function declarations used to put on `window` for the inline on* handlers
 * in the markup.
 */
import { esc } from '../shared/html.js';

let feedbackEntries = JSON.parse(localStorage.getItem('psat_uat_feedback') || '[]');

document.addEventListener('DOMContentLoaded', () => {
  // Pre-fill QID from query param if available (?qid=12345)
  const urlParams = new URLSearchParams(window.location.search);
  const qid = urlParams.get('qid');
  if (qid) {
    document.getElementById('fb-qid').value = qid;
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
  renderFeedbackList();
});

// Single place that owns #form-msg styling, so a failure can never be
// rendered in the success colour (CLAUDE.md mode 5).
const FORM_MSG_CLASSES = {
  pending: 'text-xs font-semibold text-slate-500',
  success: 'text-xs font-semibold text-emerald-600',
  error: 'text-xs font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5 mr-3'
};

function setFormMsg(text, kind) {
  const msg = document.getElementById('form-msg');
  if (!msg) return;
  msg.className = FORM_MSG_CLASSES[kind] || FORM_MSG_CLASSES.pending;
  msg.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  msg.innerText = text;
}

function handleFeedbackSubmit(e) {
  e.preventDefault();
  const entry = {
    id: 'fb_' + Date.now(),
    category: document.getElementById('fb-category').value,
    qid: document.getElementById('fb-qid').value.trim() || 'N/A',
    tester: document.getElementById('fb-tester').value,
    severity: document.getElementById('fb-severity').value,
    title: document.getElementById('fb-title').value.trim(),
    desc: document.getElementById('fb-desc').value.trim(),
    timestamp: new Date().toLocaleString()
  };

  feedbackEntries.unshift(entry);
  localStorage.setItem('psat_uat_feedback', JSON.stringify(feedbackEntries));

  document.getElementById('feedback-form').reset();
  setFormMsg('⏳ Syncing feedback to Cosmos DB...', 'pending');

  // Push to Azure Cosmos DB UATFeedback container
  fetch('https://psat-api-4915.azurewebsites.net/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry)
  }).then(res => {
    if (res.ok) {
      setFormMsg('✓ Feedback entry logged & synced to Cosmos DB successfully!', 'success');
      setTimeout(() => { setFormMsg('', 'pending'); }, 3500);
    } else {
      // A real server rejection must never look like a success (CLAUDE.md mode 5).
      console.error('Cosmos feedback sync rejected with HTTP', res.status);
      setFormMsg(`⚠ NOT synced — the server rejected this report (HTTP ${res.status}). Your entry is saved on this device and listed in the table below; please submit it again later, or send the Markdown export instead.`, 'error');
    }
  }).catch(err => {
    console.error('Cosmos feedback sync error:', err);
    setFormMsg('⚠ NOT synced — could not reach the feedback server (you may be offline). Your entry is saved on this device and listed in the table below; please submit it again once you are back online, or send the Markdown export instead.', 'error');
  });

  renderFeedbackList();
}

function renderFeedbackList() {
  const tbody = document.getElementById('feedback-table-body');
  const countEl = document.getElementById('feedback-count');
  tbody.innerHTML = '';
  countEl.innerText = feedbackEntries.length;

  if (feedbackEntries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-6 text-center text-slate-400 italic">No feedback entries recorded yet. Submit your first observation above!</td></tr>`;
    updateMarkdownPreview();
    return;
  }

  feedbackEntries.forEach((fb, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50 transition-colors';

    const sevBadge = fb.severity === 'High' ? '<span class="px-2 py-0.5 rounded text-xs font-bold bg-rose-100 text-rose-800">High</span>' :
                    (fb.severity === 'Medium' ? '<span class="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800">Medium</span>' :
                    '<span class="px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">Low</span>');

    tr.innerHTML = `
      <td class="px-4 py-3 text-xs font-semibold text-slate-800">${esc(fb.category)}</td>
      <td class="px-4 py-3 font-mono text-xs font-bold text-indigo-600">${esc(fb.qid)}</td>
      <td class="px-4 py-3 text-xs">
        <div class="font-bold text-slate-900">${esc(fb.title)}</div>
        <div class="text-slate-500 text-xs mt-0.5 line-clamp-2">${esc(fb.desc)}</div>
      </td>
      <td class="px-4 py-3 text-xs text-slate-600">${esc(fb.tester)}</td>
      <td class="px-4 py-3 text-xs">${sevBadge}</td>
      <td class="px-4 py-3 text-right">
        <button onclick="deleteEntry('${fb.id}')" class="btn btn-sm btn-icon btn-ghost text-slate-400 hover:text-rose-600" title="Delete entry">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
  updateMarkdownPreview();
}

function deleteEntry(id) {
  feedbackEntries = feedbackEntries.filter(e => e.id !== id);
  localStorage.setItem('psat_uat_feedback', JSON.stringify(feedbackEntries));
  renderFeedbackList();
}

function clearAllFeedback() {
  if (confirm('Are you sure you want to clear all feedback entries?')) {
    feedbackEntries = [];
    localStorage.setItem('psat_uat_feedback', JSON.stringify(feedbackEntries));
    renderFeedbackList();
  }
}

function updateMarkdownPreview() {
  const preview = document.getElementById('markdown-preview');
  if (feedbackEntries.length === 0) {
    preview.value = `# PSAT Prep Mastery — UAT Feedback Report\n\nNo issues recorded.`;
    return;
  }

  let md = `# PSAT Prep Mastery — UAT Feedback Report\n`;
  md += `Generated: ${new Date().toLocaleString()}\n`;
  md += `Total Observations: ${feedbackEntries.length}\n\n`;
  md += `| # | Severity | Category | QID | Summary | Submitted By |\n`;
  md += `|---|---|---|---|---|---|\n`;

  feedbackEntries.forEach((fb, i) => {
    md += `| ${i+1} | ${fb.severity} | ${fb.category} | ${fb.qid} | ${fb.title.replace(/\|/g, '-')} | ${fb.tester} |\n`;
  });

  md += `\n## Detailed Observations\n\n`;
  feedbackEntries.forEach((fb, i) => {
    md += `### ${i+1}. [${fb.severity}] ${fb.title} (QID: ${fb.qid})\n`;
    md += `- **Category:** ${fb.category}\n`;
    md += `- **Tester:** ${fb.tester}\n`;
    md += `- **Timestamp:** ${fb.timestamp}\n`;
    md += `- **Details:**\n${fb.desc}\n\n`;
  });

  preview.value = md;
}

function exportFeedbackMarkdown() {
  updateMarkdownPreview();
  const text = document.getElementById('markdown-preview').value;
  navigator.clipboard.writeText(text).then(() => {
    alert('Copied UAT Feedback Markdown report to clipboard! You can paste it directly to the assistant.');
  }).catch(() => {
    alert('Please copy the markdown text from the preview box below.');
  });
}

function downloadFeedbackJSON() {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(feedbackEntries, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `psat_uat_feedback_${Date.now()}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

// ---------------------------------------------------------------------------
// Global handler surface.
//
// A classic <script> puts every top-level function declaration on `window`;
// an ES module does not. feedback.html's markup calls these from inline
// on* attributes (onsubmit/onclick), so they are re-published explicitly.
// WI-09 keeps the HTML untouched: converting to addEventListener is a much
// larger diff and is deliberately out of scope for this work item.
// ---------------------------------------------------------------------------
Object.assign(window, {
  esc,
  setFormMsg,
  handleFeedbackSubmit,
  renderFeedbackList,
  deleteEntry,
  clearAllFeedback,
  updateMarkdownPreview,
  exportFeedbackMarkdown,
  downloadFeedbackJSON,
});
