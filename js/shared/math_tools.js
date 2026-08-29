/**
 * js/shared/math_tools.js — the floating Desmos calculator, the scientific
 * calculator, the formula reference sheet, and the drag behaviour they share.
 *
 * WI-09 duplication ledger — the single largest twin in the app. This entire
 * ~360-line block existed twice, once at the end of index.html's inline script
 * and once at the end of parent.html's. A line-by-line diff of the two copies
 * found only cosmetic differences:
 *   * index.html wrote `setTimeout(() => { desmosCalculatorInstance.resize(); }, 50)`
 *     where parent.html wrote the expression-body form of the same arrow;
 *   * three comment lines differed in wording;
 *   * index.html declared desmosCalculatorInstance/desmosIsExpanded inside the
 *     block, parent.html ~1,350 lines earlier. Both are now module state here.
 * Everything else — every element id, every Tailwind class swap, every
 * keyboard shortcut, the Desmos options object, the sci-calc grammar and its
 * DEG/RAD handling, the drag maths — was byte-identical.
 *
 * Per-function tally (2 sites -> 1 each):
 *   toggleDesmosCalculator, initDesmosCalculator, fallbackDesmosIframe,
 *   toggleDesmosSize, toggleScientificCalculator, toggleScientificAngleMode,
 *   sciCalcInput, sciCalcClear, sciCalcBackspace, sciCalcEvaluate,
 *   updateSciCalcDisplay, toggleReferenceSheet, setFormulaTab, makeDraggable
 *   = 14 functions, 28 sites -> 14.
 *
 * The DOMContentLoaded handler at the bottom (drag wiring, the reference
 * sheet's tablist keyboard navigation, and the Alt+C/G / Alt+S / Alt+R / Esc
 * shortcuts) was also identical on both pages and registers itself on import.
 * `<script type="module">` is deferred, so it still runs before
 * DOMContentLoaded fires — exactly as the inline copies did.
 *
 * Both pages ship the same markup for these tools (#desmos-floating-window,
 * #scientific-calculator-window, #formula-sheet-modal and their handles), and
 * every function here no-ops when its element is absent, so importing this on
 * a page without one of the tools is safe.
 */

// ============================================================
// DESMOS GRAPHING CALCULATOR & MATH REFERENCE SHEET CONTROLLER
// ============================================================
let desmosCalculatorInstance = null;
let desmosIsExpanded = false;

export function toggleDesmosCalculator(forceState) {
  const modal = document.getElementById('desmos-floating-window');
  if (!modal) return;
  const shouldOpen = (typeof forceState === 'boolean') ? forceState : modal.classList.contains('hidden');

  if (shouldOpen) {
    modal.classList.remove('hidden');
    initDesmosCalculator();
  } else {
    modal.classList.add('hidden');
  }
  lucide.createIcons();
}

export function initDesmosCalculator() {
  const container = document.getElementById('desmos-calculator-container');
  if (!container) return;

  if (!desmosCalculatorInstance) {
    if (window.Desmos && typeof window.Desmos.GraphingCalculator === 'function') {
      try {
        desmosCalculatorInstance = window.Desmos.GraphingCalculator(container, {
          keypad: true,
          expressions: true,
          settingsMenu: true,
          zoomButtons: true,
          graphpaper: true,
          border: false,
          degreeMode: true
        });
      } catch (err) {
        console.warn('Desmos API init error, falling back to embedded frame:', err);
        fallbackDesmosIframe(container);
      }
    } else {
      fallbackDesmosIframe(container);
    }
  } else if (typeof desmosCalculatorInstance.resize === 'function') {
    setTimeout(() => desmosCalculatorInstance.resize(), 50);
  }
}

export function fallbackDesmosIframe(container) {
  container.innerHTML = `
    <iframe src="https://www.desmos.com/calculator"
      class="w-full h-full border-0 rounded-b-2xl"
      title="Desmos Graphing Calculator"
      allow="clipboard-write">
    </iframe>
  `;
}

export function toggleDesmosSize() {
  const modal = document.getElementById('desmos-floating-window');
  const icon = document.getElementById('desmos-size-icon');
  if (!modal) return;

  desmosIsExpanded = !desmosIsExpanded;
  if (desmosIsExpanded) {
    modal.classList.remove('sm:w-[580px]', 'md:w-[640px]', 'h-[520px]');
    modal.classList.add('sm:w-[840px]', 'md:w-[940px]', 'h-[640px]');
    if (icon) icon.setAttribute('data-lucide', 'minimize-2');
  } else {
    modal.classList.remove('sm:w-[840px]', 'md:w-[940px]', 'h-[640px]');
    modal.classList.add('sm:w-[580px]', 'md:w-[640px]', 'h-[520px]');
    if (icon) icon.setAttribute('data-lucide', 'maximize-2');
  }

  if (desmosCalculatorInstance && typeof desmosCalculatorInstance.resize === 'function') {
    setTimeout(() => desmosCalculatorInstance.resize(), 100);
  }
  lucide.createIcons();
}

