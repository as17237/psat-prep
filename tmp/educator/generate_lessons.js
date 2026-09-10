#!/usr/bin/env node
/**
 * tmp/educator/generate_lessons.js — TEMPORARY experiment (branch exp/educator-lessons).
 *
 * Reads a student snapshot (progress + exam history) and the real question bundle,
 * ranks weak skills by measured misses, and emits static HTML lessons with inline
 * SVG visualizations into tmp/educator/lessons/.
 *
 * Read-only: never touches Cosmos, localStorage, or data/. Re-run with:
 *   node tmp/educator/generate_lessons.js
 *
 * Inputs : tmp/educator/student_snapshot.backup.json (gitignored, see README)
 *          data/questions_data.js
 * Outputs: tmp/educator/lessons/index.html + lesson-<slug>.html
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const SNAP_PATH = path.join(HERE, 'student_snapshot.backup.json');
const OUT_DIR = path.join(HERE, 'lessons');
const BUNDLE_PATH = path.join(HERE, '..', '..', 'data', 'questions_data.js');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadBundle() {
  const js = fs.readFileSync(BUNDLE_PATH, 'utf8');
  const arr = JSON.parse(js.slice(js.indexOf('=') + 1, js.lastIndexOf(']') + 1));
  const map = {};
  arr.forEach(q => { if (q && q.id) map[q.id] = q; });
  return { all: arr, map };
}

// A question is usable in a lesson only if its text/options/rationale are real.
function isLessonQuality(q) {
  if (!q || q.type !== 'multiple_choice') return false;
  if (!Array.isArray(q.options) || q.options.length !== 4) return false;
  if (!q.options.every(o => o && o.key && o.text && o.text.trim().length > 5)) return false;
  if (!q.question_text || q.question_text.trim().length < 50) return false;
  if (!q.rationale || q.rationale.trim().length < 80) return false;
  if (/as shown|shown above|the figure|the graph|the table|the diagram|refer to the/i.test(q.question_text)) return false;
  return true;
}

function skillStats(progress, qmap) {
  const st = {};
  Object.entries(progress || {}).forEach(([qid, p]) => {
    const q = qmap[qid];
    if (!q || !p || !p.answered) return;
    const k = q.test + '|' + q.domain + '|' + q.skill;
    if (!st[k]) st[k] = { test: q.test, domain: q.domain, skill: q.skill, seen: 0, corr: 0, missIds: [] };
    const s = st[k];
    s.seen += p.timesSeen || 1;
    s.corr += p.timesCorrect || 0;
    const ic = (typeof p.timesIncorrect === 'number') ? p.timesIncorrect : (!p.isCorrect ? 1 : 0);
    if (ic > 0) s.missIds.push(qid);
  });
  Object.values(st).forEach(s => { s.inc = s.seen - s.corr; s.acc = s.seen ? s.corr / s.seen : null; });
  return st;
}

function overallAccuracy(progress) {
  let seen = 0, corr = 0;
  Object.values(progress || {}).forEach(p => {
    if (!p || !p.answered) return;
    seen += p.timesSeen || 1; corr += p.timesCorrect || 0;
  });
  return { seen, corr, acc: seen ? corr / seen : null };
}

// Per-exam accuracy trend for one skill (exams with >=2 skill questions only).
function skillTrend(examHistory, qmap, test, skill) {
  const pts = [];
  (examHistory || []).slice().sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0)).forEach(ex => {
    let n = 0, c = 0;
    (ex.moduleReports || []).forEach(m => (m.questions || []).forEach(q => {
      const full = qmap[q.questionId];
      if (!full || full.test !== test || full.skill !== skill || !q.answered) return;
      n++; if (q.isCorrect) c++;
    }));
    if (n >= 2) pts.push({ t: ex.completedAt, label: fmtDate(ex.completedAt), n, acc: c / n });
  });
  return pts;
}

function fmtDate(ms) {
  if (!ms) return '?';
  const d = new Date(ms);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

// Picked-vs-correct position matrix over mapped MCQ misses (positions 0..3).
function heatmapData(progress, qmap, test, skill) {
  const cells = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  let mapped = 0, missed = 0;
  Object.entries(progress || {}).forEach(([qid, p]) => {
    const q = qmap[qid];
    if (!q || q.test !== test || q.skill !== skill || !p || !p.answered) return;
    const ic = (typeof p.timesIncorrect === 'number') ? p.timesIncorrect : (!p.isCorrect ? 1 : 0);
    if (ic === 0) return;
    missed++;
    if (q.type === 'multiple_choice' && Array.isArray(q.options)) {
      const oi = q.options.findIndex(o => o.key === String(p.selectedAnswer || '').toUpperCase());
      const ci = q.options.findIndex(o => o.key === q.correct_answer);
      if (oi >= 0 && ci >= 0) { cells[oi][ci]++; mapped++; }
    }
  });
  return { cells, mapped, missed };
}

function pickWalkthrough(progress, qmap, test, skill) {
  const cands = [];
  Object.entries(progress || {}).forEach(([qid, p]) => {
    const q = qmap[qid];
    if (!q || q.test !== test || q.skill !== skill || !p || p.isCorrect !== false) return;
    if (!isLessonQuality(q)) return;
    cands.push({ q, pick: String(p.selectedAnswer || '').toUpperCase() });
  });
  cands.sort((a, b) => b.q.rationale.length - a.q.rationale.length);
  return cands[0] || null;
}

function pickSibling(all, progress, test, skill) {
  const cands = all.filter(q =>
    q.test === test && q.skill === skill && !(progress || {})[q.id] && isLessonQuality(q));
  return cands[0] || null;
}

// ---- SVG visualizations (inline, dependency-free) ----

function trendSVG(pts, accent) {
  const W = 560, H = 220, PL = 36, PR = 12, PT = 14, PB = 30;
  if (!pts.length) {
    return '<p class="note">Not enough exam data for a trend line yet (needs exams with 2+ ' +
      esc('questions') + ' in this skill).</p>';
  }
  const iw = W - PL - PR, ih = H - PT - PB;
  const X = i => PL + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const Y = a => PT + (1 - a) * ih;
  const line = pts.map((p, i) => X(i).toFixed(1) + ',' + Y(p.acc).toFixed(1)).join(' ');
  let dots = '', labels = '';
  pts.forEach((p, i) => {
    dots += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.acc).toFixed(1) + '" r="4.5" fill="' + accent + '">' +
      '<title>' + esc(p.label) + ': ' + Math.round(p.acc * 100) + '% (' + p.n + ' questions)</title></circle>';
    if (pts.length <= 12 || i % Math.ceil(pts.length / 12) === 0) {
      labels += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 10) + '" font-size="10" text-anchor="middle" fill="#5b636e">' +
        esc(p.label) + '</text>';
    }
  });
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Per-exam accuracy trend" class="chart">' +
    [0, 25, 50, 75, 100].map(v =>
      '<line x1="' + PL + '" y1="' + Y(v / 100).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(v / 100).toFixed(1) +
      '" stroke="#e2e5ea" stroke-width="1"/>' +
      '<text x="' + (PL - 6) + '" y="' + (Y(v / 100) + 3.5).toFixed(1) + '" font-size="10" text-anchor="end" fill="#5b636e">' + v + '%</text>'
    ).join('') +
    '<polyline points="' + esc(line) + '" fill="none" stroke="' + accent + '" stroke-width="2.5"/>' + dots + labels + '</svg>';
}

function heatSVG(hm, accent) {
  const letters = ['A', 'B', 'C', 'D'];
  const max = Math.max(1, ...hm.cells.flat());
  const C = 64, L = 44, T = 30;
  let s = '<svg viewBox="0 0 ' + (L + 4 * C + 8) + ' ' + (T + 4 * C + 26) + '" role="img" ' +
    'aria-label="Picked versus correct answer position matrix" class="chart heat">';
  letters.forEach((L2, j) => {
    s += '<text x="' + (L + j * C + C / 2) + '" y="20" font-size="11" text-anchor="middle" fill="#5b636e">correct ' + L2 + '</text>';
  });
  for (let i = 0; i < 4; i++) {
    s += '<text x="' + (L - 10) + '" y="' + (T + i * C + C / 2 + 4) + '" font-size="11" text-anchor="end" fill="#5b636e">picked ' + letters[i] + '</text>';
    for (let j = 0; j < 4; j++) {
      const v = hm.cells[i][j];
      const a = v === 0 ? 0.04 : 0.12 + 0.88 * (v / max);
      const fill = i === j ? '150,140,150' : '15,118,110';
      s += '<rect x="' + (L + j * C + 2) + '" y="' + (T + i * C + 2) + '" width="' + (C - 4) + '" height="' + (C - 4) +
        '" rx="6" fill="rgba(' + fill + ',' + a.toFixed(2) + ')">' +
        '<title>picked ' + letters[i] + ', correct ' + letters[j] + ': ' + v + '</title></rect>' +
        '<text x="' + (L + j * C + C / 2) + '" y="' + (T + i * C + C / 2 + 6) + '" font-size="16" text-anchor="middle" ' +
        'fill="' + (a > 0.5 ? '#ffffff' : '#1f2933') + '">' + v + '</text>';
    }
  }
  s += '</svg>';
  return s;
}

function barRow(label, pct, accent, note) {
  return '<div class="bar-row"><div class="bar-label">' + esc(label) +
    '<span class="bar-num">' + pct + '%</span></div>' +
    '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + accent + '"></div></div>' +
    (note ? '<div class="bar-note">' + esc(note) + '</div>' : '') + '</div>';
}

// ---- Hand-written pedagogy (the only non-computed content) ----

const LESSONS = {
  'Boundaries': {
    slug: 'boundaries',
    accent: '#0f766e',
    title: 'Boundaries: where sentences stop',
    bigIdea: 'Punctuation marks are traffic signals. A period, question mark, or exclamation ' +
      'point is a <strong>stop sign</strong>: when complete thoughts stand on both sides, you must come ' +
      'to a full stop between them. A semicolon is a <strong>yield sign</strong>: it also joins two ' +
      'complete thoughts, but signals they are closely related. A colon is a <strong>gate that swings ' +
      'open</strong>: it must follow a complete thought and announces what comes next — a list, an ' +
      'explanation, an example. A comma is only a <strong>pause</strong>: it can never join two complete ' +
      'thoughts by itself. Joining them with just a comma is called a comma splice, and it is the ' +
      'single most tested Boundaries error.',
    trap: 'There is no letter shortcut here: the misses spread across every answer position (see the ' +
      'grid below), so the errors are conceptual, not positional. The favorite trick is the comma that ' +
      '<em>sounds</em> right — you naturally pause there when reading aloud, so the comma feels fine. ' +
      'But a pause is not a stop. The test also plants semicolons after fragments and colons after ' +
      'incomplete thoughts, hoping you check only one side of the mark.',
    rules: [
      '<strong>Cover the mark, read both sides.</strong> If each side can stand alone as a sentence, cross out every lone comma.',
      '<strong>Run the substitution tests.</strong> Semicolon: swap in a period — if both halves still work, it fits. Colon: the part before it must be a complete sentence.'
    ],
    retrieval: 'Close this page and say the stop / yield / gate rule aloud from memory. Re-open and check what you dropped — then re-test yourself tomorrow.'
  },
  'Nonlinear functions': {
    slug: 'nonlinear-functions',
    accent: '#1d4ed8',
    title: 'Nonlinear functions: the machine rule',
    bigIdea: 'A function is a machine with one strict rule: each input goes to exactly one output. ' +
      'Nonlinear just means the rule <em>bends</em> — squares make parabolas, repeated multiplication ' +
      'makes exponential growth. Two moves solve most questions. First, <strong>read the rule ' +
      'literally</strong>: f(3) means "put 3 everywhere x appears" — nothing fancier. Second, ' +
      '<strong>match the shape</strong>: tables and graphs are the same machine drawn differently, and ' +
      'each row or dot is one input-output pair. Translate the question into "when the input is ___, ' +
      'the output is ___?" and read only that pair.',
    trap: 'The test dresses up simple substitution. The regular traps: evaluating at the wrong value ' +
      '(answering for x instead of f(x), or mixing up which table column is the input), sign errors ' +
      'when squaring negatives, and choices with the right shape but wrong details — a vertex or shift ' +
      'off by one. In word problems, the trap is calling steady repeated multiplication "linear".',
    rules: [
      '<strong>Substitute literally.</strong> Circle every x, replace it with the given value in parentheses — especially negatives: (-2)^2 is +4.',
      '<strong>One pair at a time.</strong> For graphs and tables, find the exact input the question names, read its single output, and ignore the rest.'
    ],
    retrieval: 'Without looking, state the two moves (literal substitution, one-pair reading). Then solve the practice question by substitution only.'
  },
  'Command of Evidence': {
    slug: 'command-of-evidence',
    accent: '#b45309',
    title: 'Command of Evidence: the courtroom rule',
    bigIdea: 'Treat the question like a courtroom. The claim is the <strong>charge</strong>; each answer ' +
      'choice is an <strong>exhibit</strong>. An exhibit only helps if it directly proves <em>that</em> ' +
      'charge — a true statement about something else gets thrown out. Work in three moves: ' +
      '<strong>Claim</strong> (restate what must be proven), <strong>Test</strong> (turn it into a yes/no ' +
      'check), <strong>Match</strong> (test every word of each choice against it, never judge a choice ' +
      'true or false in isolation).',
    trap: 'The signature trap is <strong>true-but-useless</strong>: the wrong answers are usually statements ' +
      'the passage genuinely supports — they just prove a <em>different</em> claim. That is why they survive ' +
      'a careless re-read, and why the miss grid below shows wrong picks spread over every cell instead of ' +
      'one tempting letter.',
    rules: [
      '<strong>Underline the exact thing to prove</strong> before reading the choices — write it in your own words.',
      '<strong>Ask of each choice: does this prove THAT, or just something nearby?</strong> Eliminate the nearby ones first.'
    ],
    retrieval: 'Cover the choices of the practice question and state its claim in one sentence from memory. Then uncover and match.'
  }
};

function questionHTML(q, highlightPick) {
  let s = '<div class="qtext">' + esc(q.question_text).replace(/\n/g, '<br>') + '</div><ol class="opts" type="A">';
  q.options.forEach(o => {
    const cls = [];
    if (highlightPick && o.key === highlightPick) cls.push('picked');
    s += '<li' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '><span class="opt-key">' +
      esc(o.key) + '.</span> ' + esc(o.text) +
      (highlightPick && o.key === highlightPick ? ' <span class="picked-tag">your pick</span>' : '') + '</li>';
  });
  return s + '</ol>';
}

const CSS = `
:root{--ink:#1f2933;--muted:#5b636e;--line:#e2e5ea;--bg:#ffffff;--panel:#f6f7f9;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;line-height:1.6}
.wrap{max-width:760px;margin:0 auto;padding:28px 20px 64px}
nav.back{margin-bottom:18px;font-size:14px}
nav.back a{color:var(--muted);text-decoration:none}
h1{font-size:28px;line-height:1.25;margin:6px 0 4px;letter-spacing:-0.01em}
h2{font-size:19px;margin:30px 0 8px;padding-top:18px;border-top:1px solid var(--line)}
.kicker{font-size:14px;color:var(--muted);margin:0}
.stat-strip{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}
.stat{flex:1 1 140px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.stat b{display:block;font-size:22px}
.stat span{font-size:13px;color:var(--muted)}
.bar-row{margin:10px 0}
.bar-label{display:flex;justify-content:space-between;font-size:14px;margin-bottom:4px}
.bar-num{font-weight:700}
.bar-track{background:#eceef1;border-radius:5px;height:12px}
.bar-fill{height:12px;border-radius:5px}
.bar-note{font-size:13px;color:var(--muted)}
.chart{width:100%;height:auto;margin:8px 0}
.note,.caption{font-size:13px;color:var(--muted)}
.qbox{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:12px 0}
.qtext{white-space:normal;margin-bottom:8px}
ol.opts{margin:8px 0 4px;padding-left:22px}
ol.opts li{margin:6px 0}
.opt-key{font-weight:700}
li.picked{background:#fff7e6;border-radius:4px}
.picked-tag{font-size:12px;font-weight:700;color:#926100;background:#fdeec9;border-radius:4px;padding:1px 6px}
details.answer{margin:10px 0;border:1px solid var(--line);border-radius:8px;padding:10px 14px;background:#fff}
details.answer summary{cursor:pointer;font-weight:600}
.rule{background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:8px 0}
.science{font-size:13px;color:var(--muted);border-top:1px solid var(--line);margin-top:30px;padding-top:12px}
.cards{display:grid;gap:12px;margin:16px 0}
.card{border:1px solid var(--line);border-radius:10px;padding:14px 16px;text-decoration:none;color:inherit;display:block}
.card:hover{border-color:#9aa3af}
.card h3{margin:0 0 4px;font-size:17px}
.card p{margin:4px 0;font-size:14px;color:var(--muted)}
footer{margin-top:36px;font-size:13px;color:var(--muted);border-top:1px solid var(--line);padding-top:12px}
`;

function shell(title, accent, body) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + '</title><style>' + CSS + '</style></head>' +
    '<body><div class="wrap">' + body + '</div></body></html>';
}

function lessonPage(lsn, st, ov, trend, hm, walk, sib, snapDate, totalMiss) {
  const acc = Math.round(st.acc * 100), oacc = Math.round(ov.acc * 100);
  const share = Math.round(100 * st.inc / Math.max(1, totalMiss));
  const chap = [];
  chap.push('<nav class="back"><a href="index.html">&larr; All lessons</a></nav>');
  chap.push('<p class="kicker">' + esc(st.test + ' · ' + st.domain + ' · ' + st.skill) + '</p>');
  chap.push('<h1>' + esc(lsn.title) + '</h1>');
  chap.push('<p class="kicker">Built from your last ' + ov.seen + ' attempts across ' +
    'practice and exams. Every number below is measured, not estimated.</p>');

  chap.push('<div class="stat-strip">' +
    '<div class="stat"><b>' + st.seen + '</b><span>attempts on this skill</span></div>' +
    '<div class="stat"><b>' + acc + '%</b><span>your accuracy (you overall: ' + oacc + '%)</span></div>' +
    '<div class="stat"><b>' + st.inc + '</b><span>misses · ' + share + '% of all your misses</span></div></div>');

  chap.push('<h2>Your numbers</h2>');
  chap.push(barRow('This skill (' + st.seen + ' attempts)', acc, lsn.accent));
  chap.push(barRow('Your overall (' + ov.seen + ' attempts)', oacc, '#9aa3af'));

  chap.push('<h2>Trend across exams</h2>');
  chap.push(trendSVG(trend, lsn.accent));
  chap.push('<p class="caption">One dot per exam with 2+ ' + esc(st.skill) +
    ' questions (' + trend.length + ' exams qualify). Hover a dot for the exact score.</p>');

  chap.push('<h2>Where your wrong picks landed</h2>');
  chap.push(heatSVG(hm, lsn.accent));
  const topCell = Math.max(...hm.cells.flat());
  const spreadReading = hm.mapped > 0 && topCell / hm.mapped > 0.4
    ? 'Misses cluster in one cell — that pick-vs-answer pattern is worth a second look.'
    : 'The misses spread across cells, which means the gap is conceptual — no single trap letter to avoid.';
  chap.push('<p class="caption">Rows: the letter you picked. Columns: the correct letter. ' +
    'Off-diagonal cells are misses (' + hm.mapped + ' of ' + hm.missed +
    ' missed questions mapped). ' + spreadReading + '</p>');

  chap.push('<h2>The big idea</h2><p>' + lsn.bigIdea + '</p>');
  chap.push('<h2>The PSAT trap (and your data)</h2><p>' + lsn.trap + '</p>');
  chap.push('<h2>Rules in a nutshell</h2>' + lsn.rules.map(r => '<div class="rule">' + r + '</div>').join(''));

  if (walk) {
    chap.push('<h2>Walkthrough: a question you missed</h2>');
    chap.push('<div class="qbox">' + questionHTML(walk.q, walk.pick) +
      '<p class="caption">You picked ' + esc(walk.pick) + '; the correct answer is ' +
      esc(walk.q.correct_answer) + '. Work the rules above before reading on.</p></div>');
    chap.push('<details class="answer"><summary>Step-by-step thinking + answer</summary>' +
      '<p><strong>Answer: ' + esc(walk.q.correct_answer) + '.</strong> ' + esc(walk.q.rationale) + '</p></details>');
  } else {
    chap.push('<h2>Walkthrough</h2><p class="note">No currently-missed question in this skill ' +
      'passed the text-quality filter, so this section was omitted rather than invented.</p>');
  }

  if (sib) {
    chap.push('<h2>Check your intuition (retrieval practice)</h2>');
    chap.push('<p>Cover the answer, attempt this fresh question from the same skill, then check. ' +
      'Retrieving from memory — not re-reading — is what builds retention ' +
      '(Karpicke &amp; Roediger, 2008).</p>');
    chap.push('<div class="qbox">' + questionHTML(sib, null) + '</div>');
    chap.push('<details class="answer"><summary>Answer key</summary>' +
      '<p><strong>Answer: ' + esc(sib.correct_answer) + '.</strong> ' + esc(sib.rationale) + '</p></details>');
    chap.push('<p class="note">' + esc(lsn.retrieval) + '</p>');
  }

  chap.push('<div class="science">How to lock this in: re-attempt this skill in 2 days, then 7 ' +
    '(spacing beats cramming — Cepeda et al., 2006, meta-analysis of 317 experiments); mix it with ' +
    'other skills rather than drilling it alone (interleaving improves discrimination — Rohrer &amp; Taylor). ' +
    'Your app SRS queue already schedules this.</div>');
  chap.push('<footer>Instructional content generated ' + esc(snapDate) +
    ' from measured practice data. Not official College Board material. No score is projected here.</footer>');
  return shell(lsn.title, lsn.accent, chap.join('\n'));
}

function indexPage(picks, ov, snap, examCount, dayCount) {
  const oacc = Math.round(ov.acc * 100);
  const b = [];
  b.push('<p class="kicker">Temporary experiment · data as of ' + esc(snap.pulledAt.slice(0, 10)) + '</p>');
  b.push('<h1>Your 3 highest-leverage lessons</h1>');
  b.push('<p>Chosen by measured misses across <strong>' + ov.seen + ' attempts</strong> (' +
    examCount + ' exams, ' + dayCount + ' practice days, overall accuracy ' + oacc +
    '%). Together these three skills hold <strong>' + picks.reduce((a, p) => a + p.st.inc, 0) +
    ' of your ' + picks[0].totalMiss + ' misses</strong>.</p>');
  b.push('<div class="cards">' + picks.map(p => {
    const acc = Math.round(p.st.acc * 100);
    return '<a class="card" href="lesson-' + p.lsn.slug + '.html"><h3>' + esc(p.lsn.title) + '</h3>' +
      '<p>' + esc(p.st.domain + ' · ' + p.st.skill) + ' — ' + p.st.seen + ' attempts, ' + acc +
      '% accuracy, ' + p.st.inc + ' misses</p>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + acc + '%;background:' + p.lsn.accent + '"></div></div></a>';
  }).join('') + '</div>');
  b.push('<h2>Why these lessons work this way (the science)</h2>');
  b.push('<p>Each lesson follows the same evidence-based shape. <strong>Worked example first, then ' +
    'retrieval:</strong> studying a step-by-step walkthrough before attempting a sibling question ' +
    'beats attempting cold (worked-example effect — Sweller, cognitive load theory). ' +
    '<strong>Covert retrieval:</strong> every lesson ends with a recall-from-memory check, because ' +
    'practice testing was one of only two strategies rated <em>high utility</em> across contexts ' +
    '(Dunlosky et al., 2013). <strong>Spacing over cramming:</strong> distributed practice beat massed ' +
    'practice in nearly every one of 317 experiments (Cepeda et al., 2006) — hence the 2-day / 7-day ' +
    're-test prompts. <strong>Interleaving:</strong> the three lessons mix reading and math so practice ' +
    'trains discrimination between problem types, not just repetition of one (Rohrer &amp; Taylor; ' +
    'recent work also shows learners <em>feel</em> interleaving works worse even as it performs better — ' +
    'PNAS, 2024 — so trust the schedule, not the feeling). <strong>Dual coding:</strong> each claim is ' +
    'shown visually (charts) and verbally (Paivio; Mayer).</p>');
  b.push('<footer>Temporary experiment on branch exp/educator-lessons. Numbers are measured from ' +
    'the student snapshot; prose is instructional content, not an official score or projection.</footer>');
  return shell('Your 3 highest-leverage lessons', '#1f2933', b.join('\n'));
}

function main() {
  const snap = JSON.parse(fs.readFileSync(SNAP_PATH, 'utf8'));
  const { all, map } = loadBundle();
  console.log('bundle questions:', all.length);
  console.log('snapshot:', snap.student_name, snap.pulledAt,
    '| progress:', Object.keys(snap.progress || {}).length,
    '| exams:', (snap.examHistory || []).length,
    '| days:', Object.keys(snap.sessionsState || {}).length);

  const stats = skillStats(snap.progress, map);
  const ov = overallAccuracy(snap.progress);
  let totalMiss = 0;
  Object.values(stats).forEach(s => { totalMiss += s.inc; });
  console.log('overall: seen', ov.seen, 'acc', (ov.acc * 100).toFixed(1) + '%', 'totalMiss', totalMiss);

  const ranked = Object.values(stats)
    .filter(s => s.seen >= 10 && LESSONS[s.skill])
    .sort((a, b) => b.inc - a.inc)
    .slice(0, 3);
  if (ranked.length < 3) throw new Error('expected 3 lesson-eligible skills, got ' + ranked.length);
  console.log('picked:', ranked.map(s => s.skill + ' (inc ' + s.inc + ', acc ' +
    Math.round(s.acc * 100) + '%)').join(' | '));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const picks = [];
  ranked.forEach(st => {
    const lsn = LESSONS[st.skill];
    const trend = skillTrend(snap.examHistory, map, st.test, st.skill);
    const hm = heatmapData(snap.progress, map, st.test, st.skill);
    const walk = pickWalkthrough(snap.progress, map, st.test, st.skill);
    const sib = pickSibling(all, snap.progress, st.test, st.skill);
    console.log(lsn.slug + ': trendPts=' + trend.length, 'heatMapped=' + hm.mapped + '/' + hm.missed,
      'walk=' + (walk ? walk.q.id + '(picked ' + walk.pick + ', ans ' + walk.q.correct_answer + ')' : 'NONE'),
      'sib=' + (sib ? sib.id : 'NONE'));
    if (!walk) throw new Error('no walkthrough for ' + st.skill + ' — refusing to invent one');
    if (!sib) throw new Error('no sibling for ' + st.skill + ' — refusing to invent one');
    fs.writeFileSync(path.join(OUT_DIR, 'lesson-' + lsn.slug + '.html'),
      lessonPage(lsn, st, ov, trend, hm, walk, sib, snap.pulledAt.slice(0, 10), totalMiss));
    picks.push({ lsn, st, totalMiss });
  });
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'),
    indexPage(picks, ov, snap, (snap.examHistory || []).length, Object.keys(snap.sessionsState || {}).length));
  console.log('wrote', fs.readdirSync(OUT_DIR).join(', '));
}

main();




