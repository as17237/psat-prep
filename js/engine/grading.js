/**
 * js/engine/grading.js — Free-response grading, numeric parsing, answer-key presentation and the
 * on-screen scientific calculator — everything that turns a student's raw input
 * into "right / wrong / here is why".
 *
 * Part of the engine that was one 3,458-line srs.js until REFACTOR_PLAN.md
 * WI-10. The code below is the SAME code, moved verbatim; `srs.js` is now a
 * facade that recomposes these parts into the unchanged `PSAT_ENGINE` object.
 *
 * Loading: same UMD shape as srs.js always had — `module.exports` under Node,
 * `window.__PSAT_ENGINE_PARTS.grading` in the browser. There is no build step,
 * so the pages load the parts as ordinary <script> tags in dependency order
 * (grading -> scheduler -> scoring -> storage -> examgen -> sync) before srs.js.
 * Dependencies: none.
 * A missing dependency throws immediately rather than yielding a half-built
 * part whose functions ReferenceError at call time (CLAUDE.md failure mode 5).
 */
(function (root, factory) {
  var DEPS = [];
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory.apply(null, DEPS.map(function (d) { return require('./' + d + '.js'); }));
  } else {
    var parts = root.__PSAT_ENGINE_PARTS = root.__PSAT_ENGINE_PARTS || {};
    parts.grading = factory.apply(null, DEPS.map(function (d) {
      if (!parts[d]) {
        throw new Error(
          'js/engine/grading.js requires js/engine/' + d + '.js, which has not loaded yet. ' +
          'Load the engine parts in this order before srs.js: grading, scheduler, scoring, storage, examgen, sync.'
        );
      }
      return parts[d];
    }));
  }
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Parses string numeric values including decimals, fractions (e.g. 5/2, -49/150), and formatted text.
   */
  function parseNumeric(s) {
    if (s === null || s === undefined) return null;
    var cleaned = String(s).trim().replace(/[$,%\s]/g, '');
    if (!cleaned) return null;

    // Check fraction format: numerator / denominator
    var fracMatch = cleaned.match(/^(-?\d*\.?\d+)\/(-?\d*\.?\d+)$/);
    if (fracMatch) {
      var num = parseFloat(fracMatch[1]);
      var den = parseFloat(fracMatch[2]);
      if (den === 0 || isNaN(num) || isNaN(den)) return null;
      return num / den;
    }

    var n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }


  /**
   * Extracts all accepted forms from a free-response answer key (handles comma separation, prose 'either X or Y').
   */
  function extractAcceptedForms(key) {
    if (key === null || key === undefined) return [];
    var raw = String(key).trim();
    if (!raw) return [];

    // Strip leading 'either ' (e.g., 'either 8 or 9')
    raw = raw.replace(/^either\s+/i, '');

    // Split on commas or word-bounded 'or'
    var parts = raw.split(/\s*(?:,|\bor\b)\s*/i).map(function (s) {
      return s.trim();
    }).filter(Boolean);

    return parts;
  }


  /**
   * Grades free-response (Student-Produced Response) input against one or multiple accepted keys.
   */
  function gradeFreeResponse(input, key) {
    if (input === null || input === undefined || key === null || key === undefined) return false;
    var rawInput = String(input).trim();
    if (!rawInput) return false;

    var acceptedForms = extractAcceptedForms(key);
    var userNum = parseNumeric(rawInput);

    return acceptedForms.some(function (accepted) {
      if (userNum !== null) {
        var keyNum = parseNumeric(accepted);
        if (keyNum !== null) {
          // Allow absolute tolerance of 1e-4 or relative tolerance of 1e-3 (handles rounding of repeating decimals like 14.66 vs 44/3)
          var diff = Math.abs(userNum - keyNum);
          var tol = Math.max(1e-4, Math.abs(keyNum) * 1e-3);
          if (diff <= tol) return true;
        }
      }
      return rawInput.toLowerCase() === accepted.toLowerCase();
    });
  }


  /**
   * Formats a key into human-friendly text (e.g. ".2, 1/5" -> ".2 or 1/5", "either 8 or 9" -> "8 or 9")
   */
  function formatAcceptedAnswers(key) {
    if (!key) return '';
    var forms = extractAcceptedForms(key);
    if (forms.length <= 1) return forms[0] || '';
    if (forms.length === 2) return forms[0] + ' or ' + forms[1];
    return forms.slice(0, -1).join(', ') + ', or ' + forms[forms.length - 1];
  }


  /**
   * Computes SM-2 response grade (1 to 5) based on correctness and response time.
   * If timing is missing or unreliable, falls back conservatively to grade 3 (Hesitant).
   */
  function gradeAttempt(isCorrect, timeMs, timingReliable) {
    if (!isCorrect) return 1;
    if (timingReliable === false || typeof timeMs !== 'number' || isNaN(timeMs) || timeMs <= 0) {
      return 3; // Conservative fallback: Hesitant
    }
    if (timeMs < 45000) return 5; // Fast / Mastered (<45s)
    if (timeMs <= 90000) return 4; // Proficient (45s-90s)
    return 3; // Hesitant (>90s)
  }

  /**
   * Renders high-fidelity, structured step-by-step rationales.
   * - Normalizes broken OCR line wraps into readable paragraphs.
   * - Splits Choice A/B/C/D into dedicated answer cards with green highlight for correct choice.
   * - Compact neutral/rose styling for incorrect traps.
   * - Detects incomplete extraction (text_complete: false) and displays notice + screenshot-first layout.
   * - HTML escaping protection against XSS.
   */
  function renderRationale(question, options) {
    options = options || {};
    var q = question || {};
    var raw = q.rationale || '';
    if (!raw.trim()) {
      return '<div class="p-4 rounded-2xl bg-amber-50/60 border border-amber-200 text-xs text-amber-800 italic">No official explanation provided for this question.</div>';
    }

    var _esc = function(s) {
      if (s === null || s === undefined) return '';
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };

    var isIncomplete = (q.text_complete === false || q.formula_complete === false || q.review_status === 'incomplete_ocr' || q.review_status === 'needs_review');
    var userAns = (options.userSelectedAnswer || options.selectedAnswer || '').trim().toUpperCase();
    var correctAns = (q.correct_answer || '').trim().toUpperCase();

    // 1. Normalize line wraps inside paragraphs while keeping real paragraph boundaries
    var normalized = raw.replace(/\r\n/g, '\n').trim();
    normalized = normalized.replace(/([^\n])\n(?!\n|[•\-\d+\.])/g, '$1 ');
    var paragraphs = normalized.split(/\n\s*\n/).map(function(p) { return p.trim(); }).filter(Boolean);

    // 2. Build Header
    var headerHtml = '';
    if (isIncomplete) {
      headerHtml = 
        '<div class="space-y-2.5 pb-2.5 border-b border-amber-200/80">' +
          '<div class="flex flex-wrap items-center justify-between gap-2 text-amber-900 font-bold text-xs uppercase tracking-wider">' +
            '<div class="flex items-center space-x-2">' +
              '<i data-lucide="alert-circle" class="w-4 h-4 text-amber-700"></i>' +
              '<span>Extracted Explanation (Partial Text)</span>' +
            '</div>' +
            (q.review_status ? '<span class="px-2 py-0.5 text-[10px] rounded font-bold uppercase ' + (q.review_status === 'verified' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800') + '">' + _esc(q.review_status) + '</span>' : '') +
          '</div>' +
          '<div class="p-3 bg-amber-100/90 border border-amber-300/90 rounded-xl text-xs text-amber-950 flex items-start space-x-2.5 shadow-2xs">' +
            '<i data-lucide="info" class="w-4 h-4 text-amber-700 shrink-0 mt-0.5"></i>' +
            '<span><strong>Notice:</strong> Some mathematical notation was lost during text extraction. Refer to the official question diagram/image above for complete formula fidelity.</span>' +
          '</div>' +
        '</div>';
    } else {
      headerHtml = 
        '<div class="flex flex-wrap items-center justify-between gap-2 text-amber-900 font-bold text-xs uppercase tracking-wider pb-2.5 border-b border-amber-200/80">' +
          '<div class="flex items-center space-x-2">' +
            '<i data-lucide="book-open" class="w-4 h-4 text-amber-700"></i>' +
            '<span>Official Step-by-Step Solution &amp; Trap Rationale</span>' +
          '</div>' +
          (q.review_status === 'verified' ? '<span class="px-2 py-0.5 text-[10px] rounded font-bold bg-emerald-100 text-emerald-800 uppercase">Verified Solution</span>' : '') +
        '</div>';
    }

    // 3. Screenshot Image for Incomplete Question (if requested)
    var imageHtml = '';
    if (options.includeScreenshot && (q.image_url || q.question_image)) {
      var imgSrc = q.image_url || ('data/' + q.question_image);
      imageHtml = 
        '<div class="p-3.5 bg-slate-50 rounded-2xl border border-slate-200 flex flex-col items-center justify-center space-y-1.5 cursor-pointer group" onclick="typeof openImageLightbox === \'function\' ? openImageLightbox(\'' + _esc(imgSrc) + '\') : window.open(\'' + _esc(imgSrc) + '\', \'_blank\')">' +
          '<img src="' + _esc(imgSrc) + '" class="max-h-64 max-w-full object-contain rounded-xl shadow-2xs transition-transform group-hover:scale-[1.01]" alt="Question Diagram">' +
          '<span class="text-[11px] text-indigo-600 font-semibold flex items-center group-hover:underline">' +
            '<i data-lucide="zoom-in" class="w-3.5 h-3.5 mr-1"></i> Click screenshot to inspect full size' +
          '</span>' +
        '</div>';
    }

    // 4. Try Choice A/B/C/D parsing for multiple choice
    var choiceRegex = /\b(Choice\s+([A-D])\b[\s\S]*?)(?=\bChoice\s+[A-D]\b|$)/gi;
    var firstChoiceMatch = /\bChoice\s+([A-D])\b/i.exec(normalized);

    var bodyHtml = '';
    if (firstChoiceMatch) {
      var firstChoiceIdx = firstChoiceMatch.index;
      var intro = normalized.substring(0, firstChoiceIdx).trim();
      var choicesText = normalized.substring(firstChoiceIdx);

      var choiceBlocks = [];
      var cMatch;
      while ((cMatch = choiceRegex.exec(choicesText)) !== null) {
        choiceBlocks.push({ letter: cMatch[2].toUpperCase(), text: cMatch[1].trim() });
      }

      var introHtml = '';
      if (intro) {
        introHtml = '<div class="text-sm text-slate-800 leading-relaxed font-serif max-w-3xl pb-1.5">' + _esc(intro) + '</div>';
      }

      var cardsHtml = choiceBlocks.map(function(c) {
        var isCorrect = (c.letter === correctAns || /is the best answer|is correct/i.test(c.text));
        var isStudentChoice = (userAns && c.letter === userAns);

        if (isCorrect) {
          return '<div class="p-4 sm:p-5 rounded-2xl border border-emerald-300 bg-emerald-50/90 text-emerald-950 shadow-2xs space-y-2">' +
            '<div class="flex items-center justify-between gap-2">' +
              '<span class="px-2.5 py-0.5 bg-emerald-600 text-white font-bold text-xs rounded-lg flex items-center shrink-0">' +
                '<i data-lucide="check" class="w-3.5 h-3.5 mr-1"></i> Choice ' + _esc(c.letter) + ' — Correct Answer ✓' +
              '</span>' +
            '</div>' +
            '<p class="text-sm sm:text-base text-emerald-950 leading-relaxed font-sans max-w-3xl">' + _esc(c.text) + '</p>' +
          '</div>';
        } else {
          return '<div class="p-3.5 sm:p-4 rounded-2xl border border-slate-200 bg-white/95 text-slate-800 shadow-2xs space-y-1.5">' +
            '<div class="flex items-center justify-between gap-2">' +
              '<span class="px-2 py-0.5 bg-slate-100 text-slate-700 font-bold text-xs rounded-lg border border-slate-200 shrink-0">' +
                'Choice ' + _esc(c.letter) + ' — Incorrect' +
              '</span>' +
              (isStudentChoice ? '<span class="px-2 py-0.5 bg-rose-100 text-rose-800 font-bold text-xs rounded-lg border border-rose-200 shrink-0">Student Selected ❌</span>' : '') +
            '</div>' +
            '<p class="text-xs sm:text-sm text-slate-600 leading-relaxed font-sans max-w-3xl">' + _esc(c.text) + '</p>' +
          '</div>';
        }
      }).join('');

      bodyHtml = introHtml + '<div class="grid grid-cols-1 gap-2.5 pt-1">' + cardsHtml + '</div>';
    } else {
      // Free response or regular prose paragraphs
      bodyHtml = '<div class="space-y-2.5 text-xs sm:text-sm text-amber-950 leading-relaxed font-sans max-w-3xl">' +
        paragraphs.map(function(p) { return '<p>' + _esc(p) + '</p>'; }).join('') +
      '</div>';
    }

    return '<div class="p-5 sm:p-6 rounded-3xl bg-amber-50/80 border border-amber-200 space-y-3.5">' +
      headerHtml +
      imageHtml +
      bodyHtml +
    '</div>';
  }


  /**
   * Scientific Expression Tokenizer & Parser
   * Deterministic mathematical evaluator supporting:
   * - Operators: +, -, *, /, %, ^ (power)
   * - Unary: +, -
   * - Parentheses: (, )
   * - Functions: sqrt, sin, cos, tan, asin, acos, atan, log (log10), ln (log_e), abs, reciprocal
   * - Constants: pi, e
   * - Memory: ans
   * - Angle Mode: DEG (default) or RAD
   */
  function evaluateScientificExpression(expr, options) {
    options = options || {};
    var angleMode = options.angleMode || 'DEG';
    var ansValue = (typeof options.ans === 'number' && !isNaN(options.ans)) ? options.ans : 0;

    if (!expr || typeof expr !== 'string') {
      return { result: null, error: 'Empty expression' };
    }

    var cleanExpr = expr.trim();
    if (cleanExpr.length > 150) {
      return { result: null, error: 'Input Too Long' };
    }

    // Tokenizer
    var tokens = [];
    var i = 0;
    var len = cleanExpr.length;

    // Normalizations for special symbols
    cleanExpr = cleanExpr
      .replace(/×/g, '*')
      .replace(/÷/g, '/')
      .replace(/−/g, '-')
      .replace(/π/g, 'pi')
      .replace(/√/g, 'sqrt')
      .replace(/sin⁻¹/g, 'asin')
      .replace(/cos⁻¹/g, 'acos')
      .replace(/tan⁻¹/g, 'atan');

    len = cleanExpr.length;

    while (i < len) {
      var ch = cleanExpr[i];

      // Whitespace
      if (/\s/.test(ch)) {
        i++;
        continue;
      }

      // Numbers: digits and decimal point
      if (/\d/.test(ch) || (ch === '.' && i + 1 < len && /\d/.test(cleanExpr[i + 1]))) {
        var numStr = '';
        while (i < len && (/\d/.test(cleanExpr[i]) || cleanExpr[i] === '.')) {
          numStr += cleanExpr[i];
          i++;
        }
        var parsedNum = parseFloat(numStr);
        if (isNaN(parsedNum)) {
          return { result: null, error: 'Invalid Number' };
        }
        tokens.push({ type: 'NUMBER', value: parsedNum });
        continue;
      }

      // Operators and Parentheses
      if ('+-*/%^()'.indexOf(ch) !== -1) {
        tokens.push({ type: 'OP', value: ch });
        i++;
        continue;
      }

      // Words / Identifiers (functions, constants, memory)
      if (/[a-zA-Z]/.test(ch)) {
        var ident = '';
        while (i < len && /[a-zA-Z0-9_]/.test(cleanExpr[i])) {
          ident += cleanExpr[i];
          i++;
        }
        var lowerIdent = ident.toLowerCase();
        if (lowerIdent === 'pi') {
          tokens.push({ type: 'NUMBER', value: Math.PI });
        } else if (lowerIdent === 'e') {
          tokens.push({ type: 'NUMBER', value: Math.E });
        } else if (lowerIdent === 'ans') {
          tokens.push({ type: 'NUMBER', value: ansValue });
        } else if (['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sqrt', 'log', 'ln', 'abs', 'reciprocal'].indexOf(lowerIdent) !== -1) {
          tokens.push({ type: 'FN', value: lowerIdent });
        } else {
          return { result: null, error: 'Unknown function: ' + ident };
        }
        continue;
      }

      return { result: null, error: 'Unexpected character: ' + ch };
    }

    if (tokens.length === 0) {
      return { result: null, error: 'Empty expression' };
    }

    // Parser state
    var pos = 0;
    var evalError = null;

    function peek() {
      return tokens[pos];
    }

    function consume(expected) {
      var tok = tokens[pos];
      if (!tok) {
        evalError = 'Unexpected end of expression';
        return null;
      }
      if (expected && (tok.value !== expected && tok.type !== expected)) {
        evalError = 'Expected ' + expected + ' but got ' + (tok.value || tok.type);
        return null;
      }
      pos++;
      return tok;
    }

    function parseExpr() {
      if (evalError) return 0;
      var left = parseTerm();
      while (!evalError && pos < tokens.length) {
        var tok = peek();
        if (tok && tok.type === 'OP' && (tok.value === '+' || tok.value === '-')) {
          consume();
          var right = parseTerm();
          if (tok.value === '+') left = left + right;
          else left = left - right;
        } else {
          break;
        }
      }
      return left;
    }

    function parseTerm() {
      if (evalError) return 0;
      var left = parsePower();
      while (!evalError && pos < tokens.length) {
        var tok = peek();
        if (tok && tok.type === 'OP' && (tok.value === '*' || tok.value === '/' || tok.value === '%')) {
          consume();
          var right = parsePower();
          if (tok.value === '*') {
            left = left * right;
          } else if (tok.value === '/') {
            if (right === 0) {
              evalError = 'Cannot divide by 0';
              return 0;
            }
            left = left / right;
          } else if (tok.value === '%') {
            if (right === 0) {
              evalError = 'Cannot divide by 0';
              return 0;
            }
            left = left % right;
          }
        } else {
          break;
        }
      }
      return left;
    }

    function parsePower() {
      if (evalError) return 0;
      var left = parseUnary();
      if (!evalError && pos < tokens.length) {
        var tok = peek();
        if (tok && tok.type === 'OP' && tok.value === '^') {
          consume();
          var right = parsePower();
          if (left < 0 && Math.floor(right) !== right) {
            evalError = 'Domain Error';
            return 0;
          }
          left = Math.pow(left, right);
        }
      }
      return left;
    }

    function parseUnary() {
      if (evalError) return 0;
      var tok = peek();
      if (tok && tok.type === 'OP' && (tok.value === '+' || tok.value === '-')) {
        consume();
        var factor = parseUnary();
        return (tok.value === '-') ? -factor : factor;
      }
      return parseFactor();
    }

    function parseFactor() {
      if (evalError) return 0;
      var tok = peek();
      if (!tok) {
        evalError = 'Unexpected end of expression';
        return 0;
      }

      if (tok.type === 'NUMBER') {
        consume();
        return tok.value;
      }

      if (tok.type === 'FN') {
        var fnName = tok.value;
        consume();
        var nextTok = peek();
        var hasParen = (nextTok && nextTok.type === 'OP' && nextTok.value === '(');
        if (hasParen) {
          consume('(');
        }
        var arg = parseExpr();
        if (hasParen) {
          if (!peek() || peek().value !== ')') {
            evalError = 'Unclosed parentheses';
            return 0;
          }
          consume(')');
        }

        if (evalError) return 0;

        if (fnName === 'sqrt') {
          if (arg < 0) {
            evalError = 'Domain Error';
            return 0;
          }
          return Math.sqrt(arg);
        } else if (fnName === 'log') {
          if (arg <= 0) {
            evalError = 'Domain Error';
            return 0;
          }
          return Math.log10(arg);
        } else if (fnName === 'ln') {
          if (arg <= 0) {
            evalError = 'Domain Error';
            return 0;
          }
          return Math.log(arg);
        } else if (fnName === 'abs') {
          return Math.abs(arg);
        } else if (fnName === 'reciprocal') {
          if (arg === 0) {
            evalError = 'Cannot divide by 0';
            return 0;
          }
          return 1 / arg;
        } else if (fnName === 'sin') {
          var rad = (angleMode === 'DEG') ? (arg * Math.PI / 180) : arg;
          var val = Math.sin(rad);
          return (Math.abs(val) < 1e-15) ? 0 : val;
        } else if (fnName === 'cos') {
          if (angleMode === 'DEG' && (Math.abs(arg % 180) === 90 || Math.abs(arg % 360) === 270)) {
            return 0;
          }
          var rad = (angleMode === 'DEG') ? (arg * Math.PI / 180) : arg;
          var val = Math.cos(rad);
          return (Math.abs(val) < 1e-15) ? 0 : val;
        } else if (fnName === 'tan') {
          if (angleMode === 'DEG') {
            var norm = Math.abs(arg) % 180;
            if (norm === 90) {
              evalError = 'Undefined';
              return 0;
            }
          }
          var rad = (angleMode === 'DEG') ? (arg * Math.PI / 180) : arg;
          var val = Math.tan(rad);
          return (Math.abs(val) < 1e-15) ? 0 : val;
        } else if (fnName === 'asin') {
          if (arg < -1 || arg > 1) {
            evalError = 'Domain Error';
            return 0;
          }
          var rad = Math.asin(arg);
          return (angleMode === 'DEG') ? (rad * 180 / Math.PI) : rad;
        } else if (fnName === 'acos') {
          if (arg < -1 || arg > 1) {
            evalError = 'Domain Error';
            return 0;
          }
          var rad = Math.acos(arg);
          return (angleMode === 'DEG') ? (rad * 180 / Math.PI) : rad;
        } else if (fnName === 'atan') {
          var rad = Math.atan(arg);
          return (angleMode === 'DEG') ? (rad * 180 / Math.PI) : rad;
        }

        evalError = 'Unknown function: ' + fnName;
        return 0;
      }

      if (tok.type === 'OP' && tok.value === '(') {
        consume('(');
        var res = parseExpr();
        if (!peek() || peek().value !== ')') {
          evalError = 'Unclosed parentheses';
          return 0;
        }
        consume(')');
        return res;
      }

      evalError = 'Syntax Error';
      return 0;
    }

    var finalResult = parseExpr();

    if (evalError) {
      return { result: null, error: evalError };
    }

    if (pos < tokens.length) {
      return { result: null, error: 'Syntax Error' };
    }

    if (typeof finalResult !== 'number' || isNaN(finalResult) || !isFinite(finalResult)) {
      return { result: null, error: 'Math Error' };
    }

    var rounded = Math.round(finalResult * 1e12) / 1e12;
    return { result: rounded, error: null };
  }


  return {
    parseNumeric: parseNumeric,
    extractAcceptedForms: extractAcceptedForms,
    gradeFreeResponse: gradeFreeResponse,
    formatAcceptedAnswers: formatAcceptedAnswers,
    gradeAttempt: gradeAttempt,
    renderRationale: renderRationale,
    evaluateScientificExpression: evaluateScientificExpression
  };
});