// SCIENTIFIC CALCULATOR STATE & CONTROLLER
// =======================================
let sciCalcState = {
  expression: '',
  result: 0,
  ans: 0,
  angleMode: 'DEG',
  hasEvaluated: false
};

export function toggleScientificCalculator(forceState) {
  const modal = document.getElementById('scientific-calculator-window');
  if (!modal) return;
  const shouldOpen = (typeof forceState === 'boolean') ? forceState : modal.classList.contains('hidden');

  if (shouldOpen) {
    modal.classList.remove('hidden');
    updateSciCalcDisplay();
  } else {
    modal.classList.add('hidden');
  }
  lucide.createIcons();
}

export function toggleScientificAngleMode() {
  sciCalcState.angleMode = (sciCalcState.angleMode === 'DEG') ? 'RAD' : 'DEG';
  const btn = document.getElementById('btn-sci-angle-mode');
  const badge = document.getElementById('sci-mode-badge');
  if (btn) btn.innerText = sciCalcState.angleMode;
  if (badge) badge.innerText = sciCalcState.angleMode;
  if (sciCalcState.expression) {
    sciCalcEvaluate();
  }
}

export function sciCalcInput(str) {
  if (sciCalcState.hasEvaluated && /[0-9.]/.test(str)) {
    sciCalcState.expression = '';
  }
  sciCalcState.hasEvaluated = false;
  sciCalcState.expression += str;
  updateSciCalcDisplay();
}

export function sciCalcClear() {
  sciCalcState.expression = '';
  sciCalcState.result = 0;
  sciCalcState.hasEvaluated = false;
  updateSciCalcDisplay();
}

export function sciCalcBackspace() {
  if (sciCalcState.expression.length > 0) {
    sciCalcState.expression = sciCalcState.expression.slice(0, -1);
  }
  updateSciCalcDisplay();
}

export function sciCalcEvaluate() {
  if (!sciCalcState.expression) return;
  const res = (typeof PSAT_ENGINE !== 'undefined' && PSAT_ENGINE.evaluateScientificExpression) ?
    PSAT_ENGINE.evaluateScientificExpression(sciCalcState.expression, {
      angleMode: sciCalcState.angleMode,
      ans: sciCalcState.ans
    }) :
    { result: null, error: 'Engine unavailable' };

  const resultEl = document.getElementById('sci-calc-result');
  if (res.error) {
    if (resultEl) {
      resultEl.innerText = res.error;
      resultEl.className = 'font-mono text-base font-bold text-rose-400 overflow-x-auto whitespace-nowrap min-h-[32px]';
    }
  } else {
    sciCalcState.result = res.result;
    sciCalcState.ans = res.result;
    sciCalcState.hasEvaluated = true;
    if (resultEl) {
      resultEl.innerText = String(res.result);
      resultEl.className = 'font-mono text-2xl font-black text-white overflow-x-auto whitespace-nowrap min-h-[32px] tracking-tight';
    }
  }
}

export function updateSciCalcDisplay() {
  const exprEl = document.getElementById('sci-calc-expr');
  const resultEl = document.getElementById('sci-calc-result');
  if (exprEl) {
    exprEl.innerText = sciCalcState.expression || '';
  }
  if (resultEl && !sciCalcState.hasEvaluated) {
    resultEl.innerText = sciCalcState.result !== undefined ? String(sciCalcState.result) : '0';
    resultEl.className = 'font-mono text-2xl font-black text-white overflow-x-auto whitespace-nowrap min-h-[32px] tracking-tight';
  }
}

export function toggleReferenceSheet(forceState) {
  const modal = document.getElementById('formula-sheet-modal');
  if (!modal) return;
  const shouldOpen = (typeof forceState === 'boolean') ? forceState : modal.classList.contains('hidden');

  if (shouldOpen) {
    modal.classList.remove('hidden');
  } else {
    modal.classList.add('hidden');
  }
  lucide.createIcons();
}

export function setFormulaTab(tab) {
  const btnOfficial = document.getElementById('btn-tab-ref-official');
  const btnAdvanced = document.getElementById('btn-tab-ref-advanced');
  const paneOfficial = document.getElementById('tab-content-ref-official');
  const paneAdvanced = document.getElementById('tab-content-ref-advanced');
  if (!btnOfficial || !btnAdvanced || !paneOfficial || !paneAdvanced) return;

  if (tab === 'official') {
    btnOfficial.className = 'btn btn-sm btn-primary is-active';
    btnAdvanced.className = 'btn btn-sm btn-ghost text-slate-300';
    btnOfficial.setAttribute('aria-selected', 'true');
    btnAdvanced.setAttribute('aria-selected', 'false');
    btnOfficial.tabIndex = 0;
    btnAdvanced.tabIndex = -1;
    paneOfficial.classList.remove('hidden');
    paneAdvanced.classList.add('hidden');
  } else {
    btnAdvanced.className = 'btn btn-sm btn-primary is-active';
    btnOfficial.className = 'btn btn-sm btn-ghost text-slate-300';
    btnOfficial.setAttribute('aria-selected', 'false');
    btnAdvanced.setAttribute('aria-selected', 'true');
    btnOfficial.tabIndex = -1;
    btnAdvanced.tabIndex = 0;
    paneAdvanced.classList.remove('hidden');
    paneOfficial.classList.add('hidden');
  }
}

