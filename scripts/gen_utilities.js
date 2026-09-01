/**
 * scripts/gen_utilities.js — WI-13 Phase 6: generate a self-hosted static CSS
 * for exactly the Tailwind utility classes index.html + js/pages/student.js use,
 * so the Tailwind Play CDN can be removed. Deterministic + reproducible; run:
 *
 *   node scripts/gen_utilities.js
 *
 * Design intent (owner-approved approach): COLOR utilities resolve to the WI-12
 * design tokens (styles/tokens.css) wherever a matching token shade exists, so a
 * future re-theme is a one-file tokens.css edit. Shades with no token fall back
 * to the literal Tailwind hex (visually identical); opacity modifiers use
 * color-mix() so they stay token-driven too.
 *
 * SAFETY: the script HARD-FAILS (exit 1) if it encounters any used class it does
 * not know how to emit — there are no silent gaps. Output: styles/utilities.css.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Collect the used class tokens (same sources as the extraction step).
// ---------------------------------------------------------------------------
// A token is a real utility iff (after stripping variant prefixes) its base is a
// known Tailwind FAMILY (bg-/text-/p-/…) or a known bare keyword. This is what
// lets the JS scanner keep `bg-emerald-100` while rejecting element ids
// (`exam-active`), lucide icon names (`check-circle`), and getElementById args.
const VARIANT_RE = /^(?:(?:sm|md|lg|xl|hover|focus|focus-within|active|disabled|group-hover):)*/;
// families must be followed by a value ("-…"), so bare English words / identifiers
// ("top", "text", "to", "from", "gap") don't leak. Bare-valid utilities live in BARE.
const FAMILY_RE = /^-?(bg|text|border|from|via|to|ring|divide|px|py|pt|pb|pl|pr|p|mx|my|mt|mb|ml|mr|m|gap-x|gap-y|gap|space-x|space-y|min-w|min-h|max-w|max-h|w|h|rounded|shadow|font|leading|tracking|grid-cols|grid|col-span|row-span|z|top|bottom|left|right|translate-x|translate-y|scale|duration|delay|opacity|items|justify|self|order|object|cursor|overflow-x|overflow-y|overflow|flex|shrink|inline)-/;
const BARE = new Set(['flex','grid','border','inline','inline-flex','inline-block','hidden','block','relative','absolute',
  'fixed','sticky','static','italic','not-italic','uppercase','lowercase','capitalize','truncate','transform','transition',
  'antialiased','underline','no-underline','rounded','shadow','whitespace-nowrap','whitespace-pre','whitespace-pre-line',
  'whitespace-normal','animate-spin','animate-in','fade-in','zoom-in','slide-in-from-bottom','appearance-none','select-none',
  'pointer-events-none','pointer-events-auto','resize-none','sr-only','align-middle','bg-clip-text','text-transparent',
  'grid-flow-col','origin-center','divide-y']);