export function makeDraggable(element, handle) {
  if (!element || !handle) return;
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  handle.onmousedown = dragMouseDown;
  handle.ontouchstart = dragTouchStart;

  function dragMouseDown(e) {
    if (e.target.tagName === 'BUTTON' || e.target.closest('button') || e.target.tagName === 'INPUT') return;
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }

  function elementDrag(e) {
    e.preventDefault();
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    const newTop = Math.max(10, Math.min(window.innerHeight - 80, element.offsetTop - pos2));
    const newLeft = Math.max(10, Math.min(window.innerWidth - 100, element.offsetLeft - pos1));
    element.style.top = newTop + 'px';
    element.style.left = newLeft + 'px';
    element.style.bottom = 'auto';
    element.style.right = 'auto';
  }

  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
  }

  function dragTouchStart(e) {
    if (e.target.tagName === 'BUTTON' || e.target.closest('button') || e.target.tagName === 'INPUT') return;
    const touch = e.touches[0];
    pos3 = touch.clientX;
    pos4 = touch.clientY;
    document.ontouchend = closeDragTouch;
    document.ontouchmove = elementTouchDrag;
  }

  function elementTouchDrag(e) {
    const touch = e.touches[0];
    pos1 = pos3 - touch.clientX;
    pos2 = pos4 - touch.clientY;
    pos3 = touch.clientX;
    pos4 = touch.clientY;
    const newTop = Math.max(10, Math.min(window.innerHeight - 80, element.offsetTop - pos2));
    const newLeft = Math.max(10, Math.min(window.innerWidth - 100, element.offsetLeft - pos1));
    element.style.top = newTop + 'px';
    element.style.left = newLeft + 'px';
    element.style.bottom = 'auto';
    element.style.right = 'auto';
  }

  function closeDragTouch() {
    document.ontouchend = null;
    document.ontouchmove = null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const desmosWin = document.getElementById('desmos-floating-window');
  const desmosHandle = document.getElementById('desmos-drag-handle');
  if (desmosWin && desmosHandle) makeDraggable(desmosWin, desmosHandle);

  const sciWin = document.getElementById('scientific-calculator-window');
  const sciHandle = document.getElementById('scientific-drag-handle');
  if (sciWin && sciHandle) {
    makeDraggable(sciWin, sciHandle);
    sciWin.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key >= '0' && e.key <= '9') {
        sciCalcInput(e.key);
      } else if (e.key === '.' || e.key === '+' || e.key === '-' || e.key === '*' || e.key === '/' || e.key === '(' || e.key === ')' || e.key === '^' || e.key === '%') {
        sciCalcInput(e.key);
      } else if (e.key === 'Enter' || e.key === '=') {
        e.preventDefault();
        sciCalcEvaluate();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        sciCalcBackspace();
      } else if (e.key === 'c' || e.key === 'C') {
        sciCalcClear();
      }
    });
  }

  const refWin = document.getElementById('formula-sheet-modal');
  const refHandle = document.getElementById('formula-drag-handle');
  if (refWin && refHandle) makeDraggable(refWin, refHandle);

  // Reference tab keyboard navigation
  const tablist = document.querySelector('#formula-sheet-modal [role="tablist"]');
  if (tablist) {
    tablist.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const isOfficialActive = document.getElementById('btn-tab-ref-official').getAttribute('aria-selected') === 'true';
        if (isOfficialActive) {
          setFormulaTab('advanced');
          const adv = document.getElementById('btn-tab-ref-advanced');
          if (adv) adv.focus();
        } else {
          setFormulaTab('official');
          const off = document.getElementById('btn-tab-ref-official');
          if (off) off.focus();
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        setFormulaTab('official');
        const off = document.getElementById('btn-tab-ref-official');
        if (off) off.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        setFormulaTab('advanced');
        const adv = document.getElementById('btn-tab-ref-advanced');
        if (adv) adv.focus();
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'c' || e.key === 'C' || e.key === 'g' || e.key === 'G')) {
      e.preventDefault();
      toggleDesmosCalculator();
    } else if (e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      toggleScientificCalculator();
    } else if (e.altKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      toggleReferenceSheet();
    } else if (e.key === 'Escape') {
      const d = document.getElementById('desmos-floating-window');
      const s = document.getElementById('scientific-calculator-window');
      const r = document.getElementById('formula-sheet-modal');
      if (d && !d.classList.contains('hidden')) d.classList.add('hidden');
      if (s && !s.classList.contains('hidden')) s.classList.add('hidden');
      if (r && !r.classList.contains('hidden')) r.classList.add('hidden');
    }
  });
});