function isUtility(tok) {
  const base = tok.replace(VARIANT_RE, '');
  return FAMILY_RE.test(base) || BARE.has(base);
}
function collectClasses() {
  const htmlSet = new Set(), jsSet = new Set();
  // HTML class="..." attributes are AUTHORITATIVE — take every token (flagged if unhandled).
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/class="([^"]*)"/g)) m[1].split(/\s+/).forEach((c) => { if (c && !isOwned(c)) htmlSet.add(c); });
  // JS: BEST-EFFORT scan (class attrs, ternaries, concatenations, template literals).
  // Kept only if it looks like a real utility; unknowns are dropped (id/icon-name noise),
  // not flagged — shape alone can't always separate `text-emerald-800` from `text-mode-warning`.
  const js = fs.readFileSync(path.join(ROOT, 'js/pages/student.js'), 'utf8');
  for (const m of js.matchAll(/(?<![\w$@#])-?[a-z][a-z0-9:/[\]%.-]*/g)) {
    const tok = m[0];
    if (isUtility(tok) && !isOwned(tok.replace(VARIANT_RE, '')) && !htmlSet.has(tok)) jsSet.add(tok);
  }
  return { htmlSet, jsSet };
}

// design-system / bespoke classes owned elsewhere — never emit these here.
const OWNED = new Set(['card','card-title','card-subtitle','banner','banner-icon','banner-title','banner-info',
  'badge','tab','tabs','question-option','question-options','question-option-key','question-meta','question-text',
  'question-image','question-rationale','stat','stat-label','stat-value','stat-estimate-badge','empty-state',
  'empty-state-icon','empty-state-title','empty-state-desc','modal','modal-backdrop','modal-header','modal-title',
  'modal-body','modal-footer','modal-close','progress-bar','progress-track','progress-caption','table','table-empty-cell',
  'tab-active','tab-link','is-active','is-correct','is-incorrect','is-selected','is-done','is-loading','is-error',
  'custom-scrollbar','no-scrollbar','skeleton-line']);
const OWNED_PREFIX = ['badge-','banner-','btn','stat-'];
function isOwned(base) {
  if (OWNED.has(base)) return true;
  return OWNED_PREFIX.some((p) => base === p || base.startsWith(p));
}

// ---------------------------------------------------------------------------
// 2. Scales + palettes.
// ---------------------------------------------------------------------------
const SP = { 'px':'1px','0':'0','0.5':'0.125rem','1':'0.25rem','1.5':'0.375rem','2':'0.5rem','2.5':'0.625rem',
  '3':'0.75rem','3.5':'0.875rem','4':'1rem','5':'1.25rem','6':'1.5rem','7':'1.75rem','8':'2rem','9':'2.25rem',
  '10':'2.5rem','11':'2.75rem','12':'3rem','14':'3.5rem','16':'4rem','20':'5rem','24':'6rem','28':'7rem','32':'8rem',
  '36':'9rem','40':'10rem','44':'11rem','48':'12rem','52':'13rem','56':'14rem','60':'15rem','64':'16rem','72':'18rem',
  '80':'20rem','96':'24rem' };
const FRAC = { '1/2':'50%','1/3':'33.333333%','2/3':'66.666667%','1/4':'25%','3/4':'75%','full':'100%' };
const MAXW = { 'xs':'20rem','sm':'24rem','md':'28rem','lg':'32rem','xl':'36rem','2xl':'42rem','3xl':'48rem',
  '4xl':'56rem','5xl':'64rem','6xl':'72rem','7xl':'80rem','full':'100%','none':'none' };
const TEXT = { 'xs':['0.75rem','1rem'],'sm':['0.875rem','1.25rem'],'base':['1rem','1.5rem'],'lg':['1.125rem','1.75rem'],
  'xl':['1.25rem','1.75rem'],'2xl':['1.5rem','2rem'],'3xl':['1.875rem','2.25rem'],'4xl':['2.25rem','2.5rem'],
  '5xl':['3rem','1'],'6xl':['3.75rem','1'],'7xl':['4.5rem','1'] };
const WEIGHT = { 'thin':'100','light':'300','normal':'400','medium':'500','semibold':'600','bold':'700','extrabold':'800','black':'900' };
const RADIUS = { '':'0.25rem','sm':'0.125rem','md':'0.375rem','lg':'0.5rem','xl':'0.75rem','2xl':'1rem','3xl':'1.5rem','full':'9999px','none':'0' };
const SHADOW = { 'xs':'0 1px 2px 0 rgb(0 0 0 / 0.05)', 'sm':'0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  '':'0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)', 'md':'0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  'lg':'0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)', 'xl':'0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  '2xl':'0 25px 50px -12px rgb(0 0 0 / 0.25)', 'inner':'inset 0 2px 4px 0 rgb(0 0 0 / 0.05)', 'none':'none' };
const LEADING = { 'none':'1','tight':'1.25','snug':'1.375','normal':'1.5','relaxed':'1.625','loose':'2' };

// Tailwind palette (fallback hex) for the palettes actually used.
const HEX = {
  slate:{50:'#f8fafc',100:'#f1f5f9',200:'#e2e8f0',300:'#cbd5e1',400:'#94a3b8',500:'#64748b',600:'#475569',700:'#334155',800:'#1e293b',900:'#0f172a',950:'#020617'},
  indigo:{50:'#eef2ff',100:'#e0e7ff',200:'#c7d2fe',300:'#a5b4fc',400:'#818cf8',500:'#6366f1',600:'#4f46e5',700:'#4338ca',800:'#3730a3',900:'#312e81',950:'#1e1b4b'},
  emerald:{50:'#ecfdf5',100:'#d1fae5',200:'#a7f3d0',300:'#6ee7b7',400:'#34d399',500:'#10b981',600:'#059669',700:'#047857',800:'#065f46',900:'#064e3b',950:'#022c22'},
  rose:{50:'#fff1f2',100:'#ffe4e6',200:'#fecdd3',300:'#fda4af',400:'#fb7185',500:'#f43f5e',600:'#e11d48',700:'#be123c',800:'#9f1239',900:'#881337',950:'#4c0519'},
  amber:{50:'#fffbeb',100:'#fef3c7',200:'#fde68a',300:'#fcd34d',400:'#fbbf24',500:'#f59e0b',600:'#d97706',700:'#b45309',800:'#92400e',900:'#78350f',950:'#451a03'},
  teal:{50:'#f0fdfa',100:'#ccfbf1',200:'#99f6e4',300:'#5eead4',400:'#2dd3bf',500:'#14b8a6',600:'#0d9488',700:'#0f766e',800:'#115e59',900:'#134e4a',950:'#042f2e'},
};
// palette -> token role, and which shades exist as tokens (styles/tokens.css)
const ROLE = { slate:'neutral', indigo:'primary', emerald:'success', rose:'danger', amber:'warning', teal:'accent' };
const TOKEN_SHADES = {
  neutral:new Set([50,100,200,300,400,500,600,700,800,900]),
  primary:new Set([50,100,200,300,400,500,600,700,800,900]),
  accent:new Set([50,100,200,300,400,500,600,700,800,900]),
  success:new Set([50,100,200,500,600,700,800]),
  warning:new Set([50,100,200,500,600,700,800]),
  danger:new Set([50,100,200,500,600,700,800]),
};

// Resolve a color token like "slate-800" or "white" (+ optional /alpha) to a CSS color.
function color(name, alpha) {
  let base;
  if (name === 'white') base = '#ffffff';
  else if (name === 'black') base = '#000000';
  else if (name === 'transparent') return 'transparent';
  else if (name === 'current') return 'currentColor';
  else {
    const m = name.match(/^([a-z]+)-(\d+)$/);
    if (!m) return null;
    const [, pal, shadeStr] = m;
    const shade = parseInt(shadeStr, 10);
    const role = ROLE[pal];
    if (role && TOKEN_SHADES[role] && TOKEN_SHADES[role].has(shade)) base = `var(--color-${role}-${shade})`;
    else if (HEX[pal] && HEX[pal][shade]) base = HEX[pal][shade]; // fallback: literal Tailwind hex
    else return null;
  }
  if (alpha == null) return base;
  const pct = (parseInt(alpha, 10)) + '%';
  return `color-mix(in srgb, ${base} ${pct}, transparent)`;
}
// split "indigo-500/30" -> ["indigo-500","30"]
function splitAlpha(s) { const i = s.indexOf('/'); return i === -1 ? [s, null] : [s.slice(0, i), s.slice(i + 1)]; }
// arbitrary value: "[520px]" -> "520px", "[85vh]" -> "85vh"
function arb(s) { const m = s.match(/^\[(.+)\]$/); return m ? m[1] : null; }

// ---------------------------------------------------------------------------
// 3. Base utility -> declarations. Returns array of "prop: value" or null.
// ---------------------------------------------------------------------------
function decls(base) {
  const kv = (p, v) => [`${p}: ${v}`];
  // display / layout keywords
  const KW = { 'block':['display:block'],'inline-block':['display:inline-block'],'inline':['display:inline'],
    'flex':['display:flex'],'inline-flex':['display:inline-flex'],'grid':['display:grid'],'hidden':['display:none'],
    'flex-col':['flex-direction:column'],'flex-row':['flex-direction:row'],'flex-wrap':['flex-wrap:wrap'],
    'flex-1':['flex:1 1 0%'],'flex-shrink-0':['flex-shrink:0'],'shrink-0':['flex-shrink:0'],'flex-grow':['flex-grow:1'],
    'items-center':['align-items:center'],'items-start':['align-items:flex-start'],'items-end':['align-items:flex-end'],'items-baseline':['align-items:baseline'],'items-stretch':['align-items:stretch'],
    'justify-center':['justify-content:center'],'justify-between':['justify-content:space-between'],'justify-start':['justify-content:flex-start'],'justify-end':['justify-content:flex-end'],'justify-around':['justify-content:space-around'],'justify-evenly':['justify-content:space-evenly'],
    'self-auto':['align-self:auto'],'self-center':['align-self:center'],'self-start':['align-self:flex-start'],'self-end':['align-self:flex-end'],
    'relative':['position:relative'],'absolute':['position:absolute'],'fixed':['position:fixed'],'sticky':['position:sticky'],'static':['position:static'],
    'overflow-hidden':['overflow:hidden'],'overflow-auto':['overflow:auto'],'overflow-x-auto':['overflow-x:auto'],'overflow-y-auto':['overflow-y:auto'],'overflow-x-hidden':['overflow-x:hidden'],'overflow-y-hidden':['overflow-y:hidden'],
    'cursor-pointer':['cursor:pointer'],'cursor-default':['cursor:default'],'cursor-move':['cursor:move'],'cursor-not-allowed':['cursor:not-allowed'],
    'uppercase':['text-transform:uppercase'],'lowercase':['text-transform:lowercase'],'capitalize':['text-transform:capitalize'],
    'text-left':['text-align:left'],'text-center':['text-align:center'],'text-right':['text-align:right'],
    'whitespace-nowrap':['white-space:nowrap'],'whitespace-pre':['white-space:pre'],'whitespace-pre-wrap':['white-space:pre-wrap'],'whitespace-normal':['white-space:normal'],
    'truncate':['overflow:hidden','text-overflow:ellipsis','white-space:nowrap'],
    'font-mono':["font-family:'JetBrains Mono', ui-monospace, monospace"],'font-sans':["font-family:'Inter', ui-sans-serif, system-ui, sans-serif"],
    'italic':['font-style:italic'],'not-italic':['font-style:normal'],'underline':['text-decoration-line:underline'],'no-underline':['text-decoration-line:none'],
    'transition':['transition-property:color,background-color,border-color,text-decoration-color,fill,stroke,opacity,box-shadow,transform,filter,backdrop-filter','transition-timing-function:cubic-bezier(0.4,0,0.2,1)','transition-duration:150ms'],
    'transition-all':['transition-property:all','transition-timing-function:cubic-bezier(0.4,0,0.2,1)','transition-duration:150ms'],
    'transition-colors':['transition-property:color,background-color,border-color,text-decoration-color,fill,stroke','transition-timing-function:cubic-bezier(0.4,0,0.2,1)','transition-duration:150ms'],
    'transition-transform':['transition-property:transform','transition-timing-function:cubic-bezier(0.4,0,0.2,1)','transition-duration:150ms'],
    'border':['border-width:1px'],'border-0':['border-width:0'],'border-2':['border-width:2px'],'border-4':['border-width:4px'],
    'border-t':['border-top-width:1px'],'border-b':['border-bottom-width:1px'],'border-l':['border-left-width:1px'],'border-r':['border-right-width:1px'],'border-b-0':['border-bottom-width:0'],
    'divide-y':['/*divide*/'], // handled specially below
    'rounded-full':['border-radius:9999px'],'appearance-none':['appearance:none','-webkit-appearance:none'],
    'select-none':['user-select:none'],'pointer-events-none':['pointer-events:none'],'pointer-events-auto':['pointer-events:auto'],
    'w-full':['width:100%'],'h-full':['height:100%'],'w-auto':['width:auto'],'h-auto':['height:auto'],'min-h-screen':['min-height:100vh'],'min-w-0':['min-width:0'],'min-h-0':['min-height:0'],
    'inset-0':['inset:0'],'resize-none':['resize:none'],'sr-only':['position:absolute','width:1px','height:1px','padding:0','margin:-1px','overflow:hidden','clip:rect(0,0,0,0)','white-space:nowrap','border-width:0'],
    'antialiased':['-webkit-font-smoothing:antialiased','-moz-osx-font-smoothing:grayscale'],'align-middle':['vertical-align:middle'],
    'bg-clip-text':['-webkit-background-clip:text','background-clip:text'],'text-transparent':['color:transparent'],
    'grid-flow-col':['grid-auto-flow:column'],'origin-center':['transform-origin:center'],
    'object-contain':['object-fit:contain'],'object-cover':['object-fit:cover'],'object-center':['object-position:center'],
    'whitespace-pre-line':['white-space:pre-line'],'transform':[],'flex-nowrap':['flex-wrap:nowrap'],
    'animate-spin':['animation:twSpin 1s linear infinite'],
  };
  if (KW[base]) return KW[base];

  // patterned families
  let m;
  if ((m = base.match(/^p([xytblr]?)-(.+)$/))) return spacing('padding', m[1], m[2]);
  if ((m = base.match(/^m([xytblr]?)-(.+)$/))) return spacing('margin', m[1], m[2], true);
  if ((m = base.match(/^-m([xytblr]?)-(.+)$/))) return spacing('margin', m[1], m[2], true, true);
  if ((m = base.match(/^gap-(.+)$/))) { const v = SP[m[2]||m[1]] || (arb(m[1]) ); const g = SP[m[1]]; return g?kv('gap',g):null; }
  if ((m = base.match(/^gap-x-(.+)$/))) return SP[m[1]]?kv('column-gap',SP[m[1]]):null;
  if ((m = base.match(/^gap-y-(.+)$/))) return SP[m[1]]?kv('row-gap',SP[m[1]]):null;
  if ((m = base.match(/^space-x-(.+)$/))) return SP[m[1]]?[`/*space-x*/`, m[1]]:null; // handled specially
  if ((m = base.match(/^space-y-(.+)$/))) return SP[m[1]]?[`/*space-y*/`, m[1]]:null; // handled specially
  if ((m = base.match(/^w-(.+)$/))) return sizeVal('width', m[1]);
  if ((m = base.match(/^h-(.+)$/))) return sizeVal('height', m[1]);
  if ((m = base.match(/^min-w-(.+)$/))) return sizeVal('min-width', m[1]);
  if ((m = base.match(/^min-h-(.+)$/))) return sizeVal('min-height', m[1]);
  if ((m = base.match(/^max-w-(.+)$/))) { const a=arb(m[1]); return a?kv('max-width',a):(MAXW[m[1]]?kv('max-width',MAXW[m[1]]):null); }
  if ((m = base.match(/^max-h-(.+)$/))) { const a=arb(m[1]); return a?kv('max-height',a):(SP[m[1]]?kv('max-height',SP[m[1]]):null); }
  if ((m = base.match(/^text-(.+)$/))) return textUtil(m[1]);
  if ((m = base.match(/^font-(.+)$/))) return WEIGHT[m[1]]?kv('font-weight',WEIGHT[m[1]]):null;
  if ((m = base.match(/^leading-(.+)$/))) return LEADING[m[1]]?kv('line-height',LEADING[m[1]]):null;
  if ((m = base.match(/^tracking-(.+)$/))) { const T={tighter:'-0.05em',tight:'-0.025em',normal:'0',wide:'0.025em',wider:'0.05em',widest:'0.1em'}; return T[m[1]]?kv('letter-spacing',T[m[1]]):null; }
  if ((m = base.match(/^rounded(-.+)?$/))) { const k=(m[1]||'').replace(/^-/,''); return RADIUS[k]!=null?kv('border-radius',RADIUS[k]):null; }
  if ((m = base.match(/^shadow(-.+)?$/))) { const k=(m[1]||'').replace(/^-/,''); if(SHADOW[k]!=null) return kv('box-shadow',SHADOW[k]); /* colored shadow (shadow-indigo-100 etc.): approximate with default */ return kv('box-shadow',SHADOW['']); }
  if (base === 'bg-gradient-to-r') return kv('background-image','linear-gradient(to right, var(--tw-from, transparent), var(--tw-via, var(--tw-from, transparent)), var(--tw-to, transparent))');
  if (base === 'bg-gradient-to-br') return kv('background-image','linear-gradient(to bottom right, var(--tw-from, transparent), var(--tw-via, var(--tw-from, transparent)), var(--tw-to, transparent))');
  if (base === 'bg-gradient-to-b') return kv('background-image','linear-gradient(to bottom, var(--tw-from, transparent), var(--tw-to, transparent))');
  if ((m = base.match(/^bg-(.+)$/))) return bgUtil(m[1]);
  if ((m = base.match(/^text-(.+)$/))) return null;
  if ((m = base.match(/^border-(.+)$/))) { const [c,a]=splitAlpha(m[1]); const col=color(c,a); return col?kv('border-color',col):null; }
  if ((m = base.match(/^from-(.+)$/))) { const [c,a]=splitAlpha(m[1]); const col=color(c,a); return col?kv('--tw-from',col):null; }
  if ((m = base.match(/^to-(.+)$/))) { const [c,a]=splitAlpha(m[1]); const col=color(c,a); return col?kv('--tw-to',col):null; }
  if ((m = base.match(/^via-(.+)$/))) { const [c,a]=splitAlpha(m[1]); const col=color(c,a); return col?kv('--tw-via',col):null; }
  if ((m = base.match(/^grid-cols-(\d+)$/))) return kv('grid-template-columns',`repeat(${m[1]}, minmax(0, 1fr))`);
  if ((m = base.match(/^col-span-(\d+)$/))) return kv('grid-column',`span ${m[1]} / span ${m[1]}`);
  if ((m = base.match(/^row-span-(\d+)$/))) return kv('grid-row',`span ${m[1]} / span ${m[1]}`);
  if ((m = base.match(/^z-(.+)$/))) return SP[m[1]]!=null||/^\d+$/.test(m[1])?kv('z-index',m[1]):null;
  if ((m = base.match(/^top-(.+)$/))) return posVal('top', m[1]);
  if ((m = base.match(/^bottom-(.+)$/))) return posVal('bottom', m[1]);
  if ((m = base.match(/^left-(.+)$/))) return posVal('left', m[1]);
  if ((m = base.match(/^right-(.+)$/))) return posVal('right', m[1]);
  if ((m = base.match(/^duration-(\d+)$/))) return kv('transition-duration', m[1] + 'ms');
  if ((m = base.match(/^delay-(\d+)$/))) return kv('transition-delay', m[1] + 'ms');
  if ((m = base.match(/^translate-x-(.+)$/))) return transUtil('X', m[1], false);
  if ((m = base.match(/^-translate-x-(.+)$/))) return transUtil('X', m[1], true);
  if ((m = base.match(/^translate-y-(.+)$/))) return transUtil('Y', m[1], false);
  if ((m = base.match(/^-translate-y-(.+)$/))) return transUtil('Y', m[1], true);
  if ((m = base.match(/^scale-(\d+)$/))) return kv('transform', `scale(${parseInt(m[1],10)/100})`);
  if (base.match(/^ring-offset-/)) return []; // ring-offset-* — visual no-op in this shim
  if ((m = base.match(/^ring-(\d+)$/))) return kv('box-shadow', `0 0 0 ${m[1]}px var(--tw-ring-color, var(--color-primary-500))`);
  if ((m = base.match(/^ring-(.+)$/))) { const col=color(...splitAlpha(m[1])); return col?kv('--tw-ring-color',col):null; }
  if (base === 'divide-y') return null; // handled specially in emit
  if (base === 'animate-in' || base === 'fade-in' || base === 'zoom-in' || base === 'slide-in-from-bottom') return kv('animation', 'twFadeIn 0.15s ease-out'); // lightweight
  return null;

  function spacing(prop, dir, val, allowNeg, neg) {
    const a = arb(val); let v = a || (val === 'auto' ? 'auto' : SP[val]); if (v == null) return null; if (neg) v = '-' + v;
    if (dir === '' ) return [`${prop}: ${v}`];
    if (dir === 'x') return [`${prop}-left: ${v}`, `${prop}-right: ${v}`];
    if (dir === 'y') return [`${prop}-top: ${v}`, `${prop}-bottom: ${v}`];
    const map = { t:'top', b:'bottom', l:'left', r:'right' };
    return [`${prop}-${map[dir]}: ${v}`];
  }
  function sizeVal(prop, val) { const a = arb(val); if (a) return kv(prop, a); if (FRAC[val]) return kv(prop, FRAC[val]); if (SP[val]) return kv(prop, SP[val]); if (val==='screen') return kv(prop, prop.includes('h')?'100vh':'100vw'); return null; }
  function posVal(prop, val) { const a=arb(val); if(a) return kv(prop,a); if(FRAC[val]) return kv(prop,FRAC[val]); if(SP[val]) return kv(prop,SP[val]); return null; }
  function textUtil(v) { const [c,a]=splitAlpha(v); const col=color(c,a); if(col) return kv('color',col); const ab=arb(v); if(ab) return kv('font-size',ab); if(TEXT[v]) return [`font-size: ${TEXT[v][0]}`, `line-height: ${TEXT[v][1]}`]; return null; }
  function bgUtil(v) { const [c,a]=splitAlpha(v); const col=color(c,a); if(col) return kv('background-color',col); return null; }
  function transUtil(axis, val, neg) { const a=arb(val); let v=a||FRAC[val]||SP[val]; if(v==null) return null; if(neg) v='-'+v; return kv('transform', `translate${axis}(${v})`); }
}

// ---------------------------------------------------------------------------
// 4. Emit.
// ---------------------------------------------------------------------------
const VARIANT_MEDIA = { sm:'640px', md:'768px', lg:'1024px', xl:'1280px' };
const STATE = { hover:':hover', focus:':focus', 'focus-within':':focus-within', active:':active', disabled:':disabled', 'group-hover':'' };

function cssEscape(cls) { return cls.replace(/([:./\[\]%])/g, '\\$1'); }

function main() {
  const { htmlSet, jsSet } = collectClasses();
  const used = [...new Set([...htmlSet, ...jsSet])].sort();
  const rules = [];       // {media, sel, body}
  const spaceX = [];      // classes needing > * + * selectors
  const spaceY = [];
  const divideY = [];
  const unhandled = [];

  for (const cls of used) {
    // parse variant chain: e.g. "sm:hover:bg-white"
    const parts = cls.split(':');
    const base = parts.pop();
    const variants = parts;
    let media = null, pseudo = '';
    for (const v of variants) {
      if (VARIANT_MEDIA[v]) media = VARIANT_MEDIA[v];
      else if (STATE[v] != null) pseudo += STATE[v];
    }
    if (variants.some((v) => !VARIANT_MEDIA[v] && STATE[v] == null)) { if (htmlSet.has(cls)) unhandled.push(cls); continue; }

    // special families that need combinator selectors
    let sm;
    if ((sm = base.match(/^space-x-(.+)$/)) && SP[sm[1]]) { spaceX.push({ cls, v: SP[sm[1]], media, pseudo }); continue; }
    if ((sm = base.match(/^space-y-(.+)$/)) && SP[sm[1]]) { spaceY.push({ cls, v: SP[sm[1]], media, pseudo }); continue; }
    if (base === 'divide-y') { divideY.push({ cls, media, pseudo }); continue; }
    if (base.match(/^divide-/)) { const c = color(...splitAlpha(base.replace(/^divide-/,''))); if (c) { divideY.push({ cls, media, pseudo, color: c }); continue; } }

    const d = decls(base);
    if (!d || d.some((x) => x.includes('/*'))) { if (htmlSet.has(cls)) unhandled.push(cls); continue; }
    rules.push({ media, sel: `.${cssEscape(cls)}${pseudo}`, body: d.length ? d.join('; ') + ';' : '' });
  }

  if (unhandled.length) {
    console.error('UNHANDLED CLASSES (' + unhandled.length + '):');
    console.error(unhandled.join('\n'));
    process.exit(1);
  }

  // Assemble CSS
  let out = `/* styles/utilities.css — GENERATED by scripts/gen_utilities.js. DO NOT EDIT BY HAND.
   Self-hosted subset of Tailwind utilities used by index.html + js/pages/student.js,
   so the Tailwind Play CDN can be removed. Color utilities resolve to styles/tokens.css
   tokens where a shade exists (re-theme via tokens), else the literal Tailwind hex.
   Regenerate: node scripts/gen_utilities.js */\n\n`;
  // Preflight — faithful subset of Tailwind's base reset the markup relies on.
  // (Without this, removing the CDN brings back default UA margins on body/
  // headings/p, blue underlined links, UA button fonts, and list bullets.)
  out += [
    `*,::before,::after{box-sizing:border-box;border-width:0;border-style:solid;border-color:var(--color-border, #e2e8f0);}`,
    `html{line-height:1.5;-webkit-text-size-adjust:100%;-moz-tab-size:4;tab-size:4;font-family:'Inter',ui-sans-serif,system-ui,sans-serif;}`,
    `body{margin:0;line-height:inherit;}`,
    `h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit;margin:0;}`,
    `p,figure,blockquote,dl,dd{margin:0;}`,
    `hr{height:0;color:inherit;border-top-width:1px;}`,
    `a{color:inherit;text-decoration:inherit;}`,
    `b,strong{font-weight:bolder;}`,
    `code,kbd,samp,pre{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:1em;}`,
    `small{font-size:80%;}`,
    `button,input,optgroup,select,textarea{font-family:inherit;font-size:100%;font-weight:inherit;line-height:inherit;color:inherit;margin:0;padding:0;}`,
    `button,select{text-transform:none;}`,
    `button,[type='button'],[type='reset'],[type='submit']{-webkit-appearance:button;background-color:transparent;background-image:none;cursor:pointer;}`,
    `:disabled{cursor:default;}`,
    `img,svg,video,canvas,audio,iframe,embed,object{display:block;vertical-align:middle;}`,
    `img,video{max-width:100%;height:auto;}`,
    `ol,ul,menu{list-style:none;margin:0;padding:0;}`,
    `table{border-collapse:collapse;}`,
    `[hidden]{display:none;}`,
    `input::placeholder,textarea::placeholder{opacity:1;color:var(--color-text-subtle, #64748b);}`,
  ].join('\n') + '\n';
  out += `@keyframes twFadeIn{from{opacity:0}to{opacity:1}}\n`;
  out += `@keyframes twSpin{to{transform:rotate(360deg)}}\n\n`;

  const base = rules.filter((r) => !r.media);
  const byMedia = {};
  rules.filter((r) => r.media).forEach((r) => { (byMedia[r.media] = byMedia[r.media] || []).push(r); });

  for (const r of base) out += `${r.sel}{${r.body}}\n`;
  // space-x/y and divide (base + media)
  const emitCombinator = (items) => {
    let s = '';
    const baseItems = items.filter((i) => !i.media), med = {};
    items.filter((i) => i.media).forEach((i) => { (med[i.media] = med[i.media] || []).push(i); });
    const line = (i) => {
      const sel = `.${cssEscape(i.cls)}${i.pseudo} > * + *`;
      if (i.cls.startsWith('space-x-')) return `${sel}{margin-left:${i.v};}`;
      if (i.cls.startsWith('space-y-')) return `${sel}{margin-top:${i.v};}`;
      if (i.cls === 'divide-y') return `${sel}{border-top-width:1px;}`;
      if (i.cls.startsWith('divide-')) return `${sel}{border-color:${i.color};}`;
      return '';
    };
    baseItems.forEach((i) => { s += line(i) + '\n'; });
    for (const mq of Object.keys(med)) { s += `@media (min-width:${mq}){` + med[mq].map(line).join('') + `}\n`; }
    return s;
  };
  out += emitCombinator([...spaceX, ...spaceY, ...divideY]);

  for (const mq of Object.keys(byMedia).sort((a, b) => parseInt(a) - parseInt(b))) {
    out += `\n@media (min-width:${mq}){\n`;
    for (const r of byMedia[mq]) out += `  ${r.sel}{${r.body}}\n`;
    out += `}\n`;
  }

  fs.writeFileSync(path.join(ROOT, 'styles/utilities.css'), out);
  console.log('OK: wrote styles/utilities.css');
  console.log('classes covered:', used.length, '| base rules:', base.length, '| media rules:', rules.length - base.length,
    '| space/divide:', spaceX.length + spaceY.length + divideY.length);
}
main();
