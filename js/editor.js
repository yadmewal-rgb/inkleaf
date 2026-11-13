// The notebook editor: page layout, pan/zoom, stylus/finger/mouse input, tools, selection, undo.
import { db, newPage, loadPages, trashPage, sysPages, addSysPage, removeSysPage, TRASH_DAYS, dayKey, dayIndex, newDayPage } from './db.js';
import { chooseNotebook, markOpened, detailsDialog } from './library.js';
import { shareNotebook } from './sync.js';
import { openPdf } from './pdfrender.js';
import { h, uid, nextZ, clamp, bus, distSeg, downloadBlob, safeName, debounce, fill, imgReady } from './util.js';
import * as R from './render.js';
import { renderPdfPage } from './pdfrender.js';
import { pageLinks, resolveDest, pdfOutline, pageText, textMatches } from './pdftools.js';
import { I } from './icons.js';
import { popMenu, popover, confirmBox, promptText, toast, modal, chipGroup, templatePicker, PAPER_OPTS, busy } from './ui.js';
import { exportFlow } from './export.js';
import { syncNow, syncStatus, mergePage, mergeDoc } from './sync.js';

const GAP = 14, MIN_S = 0.2, MAX_S = 6;
const COARSE = matchMedia('(pointer: coarse)').matches;
const MAXPX = COARSE ? 5.5e6 : 9e6; // cap on pixels per whole-page canvas (memory on tablets)
const REGION_PX = COARSE ? 6e6 : 12e6; // cap when only the visible part of a page is drawn (zoomed in)
const REGION_PAD = 0.15;               // extra drawn around the visible part, as a fraction of the screen
const PULL_PX = 90;                    // how far to drag up past the last page to add a new one
const PALM_MS = 350;                  // touches this soon after the stylus was seen are treated as the palm
const INK = '#1c1d21', INK_ON_DARK = '#f1f3f5';

const PEN_COLORS = [INK, '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#ffffff'];
const HL_COLORS = ['#ffd43b', '#8ce99a', '#74c0fc', '#faa2c1', '#ffa94d'];
const SHAPES = [['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['arrow', 'Arrow']];

const MM = 0.3528; // one page unit (a PDF point) in millimetres
const mmToPt = mm => Math.round(mm / MM * 100) / 100;

const TAPE_COLORS = ['#e9d8a6', '#f4b6c2', '#a9d6e5', '#c9c9c9', '#2b2d42'];
const LASER_COLORS = ['#ff2d2d', '#22c55e', '#3b82f6'];
const RULER_L = 170 / MM, RULER_W = 46; // the on-screen ruler: 17 cm long, in page units
const ZOOM_TOOLS = ['pen', 'hl', 'eraser'];

const NOTE_COLORS = ['#ffe066', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#d0bfff'];
const FILL_COLORS = ['#ffe3e3', '#fff3bf', '#d3f9d8', '#d0ebff', '#e5dbff', '#dee2e6'];
const HIST_GAP = 5 * 60e3, HIST_MAX = 25, HIST_DAYS = 14; // page history: one snapshot per 5 minutes of writing
let activeEd = null; // with two notebooks side by side, the one last touched gets the keyboard
const TM = { open: false, running: false, t0: 0, acc: 0, dur: 0 }; // the timer, shared by every notebook (dur 0 = stopwatch)

const DEFAULTS = {
  noteColor: '#ffe066',
  tape:{ color: '#e9d8a6', size: mmToPt(7) },
  laser: { color: '#ff2d2d' },
  flow: 'v',      // 'v' = pages run down the screen, 'h' = side by side, one at a time
  tool: 'pen',
  pen: { color: INK, size: mmToPt(0.7), style: 'fountain' },
  scribble: true, // a zigzag over ink erases it
  favs: [],       // favourite pens: [{color, size, style}]
  hl: { color: '#ffd43b', size: mmToPt(5.5) },
  eraser: { size: mmToPt(5.5), mode: 'stroke', only: 'all' },
  shape: { kind: 'rect', color: '#1971c2', size: mmToPt(0.8), fill: null },
  text: { color: INK, size: 16, b: false, i: false, u: false, ff: 'sans', al: 'l' },
  fingerDraw: null, // null = automatic: fingers draw until a stylus has been seen
  penSeen: false
};

// opts: page (1-based page to open at), q (text to find), pane / other (side by side: this pane's index, the other notebook)
export async function mountEditor(root, docId, opts = {}) {
  const doc = await db.get('docs', docId);
  if (!doc || doc.deleted || doc.trashed) { location.hash = opts.other ? '#/d/' + opts.other : '#/'; return { destroy() {} }; }
  const split = !!opts.other, me = {};
  if (!split || opts.pane === 0 || !activeEd) activeEd = me;
  markOpened(doc.id);
  const pages = await loadPages(doc);
  if (!pages.length) {
    const pg = newPage(doc.id, { w: doc.w || 595, h: doc.h || 842, template: doc.template, paper: doc.paper });
    pages.push(pg);
    doc.pages = [pg.id];
    await db.put('pages', pg);
    await db.put('docs', doc);
  }

  const prefs = JSON.parse(JSON.stringify(DEFAULTS));
  const saved = await db.getMeta('prefs');
  if (saved) {
    for (const k in saved) {
      if (prefs[k] && typeof prefs[k] === 'object' && saved[k] && typeof saved[k] === 'object') Object.assign(prefs[k], saved[k]);
      else if (k in prefs) prefs[k] = saved[k];
    }
  }
  const savePrefs = () => db.setMeta('prefs', prefs).catch(() => {});

  // ------------------------------------------------------------------ DOM
  const vp = h('div', { class: 'vp' });
  const world = h('div', { class: 'world' });
  const overlay = h('div', { class: 'overlay' });
  const live = h('canvas', { class: 'live' });
  const eraserCur = h('div', { class: 'eraser-cur', hidden: true });
  const selBox = h('div', { class: 'selbox', hidden: true }, h('div', { class: 'handle' }));
  const selBar = h('div', { class: 'selbar', hidden: true });
  const panel = h('aside', { class: 'panel', hidden: true });
  // The notebook's name in its tab: a plain tap does nothing, holding it (or a right-click) renames.
  const titleBtn = h('button', { class: 'title', type: 'button', title: 'Hold to rename' }, doc.title);
  {
    let t = 0, x0 = 0, y0 = 0;
    const off = () => clearTimeout(t);
    titleBtn.addEventListener('pointerdown', e => { off(); x0 = e.clientX; y0 = e.clientY; t = setTimeout(() => rename(), 550); });
    titleBtn.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - x0, e.clientY - y0) > 8) off(); });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) titleBtn.addEventListener(ev, off);
    titleBtn.addEventListener('contextmenu', e => { e.preventDefault(); off(); rename(); });
  }
  const pageInd = h('button', { class: 'pageind', type: 'button', title: 'Go to page', onclick: () => gotoPrompt() });
  const bmBtn = h('button', { class: 'ic', type: 'button', title: 'Bookmark this page', onclick: () => toggleBookmark(currentPv().page), html: I.star });
  const undoBtn = h('button', { class: 'ic', type: 'button', title: 'Undo (Ctrl+Z)', onclick: () => undo(), html: I.undo });
  const redoBtn = h('button', { class: 'ic', type: 'button', title: 'Redo (Ctrl+Y)', onclick: () => redo(), html: I.redo });
  const toolsEl = h('div', { class: 'toolset' });
  const optsEl = h('div', { class: 'opts' });
  const fileInp = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: onImageFile });
  const scanInp = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: onScanFile });
  const syncBtn = h('button', { class: 'ic', type: 'button', html: I.sync, onclick: () => syncNow(true) });
  // Shown at the end of the tool bar while the title bar is hidden in full screen.
  const undoBtn2 = h('button', { class: 'ic', type: 'button', title: 'Undo', onclick: () => undo(), html: I.undo });
  const redoBtn2 = h('button', { class: 'ic', type: 'button', title: 'Redo', onclick: () => redo(), html: I.redo });
  // In full screen the tool bar floats over the page; "mini" shrinks it to undo, redo and the page number.
  const pageInd2 = h('button', { class: 'pageind', type: 'button', title: 'Go to page', onclick: () => gotoPrompt() });
  const miniBtn = h('button', { class: 'ic', type: 'button', title: 'Shrink the tool bar', onclick: () => setMini(!el.classList.contains('mini')), html: I.collapse });
  const fullTools = h('div', { class: 'fullonly' },
    undoBtn2, redoBtn2, pageInd2,
    h('button', { class: 'ic nomini', type: 'button', title: 'Pages', onclick: () => togglePanel(), html: I.pages }),
    h('button', { class: 'ic nomini', type: 'button', title: 'Add page', onclick: () => addPageAfter(currentPv()), html: I.plus }),
    h('button', { class: 'ic nomini', type: 'button', title: 'More', onclick: e => moreMenu(e.currentTarget), html: I.more }),
    miniBtn,
    h('button', { class: 'ic nomini', type: 'button', title: 'Leave full screen (F)', onclick: () => setFull(false), html: I.fullExit }));
  const showSync = s => {
    syncBtn.hidden = s.state === 'off';
    syncBtn.classList.toggle('spin', s.state === 'syncing');
    syncBtn.classList.toggle('warn', s.state === 'error' || s.state === 'signin');
    syncBtn.title = s.text;
  };

  vp.append(world);
  const pullHint = h('div', { class: 'pullhint', hidden: true });
  const laserCv = h('canvas', { class: 'laser' });
  // Find bar
  const findInp = h('input', { class: 'inp sm', type: 'search', placeholder: 'Find in this notebook' });
  const findLbl = h('span', { class: 'find-n' });
  const findBar = h('div', { class: 'findbar', hidden: true },
    findInp, findLbl,
    h('button', { class: 'ic sm', type: 'button', title: 'Previous (Shift+Enter)', html: I.up, onclick: () => findStep(-1) }),
    h('button', { class: 'ic sm', type: 'button', title: 'Next (Enter)', html: I.down, onclick: () => findStep(1) }),
    h('button', { class: 'ic sm', type: 'button', title: 'Close', html: I.close, onclick: () => closeFind() }));
  // Zoom window: a magnified strip of the page to write in, shown along the bottom of the screen.
  const zcv = h('canvas', { class: 'zw-c' }), zlive = h('canvas', { class: 'zw-c zw-live' });
  const zpad = h('div', { class: 'zw-pad' }, zcv, zlive);
  const zwin = h('div', { class: 'zwin', hidden: true },
    h('div', { class: 'zw-bar' },
      h('button', { class: 'ic sm', type: 'button', title: 'Move left', html: I.back, onclick: () => zoomMove(-0.7) }),
      h('button', { class: 'ic sm', type: 'button', title: 'Move right', html: I.fwd, onclick: () => zoomMove(0.7) }),
      h('button', { class: 'ic sm', type: 'button', title: 'Next line', html: I.newline, onclick: () => zoomNewline() }),
      h('span', { class: 'hint' }, 'Write here. Drag the frame on the page to choose the spot.'),
      h('div', { class: 'grow' }),
      h('button', { class: 'ic sm', type: 'button', title: 'Close the zoom window', html: I.close, onclick: () => toggleZoom(false) })),
    zpad);
  const zgrip = h('div', { class: 'zgrip', title: 'Move', html: I.grip }), zsize = h('div', { class: 'handle', title: 'Resize' });
  const zframe = h('div', { class: 'zframe', hidden: true }, zgrip, zsize);
  overlay.append(eraserCur, selBox, selBar, zframe, laserCv, pullHint, findBar);
  // Top row: home and the open notebooks as tabs. Second row: sidebar, search and read-only on the left, the
  // tools in the middle, and timer / bookmark / full screen / add page / share / more on the right.
  const tabsEl = h('div', { class: 'tabs' });
  const roBtn = h('button', { class: 'ic wide', type: 'button', onclick: () => setReadOnly(!readOnly), html: I.eye });
  const timerBtn = h('button', { class: 'ic wide', type: 'button', title: 'Timer', onclick: () => toggleTimer(), html: I.timer });
  const el = h('div', { class: 'ed' },
    h('div', { class: 'bar top' },
      h('button', { class: 'ic', type: 'button', title: split ? 'Close this side' : 'Library', onclick: exit, html: split ? I.back : I.home }),
      tabsEl, pageInd,
      syncBtn, undoBtn, redoBtn),
    h('div', { class: 'bar tools' },
      h('div', { class: 'lead nofull' },
        h('button', { class: 'ic', type: 'button', title: 'Pages', onclick: togglePanel, html: I.sidebar }),
        h('button', { class: 'ic wide', type: 'button', title: 'Find text (Ctrl+F)', onclick: () => openFind(), html: I.search }),
        roBtn),
      h('div', { class: 'vsep nofull' }),
      toolsEl, h('div', { class: 'vsep' }), optsEl, h('div', { class: 'grow' }),
      h('div', { class: 'trail nofull' },
        doc.journal ? h('button', { class: 'ic', type: 'button', title: 'Journal calendar', onclick: () => calendarDialog(), html: I.calendar }) : null,
        timerBtn, bmBtn,
        h('button', { class: 'ic wide', type: 'button', title: 'Full screen (F)', onclick: () => setFull(true), html: I.full }),
        h('button', { class: 'ic', type: 'button', title: 'Add page', onclick: () => addPageAfter(currentPv()), html: I.addPage }),
        h('button', { class: 'ic', type: 'button', title: 'Share and export', onclick: e => shareMenu(e.currentTarget), html: I.share }),
        h('button', { class: 'ic', type: 'button', title: 'More', onclick: e => moreMenu(e.currentTarget), html: I.more })),
      fullTools),
    h('div', { class: 'stage' }, vp, overlay, zwin, panel),
    fileInp, scanInp);
  if (split) el.classList.add('in-split');
  el.addEventListener('pointerdown', () => { activeEd = me; }, true);
  root.append(el);

  // ------------------------------------------------------------------ view state
  let scale = 1, ls = 1, tx = 0, ty = 0, vpRect = vp.getBoundingClientRect(), worldW = 0, worldH = 0;
  let zooming = false, zoomT = 0, rafView = 0;
  const pvs = []; // one "page view" per page: {page, el, bg, hi, ink, x, y, rs, clip, bgRs, bgTok, hiTok}

  let ptrs = new Map();
  let action = null, pan = null, pinch = null, spaceDown = false, inertiaRaf = 0;
  let penSeen = !!prefs.penSeen;
  let lastPenT = -1e9;   // when the stylus was last seen (touching or hovering)
  let multiTap = null;   // a two/three finger tap in progress
  let lastTap = null;    // previous single finger tap, for double-tap
  let full = false, dbg = null;
  let clipItems = (await db.getMeta('clip')) || null; // copied items, shared by every notebook on this device
  let panelQ = '', panelBm = false, panelList = null; // pages panel: search text, bookmarks-only, the list element
  let pickMode = false, lastPick = -1, pickBar = null; // pages panel: choosing several pages to act on together
  const picked = new Set();                            // ids of the chosen pages
  let sel = null, textEd = null;
  let livePv = null, liveFn = null, rafLive = 0;
  const undoStack = [], redoStack = [];
  const dirtyPages = new Set();
  let saveT = 0, docDirty = false, changed = false, destroyed = false;
  let touched = false;        // has the notebook's "last edited" stamp been bumped this session?
  let pendingRebuild = false; // a page arrived or left on another device while a gesture was in progress
  const gonePages = new Set(); // pages deleted here or elsewhere during this session
  const inkDirty = new Set();
  let rafInk = 0;
  let panelOpen = false, thumbObs = null;
  const thumbs = new Map(); // pageId -> canvas
  let hz = prefs.flow === 'h';  // pages side by side
  let wheelAcc = 0, wheelLock = 0, wheelT = 0;
  const laser = { strokes: [], raf: 0 };
  let ruler = null;             // {x, y: centre in world units, ang, el, cv, lbl, s}
  let zw = null, zpan = null, rafZoom = 0; // zoom window: {pv, x, y, w, h, zs, d, rect, home, pdfC, pdfKey, pdfAsk, tok}
  let find = null, findTok = 0; // find bar: {q, hits: [{pg, rects, els}], cur}
  const pdfText = new Map();    // pageId -> text of its PDF page, once loaded (for the pages panel search)
  let textWarm = null;
  let boxEd = null;             // typing in a sticky note or a table cell: {pv, item, kind, r, c, ta, x, y, w, h, fs}
  const histOrig = new Map(pages.map(p => [p.id, { t: p.modified, items: p.items.slice() }])); // pages as they were when opened
  const histLast = new Map();   // page id -> when its last history snapshot was taken this session

  let readOnly = false; // read-only view: nothing that touches the page draws on it
  try { readOnly = localStorage.getItem('inkleaf.ro.' + doc.id) === '1'; } catch { /* private mode */ }
  const fingerDraws = () => !readOnly && (prefs.fingerDraw === true || (prefs.fingerDraw == null && !penSeen));
  const inkFor = (pv, color) => (color === INK && R.paperOf(pv.page).dark ? INK_ON_DARK : color);

  // ------------------------------------------------------------------ layout & rendering
  function stylePv(pv) {
    const pap = R.paperOf(pv.page);
    pv.el.style.background = pap.bg;
    pv.el.classList.toggle('dark', pap.dark);
  }

  function rebuild() {
    if (live.parentNode) live.remove();
    livePv = null;
    world.replaceChildren();
    pvs.length = 0;
    for (const page of pages) {
      const bg = h('canvas', { class: 'bg' }), ink = h('canvas', { class: 'ink' });
      const pel = h('div', { class: 'page' }, bg, ink);
      const pv = { page, el: pel, bg, ink, img: null, tape: null, hi: null, links: undefined, x: 0, y: 0, rs: 0, clip: null, bgRs: 0, bgTok: 0, hiTok: 0 };
      stylePv(pv);
      pvs.push(pv);
      world.append(pel);
    }
    layout();
    if (zw) {
      const nv = pvs.find(v => v.page === zw.pv.page);
      if (nv) { zw.pv = nv; queueZoom(); } else toggleZoom(false);
    }
    if (find) showFindMarks();
  }

  // Round a CSS length to whole device pixels.
  const snap = v => { const d = window.devicePixelRatio || 1; return Math.round(v * d) / d; };

  function layout() {
    if (hz) {
      worldH = Math.max(...pages.map(p => p.h)) + 2 * GAP;
      let x = GAP;
      for (const pv of pvs) {
        pv.x = x;
        pv.y = (worldH - pv.page.h) / 2;
        x += pv.page.w + GAP;
        Object.assign(pv.el.style, { left: snap(pv.x * ls) + 'px', top: snap(pv.y * ls) + 'px', width: pv.page.w * ls + 'px', height: pv.page.h * ls + 'px' });
      }
      worldW = x;
      return;
    }
    worldW = Math.max(...pages.map(p => p.w));
    let y = GAP;
    for (const pv of pvs) {
      pv.x = (worldW - pv.page.w) / 2;
      pv.y = y;
      y += pv.page.h + GAP;
      Object.assign(pv.el.style, { left: snap(pv.x * ls) + 'px', top: snap(pv.y * ls) + 'px', width: pv.page.w * ls + 'px', height: pv.page.h * ls + 'px' });
    }
    worldH = y;
  }

  // Pages are laid out at their real on-screen size ("ls" = the zoom they were laid out for) and only
  // moved with CSS, never enlarged with it: iPad browsers blur anything that is scaled up by a transform.
  // A CSS scale is used just while a zoom gesture is in progress.
  function relayout() {
    ls = scale;
    layout();
    for (const pv of pvs) {
      if (!pv.rs) continue;
      place(pv.ink, pv);
      if (pv.img) place(pv.img, pv);
      if (pv.tape) place(pv.tape, pv);
      placeHi(pv);
    }
    if (livePv) place(live, livePv);
  }

  function measure() { vpRect = vp.getBoundingClientRect(); }

  // The zoom that shows a page comfortably: its full width when pages run downwards, the whole page when side by side.
  function fitScale(pg, max = 2.5) {
    if (!hz) return clamp((vpRect.width - 24) / worldW, MIN_S, max);
    return clamp(Math.min((vpRect.width - 24) / pg.w, (vpRect.height - 24) / pg.h), MIN_S, max);
  }

  // Where tx must be to show a page in side-by-side mode: centred if it fits, otherwise its left edge.
  function pageTx(pv) {
    const w = pv.page.w * scale, vw = vpRect.width;
    return w <= vw - 8 ? vw / 2 - (pv.x + pv.page.w / 2) * scale : 12 - pv.x * scale;
  }

  function clampView() {
    const vw = vpRect.width, vh = vpRect.height, pad = 12;
    const cw = worldW * scale, ch = worldH * scale;
    if (hz && pvs.length) { // the first and last page may sit in the middle of the screen
      const a = pvs[0], b = pvs[pvs.length - 1];
      const hi = Math.max(pad, vw / 2 - (a.x + a.page.w / 2) * scale), lo = Math.min(vw - cw - pad, vw / 2 - (b.x + b.page.w / 2) * scale);
      tx = clamp(tx, Math.min(lo, hi), hi);
    } else tx = cw + 2 * pad <= vw ? (vw - cw) / 2 : clamp(tx, vw - cw - pad, pad);
    const top = full && !el.classList.contains('mini') ? 58 : 0; // room to pull the page out from under the floating tool bar
    const bot = zw ? zwin.offsetHeight : 0;                      // and from behind the zoom window
    ty = ch + top <= vh - bot ? (hz ? Math.max(top, (vh - bot - ch) / 2) : top) : clamp(ty, vh - bot - ch, top);
  }

  function applyView() {
    clampView();
    if (!zooming && ls !== scale) relayout();
    if (ls === scale) {
      const d = window.devicePixelRatio || 1; // whole device pixels keep the ink crisp
      world.style.transform = `translate(${Math.round(tx * d) / d}px,${Math.round(ty * d) / d}px)`;
    } else world.style.transform = `translate(${tx}px,${ty}px) scale(${scale / ls})`;
    if (!rafView) {
      rafView = requestAnimationFrame(() => {
        rafView = 0;
        if (destroyed) return;
        updateVisible();
        positionOverlays();
        updateIndicator();
      });
    }
  }

  // The part of a page that is on screen, in page units, widened by pad (a fraction of the screen). null = none.
  function visRect(pv, pad) {
    const vw = vpRect.width / scale, vh = vpRect.height / scale;
    const x0 = Math.max(0, -tx / scale - pv.x - vw * pad), y0 = Math.max(0, -ty / scale - pv.y - vh * pad);
    const x1 = Math.min(pv.page.w, -tx / scale - pv.x + vw * (1 + pad)), y1 = Math.min(pv.page.h, -ty / scale - pv.y + vh * (1 + pad));
    return x1 - x0 < 1 || y1 - y0 < 1 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // How a page should be drawn right now. A whole-page canvas is used while it is sharp enough; zoomed in
  // further, only the visible part ("clip") is drawn, at full screen resolution.
  function plan(pv) {
    const pg = pv.page;
    const want = scale * Math.min(window.devicePixelRatio || 1, 3);
    const base = Math.min(want, Math.sqrt(MAXPX / (pg.w * pg.h)));
    const whole = { rs: base, base, clip: null };
    if (want <= base * 1.03) return whole;
    const r = visRect(pv, REGION_PAD);
    if (!r) return whole;
    const rs = Math.min(want, Math.sqrt(REGION_PX / (r.w * r.h)));
    if (rs <= base * 1.03) return whole;
    const x = Math.floor(r.x * rs) / rs, y = Math.floor(r.y * rs) / rs; // start on a whole pixel
    const W = Math.max(1, Math.ceil((r.x + r.w - x) * rs)), H = Math.max(1, Math.ceil((r.y + r.h - y) * rs));
    return { rs, base, clip: { x, y, w: W / rs, h: H / rs, W, H } };
  }

  // Does the page need redrawing for the current view? Resolution changes wait until a zoom has settled.
  function stale(pv) {
    if (action && action.pv === pv) return false;
    const c = pv.clip;
    if (c) {
      const v = visRect(pv, 0), e = 1 / scale;
      if (v && (v.x < c.x - e || v.y < c.y - e || v.x + v.w > c.x + c.w + e || v.y + v.h > c.y + c.h + e)) return true;
    }
    if (zooming) return false;
    const p = plan(pv);
    return !p.clip !== !c || Math.abs(pv.rs - p.rs) / pv.rs > 0.04;
  }

  function inRange(pv, margin) {
    if (hz) {
      const l = (-tx - margin) / scale, r = (-tx + vpRect.width + margin) / scale;
      return pv.x + pv.page.w > l && pv.x < r;
    }
    const top = (-ty - margin) / scale, bot = (-ty + vpRect.height + margin) / scale;
    return pv.y + pv.page.h > top && pv.y < bot;
  }

  // Only pages near the viewport keep live canvases; the rest are released to save memory.
  function updateVisible() {
    const vh = hz ? vpRect.width : vpRect.height;
    for (const pv of pvs) {
      if (inRange(pv, vh * 0.5)) {
        if (!pv.rs || stale(pv)) renderPv(pv);
      } else if (pv.rs && !inRange(pv, vh * 1.5) && !(sel && sel.pv === pv) && !(action && action.pv === pv) && !(textEd && textEd.pv === pv)) {
        releasePv(pv);
      }
    }
  }

  // Position a layer canvas over the part of the page it covers.
  function place(c, pv) {
    const k = pv.clip;
    Object.assign(c.style, k
      ? { left: k.x * ls + 'px', top: k.y * ls + 'px', width: k.w * ls + 'px', height: k.h * ls + 'px' }
      : { left: '', top: '', width: '', height: '' });
  }

  function placeHi(pv) {
    const k = pv.hiClip;
    if (pv.hi && k) Object.assign(pv.hi.style, { left: k.x * ls + 'px', top: k.y * ls + 'px', width: k.w * ls + 'px', height: k.h * ls + 'px' });
  }

  // Page units -> canvas pixels for a page's ink layers.
  function xf(c, pv) {
    const k = pv.clip, rs = pv.rs;
    c.setTransform(rs, 0, 0, rs, k ? -k.x * rs : 0, k ? -k.y * rs : 0);
  }

  function renderPv(pv, force) {
    const p = plan(pv);
    pv.rs = p.rs;
    pv.clip = p.clip;
    const W = p.clip ? p.clip.W : Math.max(1, Math.round(pv.page.w * p.rs));
    const H = p.clip ? p.clip.H : Math.max(1, Math.round(pv.page.h * p.rs));
    place(pv.ink, pv);
    pv.ink.width = W;
    pv.ink.height = H;
    loadLinks(pv);
    paintInk(pv);
    paintBg(pv, p.base, force);
    paintHi(pv);
    if (livePv === pv) {
      place(live, pv);
      live.width = W;
      live.height = H;
      if (sel && sel.pv === pv) drawSelLive();
    }
  }

  // Sharp paper (and PDF) for the visible part of a zoomed-in page, laid over the whole-page background.
  function paintHi(pv) {
    const k = pv.clip, pg = pv.page, rs = pv.rs, tok = ++pv.hiTok;
    if (!k) {
      if (pv.hi) { pv.hi.remove(); pv.hi = null; }
      return;
    }
    const put = pdfCanvas => {
      if (!pv.hi) { pv.hi = h('canvas', { class: 'hi' }); pv.bg.after(pv.hi); }
      const c = pv.hi;
      c.width = k.W;
      c.height = k.H;
      pv.hiClip = k;
      placeHi(pv);
      const x = c.getContext('2d');
      if (pdfCanvas) x.drawImage(pdfCanvas, 0, 0);
      else { x.setTransform(rs, 0, 0, rs, -k.x * rs, -k.y * rs); R.drawPaper(x, pg); }
    };
    if (!pg.pdf) { put(null); return; }
    // The previous sharp piece stays in place until the new one is ready.
    renderPdfPage(pg.pdf.a, pg.pdf.i, rs, () => tok !== pv.hiTok || !pv.rs, k)
      .then(c => { if (c && tok === pv.hiTok && pv.rs) put(c); })
      .catch(err => console.warn('PDF region render failed', err));
  }

  function paintBg(pv, rs, force) {
    if (!force && pv.bg.width && pv.bgRs && Math.abs(pv.bgRs - rs) / rs < 0.04) return;
    pv.bgRs = rs;
    const tok = ++pv.bgTok, pg = pv.page;
    const W = Math.max(1, Math.round(pg.w * rs)), H = Math.max(1, Math.round(pg.h * rs));
    const draw = pdfCanvas => {
      pv.bg.width = W;
      pv.bg.height = H;
      const c = pv.bg.getContext('2d');
      c.setTransform(rs, 0, 0, rs, 0, 0);
      R.drawPaper(c, pg);
      if (pdfCanvas) {
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.drawImage(pdfCanvas, 0, 0, W, H);
      }
    };
    if (!pg.pdf) { draw(null); return; }
    if (!pv.bg.width) draw(null); // show paper immediately, the PDF arrives when rendered
    renderPdfPage(pg.pdf.a, pg.pdf.i, rs, () => tok !== pv.bgTok || !pv.rs)
      .then(c => { if (c && tok === pv.bgTok && pv.rs) draw(c); })
      .catch(err => console.warn('PDF page render failed', err));
  }

  function releasePv(pv) {
    pv.rs = 0;
    pv.bgRs = 0;
    pv.clip = null;
    pv.bgTok++;
    pv.hiTok++;
    pv.bg.width = pv.bg.height = 0;
    pv.ink.width = pv.ink.height = 0;
    place(pv.ink, pv);
    if (pv.img) { pv.img.remove(); pv.img = null; }
    if (pv.tape) { pv.tape.remove(); pv.tape = null; }
    if (pv.hi) { pv.hi.remove(); pv.hi = null; pv.hiClip = null; }
    if (livePv === pv) { live.remove(); live.width = live.height = 0; livePv = null; }
  }

  function hiddenIds(pv) {
    if (sel && sel.pv === pv) return sel.ids;
    if (textEd && textEd.pv === pv && textEd.item) return new Set([textEd.item.id]);
    if (boxEd && boxEd.pv === pv && boxEd.kind === 'nt') return new Set([boxEd.item.id]);
    return null;
  }

  function paintInk(pv) {
    if (!pv.rs) return;
    const c = pv.ink.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, pv.ink.width, pv.ink.height);
    xf(c, pv);
    R.drawItems(c, pv.page.items, hiddenIds(pv), false, pv.clip);
    // Linked items get a faint dashed frame (on screen only, never in exports).
    const linked = pv.page.items.filter(it => it.lk);
    if (linked.length) {
      const px = (window.devicePixelRatio || 1) / pv.rs;
      c.save();
      c.strokeStyle = 'rgba(25,113,194,.75)';
      c.lineWidth = 1.2 * px;
      c.setLineDash([4 * px, 3 * px]);
      for (const it of linked) { const b = R.bounds(it); c.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4); }
      c.restore();
    }
    paintImg(pv);
    paintTape(pv);
    if (zw && zw.pv === pv) queueZoom();
  }

  // Tape covers the ink, so it gets its own unblended layer above it (created only when the page has tape).
  function paintTape(pv) {
    if (!pv.rs || !pv.page.items.some(it => it.t === 'tp' || it.t === 'nt')) {
      if (pv.tape) { pv.tape.remove(); pv.tape = null; }
      return;
    }
    if (!pv.tape) { pv.tape = h('canvas', { class: 'tape' }); pv.ink.after(pv.tape); }
    if (pv.tape.width !== pv.ink.width || pv.tape.height !== pv.ink.height) {
      pv.tape.width = pv.ink.width;
      pv.tape.height = pv.ink.height;
    }
    place(pv.tape, pv);
    const c = pv.tape.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, pv.tape.width, pv.tape.height);
    xf(c, pv);
    R.drawTapes(c, pv.page.items, hiddenIds(pv), pv.clip);
  }

  // Pictures live on their own opaque layer between the paper and the ink (created only when needed).
  function paintImg(pv) {
    if (!pv.rs || !pv.page.items.some(it => it.t === 'im')) {
      if (pv.img) { pv.img.remove(); pv.img = null; }
      return;
    }
    if (!pv.img) { pv.img = h('canvas', { class: 'img' }); pv.ink.before(pv.img); }
    if (pv.img.width !== pv.ink.width || pv.img.height !== pv.ink.height) {
      pv.img.width = pv.ink.width;
      pv.img.height = pv.ink.height;
    }
    place(pv.img, pv);
    const c = pv.img.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, pv.img.width, pv.img.height);
    xf(c, pv);
    R.drawImages(c, pv.page.items, hiddenIds(pv), pv.clip);
  }

  function queueInk(pv) {
    inkDirty.add(pv);
    if (!rafInk) {
      rafInk = requestAnimationFrame(() => {
        rafInk = 0;
        for (const p of inkDirty) paintInk(p);
        inkDirty.clear();
      });
    }
  }

  // The "live" canvas sits on top of the page being worked on (stroke in progress, lasso, selection).
  function useLive(pv) {
    if (!pv.rs) renderPv(pv);
    if (livePv !== pv || live.width !== pv.ink.width || live.height !== pv.ink.height) {
      pv.el.append(live);
      place(live, pv);
      live.width = pv.ink.width;
      live.height = pv.ink.height;
      livePv = pv;
    }
    const c = live.getContext('2d');
    xf(c, pv);
    c.globalAlpha = 1;
    c.setLineDash([]);
    return c;
  }

  function clearLive() {
    liveFn = null;
    if (zw && zlive.width) {
      const z = zlive.getContext('2d');
      z.setTransform(1, 0, 0, 1, 0, 0);
      z.clearRect(0, 0, zlive.width, zlive.height);
      zxf(z);
    }
    if (!livePv || !live.width) return;
    const c = live.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, live.width, live.height);
    if (livePv.rs) xf(c, livePv);
  }

  function nextLive(fn) {
    liveFn = fn;
    if (!rafLive) {
      rafLive = requestAnimationFrame(() => {
        rafLive = 0;
        const f = liveFn;
        liveFn = null;
        if (f && !destroyed) f();
      });
    }
  }

  // ------------------------------------------------------------------ coordinates
  const toPage = (pv, cx, cy) => [(cx - vpRect.left - tx) / scale - pv.x, (cy - vpRect.top - ty) / scale - pv.y];
  const toScreen = (pv, x, y) => [(pv.x + x) * scale + tx, (pv.y + y) * scale + ty];

  function pvAt(cx, cy) {
    const wy = (cy - vpRect.top - ty) / scale, wx = (cx - vpRect.left - tx) / scale;
    let best = pvs[0], bd = Infinity;
    for (const pv of pvs) {
      const d = hz
        ? (wx < pv.x ? pv.x - wx : wx > pv.x + pv.page.w ? wx - pv.x - pv.page.w : 0)
        : (wy < pv.y ? pv.y - wy : wy > pv.y + pv.page.h ? wy - pv.y - pv.page.h : 0);
      if (d < bd) { bd = d; best = pv; }
    }
    return best;
  }

  function currentPv() {
    if (hz) {
      const cx = (-tx + vpRect.width / 2) / scale;
      return pvs.find(pv => cx < pv.x + pv.page.w + GAP / 2) || pvs[pvs.length - 1];
    }
    const cy = (-ty + vpRect.height / 2) / scale;
    return pvs.find(pv => cy < pv.y + pv.page.h + GAP) || pvs[pvs.length - 1];
  }

  function fitWidth() {
    measure();
    const keep = pvs.length ? pvs.indexOf(currentPv()) : 0;
    scale = fitScale(pvs[keep].page);
    if (!hz) tx = (vpRect.width - worldW * scale) / 2;
    scrollToPage(keep);
  }

  function scrollToPage(i) {
    const pv = pvs[clamp(i, 0, pvs.length - 1)];
    stopInertia();
    if (hz) tx = pageTx(pv); else ty = -(pv.y - GAP) * scale;
    applyView();
  }

  // Glide the view to a position (used to settle on a page when they are side by side).
  function animateTo(x1, y1) {
    stopInertia();
    const x0 = tx, y0 = ty, t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 230), e = 1 - Math.pow(1 - k, 3);
      tx = x0 + (x1 - x0) * e;
      ty = y0 + (y1 - y0) * e;
      applyView();
      inertiaRaf = k < 1 && !destroyed ? requestAnimationFrame(step) : 0;
    };
    inertiaRaf = requestAnimationFrame(step);
  }

  function goPage(d) {
    const i = clamp(pvs.indexOf(currentPv()) + d, 0, pvs.length - 1);
    if (hz) animateTo(pageTx(pvs[i]), ty); else scrollToPage(i);
  }

  // Side by side, with a whole page fitting across the screen: come to rest on one page.
  // vx is the speed of the flick that ended the drag, i0 the page it started on.
  function snapPage(vx, i0) {
    if (!hz || !pvs.length) return false;
    let i = pvs.indexOf(currentPv());
    if (pvs[i].page.w * scale > vpRect.width + 2) return false; // zoomed in: move freely
    if (i0 != null && i === i0 && Math.abs(vx) > 0.35) i = clamp(i0 + (vx < 0 ? 1 : -1), 0, pvs.length - 1);
    animateTo(pageTx(pvs[i]), ty);
    return true;
  }

  function setFlow(f) {
    commitText();
    clearSel();
    const i = pvs.indexOf(currentPv());
    prefs.flow = f;
    hz = f === 'h';
    savePrefs();
    rebuild();
    measure();
    scale = fitScale(pages[i]);
    if (!hz) tx = (vpRect.width - worldW * scale) / 2;
    scrollToPage(i);
    toast(hz ? 'Pages side by side: swipe left and right' : 'Pages run down the screen');
  }

  function zoomAt(cx, cy, factor) {
    const ns = clamp(scale * factor, MIN_S, MAX_S);
    const px = cx - vpRect.left, py = cy - vpRect.top;
    tx = px - (px - tx) * (ns / scale);
    ty = py - (py - ty) * (ns / scale);
    scale = ns;
    zooming = true;
    clearTimeout(zoomT);
    zoomT = setTimeout(() => { zooming = false; if (!destroyed) applyView(); }, 180);
    applyView();
  }

  function updateIndicator() {
    const i = pvs.indexOf(currentPv());
    pageInd.textContent = pageInd2.textContent = `${i + 1} / ${pvs.length}`;
    const bm = !!(pvs[i] && pvs[i].page.bm);
    if (bmBtn._on !== bm) { bmBtn._on = bm; bmBtn.innerHTML = bm ? I.starOn : I.star; bmBtn.classList.toggle('star-on', bm); bmBtn.title = bm ? 'Remove bookmark' : 'Bookmark this page'; }
    try { localStorage.setItem('inkleaf.pos.' + doc.id, String(i)); } catch { /* private mode */ }
  }

  // ------------------------------------------------------------------ data changes, undo, saving
  function removeItems(page, items) {
    if (!items.length) return;
    const ids = new Set(items.map(i => i.id));
    page.items = page.items.filter(i => !ids.has(i.id));
    const t = Date.now();
    for (const id of ids) page.dels[id] = t;
  }

  function addItems(page, items) {
    if (!items.length) return;
    const t = Date.now() + 1;
    let sorted = true;
    for (const it of items) {
      it.m = t;
      delete page.dels[it.id];
      const last = page.items[page.items.length - 1];
      if (last && last.z > it.z) sorted = false;
      page.items.push(it);
    }
    if (!sorted) page.items.sort((a, b) => a.z - b.z);
  }

  function dirty(page) {
    page.modified = Date.now();
    dirtyPages.add(page);
    changed = true;
    clearTimeout(saveT);
    saveT = setTimeout(() => flush().catch(saveFailed), 250);
    if (panelOpen) refreshThumb(page);
    if (zw && zw.pv.page === page) queueZoom();
  }

  let failToastT = 0;
  function saveFailed(e) {
    console.error(e);
    if (Date.now() - failToastT < 20000) return; // the save is retried every few seconds; say so only now and then
    failToastT = Date.now();
    toast(e && e.name === 'QuotaExceededError'
      ? 'Could not save: this device\'s storage is full. Free some space; your writing is kept while this page stays open.'
      : 'Could not save just now. Trying again; keep this page open.', 4500);
  }

  async function flush() {
    clearTimeout(saveT);
    if (!dirtyPages.size && !docDirty) return;
    const ps = [...dirtyPages];
    dirtyPages.clear();
    // The notebook record itself is only rewritten when it changed (or once per session, to mark it as recently edited).
    const writeDoc = docDirty || !touched;
    docDirty = false;
    touched = true;
    try {
      await db.putMany('pages', ps);
      if (writeDoc) {
        doc.modified = Date.now();
        await db.put('docs', doc);
      }
    } catch (e) {
      // Nothing is dropped: the same pages are saved again in a few seconds, for as long as it takes.
      for (const p of ps) if (pages.includes(p)) dirtyPages.add(p);
      if (writeDoc) docDirty = true;
      if (!destroyed) { clearTimeout(saveT); saveT = setTimeout(() => flush().catch(saveFailed), 3000); }
      throw e;
    }
    for (const p of ps) snapshot(p).catch(e => console.warn('Page history not saved', e));
    verRecord(ps);
  }

  // ------------------------------------------------------------------ page history (kept on this device only)
  const histKey = id => 'hist:' + id;
  const sameList = (a, b) => a.length === b.length && a.every((it, i) => it.id === b[i].id && (it.m || 0) === (b[i].m || 0));

  async function snapshot(page, force) {
    if (page.deleted || page.trashed) return;
    const now = Date.now(), last = histLast.get(page.id);
    let add = null;
    if (force) add = { t: now, items: page.items.slice() };
    else if (last === undefined) { // first save this session: keep how the page looked when it was opened
      const o = histOrig.get(page.id);
      histLast.set(page.id, now);
      if (o && o.items.length) add = { t: o.t || now, items: o.items };
    } else if (now - last >= HIST_GAP) {
      histLast.set(page.id, now);
      add = { t: now, items: page.items.slice() };
    }
    if (!add) return;
    let arr = (await db.getMeta(histKey(page.id))) || [];
    if (arr.length && sameList(arr[arr.length - 1].items, add.items)) return;
    arr.push(add);
    arr = arr.filter(s => now - s.t < HIST_DAYS * 864e5).slice(-HIST_MAX);
    await db.setMeta(histKey(page.id), arr);
  }

  async function historyDialog() {
    const pv = currentPv(), pg = pv.page;
    const arr = ((await db.getMeta(histKey(pg.id))) || []).filter(s => !sameList(s.items, pg.items)).reverse();
    if (!arr.length) { toast('No earlier versions of this page yet. They are saved every few minutes while you write.', 3500); return; }
    const m = modal({
      title: `Page ${pvs.indexOf(pv) + 1}: earlier versions`, wide: true,
      body: h('div', { class: 'hist' },
        h('p', { class: 'modal-text small' }, `Kept on this device for ${HIST_DAYS} days. Restoring can be undone.`),
        arr.map(s => {
          const c = h('canvas', { class: 'hist-c zoomable', title: 'Tap to see it large', onclick: () => bigPreview({ ...pg, items: s.items }, new Date(s.t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })) });
          R.renderPageTo({ ...pg, items: s.items }, c, 180).catch(() => {});
          return h('div', { class: 'hist-row' }, c,
            h('div', { class: 'hist-meta' },
              h('b', null, new Date(s.t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })),
              h('span', null, `${s.items.length} item${s.items.length === 1 ? '' : 's'}`),
              h('button', { class: 'btn sm', type: 'button', onclick: () => { m.close(); restoreVersion(pv, s); } }, 'Restore this version')));
        }))
    });
  }

  // An old version of a page, large enough to read. Tap the picture to magnify it further and scroll around.
  function bigPreview(rec, title) {
    const c = h('canvas', { class: 'big-c', title: 'Tap to magnify' });
    const box = h('div', { class: 'big-box' }, c);
    c.onclick = e => {
      const r = c.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      const on = c.classList.toggle('x2');
      if (on) requestAnimationFrame(() => { box.scrollLeft = c.offsetWidth * fx - box.clientWidth / 2; box.scrollTop = c.offsetHeight * fy - box.clientHeight / 2; });
    };
    R.renderPageTo(rec, c, Math.min(2000, rec.w * 3)).catch(() => {});
    const m = modal({ title, wide: true, body: box, actions: [{ label: 'Close', primary: true }] });
    m.el.classList.add('xl');
  }

  async function restoreVersion(pv, s) {
    commitText();
    clearSel();
    const pg = pv.page, old = pg.items.slice();
    await snapshot(pg, true); // the version being replaced can itself be brought back later
    const nu = s.items.map(it => ({ ...it }));
    removeItems(pg, old);
    addItems(pg, nu);
    pushUndo({ pageId: pg.id, remove: old, add: nu });
    queueInk(pv);
    dirty(pg);
    toast('Earlier version restored. Undo puts it back.');
  }

  // ------------------------------------------------------------------ live changes from other devices
  function onRemote({ kind, rec }) {
    if (destroyed) return;
    if (kind === 'p' && rec.docId === doc.id) absorbPage(rec);
    else if (kind === 'd' && rec.id === doc.id) absorbDoc(rec);
    else if (kind === 'a') {
      for (const pv of pvs) {
        const pg = pv.page;
        if (pv.rs && ((pg.pdf && pg.pdf.a === rec.id) || pg.items.some(it => it.t === 'im' && it.a === rec.id))) renderPv(pv, true);
      }
    }
  }

  function absorbPage(rec) {
    const i = pages.findIndex(p => p.id === rec.id);
    if (i < 0) { // a page added on another device (or brought back from the bin)
      if (rec.deleted || rec.trashed) return;
      if (gonePages.has(rec.id) && !doc.pages.includes(rec.id)) return;
      gonePages.delete(rec.id);
      pages.push({ ...rec, items: rec.items || [], dels: rec.dels || {} });
      orderPages();
      remoteRebuild();
      return;
    }
    const P = pages[i];
    if (rec.deleted || rec.trashed) {
      gonePages.add(rec.id);
      if (pages.length > 1) { pages.splice(i, 1); dirtyPages.delete(P); remoteRebuild(); }
      return;
    }
    const m = mergePage(P, rec);
    if (m === P) { // we already have everything in it; make sure our copy is what is stored
      if (P.modified !== rec.modified) { dirtyPages.add(P); clearTimeout(saveT); saveT = setTimeout(() => flush().catch(saveFailed), 300); }
      return;
    }
    if (sel && sel.pv.page === P) clearSel();
    verRecord([P]); // writing arriving from another device also counts as a change in this session
    const restyle =P.template !== m.template || P.paper !== m.paper || JSON.stringify([P.bg || null, P.pdf || null]) !== JSON.stringify([m.bg || null, m.pdf || null]);
    const resize = P.w !== m.w || P.h !== m.h;
    P.items = m.items;
    P.dels = m.dels;
    P.template = m.template;
    P.paper = m.paper;
    P.bg = m.bg || null;
    P.pdf = m.pdf || null;
    if (m.tpl) P.tpl = m.tpl; else delete P.tpl;
    P.w = m.w;
    P.h = m.h;
    if (resize) { if (m === rec) P.modified = rec.modified; else dirty(P); remoteRebuild(); return; }
    const marks = !P.bm !== !m.bm || (P.title || '') !== (m.title || '');
    P.bm = m.bm;
    P.title = m.title;
    if (marks) { updateIndicator(); if (panelOpen) fillPanel(); }
    if (m === rec) P.modified = rec.modified; else dirty(P); // a true merge of both sides gets saved and sent back
    const pv = pvs.find(v => v.page === P);
    if (pv) {
      if (restyle) { stylePv(pv); if (pv.rs) renderPv(pv, true); } else queueInk(pv);
    }
    if (panelOpen) refreshThumb(P);
  }

  function absorbDoc(rec) {
    const m = mergeDoc(doc, rec, gonePages);
    if (m === doc) return;
    if (m.deleted || m.trashed) { toast('This notebook was moved to the bin on another device.'); exit(); return; }
    const before = pages.map(p => p.id).join();
    Object.assign(doc, m);
    titleBtn.textContent = doc.title;
    if (m !== rec) { docDirty = true; clearTimeout(saveT); saveT = setTimeout(() => flush().catch(saveFailed), 300); }
    orderPages();
    if (pages.map(p => p.id).join() !== before) remoteRebuild();
  }

  // Put pages in the notebook's order; pages it does not list yet stay at the end.
  function orderPages() {
    const pos = new Map(doc.pages.map((id, i) => [id, i]));
    const at = p => (pos.has(p.id) ? pos.get(p.id) : 1e9);
    const sorted = [...pages].sort((a, b) => at(a) - at(b));
    pages.splice(0, pages.length, ...sorted);
  }

  // Rebuild the page stack without moving what the reader is looking at.
  function remoteRebuild() {
    if (action) { pendingRebuild = true; return; }
    pendingRebuild = false;
    commitText();
    clearSel();
    const cur = currentPv();
    const off = cur ? (hz ? tx + cur.x * scale : ty + cur.y * scale) : 0;
    rebuild();
    const now = cur ? pvs.find(v => v.page === cur.page) : null;
    if (now) { if (hz) tx = off - now.x * scale; else ty = off - now.y * scale; }
    applyView();
    if (panelOpen) buildPanel();
  }

  function pushUndo(op) {
    undoStack.push(op);
    if (undoStack.length > 300) undoStack.shift();
    redoStack.length = 0;
    updateUndoUi();
  }

  function applyOp(op, inverse) {
    const pv = pvs.find(v => v.page.id === op.pageId);
    if (!pv) return;
    commitText();
    clearSel();
    removeItems(pv.page, inverse ? op.add : op.remove);
    addItems(pv.page, inverse ? op.remove : op.add);
    queueInk(pv);
    dirty(pv.page);
    if (!inRange(pv, 0)) scrollToPage(pvs.indexOf(pv));
  }

  function undo() {
    const op = undoStack.pop();
    if (!op) return;
    redoStack.push(op);
    applyOp(op, true);
    updateUndoUi();
  }

  function redo() {
    const op = redoStack.pop();
    if (!op) return;
    undoStack.push(op);
    applyOp(op, false);
    updateUndoUi();
  }

  function updateUndoUi() {
    undoBtn.disabled = undoBtn2.disabled = !undoStack.length;
    redoBtn.disabled = redoBtn2.disabled = !redoStack.length;
  }

  // ------------------------------------------------------------------ pointer input
  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button === 2) return;
    measure();
    pullHint.hidden = true;
    if (textEd || boxEd) { commitText(); return; } // this press just closes the text box
    try { vp.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const p = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, ignored: false };
    ptrs.set(e.pointerId, p);
    stopInertia();

    if (readOnly && e.pointerType !== 'touch') { // reading, not writing: the pen and the mouse just move the page
      if (e.pointerType === 'pen') lastPenT = performance.now();
      if (action) cancelAction();
      startPan(p);
      return;
    }
    if (e.pointerType === 'pen') {
      lastPenT = performance.now();
      if (!penSeen) { penSeen = true; prefs.penSeen = true; savePrefs(); }
      for (const q of ptrs.values()) if (q.type === 'touch') q.ignored = true; // resting palm
      // A stroke whose pen-up never arrived is kept, not thrown away.
      if (action && action.ptype === 'pen' && (action.tool === 'pen' || action.tool === 'hl')) {
        if (action.pid !== e.pointerId) ptrs.delete(action.pid);
        endAction(null);
      } else if (action) cancelAction();
      pan = null;
      if (pinch) { pinch = null; zooming = false; applyView(); }
      multiTap = null;
      const erasing = e.button === 5 || (e.buttons & 32) || e.button === 2 || (e.buttons & 2);
      if (dbg) dbgEv(e, erasing ? 'erase' : 'draw');
      startAction(e, erasing ? 'eraser' : null);
      return;
    }
    if (e.pointerType === 'mouse') {
      if (dbg) dbgEv(e, 'mouse');
      if (e.button === 1 || spaceDown) startPan(p);
      else if (e.button === 0) startAction(e);
      return;
    }
    // touch: anything that lands while the stylus is writing or hovering is the resting hand
    if ((action && action.ptype === 'pen') || performance.now() - lastPenT < PALM_MS) {
      p.ignored = true;
      if (dbg) dbgEv(e, 'palm');
      return;
    }
    const ts = [...ptrs.values()].filter(q => q.type === 'touch' && !q.ignored);
    if (dbg) dbgEv(e, ts.length >= 2 ? 'fingers ' + ts.length : fingerDraws() ? 'draw' : 'scroll');
    if (ts.length >= 2) {
      if (action) cancelAction();
      pan = null;
      if (!pinch) {
        startPinch(ts[0], ts[1]);
        if (ts.length === 2) multiTap = { t0: performance.now(), n: 2, moved: false, scale, tx, ty };
      }
      if (multiTap) multiTap.n = Math.max(multiTap.n, ts.length);
    } else if (fingerDraws() || touchOnSel(e)) startAction(e);
    else startPan(p);
  }

  function onMove(e) {
    if (e.pointerType === 'pen') lastPenT = performance.now();
    if (dbg) dbgEv(e);
    const p = ptrs.get(e.pointerId);
    if (!p) { hover(e); return; }
    p.x = e.clientX;
    p.y = e.clientY;
    if (p.ignored) return;
    if (multiTap && p.type === 'touch' && Math.hypot(p.x - p.x0, p.y - p.y0) > 14) multiTap.moved = true;
    if (action && action.pid === e.pointerId) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (evs && evs.length > 1) for (const ev of evs) actionMove(ev); else actionMove(e);
    } else if (pinch && (pinch.a === e.pointerId || pinch.b === e.pointerId)) movePinch();
    else if (pan && pan.pid === e.pointerId) movePan(e);
  }

  function onUp(e) {
    if (e.pointerType === 'pen') lastPenT = performance.now();
    if (dbg) dbgEv(e);
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    ptrs.delete(e.pointerId);
    if (action && action.pid === e.pointerId) {
      if (e.type !== 'pointercancel') endAction(e);
      // A cancelled pen or mouse stroke is still what was written, so it is kept; a cancelled finger stroke is not.
      else if (action.ptype !== 'touch' && (action.tool === 'pen' || action.tool === 'hl')) endAction(null);
      else cancelAction();
    } else if (pinch && (pinch.a === e.pointerId || pinch.b === e.pointerId)) {
      pinch = null;
      zooming = false;
      applyView();
      const rest = [...ptrs.values()].find(q => q.type === 'touch' && !q.ignored);
      if (rest) { startPan(rest); pan.moved = 99; }
    } else if (pan && pan.pid === e.pointerId) endPan(p, e);
    if (multiTap && ![...ptrs.values()].some(q => q.type === 'touch' && !q.ignored)) {
      const m = multiTap;
      multiTap = null;
      pan = null;
      if (!m.moved && e.type !== 'pointercancel' && performance.now() - m.t0 < 350) {
        // Two-finger tap = undo, three-finger tap = redo. Put back any slight zoom the tap caused.
        scale = m.scale; tx = m.tx; ty = m.ty;
        applyView();
        const can = m.n === 2 ? undoStack.length : redoStack.length;
        if (m.n === 2) undo(); else redo();
        toast(can ? (m.n === 2 ? 'Undo' : 'Redo') : (m.n === 2 ? 'Nothing to undo' : 'Nothing to redo'), 900);
      }
    }
  }

  function hover(e) {
    if (prefs.tool === 'eraser' && e.pointerType !== 'touch') showEraserCur(e.clientX, e.clientY);
    else eraserCur.hidden = true;
  }

  function showEraserCur(cx, cy) {
    const d = prefs.eraser.size * scale;
    Object.assign(eraserCur.style, {
      width: d + 'px', height: d + 'px',
      left: (cx - vpRect.left - d / 2) + 'px', top: (cy - vpRect.top - d / 2) + 'px'
    });
    eraserCur.hidden = false;
  }

  function onWheel(e) {
    e.preventDefault();
    measure();
    stopInertia();
    if (e.ctrlKey || e.metaKey) { zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01)); return; }
    const k = e.deltaMode === 1 ? 32 : 1;
    if (hz) {
      const cur = currentPv();
      if (!e.shiftKey && cur && cur.page.w * scale <= vpRect.width + 2) {
        // A whole page fits: the wheel turns pages instead of sliding them part of the way.
        const now = performance.now();
        wheelAcc += (e.deltaX + e.deltaY) * k;
        clearTimeout(wheelT);
        wheelT = setTimeout(() => { wheelAcc = 0; }, 220);
        if (now > wheelLock && Math.abs(wheelAcc) > 30) { goPage(wheelAcc > 0 ? 1 : -1); wheelLock = now + 380; wheelAcc = 0; }
        return;
      }
      if (e.shiftKey) ty -= e.deltaY * k; else { tx -= (e.deltaX + e.deltaY) * k; }
    } else if (e.shiftKey && !e.deltaX) tx -= e.deltaY * k;
    else { tx -= e.deltaX * k; ty -= e.deltaY * k; }
    applyView();
  }

  // --- pan / pinch
  function stopInertia() {
    if (inertiaRaf) { cancelAnimationFrame(inertiaRaf); inertiaRaf = 0; }
  }

  function startPan(p) {
    pan = { pid: p.id, x: p.x, y: p.y, vx: 0, vy: 0, t: performance.now(), t0: performance.now(), moved: 0, pull: 0, i0: hz ? pvs.indexOf(currentPv()) : null };
  }

  function movePan(e) {
    const t = performance.now(), dt = Math.max(1, t - pan.t);
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    pan.vx = pan.vx * 0.6 + (dx / dt) * 0.4;
    pan.vy = pan.vy * 0.6 + (dy / dt) * 0.4;
    pan.x = e.clientX;
    pan.y = e.clientY;
    pan.t = t;
    pan.moved += Math.abs(dx) + Math.abs(dy);
    tx += dx;
    const wantX = tx, want = ty + dy;
    ty = want;
    applyView();
    // Dragging past the end of the last page (up, or left when side by side): keep count of how far, to offer a new page.
    const over = hz ? tx - wantX : ty - want;
    if (over > 0.5) pan.pull += over; else if ((hz ? dx : dy) > 0) pan.pull = 0;
    pullHint.hidden = pan.pull < 14;
    pullHint.textContent = pan.pull >= PULL_PX ? 'Release to add a page' : hz ? 'Pull left to add a page' : 'Pull up to add a page';
    pullHint.classList.toggle('go', pan.pull >= PULL_PX);
  }

  function endPan(p, e) {
    const pn = pan;
    pan = null;
    pullHint.hidden = true;
    if (pn.pull >= PULL_PX) { addPageAfter(pvs[pvs.length - 1]); return; }
    const now = performance.now();
    if ((p.type === 'touch' || readOnly) && pn.moved < 8 && now - pn.t0 < 350) { tapAt(e.clientX, e.clientY); return; }
    if (snapPage(now - pn.t > 90 ? 0 : pn.vx, pn.i0)) return;
    if (p.type !== 'touch' || now - pn.t > 90) return;
    let vx = pn.vx, vy = pn.vy;
    if (Math.hypot(vx, vy) < 0.15) return;
    let last = now;
    const step = () => {
      const t = performance.now(), dt = Math.min(40, t - last);
      last = t;
      const bx = tx, by = ty;
      tx += vx * dt;
      ty += vy * dt;
      applyView();
      const f = Math.pow(0.997, dt);
      vx *= f;
      vy *= f;
      if (Math.hypot(vx, vy) < 0.02 || (tx === bx && ty === by)) { inertiaRaf = 0; return; }
      inertiaRaf = requestAnimationFrame(step);
    };
    inertiaRaf = requestAnimationFrame(step);
  }

  function startPinch(a, b) {
    pinch = {
      a: a.id, b: b.id,
      d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
      mx0: (a.x + b.x) / 2 - vpRect.left, my0: (a.y + b.y) / 2 - vpRect.top,
      tx0: tx, ty0: ty, s0: scale
    };
    zooming = true;
  }

  function movePinch() {
    const a = ptrs.get(pinch.a), b = ptrs.get(pinch.b);
    if (!a || !b) return;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2 - vpRect.left, my = (a.y + b.y) / 2 - vpRect.top;
    scale = clamp(pinch.s0 * d / pinch.d0, MIN_S, MAX_S);
    const k = scale / pinch.s0;
    tx = mx - (pinch.mx0 - pinch.tx0) * k;
    ty = my - (pinch.my0 - pinch.ty0) * k;
    applyView();
  }

  // A quick finger tap while fingers are set to pan (stylus devices).
  function tapAt(cx, cy) {
    const pv = pvAt(cx, cy);
    const [x, y] = toPage(pv, cx, cy);
    if (prefs.tool === 'text' && !readOnly) textTap(pv, x, y);
    else if (prefs.tool === 'lasso' && !readOnly) {
      const it = topItemAt(pv.page, x, y);
      clearSel();
      if (it) setSel(pv, [it]);
    } else {
      if (tapThing(pv, x, y)) { lastTap = null; return; }
      // Double tap: zoom in on that spot, or back out to the full page width.
      const now = performance.now();
      if (lastTap && now - lastTap.t < 320 && Math.hypot(cx - lastTap.x, cy - lastTap.y) < 40) {
        lastTap = null;
        const fit = fitScale(pv.page);
        zoomAt(cx, cy, Math.abs(scale - fit) / fit > 0.15 ? fit / scale : 2);
      } else lastTap = { t: now, x: cx, y: cy };
    }
  }

  function selHit(pv, x, y) {
    if (!sel || sel.pv !== pv) return null;
    const b = sel.b, hs = 18 / scale;
    if (Math.abs(x - (b.x + b.w)) < hs && Math.abs(y - (b.y + b.h)) < hs) return 'scale';
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return 'move';
    return null;
  }

  function touchOnSel(e) {
    if (!sel || prefs.tool !== 'lasso') return false;
    const [x, y] = toPage(sel.pv, e.clientX, e.clientY);
    return !!selHit(sel.pv, x, y);
  }

  // ------------------------------------------------------------------ tool actions
  // map is given when the press is in the zoom window: it turns screen positions there into page positions.
  function startAction(e, forceTool, map) {
    const tool = forceTool || prefs.tool;
    const pv = map ? zw.pv : (tool === 'lasso' && sel && touchOnSelPoint(e)) ? sel.pv : pvAt(e.clientX, e.clientY);
    const [x, y] = map ? map(e.clientX, e.clientY) : toPage(pv, e.clientX, e.clientY);
    if (tool !== 'lasso' && sel) clearSel();
    action = {
      tool, pid: e.pointerId, ptype: e.pointerType, pv, x0: x, y0: y, cx0: e.clientX, cy0: e.clientY, far: false,
      map: map || null, sc: map ? zw.zs : scale // sc = screen pixels per page unit where the pointer is
    };
    if (tool === 'pen' || tool === 'hl') beginStroke(e, x, y);
    else if (tool === 'eraser') beginErase(e, x, y);
    else if (tool === 'lasso') beginLasso(x, y);
    else if (tool === 'shape') { action.c = useLive(pv); action.x1 = x; action.y1 = y; }
    else if (tool === 'tape') { action.c = useLive(pv); live.classList.add('plain'); action.x1 = x; action.y1 = y; }
    else if (tool === 'laser') beginLaser(e);
  }

  // Where the pointer is on the page being worked on.
  const apt = (a, e) => (a.map ? a.map(e.clientX, e.clientY) : toPage(a.pv, e.clientX, e.clientY));
  const ctxs = a => (a.c2 ? [a.c, a.c2] : [a.c]);
  // Show one unfinished item (a straightened line, a tidied shape, highlighter) on the live layer(s).
  function liveItem(a, item) {
    nextLive(() => { clearLive(); for (const c of ctxs(a)) R.drawItem(c, item); });
  }

  function touchOnSelPoint(e) {
    const [x, y] = toPage(sel.pv, e.clientX, e.clientY);
    return !!selHit(sel.pv, x, y);
  }

  function actionMove(e) {
    const a = action;
    if (!a.far && Math.hypot(e.clientX - a.cx0, e.clientY - a.cy0) > 4) a.far = true;
    if (a.tool === 'pen' || a.tool === 'hl') moveStroke(e);
    else if (a.tool === 'eraser') moveErase(e);
    else if (a.tool === 'lasso') moveLasso(e);
    else if (a.tool === 'shape') moveShape(e);
    else if (a.tool === 'tape') moveTape(e);
    else if (a.tool === 'laser') moveLaser(e);
  }

  function endAction(e) {
    const a = action;
    action = null;
    if (a.tool === 'pen' || a.tool === 'hl') endStroke(a, e);
    else if (a.tool === 'eraser') endErase(a, e);
    else if (a.tool === 'lasso') endLasso(a);
    else if (a.tool === 'shape') endShape(a);
    else if (a.tool === 'tape') endTape(a);
    else if (a.tool === 'laser') { a.ls.end = performance.now(); if (!a.far) tapThing(a.pv, a.x0, a.y0); }
    else if (a.tool === 'text' && !a.far) textTap(a.pv, a.x0, a.y0);
    if (pendingRebuild) remoteRebuild();
  }

  // Abandon an unfinished gesture (a second finger arrived, the pen took over, the OS cancelled it).
  function cancelAction() {
    const a = action;
    action = null;
    if (!a) return;
    clearTimeout(a.holdT);
    if (dbg && (a.tool === 'pen' || a.tool === 'hl')) dbgCount('strokes discarded');
    if (a.tool === 'eraser') endErase(a, null);
    else if (a.tool === 'lasso' && a.mode !== 'draw') endLasso(a);
    else if (a.tool === 'laser') a.ls.end = performance.now();
    else clearLive();
    if (a.tool === 'tape') live.classList.remove('plain');
    if (a.rule && ruler) rulerLabel();
    if (pendingRebuild) remoteRebuild();
  }

  // --- pen & highlighter
  const pressureOf = e => (e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5);

  // Pen styles only change how pressure is recorded, so every device draws the result the same way:
  // ballpoint = even line, fountain = follows pressure, brush = exaggerates it.
  function inkPressure(a, e) {
    const p = pressureOf(e);
    if (a.style === 'ball') return 0.5;
    if (a.style === 'brush') return clamp(0.05 + p * 1.6, 0.05, 1.4);
    return p;
  }

  // Hold the pen still at the end of a line and it snaps straight.
  function holdCheck(a, e) {
    if (a.line || a.snap || a.rule) return;
    if (a.holdT && Math.hypot(e.clientX - a.hx, e.clientY - a.hy) < 6) return;
    a.hx = e.clientX;
    a.hy = e.clientY;
    clearTimeout(a.holdT);
    a.holdT = setTimeout(() => straighten(a), 550);
  }

  function straighten(a) {
    if (action !== a || a.line) return;
    const P = a.pts, n = P.length / 3;
    if (n < 4) return;
    const x0 = P[0], y0 = P[1], x1 = P[P.length - 3], y1 = P[P.length - 2];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 24 / a.sc) { if (a.tool === 'pen') snapShape(a); return; } // ends close together: perhaps a closed shape
    let dev = 0, sum = 0;
    for (let i = 0; i < P.length; i += 3) {
      dev = Math.max(dev, Math.abs((P[i] - x0) * (y1 - y0) - (P[i + 1] - y0) * (x1 - x0)) / len);
      sum += P[i + 2];
    }
    if (dev > Math.max(3 / a.sc, len * 0.09)) { // not a line: maybe a closed shape, otherwise leave the handwriting alone
      if (a.tool === 'pen') snapShape(a);
      return;
    }
    a.line = true;
    const p = Math.round(sum / n * 100) / 100;
    a.pts = [x0, y0, p, x1, y1, p];
    drawLine(a);
  }

  // A closed outline held still at the end is tidied into a circle/ellipse, rectangle, triangle or four-sided shape.
  function snapShape(a) {
    const P = a.pts, pts = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, len = 0;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1];
      if (i) len += Math.hypot(x - P[i - 3], y - P[i - 2]);
      pts.push([x, y]);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const diag = Math.hypot(x1 - x0, y1 - y0), n = pts.length;
    if (diag < 30 / a.sc || len < 2.2 * diag) return;
    if (Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]) > 0.25 * diag) return; // not closed

    // Corners: simplify the outline, then drop points that sit on a nearly straight run.
    const keep = new Set([0, n - 1]);
    const rdp = (i, j) => {
      let worst = 0, at = -1;
      for (let k = i + 1; k < j; k++) {
        const d = distSeg(pts[k][0], pts[k][1], pts[i][0], pts[i][1], pts[j][0], pts[j][1]);
        if (d > worst) { worst = d; at = k; }
      }
      if (worst > diag * 0.07) { keep.add(at); rdp(i, at); rdp(at, j); }
    };
    rdp(0, n - 1);
    let v = [...keep].sort((p, q) => p - q).map(i => pts[i]);
    v.pop(); // the end meets the start
    const turn = (p, q, r) => {
      const a1 = Math.atan2(p[1] - q[1], p[0] - q[0]), a2 = Math.atan2(r[1] - q[1], r[0] - q[0]);
      let d = Math.abs(a1 - a2);
      if (d > Math.PI) d = 2 * Math.PI - d;
      return d; // interior angle at q
    };
    for (let pass = 0; pass < 2 && v.length > 3; pass++) {
      v = v.filter((q, i) => turn(v[(i + v.length - 1) % v.length], q, v[(i + 1) % v.length]) < 2.6 || v.length <= 3);
    }

    let item = null;
    const r2 = x => Math.round(x * 100) / 100;
    if (v.length === 3 || v.length === 4) {
      const square = v.length === 4 && v.every((q, i) => {
        const r = v[(i + 1) % 4], ang = Math.abs(Math.atan2(r[1] - q[1], r[0] - q[0])) % (Math.PI / 2);
        return Math.min(ang, Math.PI / 2 - ang) < 0.32;
      });
      if (square) item = { t: 'sh', k: 'rect', x1: r2(x0), y1: r2(y0), x2: r2(x1), y2: r2(y1), c: a.color, w: a.size };
      else {
        const p = [];
        v.forEach((q, i) => {
          const r = v[(i + 1) % v.length], steps = Math.max(2, Math.ceil(Math.hypot(r[0] - q[0], r[1] - q[1]) / 2));
          for (let s = 0; s < steps; s++) p.push(r2(q[0] + (r[0] - q[0]) * s / steps), r2(q[1] + (r[1] - q[1]) * s / steps), 0.5);
        });
        p.push(r2(v[0][0]), r2(v[0][1]), 0.5);
        item = { t: 's', tool: 'pen', c: a.color, w: a.size, p };
      }
    } else {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      let rx = (x1 - x0) / 2, ry = (y1 - y0) / 2, dev = 0;
      if (rx < 4 || ry < 4) return;
      for (const [x, y] of pts) dev += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
      if (dev / n > 0.16) return;
      if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.14) rx = ry = (rx + ry) / 2; // nearly round: make it a true circle
      item = { t: 'sh', k: 'ellipse', x1: r2(cx - rx), y1: r2(cy - ry), x2: r2(cx + rx), y2: r2(cy + ry), c: a.color, w: a.size };
    }
    a.snap = item;
    liveItem(a, item);
  }

  function drawLine(a) {
    liveItem(a, { t: 's', tool: a.tool, c: a.color, w: a.size, p: a.pts, st: a.style === 'pencil' ? 'pencil' : undefined });
  }

  // A zigzag drawn over existing ink erases it instead of adding more ink. Returns the items to erase, or null.
  function scribbleTargets(a) {
    const P = a.pts, n = P.length / 3;
    if (n < 12) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, len = 0;
    for (let i = 0; i < P.length; i += 3) {
      x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]);
      if (i) len += Math.hypot(P[i] - P[i - 3], P[i + 1] - P[i - 2]);
    }
    const bw = x1 - x0, bh = y1 - y0;
    if (len < 2.6 * (bw + bh)) return null;
    // Count the times the line turns back on itself along one axis (small wobbles do not count).
    const turns = (o, span) => {
      const hyst = Math.max(4, span * 0.3);
      let dir = 0, ext = P[o], count = 0;
      for (let i = 3; i < P.length; i += 3) {
        const v = P[i + o];
        if (dir >= 0 && v > ext) { ext = v; if (!dir && v - P[o] > hyst) dir = 1; }
        else if (dir <= 0 && v < ext) { ext = v; if (!dir && P[o] - v > hyst) dir = -1; }
        else if (dir && Math.abs(v - ext) > hyst) { dir = -dir; ext = v; count++; }
      }
      return count;
    };
    if (Math.max(turns(0, bw), turns(1, bh)) < 4) return null;
    // Only ink lying mostly inside the scribbled area goes, so writing that merely touches a neighbour is safe.
    const r = Math.max(2, a.size), pad = 4, out = [];
    for (const it of a.pv.page.items) {
      if (it.t !== 's' && it.t !== 'sh') continue;
      const b = R.bounds(it);
      if (b.x > x1 || b.x + b.w < x0 || b.y > y1 || b.y + b.h < y0) continue;
      const ix = Math.min(b.x + b.w, x1 + pad) - Math.max(b.x, x0 - pad), iy = Math.min(b.y + b.h, y1 + pad) - Math.max(b.y, y0 - pad);
      if (ix * iy < 0.65 * b.w * b.h) continue;
      for (let i = 0; i < P.length; i += 3) if (R.hitsCircle(it, P[i], P[i + 1], r)) { out.push(it); break; }
    }
    return out.length ? out : null;
  }

  function beginStroke(e, x, y) {
    const a = action, t = prefs[a.tool];
    a.c = useLive(a.pv);
    a.c2 = a.map ? zliveCtx() : null; // the same stroke, drawn in the zoom window as it is written
    a.color = inkFor(a.pv, t.color);
    a.size = t.size;
    a.style = a.tool === 'pen' ? (t.style || 'fountain') : null;
    a.sp = inkPressure(a, e);
    // Started beside the ruler: the whole stroke runs along its edge.
    a.rule = !a.map && ruler ? ruleFor(a.pv, e.clientX, e.clientY, a.size) : null;
    if (a.rule) [x, y] = onRule(a.rule, x, y);
    a.pts = [x, y, a.sp];
    holdCheck(a, e);
    a.lw = R.pw({ w: a.size }, a.sp);
    a.lx = x;
    a.ly = y;
    for (const c of ctxs(a)) {
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.strokeStyle = c.fillStyle = R.inkPaint(c, a.color, a.style);
      if (a.tool === 'pen') {
        c.beginPath();
        c.arc(x, y, R.pw({ w: a.size }, a.sp) / 2, 0, 6.2832);
        c.fill();
      }
    }
  }

  function moveStroke(e) {
    const a = action, P = a.pts, n = P.length;
    if (a.snap) return; // already tidied into a shape
    let [x, y] = apt(a, e);
    if (a.line) { // snapped straight: the far end follows the pen
      P[3] = x;
      P[4] = y;
      drawLine(a);
      return;
    }
    if (a.rule) {
      [x, y] = onRule(a.rule, x, y);
      if (ruler) rulerLabel(Math.hypot(x - P[0], y - P[1]));
    }
    holdCheck(a, e);
    const px = P[n - 3], py = P[n - 2];
    if (Math.hypot(x - px, y - py) < 0.7 / a.sc) return;
    // light smoothing: steadier lines without visible lag
    const k = a.ptype === 'pen' ? 0.78 : 0.6;
    x = px + (x - px) * k;
    y = py + (y - py) * k;
    a.sp += (inkPressure(a, e) - a.sp) * 0.35; // pressure is eased in, so the line swells and thins gradually
    P.push(x, y, a.sp);
    if (a.tool === 'hl') {
      liveItem(a, { t: 's', tool: 'hl', c: a.color, w: a.size, p: P });
      return;
    }
    const m = P.length;
    if (m >= 9) {
      const cx = P[m - 6], cy = P[m - 5];
      const mx = (cx + x) / 2, my = (cy + y) / 2;
      const w1 = R.pw({ w: a.size }, (P[m - 4] + P[m - 1]) / 2);
      for (const c of ctxs(a)) R.inkSeg(c, a.lx, a.ly, cx, cy, mx, my, a.lw, w1);
      a.lw = w1;
      a.lx = mx;
      a.ly = my;
    }
  }

  // When the pen lifts, the line is evened out a little: each point moves a quarter of the way towards its
  // neighbours (twice for pressure), which takes out hand tremor and sensor jitter but keeps the letter shapes.
  function settle(P) {
    const n = P.length / 3;
    if (n < 5) return P;
    const o = P.slice();
    for (let i = 1; i < n - 1; i++) for (let k = 0; k < 3; k++) o[i * 3 + k] = (P[i * 3 - 3 + k] + 2 * P[i * 3 + k] + P[i * 3 + 3 + k]) / 4;
    for (let i = 1; i < n - 1; i++) P[i * 3 + 2] = (o[i * 3 - 1] + 2 * o[i * 3 + 2] + o[i * 3 + 5]) / 4;
    for (let i = 1; i < n - 1; i++) o[i * 3 + 2] = P[i * 3 + 2];
    return o;
  }

  // e is null when the stroke is closed without a proper pen-up (the system cancelled or lost it).
  function endStroke(a, e) {
    const page = a.pv.page;
    clearTimeout(a.holdT);
    if (e && !a.line && !a.snap) {
      // Smoothing trails slightly behind the tip, so finish exactly where the pen lifted.
      let [ex, ey] = apt(a, e);
      if (a.rule) [ex, ey] = onRule(a.rule, ex, ey);
      const n = a.pts.length;
      if (Math.hypot(ex - a.pts[n - 3], ey - a.pts[n - 2]) > 0.5 / a.sc) a.pts.push(ex, ey, a.sp);
    }
    if (a.rule && ruler) rulerLabel();
    const gone = a.tool === 'pen' && !a.line && !a.snap && !a.rule && prefs.scribble !== false ? scribbleTargets(a) : null;
    if (gone) {
      removeItems(page, gone);
      clearLive();
      queueInk(a.pv);
      pushUndo({ pageId: page.id, add: [], remove: gone });
      dirty(page);
      if (dbg) dbgCount('scribble erases');
      return;
    }
    if (dbg) dbgCount('strokes saved');
    if (!a.line && !a.snap && !a.rule) a.pts = settle(a.pts);
    const it = a.snap ? { ...a.snap, id: uid(), z: nextZ(), m: Date.now() } : {
      id: uid(), t: 's', tool: a.tool, c: a.color, w: a.size,
      p: a.pts.map(v => Math.round(v * 100) / 100), z: nextZ(), m: Date.now(),
      ...(a.style === 'pencil' ? { st: 'pencil' } : {})
    };
    addItems(page, [it]);
    if (a.pv.rs) {
      const c = a.pv.ink.getContext('2d');
      xf(c, a.pv);
      if (a.tool === 'hl') c.globalCompositeOperation = 'destination-over'; // highlighter goes under ink
      R.drawItem(c, it);
      c.globalCompositeOperation = 'source-over';
    }
    if (a.map) zoomPaint(); // so the stroke does not blink in the zoom window when the live layer is wiped
    clearLive();
    pushUndo({ pageId: page.id, add: [it], remove: [] });
    dirty(page);
  }

  // --- eraser
  function beginErase(e, x, y) {
    const a = action;
    a.removed = new Map();
    a.added = new Map();
    a.lx = x;
    a.ly = y;
    eraseAt(a, x, y);
    if (!a.map) showEraserCur(e.clientX, e.clientY);
  }

  function moveErase(e) {
    const a = action;
    const [x, y] = apt(a, e);
    const r = prefs.eraser.size / 2;
    const steps = Math.max(1, Math.ceil(Math.hypot(x - a.lx, y - a.ly) / (r * 0.5)));
    for (let i = 1; i <= steps; i++) eraseAt(a, a.lx + (x - a.lx) * i / steps, a.ly + (y - a.ly) * i / steps);
    a.lx = x;
    a.ly = y;
    if (!a.map) showEraserCur(e.clientX, e.clientY);
  }

  function eraseAt(a, x, y) {
    const page = a.pv.page, r = prefs.eraser.size / 2;
    const precise = prefs.eraser.mode === 'precise';
    let hit = false;
    const out = [];
    const only = prefs.eraser.only || 'all';
    const skip = it => (it.t !== 's' && it.t !== 'sh' && it.t !== 'tp')
      || (only === 'hl' && !(it.t === 's' && it.tool === 'hl'))   // highlighter only
      || (only === 'pen' && it.t === 's' && it.tool === 'hl');    // everything but highlighter
    for (const it of page.items) {
      if (skip(it) || !R.hitsCircle(it, x, y, r)) { out.push(it); continue; }
      hit = true;
      if (a.added.has(it.id)) a.added.delete(it.id); else a.removed.set(it.id, it);
      page.dels[it.id] = Date.now();
      if (precise && it.t === 's') {
        for (const piece of R.splitStroke(it, x, y, r)) { out.push(piece); a.added.set(piece.id, piece); }
      }
    }
    if (hit) { page.items = out; queueInk(a.pv); }
  }

  function endErase(a, e) {
    if (!e || e.pointerType === 'touch') eraserCur.hidden = true;
    if (!a.removed.size && !a.added.size) return;
    pushUndo({ pageId: a.pv.page.id, remove: [...a.removed.values()], add: [...a.added.values()] });
    dirty(a.pv.page);
  }

  // --- lasso & selection
  function topItemAt(page, x, y, type) {
    for (let i = page.items.length - 1; i >= 0; i--) {
      const it = page.items[i];
      if (type && it.t !== type) continue;
      if (it.t === 'tx' || it.t === 'im' || it.t === 'nt' || it.t === 'tb') {
        const b = R.bounds(it);
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return it;
      } else if (R.hitsCircle(it, x, y, 7 / scale)) return it;
    }
    return null;
  }

  function beginLasso(x, y) {
    const a = action;
    const hit = selHit(a.pv, x, y);
    if (hit) { a.mode = hit; return; }
    clearSel();
    a.mode = 'draw';
    a.poly = [x, y];
    a.c = useLive(a.pv);
  }

  function moveLasso(e) {
    const a = action;
    const [x, y] = toPage(a.pv, e.clientX, e.clientY);
    if (a.mode === 'draw') {
      a.poly.push(x, y);
      nextLive(() => {
        clearLive();
        const c = a.c, P = a.poly;
        c.beginPath();
        c.moveTo(P[0], P[1]);
        for (let i = 2; i < P.length; i += 2) c.lineTo(P[i], P[i + 1]);
        c.lineWidth = 1.4 / scale;
        c.setLineDash([5 / scale, 4 / scale]);
        c.strokeStyle = '#2f6f5e';
        c.stroke();
        c.setLineDash([]);
      });
      return;
    }
    if (a.mode === 'move') {
      sel.dx = x - a.x0;
      sel.dy = y - a.y0;
    } else {
      const b = sel.b;
      sel.k = clamp(Math.max((x - b.x) / b.w, (y - b.y) / b.h), 0.1, 12);
    }
    nextLive(drawSelLive);
    positionOverlays();
  }

  function endLasso(a) {
    if (a.mode !== 'draw') { commitSelTransform(); return; }
    clearLive();
    const page = a.pv.page;
    if (!a.far) {
      const it = topItemAt(page, a.x0, a.y0);
      if (it) setSel(a.pv, [it]);
      else { const ln = linkAt(a.pv, a.x0, a.y0); if (ln) followLink(a.pv, ln); }
      return;
    }
    const items = page.items.filter(it => R.inLasso(it, a.poly));
    if (items.length) setSel(a.pv, items);
  }

  function setSel(pv, items) {
    const u = R.unionBounds(items), pad = 5;
    sel = {
      pv, items, ids: new Set(items.map(i => i.id)),
      b: { x: u.x - pad, y: u.y - pad, w: u.w + 2 * pad, h: u.h + 2 * pad },
      k: 1, dx: 0, dy: 0
    };
    live.classList.toggle('plain', items.every(it => it.t === 'im' || it.t === 'tp'));
    paintInk(pv);
    drawSelLive();
    buildSelBar();
    selBox.hidden = false;
    selBar.hidden = false;
    positionOverlays();
  }

  function drawSelLive() {
    if (!sel) return;
    const pv = sel.pv, b = sel.b, k = sel.k;
    const c = useLive(pv);
    clearLive();
    const ox = pv.clip ? pv.clip.x : 0, oy = pv.clip ? pv.clip.y : 0;
    c.setTransform(pv.rs * k, 0, 0, pv.rs * k, pv.rs * (b.x * (1 - k) + sel.dx - ox), pv.rs * (b.y * (1 - k) + sel.dy - oy));
    R.drawItems(c, sel.items);
    R.drawTapes(c, sel.items);
    xf(c, pv);
  }

  function commitSelTransform() {
    if (!sel) return;
    const { k, dx, dy, b, pv } = sel;
    if (k === 1 && !dx && !dy) return;
    const old = sel.items;
    const nu = old.map(it => R.transformItem(it, k, b.x, b.y, dx, dy));
    replaceSel(old, nu);
  }

  // Swap the selected items for edited versions (same ids) as one undoable step.
  function replaceSel(old, nu) {
    const pv = sel.pv;
    removeItems(pv.page, old);
    addItems(pv.page, nu);
    pushUndo({ pageId: pv.page.id, remove: old, add: nu });
    dirty(pv.page);
    setSel(pv, nu);
  }

  function clearSel() {
    if (!sel) return;
    const pv = sel.pv;
    sel = null;
    clearLive();
    live.classList.remove('plain');
    paintInk(pv);
    selBox.hidden = true;
    selBar.hidden = true;
  }

  function deleteSel() {
    if (!sel) return;
    const { pv, items } = sel;
    removeItems(pv.page, items);
    pushUndo({ pageId: pv.page.id, remove: items, add: [] });
    dirty(pv.page);
    clearSel();
  }

  function duplicateSel() {
    if (!sel) return;
    const pv = sel.pv;
    const copies = sel.items.map(it => ({ ...R.transformItem(it, 1, 0, 0, 14, 14), id: uid(), z: nextZ() }));
    clearSel();
    addItems(pv.page, copies);
    pushUndo({ pageId: pv.page.id, add: copies, remove: [] });
    dirty(pv.page);
    setSel(pv, copies);
  }

  // --- copy / paste (works across pages and notebooks; kept in the local database so it survives switching)
  async function copySel(cut) {
    if (!sel) return;
    clipItems = sel.items.map(it => ({ ...it, p: it.p ? it.p.slice() : undefined }));
    db.setMeta('clip', clipItems).catch(() => {});
    const n = clipItems.length;
    if (cut) deleteSel();
    toast(`${cut ? 'Cut' : 'Copied'} ${n} item${n > 1 ? 's' : ''}. Use Paste in the Select tool, on any page or notebook.`, 2600);
    if (prefs.tool === 'lasso') renderOpts();
  }

  async function pasteClip() {
    const src = clipItems || await db.getMeta('clip');
    if (!src || !src.length) { toast('Nothing copied yet.'); return; }
    await placeItems(src);
  }

  // Put copies of items in the middle of the view (kept inside the page) and select them.
  async function placeItems(src) {
    commitText();
    clearSel();
    measure();
    const pv = currentPv(), pg = pv.page, u = R.unionBounds(src);
    // centre of the view, kept inside the page
    const [vx, vy] = viewCentre(pv);
    const dx = clamp(vx - u.w / 2, 4, Math.max(4, pg.w - u.w - 4)) - u.x, dy = clamp(vy - u.h / 2, 4, Math.max(4, pg.h - u.h - 4)) - u.y;
    await Promise.all(src.filter(it => it.t === 'im').map(it => R.loadImage(it.a)));
    const items = src.map(it => ({ ...R.transformItem(it, 1, 0, 0, dx, dy), id: uid(), z: nextZ() }));
    addItems(pg, items);
    pushUndo({ pageId: pg.id, add: items, remove: [] });
    dirty(pg);
    setTool('lasso');
    setSel(pv, items);
  }

  function rotateSel() {
    if (!sel) return;
    const b = sel.b, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const old = sel.items;
    replaceSel(old, old.map(it => R.rotateItem(it, cx, cy)));
  }

  // The selected area as a picture (paper and everything on it), to save, share or copy.
  async function selPicture() {
    if (!sel) return;
    const { pv, b } = sel, pg = pv.page;
    const x = clamp(b.x, 0, pg.w), y = clamp(b.y, 0, pg.h), w = Math.min(pg.w, b.x + b.w) - x, hgt = Math.min(pg.h, b.y + b.h) - y;
    if (w < 2 || hgt < 2) return;
    const k = Math.min(4, 2600 / Math.max(w, hgt));
    const whole = document.createElement('canvas');
    await R.renderPageTo(pg, whole, pg.w * k);
    const c = document.createElement('canvas');
    c.width = Math.round(w * k);
    c.height = Math.round(hgt * k);
    c.getContext('2d').drawImage(whole, -Math.round(x * k), -Math.round(y * k));
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    if (!blob) { toast('Could not make the picture.'); return; }
    const name = safeName(doc.title) + ' selection.png';
    const file = new File([blob], name, { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const actions = [{ label: 'Download', onClick: () => { downloadBlob(blob, name); } }];
    if (navigator.clipboard && window.ClipboardItem) {
      actions.push({
        label: 'Copy', onClick: async () => {
          try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Picture copied'); } catch { toast('This browser would not copy the picture. Use Download.'); }
        }
      });
    }
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      actions.push({ label: 'Share', primary: true, onClick: async () => { try { await navigator.share({ files: [file] }); } catch { /* cancelled */ } } });
    }
    modal({
      title: 'Selection as a picture', wide: true,
      body: h('div', { class: 'crop-wrap' }, h('img', { class: 'shot', src: url })),
      actions, onClose: () => setTimeout(() => URL.revokeObjectURL(url), 2000)
    });
  }

  function recolorSel(color) {
    if (!sel) return;
    const old = sel.items;
    replaceSel(old, old.map(it => (it.t === 'im' ? it : { ...it, c: color, m: Date.now() })));
  }

  // Crop a picture: drag the corners of the frame over the whole original image.
  async function cropDialog(it) {
    const src = await R.loadImage(it.a);
    if (!src) { toast('That picture has not finished downloading yet.'); return; }
    const old = it.cr || [0, 0, 1, 1];
    let [l, t, w, hh] = old;
    const box = h('div', { class: 'crop-box' }, ['nw', 'ne', 'sw', 'se'].map(c => h('div', { class: 'crop-h ' + c, 'data-c': c })));
    const stage = h('div', { class: 'crop-stage' }, h('img', { class: 'crop-img', src: src.src, draggable: false }), box);
    const show = () => Object.assign(box.style, { left: l * 100 + '%', top: t * 100 + '%', width: w * 100 + '%', height: hh * 100 + '%' });
    show();
    let drag = null;
    stage.addEventListener('pointerdown', e => {
      const c = e.target.getAttribute('data-c');
      if (!c && e.target !== box) return;
      e.preventDefault();
      try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const r = stage.getBoundingClientRect();
      drag = { c: c || 'move', x: e.clientX, y: e.clientY, l, t, w, hh, rw: r.width, rh: r.height };
    });
    stage.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = (e.clientX - drag.x) / drag.rw, dy = (e.clientY - drag.y) / drag.rh, min = 0.05;
      let x0 = drag.l, y0 = drag.t, x1 = drag.l + drag.w, y1 = drag.t + drag.hh;
      if (drag.c === 'move') {
        const mx = clamp(dx, -x0, 1 - x1), my = clamp(dy, -y0, 1 - y1);
        x0 += mx; x1 += mx; y0 += my; y1 += my;
      } else {
        if (drag.c[1] === 'w') x0 = clamp(x0 + dx, 0, x1 - min); else x1 = clamp(x1 + dx, x0 + min, 1);
        if (drag.c[0] === 'n') y0 = clamp(y0 + dy, 0, y1 - min); else y1 = clamp(y1 + dy, y0 + min, 1);
      }
      l = x0; t = y0; w = x1 - x0; hh = y1 - y0;
      show();
    });
    const drop = () => { drag = null; };
    stage.addEventListener('pointerup', drop);
    stage.addEventListener('pointercancel', drop);
    const apply = () => {
      if (!sel || sel.items.length !== 1 || sel.items[0] !== it) return;
      const r2 = v => Math.round(v * 100) / 100, r4 = v => Math.round(v * 1e4) / 1e4;
      const odd = (it.r || 0) % 2; // turned on its side: the box's width shows the picture's height
      const ux = (odd ? it.h : it.w) / old[2], uy = (odd ? it.w : it.h) / old[3]; // page units per whole picture: it keeps its size on the page
      const nu = { ...it, x: r2(it.x + (l - old[0]) * ux), y: r2(it.y + (t - old[1]) * uy), w: r2(w * ux), h: r2(hh * uy), m: Date.now() };
      if (it.r) { // a rotated picture stays centred where it was
        nu.w = r2(odd ? hh * uy : w * ux);
        nu.h = r2(odd ? w * ux : hh * uy);
        nu.x = r2(it.x + it.w / 2 - nu.w / 2);
        nu.y = r2(it.y + it.h / 2 - nu.h / 2);
      }
      if (l < 0.002 && t < 0.002 && w > 0.998 && hh > 0.998) delete nu.cr; else nu.cr = [r4(l), r4(t), r4(w), r4(hh)];
      replaceSel([it], [nu]);
    };
    modal({
      title: 'Crop picture',
      wide: true,
      body: h('div', { class: 'crop-wrap' }, stage),
      actions: [
        { label: 'Whole picture', onClick: () => { l = 0; t = 0; w = 1; hh = 1; show(); return false; } },
        { label: 'Cancel' },
        { label: 'Crop', primary: true, onClick: apply }
      ]
    });
  }

  function buildSelBar() {
    const one = sel.items.length === 1 ? sel.items[0] : null;
    const kids = [];
    if (sel.items.some(it => it.t !== 'im')) {
      const notes = sel.items.every(it => it.t === 'nt');
      kids.push(h('button', {
        class: 'ic', type: 'button', title: 'Colour', html: I.palette,
        onclick: e => {
          let close = () => {};
          close = popover(e.currentTarget, h('div', { class: 'swrow' }, (notes ? NOTE_COLORS : PEN_COLORS.concat(HL_COLORS.slice(0, 3))).map(c =>
            h('button', { class: 'sw', type: 'button', style: { '--c': c }, onclick: () => { close(); if (notes) { prefs.noteColor = c; savePrefs(); } recolorSel(c); } }))));
        }
      }));
    }
    if (one && one.t === 'tx') {
      kids.push(h('button', {
        class: 'ic', type: 'button', title: 'Edit text', html: I.edit,
        onclick: () => { const pv = sel.pv; clearSel(); startText(pv, one); }
      }));
    }
    if (one && one.t === 'nt') {
      kids.push(h('button', {
        class: 'ic', type: 'button', title: one.fo ? 'Open the note' : 'Type in the note', html: I.edit,
        onclick: () => { const pv = sel.pv; if (one.fo) { replaceSel([one], [(() => { const o = { ...one, m: Date.now() }; delete o.fo; return o; })()]); return; } clearSel(); boxStart(pv, one, 'nt'); }
      }));
    }
    if (one && one.t === 'tb') {
      kids.push(h('button', { class: 'ic', type: 'button', title: 'Type in the cells', html: I.edit, onclick: () => { const pv = sel.pv; clearSel(); boxStart(pv, one, 'tb', 0, 0); } }));
    }
    kids.push(h('button', { class: 'ic' + (sel.items.some(it => it.lk) ? ' on-link' : ''), type: 'button', title: 'Link', html: I.link, onclick: linkDialog }));
    if (one && one.t === 'im') {
      kids.push(h('button', { class: 'ic', type: 'button', title: 'Crop', html: I.crop, onclick: () => cropDialog(one) }));
    }
    kids.push(
      h('button', { class: 'ic', type: 'button', title: 'Copy (Ctrl+C)', html: I.copy, onclick: () => copySel(false) }),
      h('button', { class: 'ic', type: 'button', title: 'Rotate', html: I.rotate, onclick: rotateSel }),
      h('button', { class: 'ic danger', type: 'button', title: 'Delete', html: I.trash, onclick: deleteSel }),
      h('button', {
        class: 'ic', type: 'button', title: 'More', html: I.more,
        onclick: e => popMenu(e.currentTarget, [
          one && one.lk ? { label: 'Follow the link', icon: I.link, onClick: () => followItemLink(one.lk) } : null,
          { label: 'Cut', icon: I.cut, onClick: () => copySel(true) },
          { label: 'Duplicate', icon: I.pages, onClick: duplicateSel },
          { label: 'Save as element', icon: I.element, onClick: saveElement },
          { label: 'Save as a picture', icon: I.image, onClick: selPicture },
          one && one.t === 'nt' ? { label: one.fo ? 'Open the note' : 'Fold the note away', icon: I.note, onClick: () => { const o = { ...one, m: Date.now() }; if (one.fo) delete o.fo; else o.fo = 1; replaceSel([one], [o]); } } : null,
          ...(one && one.t === 'tb' ? [
            '-',
            { label: 'Add a row', icon: I.plus, onClick: () => reshapeTable(1, 0) },
            { label: 'Add a column', icon: I.plus, onClick: () => reshapeTable(0, 1) },
            { label: 'Remove last row', icon: I.close, onClick: () => reshapeTable(-1, 0) },
            { label: 'Remove last column', icon: I.close, onClick: () => reshapeTable(0, -1) },
            { label: one.hd ? 'Plain first row' : 'Shade the first row', icon: I.table, onClick: () => { const o = { ...one, m: Date.now() }; if (one.hd) delete o.hd; else o.hd = 1; replaceSel([one], [o]); } }
          ] : [])
        ].filter(Boolean))
      }));
    selBar.replaceChildren(...kids);
  }

  function positionOverlays() {
    if (sel) {
      const b = sel.b;
      const [sx, sy] = toScreen(sel.pv, b.x + sel.dx, b.y + sel.dy);
      const w = b.w * sel.k * scale, hgt = b.h * sel.k * scale;
      Object.assign(selBox.style, { left: sx + 'px', top: sy + 'px', width: w + 'px', height: hgt + 'px' });
      const bw = selBar.offsetWidth || 150;
      const by = sy - 50 > 4 ? sy - 50 : Math.min(vpRect.height - 50, sy + hgt + 10);
      Object.assign(selBar.style, { left: clamp(sx + w / 2 - bw / 2, 4, Math.max(4, vpRect.width - bw - 4)) + 'px', top: by + 'px' });
    }
    if (textEd) {
      const [sx, sy] = toScreen(textEd.pv, textEd.x, textEd.y);
      Object.assign(textEd.ta.style, {
        left: sx + 'px', top: sy + 'px', width: textEd.w * scale + 'px',
        fontSize: textEd.fs * scale + 'px', color: textEd.color
      });
      growText();
    }
    if (boxEd) {
      const b = boxEd, ta = b.ta, [sx, sy] = toScreen(b.pv, b.x, b.y);
      Object.assign(ta.style, { left: sx + 'px', top: sy + 'px', width: b.w * scale + 'px', fontSize: b.fs * scale + 'px' });
      if (b.kind === 'nt') {
        ta.style.padding = R.NOTE_PAD * scale + 'px';
        ta.style.height = 'auto';
        ta.style.height = Math.max(ta.scrollHeight, b.w * 0.7 * scale) + 'px';
      } else {
        ta.style.padding = `${3 * scale}px ${4 * scale}px`;
        ta.style.height = b.h * scale + 'px';
      }
    }
    if (zw) {
      const [sx, sy] = toScreen(zw.pv, zw.x, zw.y);
      Object.assign(zframe.style, { left: sx + 'px', top: sy + 'px', width: zw.w * scale + 'px', height: zw.h * scale + 'px' });
    }
    if (ruler) positionRuler();
  }

  // --- tape: a strip that hides what is under it until it is tapped
  function tempTape(a) {
    const t = prefs.tape;
    return { t: 'tp', x1: a.x0, y1: a.y0, x2: a.x1, y2: a.y1, c: t.color, w: t.size };
  }

  function moveTape(e) {
    const a = action;
    let [x, y] = toPage(a.pv, e.clientX, e.clientY);
    // Nearly level or nearly upright strips are straightened.
    const dx = x - a.x0, dy = y - a.y0;
    if (Math.abs(dy) < Math.abs(dx) * 0.09) y = a.y0; else if (Math.abs(dx) < Math.abs(dy) * 0.09) x = a.x0;
    a.x1 = x;
    a.y1 = y;
    nextLive(() => { clearLive(); R.drawItem(a.c, tempTape(a)); });
  }

  function endTape(a) {
    clearLive();
    live.classList.remove('plain');
    const pv = a.pv, page = pv.page;
    if (!a.far || Math.hypot(a.x1 - a.x0, a.y1 - a.y0) < 6) { // a tap: show or hide what an existing strip covers
      const tp = topItemAt(page, a.x0, a.y0, 'tp');
      if (tp) toggleTape(pv, tp);
      return;
    }
    const r2 = v => Math.round(v * 100) / 100;
    const s = tempTape(a);
    const it = { ...s, x1: r2(s.x1), y1: r2(s.y1), x2: r2(s.x2), y2: r2(s.y2), id: uid(), z: nextZ(), m: Date.now() };
    addItems(page, [it]);
    queueInk(pv);
    pushUndo({ pageId: page.id, add: [it], remove: [] });
    dirty(page);
  }

  function toggleTape(pv, tp) {
    const nu = { ...tp, m: Date.now() };
    if (tp.o) delete nu.o; else nu.o = 1;
    removeItems(pv.page, [tp]);
    addItems(pv.page, [nu]);
    pushUndo({ pageId: pv.page.id, remove: [tp], add: [nu] });
    queueInk(pv);
    dirty(pv.page);
  }

  // A tap that is not for drawing: open or close a strip of tape, or follow a PDF link. Returns true if it did something.
  function tapThing(pv, x, y) {
    const lk = itemLinkAt(pv, x, y);
    if (lk) { followItemLink(lk); return true; }
    const nt = topItemAt(pv.page, x, y, 'nt');
    if (nt) { if (sel && sel.ids.has(nt.id)) clearSel(); toggleFold(pv, nt); return true; }
    const tp = topItemAt(pv.page, x, y, 'tp');
    if (tp) { toggleTape(pv, tp); return true; }
    const ln = linkAt(pv, x, y);
    if (ln) { followLink(pv, ln); return true; }
    return false;
  }

  // --- laser pointer: a glowing trail that fades by itself and is never saved
  function laserPt(e) { return [(e.clientX - vpRect.left - tx) / scale, (e.clientY - vpRect.top - ty) / scale]; }

  function beginLaser(e) {
    const a = action;
    a.ls = { p: laserPt(e), end: 0, c: prefs.laser.color };
    laser.strokes.push(a.ls);
    if (!laser.raf) laser.raf = requestAnimationFrame(laserFrame);
  }

  function moveLaser(e) {
    const [x, y] = laserPt(e);
    action.ls.p.push(x, y);
  }

  function laserFrame() {
    laser.raf = 0;
    if (destroyed) return;
    const d = Math.min(window.devicePixelRatio || 1, 2), W = Math.round(vpRect.width * d), H = Math.round(vpRect.height * d);
    if (laserCv.width !== W || laserCv.height !== H) { laserCv.width = W; laserCv.height = H; }
    const c = laserCv.getContext('2d'), now = performance.now();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);
    laser.strokes = laser.strokes.filter(s => !s.end || now - s.end < 900);
    if (!laser.strokes.length) { laserCv.width = laserCv.height = 0; return; }
    c.setTransform(d * scale, 0, 0, d * scale, d * tx, d * ty);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const s of laser.strokes) {
      const P = s.p, n = P.length;
      c.globalAlpha = s.end ? 1 - (now - s.end) / 900 : 1;
      c.beginPath();
      c.moveTo(P[0], P[1]);
      for (let i = 2; i < n; i += 2) c.lineTo(P[i], P[i + 1]);
      if (n === 2) c.lineTo(P[0] + 0.01, P[1]);
      c.shadowColor = s.c;
      c.shadowBlur = 12 * d;
      c.strokeStyle = s.c;
      c.lineWidth = 5 / scale;
      c.stroke();
      c.shadowBlur = 0;
      c.strokeStyle = 'rgba(255,255,255,.85)';
      c.lineWidth = 1.6 / scale;
      c.stroke();
      if (!s.end) { // the dot under the pen
        c.fillStyle = s.c;
        c.shadowColor = s.c;
        c.shadowBlur = 16 * d;
        c.beginPath();
        c.arc(P[n - 2], P[n - 1], 5 / scale, 0, 6.2832);
        c.fill();
        c.shadowBlur = 0;
      }
    }
    c.globalAlpha = 1;
    laser.raf = requestAnimationFrame(laserFrame);
  }

  // --- PDF links and table of contents
  function loadLinks(pv) {
    if (pv.links !== undefined || !pv.page.pdf || pv.page.tpl) return;
    pv.links = null;
    pageLinks(pv.page.pdf.a, pv.page.pdf.i).then(l => { pv.links = l; }, () => { pv.links = undefined; });
  }

  function linkAt(pv, x, y) {
    return (pv.links && pv.links.find(l => x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h)) || null;
  }

  function gotoPdfPage(aid, i) {
    const k = pages.findIndex(p => p.pdf && p.pdf.a === aid && p.pdf.i === i);
    if (k >= 0) scrollToPage(k); else toast('That page is not in this notebook.');
  }

  async function followLink(pv, ln) {
    if (ln.url) {
      if (!/^(https?:|mailto:)/i.test(ln.url)) return;
      if (await confirmBox('Open this link?', ln.url, 'Open')) window.open(ln.url, '_blank', 'noopener');
      return;
    }
    gotoPdfPage(pv.page.pdf.a, await resolveDest(pv.page.pdf.a, ln.dest));
  }

  async function outlineDialog() {
    const rows = [];
    for (const aid of new Set(pages.filter(p => p.pdf && !p.tpl).map(p => p.pdf.a))) {
      for (const o of await pdfOutline(aid).catch(() => [])) rows.push({ ...o, aid });
    }
    if (!rows.length) { toast('This PDF has no table of contents.'); return; }
    const m = modal({
      title: 'Contents',
      body: h('div', { class: 'outline' }, rows.map(o => {
        const k = pages.findIndex(p => p.pdf && p.pdf.a === o.aid && p.pdf.i === o.i);
        return h('button', {
          class: 'ol', type: 'button', disabled: k < 0, style: { paddingLeft: 10 + o.depth * 16 + 'px' },
          onclick: () => { m.close(); scrollToPage(k); }
        }, h('span', null, o.title), h('small', null, k >= 0 ? String(k + 1) : ''));
      }))
    });
  }

  // --- find: typed text, page names and the text of PDF pages
  function openFind() {
    findBar.hidden = false;
    findInp.focus();
    findInp.select();
    if (findInp.value && !find) runFind();
  }

  function closeFind() {
    findTok++;
    find = null;
    findBar.hidden = true;
    findLbl.textContent = '';
    for (const m of world.querySelectorAll('.fmark')) m.remove();
  }

  async function runFind() {
    const tok = ++findTok, q = findInp.value.trim().toLowerCase();
    find = null;
    for (const m of world.querySelectorAll('.fmark')) m.remove();
    if (!q) { findLbl.textContent = ''; return; }
    const hits = [], list = [...pages];
    for (let n = 0; n < list.length; n++) {
      const pg = list[n];
      if ((pg.title || '').toLowerCase().includes(q)) hits.push({ pg, rects: [] });
      for (const it of pg.items) {
        const s = it.t === 'tx' || it.t === 'nt' ? it.s || '' : it.t === 'tb' ? (it.cells || []).map(r => r.join(' ')).join(' ') : '';
        if (s && s.toLowerCase().includes(q)) hits.push({ pg, rects: [R.bounds(it)] });
      }
      if (!pg.pdf || pg.tpl) continue;
      try {
        const t = await pageText(pg.pdf.a, pg.pdf.i);
        if (tok !== findTok) return;
        for (const rects of textMatches(t, q)) hits.push({ pg, rects });
      } catch { /* that PDF is not on this device yet */ }
      if (n % 15 === 14) {
        findLbl.textContent = `Searching ${n + 1}/${list.length}`;
        await new Promise(r => setTimeout(r));
        if (tok !== findTok) return;
      }
    }
    find = { q, hits, cur: -1 };
    showFindMarks();
    if (!hits.length) { findLbl.textContent = 'No results'; return; }
    // Start with the first match on or after the page being looked at.
    const at = pvs.indexOf(currentPv());
    const first = hits.findIndex(hh => pages.indexOf(hh.pg) >= at);
    find.cur = (first < 0 ? 0 : first) - 1;
    findStep(1);
  }

  // Matches are marked with boxes placed inside the page elements, so they move and zoom with the page.
  function showFindMarks() {
    for (const m of world.querySelectorAll('.fmark')) m.remove();
    if (!find) return;
    let made = 0;
    find.hits.forEach((hit, n) => {
      hit.els = [];
      const pv = pvs.find(v => v.page === hit.pg);
      if (!pv || made > 1500) return;
      for (const r of hit.rects) {
        const m = h('div', {
          class: 'fmark' + (n === find.cur ? ' cur' : ''),
          style: { left: r.x / hit.pg.w * 100 + '%', top: r.y / hit.pg.h * 100 + '%', width: r.w / hit.pg.w * 100 + '%', height: r.h / hit.pg.h * 100 + '%' }
        });
        pv.el.append(m);
        hit.els.push(m);
        made++;
      }
    });
  }

  function findStep(d) {
    if (!find || !find.hits.length) return;
    const n = find.hits.length, old = find.hits[find.cur];
    if (old && old.els) for (const m of old.els) m.classList.remove('cur');
    find.cur = (find.cur + d + n) % n;
    const hit = find.hits[find.cur];
    if (hit.els) for (const m of hit.els) m.classList.add('cur');
    findLbl.textContent = `${find.cur + 1} / ${n}`;
    const i = pages.indexOf(hit.pg);
    if (i < 0) return;
    scrollToPage(i);
    const r = hit.rects[0];
    if (!r) return;
    // Bring the match itself into view if the top of the page did not show it.
    const [sx, sy] = toScreen(pvs[i], r.x, r.y);
    let moved = false;
    if (sy < 70 || sy > vpRect.height - 90) { ty += vpRect.height / 3 - sy; moved = true; }
    if (sx < 16 || sx > vpRect.width - 60) { tx += vpRect.width / 3 - sx; moved = true; }
    if (moved) applyView();
  }

  // The pages panel search also looks inside PDF pages; their text is read once, in the background.
  function warmText() {
    if (!textWarm) {
      textWarm = (async () => {
        for (const pg of [...pages]) {
          if (!pg.pdf || pg.tpl || destroyed) continue;
          try { pdfText.set(pg.id, (await pageText(pg.pdf.a, pg.pdf.i)).s); } catch { /* not downloaded yet */ }
        }
        if (panelOpen && !destroyed && panelQ.trim()) fillPanel();
      })();
    }
  }

  // --- ruler: lies on the page; pen and highlighter strokes started beside it run straight along its edge
  function toggleRuler() {
    if (ruler) { ruler.el.remove(); ruler = null; return; }
    measure();
    const cv = h('canvas'), lbl = h('span', { class: 'ruler-lbl' });
    const el = h('div', { class: 'ruler' }, cv, lbl, h('div', { class: 'ruler-rot a', 'data-rot': 'a' }), h('div', { class: 'ruler-rot b', 'data-rot': 'b' }));
    ruler = { x: (vpRect.width / 2 - tx) / scale, y: (vpRect.height / 2 - ty) / scale, ang: 0, el, cv, lbl, s: 0 };
    overlay.insertBefore(el, selBox);
    let drag = null;
    el.addEventListener('pointerdown', e => {
      // The hand that rests on the ruler while the pen draws along it must not push it away.
      if (e.pointerType === 'touch' && ((action && action.ptype === 'pen') || performance.now() - lastPenT < PALM_MS)) return;
      e.preventDefault();
      measure();
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      drag = { id: e.pointerId, rot: e.target.getAttribute('data-rot'), x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id || !ruler) return;
      if (drag.rot) {
        const cx = ruler.x * scale + tx + vpRect.left, cy = ruler.y * scale + ty + vpRect.top;
        let a = Math.atan2(e.clientY - cy, e.clientX - cx) + (drag.rot === 'a' ? Math.PI : 0);
        const step = Math.PI / 12, near = Math.round(a / step) * step; // click into place every 15 degrees
        if (Math.abs(a - near) < 0.035) a = near;
        ruler.ang = Math.atan2(Math.sin(a), Math.cos(a));
      } else {
        ruler.x += (e.clientX - drag.x) / scale;
        ruler.y += (e.clientY - drag.y) / scale;
        drag.x = e.clientX;
        drag.y = e.clientY;
      }
      positionRuler();
    });
    const drop = e => { if (drag && e.pointerId === drag.id) drag = null; };
    el.addEventListener('pointerup', drop);
    el.addEventListener('pointercancel', drop);
    positionRuler();
  }

  // Shows the angle, or the length of the line being drawn along the edge.
  function rulerLabel(len) {
    let deg = Math.round(-ruler.ang * 180 / Math.PI);
    deg = ((deg % 180) + 180) % 180;
    ruler.lbl.textContent = len != null ? `${Math.round(len * MM)} mm` : `${deg}°`;
  }

  function positionRuler() {
    const r = ruler, w = RULER_L * scale, hh = RULER_W * scale;
    const cx = r.x * scale + tx, cy = r.y * scale + ty;
    Object.assign(r.el.style, { width: w + 'px', height: hh + 'px', left: cx - w / 2 + 'px', top: cy - hh / 2 + 'px', transform: `rotate(${r.ang}rad)` });
    if (!(action && action.rule)) rulerLabel();
    if (r.s === scale || zooming) return;
    // Tick marks: true millimetres at any zoom.
    r.s = scale;
    const d = Math.min(window.devicePixelRatio || 1, 4096 / w), c = r.cv.getContext('2d');
    r.cv.width = Math.max(1, Math.round(w * d));
    r.cv.height = Math.max(1, Math.round(hh * d));
    c.setTransform(d * scale, 0, 0, d * scale, 0, 0);
    const mm = 1 / MM, fine = mm * scale >= 3;
    c.strokeStyle = c.fillStyle = '#33363d';
    c.lineWidth = 0.5;
    c.beginPath();
    for (let i = 0; i <= 170; i += fine ? 1 : 5) {
      const x = i * mm, len = i % 10 === 0 ? 9 : i % 5 === 0 ? 6.5 : 4;
      c.moveTo(x, 0); c.lineTo(x, len);
      c.moveTo(x, RULER_W); c.lineTo(x, RULER_W - len);
    }
    c.stroke();
    c.font = '7px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'top';
    for (let cm = 1; cm < 17; cm++) c.fillText(String(cm), cm * 10 * mm, 10.5);
  }

  // Is the pointer just outside one of the ruler's long edges? Returns the line to follow, in the page's units.
  function ruleFor(pv, cx, cy, size) {
    const r = ruler, cos = Math.cos(r.ang), sin = Math.sin(r.ang);
    const wx = (cx - vpRect.left - tx) / scale - r.x, wy = (cy - vpRect.top - ty) / scale - r.y;
    const lx = wx * cos + wy * sin, ly = -wx * sin + wy * cos; // along and across the ruler
    if (Math.abs(lx) > RULER_L / 2 + 12 / scale) return null;
    const out = Math.abs(ly) - RULER_W / 2;
    if (out < -3 / scale || out > 22 / scale) return null;
    const off = (ly < 0 ? -1 : 1) * (RULER_W / 2 + size / 2 + 0.4); // the ink lies against the edge, not under it
    return { px: r.x - sin * off - pv.x, py: r.y + cos * off - pv.y, ux: cos, uy: sin };
  }

  function onRule(l, x, y) {
    const t = (x - l.px) * l.ux + (y - l.py) * l.uy;
    return [l.px + l.ux * t, l.py + l.uy * t];
  }

  // --- zoom window: write large at the bottom of the screen, the ink lands small on the page
  function toggleZoom(on = !zw) {
    if (!on) {
      if (action && action.map) cancelAction();
      zw = null;
      zpan = null;
      zwin.hidden = true;
      zframe.hidden = true;
      applyView();
      return;
    }
    if (zw) return;
    commitText();
    measure();
    const pv = currentPv(), pg = pv.page;
    zwin.hidden = false;
    zframe.hidden = false;
    const [vx, vy] = toPage(pv, vpRect.left + 24, vpRect.top + vpRect.height * 0.2);
    zw = { pv, x: clamp(vx, 0, pg.w), y: clamp(vy, 0, pg.h), w: clamp(pg.w * 0.45, 100, pg.w), h: 0, zs: 1, d: 1, rect: null, home: 0, pdfC: null, pdfKey: '', pdfAsk: '', tok: 0 };
    zoomLayout();
    zw.home = zw.x;
    zoomReveal();
  }

  const zxf = c => { const k = zw.zs * zw.d; c.setTransform(k, 0, 0, k, -zw.x * k, -zw.y * k); };
  const zmap = (cx, cy) => [zw.x + (cx - zw.rect.left) / zw.zs, zw.y + (cy - zw.rect.top) / zw.zs];

  function zliveCtx() {
    const c = zlive.getContext('2d');
    zxf(c);
    c.globalAlpha = 1;
    c.setLineDash([]);
    return c;
  }

  function zoomClamp() {
    const pg = zw.pv.page;
    zw.x = clamp(zw.x, 0, Math.max(0, pg.w - zw.w));
    zw.y = clamp(zw.y, 0, Math.max(0, pg.h - zw.h));
  }

  // Size the window's canvases and work out how much of the page it shows.
  function zoomLayout() {
    if (!zw) return;
    const r = zpad.getBoundingClientRect();
    if (!r.width || !r.height) return;
    zw.rect = r;
    zw.zs = r.width / zw.w;
    zw.h = r.height / zw.zs;
    zoomClamp();
    zw.d = Math.min(window.devicePixelRatio || 1, 2.5);
    const W = Math.round(r.width * zw.d), H = Math.round(r.height * zw.d);
    if (zcv.width !== W || zcv.height !== H) { zcv.width = zlive.width = W; zcv.height = zlive.height = H; }
    zlive.classList.toggle('mul', !R.paperOf(zw.pv.page).dark);
    zoomPaint();
    positionOverlays();
  }

  function queueZoom() {
    if (!zw || rafZoom) return;
    rafZoom = requestAnimationFrame(() => { rafZoom = 0; if (zw && !destroyed) zoomPaint(); });
  }

  function zoomPaint() {
    if (!zw || !zcv.width) return;
    const z = zw, pg = z.pv.page, k = z.zs * z.d, c = zcv.getContext('2d');
    const clip = { x: z.x, y: z.y, w: z.w, h: z.h };
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, zcv.width, zcv.height);
    zxf(c);
    R.drawPaper(c, pg);
    if (pg.pdf) {
      const key = [pg.id, z.x, z.y, z.w, z.h, k].join();
      if (z.pdfKey === key && z.pdfC) {
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.drawImage(z.pdfC, 0, 0);
        zxf(c);
      } else if (z.pdfAsk !== key) {
        z.pdfAsk = key;
        const tok = ++z.tok;
        renderPdfPage(pg.pdf.a, pg.pdf.i, k, () => zw !== z || tok !== z.tok, clip)
          .then(cv => { if (cv && zw === z && tok === z.tok) { z.pdfC = cv; z.pdfKey = key; zoomPaint(); } })
          .catch(err => console.warn('PDF render for the zoom window failed', err));
      }
    }
    R.drawImages(c, pg.items, null, clip);
    if (!R.paperOf(pg).dark) c.globalCompositeOperation = 'multiply';
    R.drawItems(c, pg.items, null, false, clip);
    c.globalCompositeOperation = 'source-over';
    R.drawTapes(c, pg.items, null, clip);
  }

  // Keep the frame where it can be seen, above the zoom window.
  function zoomReveal() {
    const [sx, sy] = toScreen(zw.pv, zw.x, zw.y);
    const visH = vpRect.height - zwin.offsetHeight, fh = zw.h * scale, fw = zw.w * scale;
    let moved = false;
    if (sy + fh > visH - 8) { ty -= sy + fh - visH + 28; moved = true; } else if (sy < 8) { ty += 28 - sy; moved = true; }
    if (sx + fw > vpRect.width - 4) { tx -= sx + fw - vpRect.width + 16; moved = true; } else if (sx < 4) { tx += 16 - sx; moved = true; }
    if (moved) applyView(); else positionOverlays();
  }

  function zoomMoved() {
    zoomClamp();
    queueZoom();
    zoomReveal();
  }

  function zoomMove(f) {
    if (!zw) return;
    zw.x += zw.w * f;
    zoomMoved();
  }

  function zoomNewline() {
    if (!zw) return;
    zw.x = zw.home;
    zw.y += zw.h * 0.5;
    zoomMoved();
  }

  function zDown(e) {
    if (!zw || readOnly || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    commitText();
    zw.rect = zpad.getBoundingClientRect();
    try { zpad.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const now = performance.now();
    if (e.pointerType === 'pen') {
      lastPenT = now;
      if (!penSeen) { penSeen = true; prefs.penSeen = true; savePrefs(); }
      zpan = null;
      if (action && action.ptype === 'pen' && (action.tool === 'pen' || action.tool === 'hl')) endAction(null);
      else if (action) cancelAction();
    } else if (e.pointerType === 'touch') {
      if ((action && action.ptype === 'pen') || now - lastPenT < PALM_MS) return; // resting hand
      if (!fingerDraws()) { zpan = { id: e.pointerId, x: e.clientX, y: e.clientY }; return; } // fingers slide the window along
    }
    if (action) return;
    const erasing = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) || e.button === 2 || (e.buttons & 2));
    const tool = erasing ? 'eraser' : prefs.tool;
    if (!ZOOM_TOOLS.includes(tool)) { toast('The zoom window works with the pen, highlighter and eraser.'); return; }
    startAction(e, tool, zmap);
  }

  function zMove(e) {
    if (e.pointerType === 'pen') lastPenT = performance.now();
    if (!zw) return;
    if (zpan && zpan.id === e.pointerId) {
      zw.x -= (e.clientX - zpan.x) / zw.zs;
      zw.y -= (e.clientY - zpan.y) / zw.zs;
      zpan.x = e.clientX;
      zpan.y = e.clientY;
      zoomClamp();
      queueZoom();
      positionOverlays();
      return;
    }
    if (!action || !action.map || action.pid !== e.pointerId) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (evs && evs.length > 1) for (const ev of evs) actionMove(ev); else actionMove(e);
  }

  function zUp(e) {
    if (e.pointerType === 'pen') lastPenT = performance.now();
    if (zpan && zpan.id === e.pointerId) { zpan = null; if (zw) zw.home = zw.x; return; }
    if (!action || !action.map || action.pid !== e.pointerId) return;
    if (e.type !== 'pointercancel') endAction(e);
    else if (action.ptype !== 'touch' && (action.tool === 'pen' || action.tool === 'hl')) endAction(null);
    else cancelAction();
  }

  // The frame on the page: its grip moves it, its corner changes how much the window magnifies.
  function frameDrag(handle, resize) {
    let d = null;
    handle.addEventListener('pointerdown', e => {
      if (!zw) return;
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      d = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    handle.addEventListener('pointermove', e => {
      if (!d || e.pointerId !== d.id || !zw) return;
      const dx = (e.clientX - d.x) / scale, dy = (e.clientY - d.y) / scale;
      d.x = e.clientX;
      d.y = e.clientY;
      if (resize) {
        zw.w = clamp(zw.w + dx, 60, zw.pv.page.w - zw.x);
        zoomLayout();
      } else {
        zw.x += dx;
        zw.y += dy;
        zoomClamp();
        zw.home = zw.x;
        queueZoom();
        positionOverlays();
      }
    });
    const drop = e => { if (d && e.pointerId === d.id) d = null; };
    handle.addEventListener('pointerup', drop);
    handle.addEventListener('pointercancel', drop);
  }
  frameDrag(zgrip, false);
  frameDrag(zsize, true);
  for (const [t, fn] of [['pointerdown', zDown], ['pointermove', zMove], ['pointerup', zUp], ['pointercancel', zUp]]) zpad.addEventListener(t, fn);

  // --- shapes
  function tempShape(a) {
    const t = prefs.shape;
    const s = { t: 'sh', k: t.kind, x1: a.x0, y1: a.y0, x2: a.x1, y2: a.y1, c: inkFor(a.pv, t.color), w: t.size };
    if (t.fill && (t.kind === 'rect' || t.kind === 'ellipse')) s.f = t.fill;
    return s;
  }

  function moveShape(e) {
    const a = action;
    let [x, y] = toPage(a.pv, e.clientX, e.clientY);
    if (e.shiftKey) {
      const dx = x - a.x0, dy = y - a.y0;
      if (prefs.shape.kind === 'rect' || prefs.shape.kind === 'ellipse') {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        x = a.x0 + Math.sign(dx || 1) * m;
        y = a.y0 + Math.sign(dy || 1) * m;
      } else {
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
        x = a.x0 + Math.cos(ang) * len;
        y = a.y0 + Math.sin(ang) * len;
      }
    }
    a.x1 = x;
    a.y1 = y;
    nextLive(() => { clearLive(); R.drawItem(a.c, tempShape(a)); });
  }

  function endShape(a) {
    clearLive();
    if (!a.far || Math.hypot(a.x1 - a.x0, a.y1 - a.y0) < 3) return;
    const r2 = v => Math.round(v * 100) / 100;
    const s = tempShape(a);
    const it = { ...s, x1: r2(s.x1), y1: r2(s.y1), x2: r2(s.x2), y2: r2(s.y2), id: uid(), z: nextZ(), m: Date.now() };
    const page = a.pv.page;
    addItems(page, [it]);
    if (a.pv.rs) {
      const c = a.pv.ink.getContext('2d');
      xf(c, a.pv);
      R.drawItem(c, it);
    }
    pushUndo({ pageId: page.id, add: [it], remove: [] });
    dirty(page);
  }

  // --- text
  function startText(pv, item, x, y) {
    commitText();
    clearSel();
    const t = prefs.text;
    const fs = item ? item.fs : t.size;
    const px = item ? item.x : clamp(x, 4, pv.page.w - 90);
    const py = item ? item.y : y - fs * R.LH / 2;
    const w = item ? item.w : clamp(pv.page.w - px - 16, 80, 340);
    const ta = h('textarea', { class: 'texted', spellcheck: false, rows: 1 });
    ta.value = item ? item.s : '';
    ta.style.lineHeight = String(R.LH);
    const st = item || t; // an existing box keeps its own style, a new one takes the tool bar's
    textEd = {
      pv, item: item || null, x: px, y: py, w, fs, color: item ? item.c : inkFor(pv, t.color), ta,
      b: !!st.b, i: !!st.i, u: !!st.u, ff: st.ff || 'sans', al: st.al || 'l'
    };
    overlay.append(ta);
    if (item) paintInk(pv);
    styleTa();
    ta.addEventListener('input', growText);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') commitText();
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) listEnter(e);
    });
    ta.focus();
    if (prefs.tool === 'text') renderOpts();
  }

  function styleTa() {
    const t = textEd;
    if (!t) return;
    Object.assign(t.ta.style, {
      fontFamily: R.FONTS[t.ff] || R.FONT, fontWeight: t.b ? '700' : '400', fontStyle: t.i ? 'italic' : 'normal',
      textDecoration: t.u ? 'underline' : 'none', textAlign: t.al === 'c' ? 'center' : t.al === 'r' ? 'right' : 'left'
    });
    positionOverlays();
  }

  // A tool bar choice for typed text: remembered for new boxes, and applied to the box being typed in.
  function textStyle(k, v) {
    if (!textEd || !textEd.item) { prefs.text[k] = v; savePrefs(); }
    if (textEd) {
      textEd[k === 'size' ? 'fs' : k] = v;
      styleTa();
      textEd.ta.focus();
    }
    renderOpts();
  }

  // Enter inside a list starts the next bullet, number or tick box; Enter on an empty one ends the list.
  const LIST_RE = /^(\s*)(•|-|\*|\[ ?\]|\[x\]|(\d+)[.)])\s+/;
  function listEnter(e) {
    const ta = textEd.ta, v = ta.value, at = ta.selectionStart, ls = v.lastIndexOf('\n', at - 1) + 1, line = v.slice(ls, at);
    const m = LIST_RE.exec(line);
    if (!m) return;
    e.preventDefault();
    if (m[0].length === line.length) ta.setRangeText('', ls, at, 'end');
    else ta.setRangeText('\n' + (m[3] ? m[0].replace(m[3], String(+m[3] + 1)) : m[0].replace('[x]', '[ ]')), at, ta.selectionEnd, 'end');
    growText();
  }

  // The List button: put a bullet in front of the line being typed, or take it away again.
  function toggleBullet() {
    if (!textEd) { toast('Tap the page to start typing first.'); return; }
    const ta = textEd.ta, v = ta.value, at = ta.selectionStart, ls = v.lastIndexOf('\n', at - 1) + 1;
    const m = LIST_RE.exec(v.slice(ls));
    if (m) ta.setRangeText('', ls, ls + m[0].length, 'preserve'); else ta.setRangeText('• ', ls, ls, 'end');
    ta.focus();
    growText();
  }

  function growText() {
    if (!textEd) return;
    const ta = textEd.ta;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  // --- sticky notes and table cells: typed into a box laid over the item
  function boxStart(pv, item, kind, r, c) {
    commitText();
    clearSel();
    const ta = h('textarea', { class: 'texted boxed', spellcheck: false, rows: 1 });
    ta.style.fontFamily = R.FONT;
    ta.style.lineHeight = String(R.LH);
    let x, y, w, hh, fs, val;
    if (kind === 'nt') {
      x = item.x; y = item.y; w = item.w; hh = 0; fs = item.fs || 13; val = item.s || '';
      ta.style.background = item.c || '#ffe066';
      ta.style.color = '#26282c';
    } else {
      const cw = item.w / item.cl, rh = item.h / item.r;
      x = item.x + c * cw; y = item.y + r * rh; w = cw; hh = rh; fs = item.fs || 12; val = (item.cells && item.cells[r] && item.cells[r][c]) || '';
      ta.style.background = R.paperOf(pv.page).bg;
      ta.style.color = R.paperOf(pv.page).dark ? INK_ON_DARK : INK;
      ta.style.fontWeight = item.hd && !r ? '700' : '400';
    }
    ta.value = val;
    boxEd = { pv, item, kind, r, c, ta, x, y, w, h: hh, fs };
    overlay.append(ta);
    if (kind === 'nt') { paintInk(pv); }
    positionOverlays();
    ta.addEventListener('input', () => positionOverlays());
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); commitBox(); }
      else if (e.key === 'Tab' && kind === 'tb') { // next (or previous) cell
        e.preventDefault();
        const n = item.r * item.cl, at = r * item.cl + c, nx = (at + (e.shiftKey ? n - 1 : 1)) % n;
        const nu = commitBox();
        boxStart(pv, nu || item, 'tb', Math.floor(nx / item.cl), nx % item.cl);
      }
    });
    ta.focus();
  }

  // Returns the item as it is after the change.
  function commitBox() {
    const b = boxEd;
    if (!b) return null;
    boxEd = null;
    const v = b.ta.value.replace(/\s+$/, '');
    b.ta.remove();
    const pg = b.pv.page, old = b.item;
    if (!pg.items.includes(old)) { paintInk(b.pv); return null; } // removed meanwhile (undo, another device)
    let nu = null;
    if (b.kind === 'nt' && v !== (old.s || '')) nu = { ...old, s: v };
    if (b.kind === 'tb') {
      const cur = (old.cells && old.cells[b.r] && old.cells[b.r][b.c]) || '';
      if (v !== cur) {
        const cells = Array.from({ length: old.r }, (_, i) => Array.from({ length: old.cl }, (_, j) => (old.cells && old.cells[i] && old.cells[i][j]) || ''));
        cells[b.r][b.c] = v;
        nu = { ...old, cells };
      }
    }
    if (!nu) { paintInk(b.pv); return old; }
    removeItems(pg, [old]);
    addItems(pg, [nu]);
    pushUndo({ pageId: pg.id, remove: [old], add: [nu] });
    paintInk(b.pv);
    dirty(pg);
    return nu;
  }

  // A tap with the Text tool: type into a sticky note or table cell under it, edit typed text, or start new text.
  function textTap(pv, x, y) {
    for (let i = pv.page.items.length - 1; i >= 0; i--) {
      const it = pv.page.items[i];
      if (it.t !== 'nt' && it.t !== 'tb') continue;
      const b = R.bounds(it);
      if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
      if (it.t === 'nt') { if (it.fo) toggleFold(pv, it); else boxStart(pv, it, 'nt'); return; }
      boxStart(pv, it, 'tb', clamp(Math.floor((y - it.y) / (it.h / it.r)), 0, it.r - 1), clamp(Math.floor((x - it.x) / (it.w / it.cl)), 0, it.cl - 1));
      return;
    }
    startText(pv, topItemAt(pv.page, x, y, 'tx'), x, y);
  }

  function toggleFold(pv, it) {
    const nu = { ...it };
    if (it.fo) delete nu.fo; else nu.fo = 1;
    removeItems(pv.page, [it]);
    addItems(pv.page, [nu]);
    pushUndo({ pageId: pv.page.id, remove: [it], add: [nu] });
    queueInk(pv);
    dirty(pv.page);
    return nu;
  }

  // New things placed in the middle of what is on screen.
  function viewCentre(pv) {
    measure();
    const vh = vpRect.height - (zw ? zwin.offsetHeight : 0);
    return toPage(pv, vpRect.left + vpRect.width / 2, vpRect.top + vh / 2);
  }

  function addNote() {
    commitText();
    const pv = currentPv(), pg = pv.page, [cx, cy] = viewCentre(pv), w = 150;
    const it = {
      id: uid(), t: 'nt', x: Math.round(clamp(cx - w / 2, 4, pg.w - w - 4)), y: Math.round(clamp(cy - 60, 4, pg.h - 110)),
      w, s: '', fs: 13, c: prefs.noteColor || NOTE_COLORS[0], z: nextZ(), m: Date.now()
    };
    addItems(pg, [it]);
    pushUndo({ pageId: pg.id, add: [it], remove: [] });
    queueInk(pv);
    dirty(pg);
    boxStart(pv, it, 'nt');
  }

  function addTable() {
    const rows = h('input', { class: 'inp', type: 'number', min: 1, max: 30, value: 3 });
    const cols = h('input', { class: 'inp', type: 'number', min: 1, max: 12, value: 3 });
    const hd = h('input', { type: 'checkbox', checked: true });
    modal({
      title: 'Insert a table',
      body: h('div', null,
        h('div', { class: 'row two' }, h('div', { class: 'field' }, h('label', null, 'Rows'), rows), h('div', { class: 'field' }, h('label', null, 'Columns'), cols)),
        h('label', { class: 'check' }, hd, 'Shade the first row as a heading'),
        h('p', { class: 'modal-text small' }, 'Type in a cell by tapping it with the Text tool (Tab moves to the next cell), or just write over it.')),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Insert', primary: true, onClick: () => {
            commitText();
            const r = clamp(parseInt(rows.value, 10) || 3, 1, 30), cl = clamp(parseInt(cols.value, 10) || 3, 1, 12);
            const pv = currentPv(), pg = pv.page, [cx, cy] = viewCentre(pv);
            const w = Math.min(pg.w - 40, cl * 110), hh = r * 28;
            const it = {
              id: uid(), t: 'tb', x: Math.round(clamp(cx - w / 2, 8, pg.w - w - 8)), y: Math.round(clamp(cy - hh / 2, 8, Math.max(8, pg.h - hh - 8))),
              w, h: hh, r, cl, cells: [], fs: 12, c: '#5c606a', z: nextZ(), m: Date.now(), ...(hd.checked ? { hd: 1 } : {})
            };
            addItems(pg, [it]);
            pushUndo({ pageId: pg.id, add: [it], remove: [] });
            queueInk(pv);
            dirty(pg);
            setTool('lasso');
            setSel(pv, [it]);
          }
        }
      ]
    });
  }

  // Add or remove a row or column of the selected table.
  function reshapeTable(dr, dc) {
    if (!sel || sel.items.length !== 1 || sel.items[0].t !== 'tb') return;
    const old = sel.items[0], r = old.r + dr, cl = old.cl + dc;
    if (r < 1 || cl < 1 || r > 40 || cl > 16) return;
    const cells = Array.from({ length: r }, (_, i) => Array.from({ length: cl }, (_, j) => (old.cells && old.cells[i] && old.cells[i][j]) || ''));
    replaceSel([old], [{ ...old, r, cl, cells, h: old.h / old.r * r, w: old.w / old.cl * cl, m: Date.now() }]);
  }

  // --- links: any item can point to a page (here or in another notebook) or a web address
  function itemLinkAt(pv, x, y) {
    const tol = 6 / scale;
    for (let i = pv.page.items.length - 1; i >= 0; i--) {
      const it = pv.page.items[i];
      if (!it.lk) continue;
      const b = R.bounds(it);
      if (x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol) return it.lk;
    }
    return null;
  }

  // Open another notebook, keeping the side-by-side view if there is one.
  function openDoc(id, page) {
    const q = page ? '?p=' + page : '';
    if (split && id !== opts.other) location.hash = '#/d/' + (opts.pane === 0 ? id + '+' + opts.other : opts.other + '+' + id);
    else location.hash = '#/d/' + id + q;
  }

  async function followItemLink(lk) {
    if (lk.u) {
      if (!/^(https?:|mailto:)/i.test(lk.u)) return;
      if (await confirmBox('Open this link?', lk.u, 'Open')) window.open(lk.u, '_blank', 'noopener');
      return;
    }
    if (!lk.d || lk.d === doc.id) {
      const i = pages.findIndex(p => p.id === lk.p);
      if (i < 0) toast('The linked page is no longer in this notebook.'); else scrollToPage(i);
      return;
    }
    const d = await db.get('docs', lk.d);
    if (!d || d.deleted || d.trashed) { toast('The linked notebook is not in your library.'); return; }
    commitText();
    await flush().catch(saveFailed);
    const i = (d.pages || []).indexOf(lk.p);
    openDoc(d.id, i >= 0 ? i + 1 : 0);
  }

  async function linkDialog() {
    if (!sel) return;
    const items = sel.items, cur = items.find(it => it.lk);
    const st = { kind: cur ? (cur.lk.u ? 'url' : cur.lk.d && cur.lk.d !== doc.id ? 'doc' : 'page') : 'page', other: null };
    if (st.kind === 'doc') st.other = await db.get('docs', cur.lk.d);
    const pageNo = h('input', { class: 'inp', type: 'number', min: 1, value: '1' });
    if (cur && !cur.lk.u) {
      const list = st.kind === 'doc' && st.other ? st.other.pages : pages.map(p => p.id);
      const i = list.indexOf(cur.lk.p);
      if (i >= 0) pageNo.value = String(i + 1);
    }
    const url = h('input', { class: 'inp', type: 'url', placeholder: 'https://...', value: cur && cur.lk.u ? cur.lk.u : '' });
    const otherBtn = h('button', { class: 'btn', type: 'button' }, st.other ? st.other.title : 'Choose a notebook...');
    otherBtn.onclick = async () => { const d = await chooseNotebook('Link to a notebook', doc.id); if (d) { st.other = d; otherBtn.textContent = d.title; pageNo.value = '1'; } };
    const named = h('div', { class: 'chips' }, pages.map((p, i) => (p.title || p.bm) ? h('button', {
      class: 'chip sm', type: 'button', onclick: () => { pageNo.value = String(i + 1); }
    }, `${i + 1}${p.title ? ': ' + p.title : ' ★'}`) : null));
    const body = h('div');
    const draw = () => fill(body,
      seg([['page', 'Page here'], ['doc', 'Another notebook'], ['url', 'Web address']], st.kind, v => { st.kind = v; draw(); }),
      st.kind === 'url' ? h('div', { class: 'field' }, h('label', null, 'Web address'), url) : null,
      st.kind === 'doc' ? h('div', { class: 'field' }, h('label', null, 'Notebook'), otherBtn) : null,
      st.kind !== 'url' ? h('div', { class: 'field' }, h('label', null, 'Page number'), pageNo) : null,
      st.kind === 'page' && named.childElementCount ? h('div', { class: 'field' }, h('label', null, 'Named and bookmarked pages'), named) : null);
    draw();
    const apply = lk => { const old = sel.items; replaceSel(old, old.map(it => { const o = { ...it, m: Date.now() }; if (lk) o.lk = lk; else delete o.lk; return o; })); };
    modal({
      title: 'Link', body,
      actions: [
        cur ? { label: 'Remove link', onClick: () => apply(null) } : null,
        { label: 'Cancel' },
        {
          label: 'Save', primary: true, onClick: () => {
            if (!sel) return;
            const n = parseInt(pageNo.value, 10) || 1;
            if (st.kind === 'url') {
              let u = url.value.trim();
              if (!u) { toast('Type a web address.'); return false; }
              if (!/^(https?:|mailto:)/i.test(u)) u = 'https://' + u;
              apply({ u });
            } else if (st.kind === 'doc') {
              if (!st.other) { toast('Choose a notebook first.'); return false; }
              const ids = st.other.pages || [];
              apply({ d: st.other.id, p: ids[clamp(n, 1, Math.max(1, ids.length)) - 1] || ids[0] });
            } else apply({ p: pages[clamp(n, 1, pages.length) - 1].id });
            toast('Linked. Tap it with a finger, or with the Laser tool, to follow it.', 3200);
          }
        }
      ].filter(Boolean)
    });
  }

  // --- saved elements: reusable bits (a diagram, a stamp, a signature), kept in a hidden notebook so they sync
  async function saveElement() {
    if (!sel) return;
    const name = await promptText('Save as an element', '', 'For example: signature, cell diagram');
    if (name == null) return;
    const u = R.unionBounds(sel.items), pad = 4;
    const items = sel.items.map(it => ({ ...R.transformItem(it, 1, 0, 0, pad - u.x, pad - u.y), id: uid() }));
    const page = newPage(null, { w: Math.ceil(u.w + 2 * pad), h: Math.ceil(u.h + 2 * pad) });
    page.items = items;
    page.title = name || 'Element';
    await addSysPage('elements', page);
    toast(`Saved "${page.title}". Find it under Insert > Saved elements.`, 3000);
  }

  async function elementsDialog() {
    const list = await sysPages('elements');
    if (!list.length) { toast('No saved elements yet. Select something with the Select tool, then More > Save as element.', 4000); return; }
    let m = null;
    const grid = h('div', { class: 'els' });
    const draw = items => grid.replaceChildren(...items.map(p => {
      const c = h('canvas', { class: 'el-c' });
      R.renderPageTo(p, c, Math.min(260, Math.max(60, p.w * 1.2))).catch(() => {});
      return h('div', { class: 'el' },
        h('button', { class: 'el-pick', type: 'button', title: 'Insert', onclick: () => { m.close(); placeItems(p.items); } }, c, h('span', null, p.title || 'Element')),
        h('button', {
          class: 'ic sm el-x', type: 'button', title: 'Remove', html: I.close, onclick: async () => {
            if (!await confirmBox('Remove element', `Remove "${p.title}" from your saved elements?`, 'Remove', true)) return;
            await removeSysPage('elements', p);
            const left = list.filter(x => x !== p);
            list.length = 0; list.push(...left);
            draw(list);
          }
        }));
    }));
    draw(list);
    m = modal({ title: 'Saved elements', wide: true, body: grid });
  }

  // --- the Insert menu
  function insertMenu(anchor) {
    popMenu(anchor, [
      { label: 'Picture', icon: I.image, onClick: () => fileInp.click() },
      { label: 'Scan with the camera', icon: I.scan, onClick: () => scanInp.click() },
      { label: 'Sticky note', icon: I.note, onClick: addNote },
      { label: 'Table', icon: I.table, onClick: addTable },
      { label: 'Saved elements', icon: I.element, onClick: elementsDialog }
    ]);
  }

  // --- camera scan: pick the four corners of the paper, it is straightened and (optionally) cleaned up
  async function onScanFile() {
    const file = scanInp.files[0];
    scanInp.value = '';
    if (!file) return;
    let src;
    try { src = await loadBitmap(file); } catch (e) { toast('That picture could not be opened: ' + ((e && e.message) || 'unknown reason'), 6000); return; }
    const url = URL.createObjectURL(file);
    const q = [[0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]]; // corners: top left, top right, bottom right, bottom left
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 1000 1000');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'scan-svg');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    svg.append(poly);
    const hs = q.map((_, i) => h('div', { class: 'crop-h scan-h', 'data-i': i }));
    const stage = h('div', { class: 'crop-stage scan-stage' }, h('img', { class: 'crop-img', src: url, draggable: false }), svg, hs);
    const show = () => {
      poly.setAttribute('points', q.map(([x, y]) => `${x * 1000},${y * 1000}`).join(' '));
      q.forEach(([x, y], i) => Object.assign(hs[i].style, { left: x * 100 + '%', top: y * 100 + '%', right: 'auto', bottom: 'auto' }));
    };
    show();
    let drag = null;
    stage.addEventListener('pointerdown', e => {
      const i = e.target.getAttribute('data-i');
      if (i == null) return;
      e.preventDefault();
      try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const r = stage.getBoundingClientRect();
      drag = { i: +i, r };
    });
    stage.addEventListener('pointermove', e => {
      if (!drag) return;
      q[drag.i] = [clamp((e.clientX - drag.r.left) / drag.r.width, 0, 1), clamp((e.clientY - drag.r.top) / drag.r.height, 0, 1)];
      show();
    });
    const drop = () => { drag = null; };
    stage.addEventListener('pointerup', drop);
    stage.addEventListener('pointercancel', drop);
    const mode = { v: 'doc' };
    modal({
      title: 'Scan', wide: true,
      body: h('div', null,
        h('p', { class: 'modal-text small' }, 'Drag the four corners onto the corners of the paper.'),
        h('div', { class: 'crop-wrap' }, stage),
        chipGroup('Look', [{ v: 'doc', label: 'Clean document' }, { v: 'gray', label: 'Greyscale' }, { v: 'color', label: 'Original colour' }], mode.v, v => { mode.v = v; })),
      onClose: () => setTimeout(() => URL.revokeObjectURL(url), 2000),
      actions: [
        { label: 'Cancel' },
        { label: 'Add as a page', primary: true, onClick: () => { scanToPage(src, q, mode.v); } }
      ]
    });
  }

  async function scanToPage(src, q, mode) {
    const b = busy('Straightening the page...');
    try {
      await new Promise(r => setTimeout(r, 30));
      // Work on a copy no bigger than 2400 px.
      const k = Math.min(1, 2400 / Math.max(src.w, src.h)), SW = Math.round(src.w * k), SH = Math.round(src.h * k);
      const sc = document.createElement('canvas');
      sc.width = SW; sc.height = SH;
      const sx = sc.getContext('2d');
      sx.drawImage(src.img, 0, 0, SW, SH);
      const S = sx.getImageData(0, 0, SW, SH).data;
      const P = q.map(([x, y]) => [x * SW, y * SH]);
      const len = (a, c) => Math.hypot(a[0] - c[0], a[1] - c[1]);
      let W = (len(P[0], P[1]) + len(P[3], P[2])) / 2, H = (len(P[0], P[3]) + len(P[1], P[2])) / 2;
      const f = 1800 / Math.max(W, H);
      W = Math.max(50, Math.round(W * f)); H = Math.max(50, Math.round(H * f));
      // Unit square -> the chosen corners (projective mapping).
      const [x0, y0] = P[0], [x1, y1] = P[1], [x2, y2] = P[2], [x3, y3] = P[3];
      const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
      let a, bb, c, d, e2, f2, g = 0, hh = 0;
      if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) { a = x1 - x0; bb = x2 - x1; c = x0; d = y1 - y0; e2 = y2 - y1; f2 = y0; }
      else {
        const det = dx1 * dy2 - dx2 * dy1;
        g = (dx3 * dy2 - dx2 * dy3) / det; hh = (dx1 * dy3 - dx3 * dy1) / det;
        a = x1 - x0 + g * x1; bb = x3 - x0 + hh * x3; c = x0; d = y1 - y0 + g * y1; e2 = y3 - y0 + hh * y3; f2 = y0;
      }
      const out = document.createElement('canvas');
      out.width = W; out.height = H;
      const ox = out.getContext('2d'), O = ox.createImageData(W, H), D = O.data;
      const lum = new Float32Array(W * H);
      for (let j = 0; j < H; j++) {
        const v = (j + 0.5) / H;
        for (let i = 0; i < W; i++) {
          const u = (i + 0.5) / W, z = g * u + hh * v + 1;
          const X = clamp((a * u + bb * v + c) / z, 0, SW - 1.001), Y = clamp((d * u + e2 * v + f2) / z, 0, SH - 1.001);
          const xi = X | 0, yi = Y | 0, fx = X - xi, fy = Y - yi, p = (yi * SW + xi) * 4, o = (j * W + i) * 4;
          for (let ch = 0; ch < 3; ch++) {
            const top = S[p + ch] * (1 - fx) + S[p + 4 + ch] * fx, bot = S[p + SW * 4 + ch] * (1 - fx) + S[p + SW * 4 + 4 + ch] * fx;
            D[o + ch] = top * (1 - fy) + bot * fy;
          }
          D[o + 3] = 255;
          lum[j * W + i] = 0.299 * D[o] + 0.587 * D[o + 1] + 0.114 * D[o + 2];
        }
      }
      if (mode !== 'color') {
        // Even out shadows: estimate the paper's brightness in blocks, then divide it out.
        const B = 40, bw = Math.ceil(W / B), bh = Math.ceil(H / B), bgv = new Float32Array(bw * bh);
        for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
          const hist = new Uint32Array(64);
          let n = 0;
          for (let y = by * B; y < Math.min(H, by * B + B); y += 2) for (let x = bx * B; x < Math.min(W, bx * B + B); x += 2) { hist[lum[y * W + x] >> 2]++; n++; }
          let acc = 0, k2 = 63;
          for (; k2 > 0; k2--) { acc += hist[k2]; if (acc >= n * 0.2) break; }
          bgv[by * bw + bx] = Math.max(40, k2 * 4 + 2);
        }
        const bgAt = (x, y) => {
          const fx = clamp(x / B - 0.5, 0, bw - 1), fy = clamp(y / B - 0.5, 0, bh - 1), ix = Math.min(bw - 2, fx | 0), iy = Math.min(bh - 2, fy | 0);
          if (bw < 2 || bh < 2) return bgv[0];
          const tx2 = fx - ix, ty2 = fy - iy;
          return (bgv[iy * bw + ix] * (1 - tx2) + bgv[iy * bw + ix + 1] * tx2) * (1 - ty2) + (bgv[(iy + 1) * bw + ix] * (1 - tx2) + bgv[(iy + 1) * bw + ix + 1] * tx2) * ty2;
        };
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          let r = lum[y * W + x] / bgAt(x, y);
          if (mode === 'doc') r = r > 0.9 ? 1 : Math.pow(Math.max(0, (r - 0.2) / 0.7), 1.4);
          const val = clamp(Math.round(r * 255), 0, 255);
          D[o] = D[o + 1] = D[o + 2] = val;
        }
      }
      ox.putImageData(O, 0, 0);
      const blob = await new Promise(res => out.toBlob(res, 'image/jpeg', 0.86));
      const asset = { id: uid(), mime: 'image/jpeg', name: 'scan.jpg', data: await blob.arrayBuffer(), modified: Date.now() };
      await db.put('assets', asset);
      await R.loadImage(asset.id);
      const cur = currentPv(), i = pages.indexOf(cur.page);
      const pw = 595, pg = newPage(doc.id, { w: pw, h: Math.round(pw * H / W * 100) / 100, bg: { a: asset.id }, paper: 'white' });
      pages.splice(i + 1, 0, pg);
      dirtyPages.add(pg);
      structureChanged(i + 1);
      toast('Scan added as a new page');
    } catch (err) {
      console.error(err);
      toast('The scan could not be made: ' + err.message);
    } finally { b.done(); }
  }

  // --- this page as a picture, and printing
  function pictureDialog(blob, name, title) {
    const file = new File([blob], name, { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const actions = [{ label: 'Download', onClick: () => { downloadBlob(blob, name); } }];
    if (navigator.clipboard && window.ClipboardItem) {
      actions.push({
        label: 'Copy', onClick: async () => {
          try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Picture copied'); } catch { toast('This browser would not copy the picture. Use Download.'); }
        }
      });
    }
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      actions.push({ label: 'Share', primary: true, onClick: async () => { try { await navigator.share({ files: [file] }); } catch { /* cancelled */ } } });
    }
    modal({
      title, wide: true,
      body: h('div', { class: 'crop-wrap' }, h('img', { class: 'shot', src: url })),
      actions, onClose: () => setTimeout(() => URL.revokeObjectURL(url), 2000)
    });
  }

  async function pagePicture() {
    commitText();
    const pv = currentPv(), pg = pv.page, k = Math.min(3, 2400 / Math.max(pg.w, pg.h));
    const c = document.createElement('canvas');
    await R.renderPageTo(pg, c, pg.w * k);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    if (!blob) { toast('Could not make the picture.'); return; }
    pictureDialog(blob, `${safeName(doc.title)} page ${pvs.indexOf(pv) + 1}.png`, 'This page as a picture');
  }

  function printDialog() {
    const cur = pvs.indexOf(currentPv());
    modal({
      title: 'Print',
      body: h('p', { class: 'modal-text' }, 'Pages are printed as they look on screen, one per sheet. For the best quality, Export as PDF and print that.'),
      actions: [
        { label: 'Cancel' },
        { label: `This page (${cur + 1})`, onClick: () => printPages([pages[cur]]) },
        { label: `All ${pages.length} pages`, primary: true, onClick: () => printPages(pages.slice()) }
      ]
    });
  }

  async function printPages(list) {
    commitText();
    const b = busy('Preparing to print...');
    const box = h('div', { id: 'print-root' });
    const urls = [];
    try {
      for (let n = 0; n < list.length; n++) {
        b.set(`Preparing to print... page ${n + 1} of ${list.length}`);
        const pg = list[n], c = document.createElement('canvas');
        await R.renderPageTo(pg, c, Math.min(1700, pg.w * 2.4));
        const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.92));
        const u = URL.createObjectURL(blob);
        urls.push(u);
        box.append(h('img', { src: u, alt: '' }));
      }
      document.getElementById('print-root')?.remove();
      document.body.append(box);
      await Promise.all([...box.querySelectorAll('img')].map(i => i.decode().catch(() => {})));
    } catch (e) {
      b.done();
      box.remove();
      toast('Could not prepare the pages: ' + e.message);
      return;
    }
    b.done();
    const done = () => { box.remove(); urls.forEach(u => URL.revokeObjectURL(u)); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 50);
    setTimeout(() => { if (!document.hidden) done(); }, 120000); // in case "afterprint" never comes
  }

  // --- two notebooks side by side
  async function openBeside() {
    const d = await chooseNotebook(split ? 'Show a different notebook beside this one' : 'Open beside this notebook', doc.id);
    if (!d) return;
    commitText();
    await flush().catch(saveFailed);
    location.hash = '#/d/' + (split && opts.pane === 1 ? d.id + '+' + doc.id : doc.id + '+' + d.id);
  }

  function commitText() {
    commitBox();
    const te = textEd;
    if (!te) return;
    textEd = null;
    const s = te.ta.value.replace(/\s+$/, '');
    te.ta.remove();
    const page = te.pv.page;
    if (prefs.tool === 'text') renderOpts();
    const sty = { fs: te.fs, c: te.color }; // only the styles that are switched on are stored
    for (const k of ['b', 'i', 'u']) if (te[k]) sty[k] = 1;
    if (te.ff !== 'sans') sty.ff = te.ff;
    if (te.al !== 'l') sty.al = te.al;
    if (te.item) {
      const old = te.item, add = [];
      const same = s === old.s && old.fs === te.fs && old.c === te.color && !old.b === !te.b && !old.i === !te.i && !old.u === !te.u
        && (old.ff || 'sans') === te.ff && (old.al || 'l') === te.al;
      if (same) { paintInk(te.pv); return; }
      removeItems(page, [old]);
      if (s) {
        const nu = { ...old, s };
        for (const k of ['b', 'i', 'u', 'ff', 'al']) delete nu[k];
        Object.assign(nu, sty);
        addItems(page, [nu]);
        add.push(nu);
      }
      pushUndo({ pageId: page.id, remove: [old], add });
    } else if (s) {
      const r2 = v => Math.round(v * 100) / 100;
      const it = { id: uid(), t: 'tx', x: r2(te.x), y: r2(te.y), w: r2(te.w), s, ...sty, z: nextZ(), m: Date.now() };
      addItems(page, [it]);
      pushUndo({ pageId: page.id, add: [it], remove: [] });
    } else return;
    paintInk(te.pv);
    dirty(page);
  }

  // --- images
  async function onImageFile() {
    const file = fileInp.files[0];
    fileInp.value = '';
    if (!file) return;
    try {
      const asset = await imageAsset(file, 3200), src = asset; // src.w, src.h: the stored picture's size
      const pv = currentPv(), pg = pv.page;
      const f = Math.min(1, pg.w * 0.9 / src.w, pg.h * 0.8 / src.h);
      const iw = src.w * f, ih = src.h * f;
      measure();
      const [cx, cy] = toPage(pv, vpRect.left + vpRect.width / 2, vpRect.top + vpRect.height / 2);
      const it = {
        id: uid(), t: 'im', a: asset.id,
        x: Math.round(clamp(cx - iw / 2, 8, Math.max(8, pg.w - iw - 8))),
        y: Math.round(clamp(cy - ih / 2, 8, Math.max(8, pg.h - ih - 8))),
        w: Math.round(iw), h: Math.round(ih), z: nextZ(), m: Date.now()
      };
      await R.loadImage(asset.id);
      addItems(pg, [it]);
      pushUndo({ pageId: pg.id, add: [it], remove: [] });
      dirty(pg);
      setTool('lasso');
      setSel(pv, [it]);
    } catch (err) {
      console.error(err);
      toast('That image could not be added: ' + ((err && err.message) || 'unknown reason'), 6000);
    }
  }

  async function loadBitmap(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await imgReady(img);
      return { img, w: img.naturalWidth, h: img.naturalHeight };
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 300000); // the scan dialog may still be drawing from it
    }
  }

  // ------------------------------------------------------------------ page management
  function structureChanged(focusIndex) {
    commitText();
    clearSel();
    doc.pages = pages.map(p => p.id);
    docDirty = true;
    changed = true;
    rebuild();
    if (focusIndex != null) scrollToPage(focusIndex); else applyView();
    flush().catch(saveFailed);
    if (panelOpen) buildPanel();
  }

  async function addPageAfter(pv) {
    const src = pv.page;
    // A page made from one of your own templates is followed by another of the same; a scanned or imported page is not.
    const o = src.tpl
      ? { w: src.w, h: src.h, template: src.template, paper: src.paper, pdf: src.pdf, bg: src.bg, tpl: src.tpl }
      : src.pdf || src.bg
        ? { w: src.w, h: src.h, template: doc.template, paper: doc.paper }
        : { w: src.w, h: src.h, template: src.template, paper: src.paper };
    const pg = newPage(doc.id, o);
    if (src.day) pg.day = src.day; // journal: a second page for the same day
    const i = pages.indexOf(src);
    pages.splice(i + 1, 0, pg);
    dirtyPages.add(pg);
    structureChanged(i + 1);
  }

  async function duplicatePage(i) {
    const src = pages[i], t = Date.now();
    const pg = { ...src, id: uid(), dels: {}, modified: t, items: src.items.map(it => ({ ...it, id: uid(), m: t })) };
    pages.splice(i + 1, 0, pg);
    dirtyPages.add(pg);
    structureChanged(i + 1);
  }

  async function deletePage(i) {
    if (pages.length === 1) { toast('A notebook needs at least one page.'); return; }
    commitText();
    await flush().catch(saveFailed);
    const pg = pages[i];
    pages.splice(i, 1);
    dirtyPages.delete(pg);
    gonePages.add(pg.id);
    verRecord([pg]);
    await trashPage(pg, doc, i);
    structureChanged(Math.min(i, pages.length - 1));
    toast(`Page ${i + 1} is in the bin for ${TRASH_DAYS} days`);
  }

  function movePage(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= pages.length) return;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    structureChanged(j);
  }

  function movePageTo(i, j) {
    if (i === j) return;
    const [p] = pages.splice(i, 1);
    pages.splice(j, 0, p);
    structureChanged(j);
  }

  // Drag a page in the panel to a new place: hold it for a moment with a finger or pen, or just drag with the mouse.
  function dragCard(card, i) {
    let s = null;
    const cards = () => [...panelList.querySelectorAll('.thumb')];
    const begin = () => {
      s.on = true;
      s.line = h('div', { class: 'drop-line' });
      panelList.append(s.line);
      card.classList.add('drag');
      try { card.setPointerCapture(s.id); } catch { /* synthetic pointer */ }
      track(s.y0);
    };
    const track = y => {
      card.style.transform = `translateY(${y - s.y0}px) scale(.94)`;
      const pr = panel.getBoundingClientRect();
      if (y < pr.top + 44) panel.scrollTop -= 14; else if (y > pr.bottom - 44) panel.scrollTop += 14;
      const cs = cards();
      let to = cs.length;
      for (let k = 0; k < cs.length; k++) {
        if (cs[k] === card) continue;
        const r = cs[k].getBoundingClientRect();
        if (y < r.top + r.height / 2) { to = k; break; }
      }
      s.to = to;
      const last = cs[cs.length - 1];
      s.line.style.top = (to < cs.length ? cs[to].offsetTop : last.offsetTop + last.offsetHeight) - 7 + 'px';
    };
    card.addEventListener('pointerdown', e => {
      if (e.button || e.target.closest('button') || pickMode || panelQ.trim() || panelBm || pages.length < 2) return;
      const st = s = { id: e.pointerId, x0: e.clientX, y0: e.clientY, on: false, to: i, t: 0, mouse: e.pointerType === 'mouse', line: null };
      if (!st.mouse) st.t = setTimeout(() => { if (s === st && !st.on) begin(); }, 350);
    });
    card.addEventListener('pointermove', e => {
      if (!s || e.pointerId !== s.id) return;
      if (!s.on) {
        if (Math.hypot(e.clientX - s.x0, e.clientY - s.y0) <= 7) return;
        if (!s.mouse) { clearTimeout(s.t); s = null; return; } // moved before the hold: the finger is scrolling the list
        begin();
      }
      track(e.clientY);
    });
    const end = e => {
      if (!s || e.pointerId !== s.id) return;
      const d = s;
      s = null;
      clearTimeout(d.t);
      if (!d.on) return;
      card._dragged = true; // the click that follows is not a "go to this page"
      setTimeout(() => { card._dragged = false; }, 60);
      d.line.remove();
      card.classList.remove('drag');
      card.style.transform = '';
      if (e.type === 'pointerup') movePageTo(i, d.to > i ? d.to - 1 : d.to);
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
    card.addEventListener('touchmove', e => { if (s && s.on && e.cancelable) e.preventDefault(); }, { passive: false });
    card.addEventListener('contextmenu', e => { if (s) e.preventDefault(); });
  }

  // Pages that are part of an imported PDF or a scan keep their own background.
  const ownBg = p => (p.pdf || p.bg) && !p.tpl;

  async function templateDialog() {
    const pv = currentPv(), pg = pv.page;
    if (ownBg(pg)) { toast('Imported PDF pages and scans keep their own background.'); return; }
    const st = { template: pg.template, paper: pg.paper, all: false, custom: null };
    const all = h('input', { type: 'checkbox', onchange: e => { st.all = e.target.checked; } });
    const tp = templatePicker(pg.tpl ? null : st.template, () => st.paper, v => { st.template = v; st.custom = null; drawMine(); });
    // Your own templates: any PDF page or picture, kept in a hidden notebook so every device has them.
    const mine = h('div', { class: 'tpls' });
    const addInp = h('input', { type: 'file', accept: 'application/pdf,.pdf,image/*', hidden: true, onchange: async () => { const f = addInp.files[0]; addInp.value = ''; if (f && await addTemplate(f)) drawMine(); } });
    async function drawMine() {
      const list = await sysPages('templates');
      mine.replaceChildren(...list.map(t => {
        const c = h('canvas', { class: 'tpl-c' });
        R.renderPageTo(t, c, 132).catch(() => {});
        const b = h('button', {
          class: 'tpl' + ((st.custom ? st.custom.id === t.id : !st.template && pg.tpl === t.id) ? ' on' : ''), type: 'button', title: t.title,
          onclick: () => { st.custom = t; st.template = null; tp.el.querySelectorAll('.tpl.on').forEach(x => x.classList.remove('on')); drawMine(); }
        }, c, h('span', null, t.title || 'Template'),
        h('span', { class: 'tpl-x', title: 'Remove this template', html: I.close, onclick: e => { e.stopPropagation(); removeTpl(t); } }));
        return b;
      }), h('button', { class: 'tpl add', type: 'button', title: 'Add a template from a PDF page or a picture', onclick: () => addInp.click() },
        h('span', { class: 'tpl-add', html: I.plus }), h('span', null, 'Add yours')));
    }
    async function removeTpl(t) {
      if (!await confirmBox('Remove template', `Remove "${t.title}" from your templates? Pages already using it keep it.`, 'Remove', true)) return;
      await removeSysPage('templates', t);
      if (st.custom && st.custom.id === t.id) st.custom = null;
      drawMine();
    }
    await drawMine();
    modal({
      title: 'Page template',
      body: h('div', null,
        h('div', { class: 'field' }, h('label', null, 'Your templates'), mine, addInp),
        tp.el,
        chipGroup('Paper', PAPER_OPTS, st.paper, v => { st.paper = v; tp.redraw(); }),
        h('label', { class: 'check' }, all, 'Apply to every page in this notebook')),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Apply', primary: true, onClick: () => {
            let resized = false;
            for (const p of (st.all ? pages.filter(q => !ownBg(q)) : [pg])) {
              if (st.custom) {
                const t = st.custom;
                if (p.w !== t.w || p.h !== t.h) resized = true;
                Object.assign(p, { pdf: t.pdf || null, bg: t.bg || null, tpl: t.id, w: t.w, h: t.h });
              } else {
                if (p.tpl) { p.pdf = null; p.bg = null; delete p.tpl; }
                if (st.template) p.template = st.template;
              }
              p.paper = st.paper;
              dirty(p);
            }
            if (st.template) doc.template = st.template;
            doc.paper = st.paper;
            docDirty = true;
            if (resized) structureChanged(pvs.indexOf(pv));
            else for (const v of pvs) { v.links = undefined; stylePv(v); if (v.rs) renderPv(v, true); }
            if (panelOpen) buildPanel();
          }
        }
      ]
    });
  }

  async function addTemplate(file) {
    try {
      const t = Date.now(), r2 = v => Math.round(v * 100) / 100;
      let page;
      if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name)) {
        const buf = await file.arrayBuffer();
        const pdf = await openPdf(new Uint8Array(buf.slice(0)));
        let i = 0;
        if (pdf.numPages > 1) {
          const v = await promptText('Which page of the PDF?', '1', `1 to ${pdf.numPages}`);
          if (v == null) { pdf.destroy(); return false; }
          i = clamp((parseInt(v, 10) || 1) - 1, 0, pdf.numPages - 1);
        }
        const vp = (await pdf.getPage(i + 1)).getViewport({ scale: 1 });
        pdf.destroy();
        const asset = { id: uid(), mime: 'application/pdf', name: file.name, data: buf, modified: t };
        await db.put('assets', asset);
        page = newPage(null, { w: r2(vp.width), h: r2(vp.height), pdf: { a: asset.id, i } });
      } else {
        const asset = await imageAsset(file, 2400);
        page = newPage(null, { w: 595, h: r2(595 * asset.h / asset.w), bg: { a: asset.id } });
      }
      page.title = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Template';
      await addSysPage('templates', page);
      toast('Template added');
      return true;
    } catch (e) {
      console.error(e);
      toast('That file could not be used as a template.');
      return false;
    }
  }

  // Store a picture file (made smaller if it is huge). Returns the asset with its pixel size.
  async function imageAsset(file, maxD) {
    const src = await loadBitmap(file);
    const k = Math.min(1, maxD / Math.max(src.w, src.h));
    let data, mime;
    if (k === 1 && (file.type === 'image/jpeg' || file.type === 'image/png')) {
      data = await file.arrayBuffer();
      mime = file.type;
    } else {
      const c = document.createElement('canvas');
      c.width = Math.round(src.w * k);
      c.height = Math.round(src.h * k);
      c.getContext('2d').drawImage(src.img, 0, 0, c.width, c.height);
      mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const blob = await new Promise(res => c.toBlob(res, mime, 0.9));
      if (!blob) throw new Error('the picture is too large for this device to process');
      data = await blob.arrayBuffer();
    }
    const asset = { id: uid(), mime, name: file.name, data, modified: Date.now() };
    await db.put('assets', asset);
    return { ...asset, w: Math.round(src.w * k), h: Math.round(src.h * k) };
  }

  // ------------------------------------------------------------------ pages panel
  function togglePanel() {
    panelOpen = !panelOpen;
    panel.hidden = !panelOpen;
    buildPanel();
  }

  // --- bookmarks, page names, jumping to a page
  function toggleBookmark(pg) {
    pg.bm = !pg.bm;
    dirty(pg);
    updateIndicator();
    if (panelOpen) fillPanel();
  }

  async function namePage(pg) {
    const name = await promptText('Name this page', pg.title || '', 'For example: Chapter 3 summary');
    if (name == null || name === (pg.title || '')) return;
    pg.title = name;
    dirty(pg);
    if (panelOpen) fillPanel();
  }

  async function gotoPrompt() {
    const v = await promptText('Go to page', '', `1 to ${pvs.length}`);
    const n = parseInt(v, 10);
    if (n >= 1) scrollToPage(n - 1);
  }

  // Does a page match the panel's search box? Looks at the page name and any typed text on it.
  function pageMatches(pg, q) {
    if (!q) return true;
    if ((pg.title || '').toLowerCase().includes(q)) return true;
    if (pg.pdf && (pdfText.get(pg.id) || '').includes(q)) return true;
    return pg.items.some(it => ((it.t === 'tx' || it.t === 'nt') && (it.s || '').toLowerCase().includes(q))
      || (it.t === 'tb' && (it.cells || []).some(r => r.some(c => (c || '').toLowerCase().includes(q)))));
  }

  function buildPanel() {
    panel.replaceChildren();
    panelList = null;
    if (!panelOpen) { fillPanel(); return; }
    const q = h('input', {
      class: 'inp sm', type: 'search', placeholder: 'Find, or page no.', value: panelQ,
      oninput: () => { panelQ = q.value; fillPanel(); },
      onkeydown: e => {
        if (e.key !== 'Enter') return;
        const n = /^\d+$/.test(q.value.trim()) ? parseInt(q.value, 10) : 0;
        if (n >= 1) { panelQ = q.value = ''; scrollToPage(n - 1); fillPanel(); }
      }
    });
    const bmBtn = h('button', {
      class: 'chip sm' + (panelBm ? ' on' : ''), type: 'button',
      onclick: () => { panelBm = !panelBm; bmBtn.classList.toggle('on', panelBm); fillPanel(); }
    }, h('span', { class: 'btn-ic', html: I.star }), 'Bookmarks');
    const pickBtn = h('button', {
      class: 'chip sm' + (pickMode ? ' on' : ''), type: 'button', title: 'Choose several pages to copy, move, delete or export together',
      onclick: () => { pickMode = !pickMode; if (!pickMode) picked.clear(); lastPick = -1; buildPanel(); }
    }, pickMode ? 'Done' : 'Select pages');
    pickBar = pickMode ? h('div', { class: 'pick-bar' }) : null;
    panel.classList.toggle('picking', pickMode);
    panelList = h('div', { class: 'panel-list' });
    panel.append(h('div', { class: 'panel-head' }, q, bmBtn, pickBtn, pickBar), panelList);
    fillPanel();
  }

  function fillPanel() {
    if (thumbObs) { thumbObs.disconnect(); thumbObs = null; }
    thumbs.clear();
    if (!panelOpen || !panelList) return;
    panelList.replaceChildren();
    const ql = panelQ.trim().toLowerCase(), numeric = /^\d+$/.test(ql);
    if (ql && !numeric && pages.some(p => p.pdf)) warmText();
    thumbObs =new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        thumbObs.unobserve(en.target);
        R.renderPageTo(en.target._page, en.target, 220).catch(() => {});
      }
    }, { root: panel, rootMargin: '300px' });
    const cur = pvs.indexOf(currentPv());
    let shown = 0;
    pages.forEach((pg, i) => {
      if (panelBm && !pg.bm) return;
      if (ql && !(numeric ? String(i + 1).startsWith(ql) : pageMatches(pg, ql))) return;
      shown++;
      const c = h('canvas', { class: 'thumb-c' });
      c._page = pg;
      c.width = 220;
      c.height = Math.round(220 * pg.h / pg.w);
      c.style.background = R.paperOf(pg).bg;
      thumbs.set(pg.id, c);
      const card = h('div', {
        class: 'thumb' + (i === cur ? ' on' : '') + (picked.has(pg.id) ? ' picked' : ''), 'data-pid': pg.id,
        onclick: e => {
          if (card._dragged) return;
          if (pickMode) { pickCard(i, e.shiftKey); return; }
          scrollToPage(i);
          if (innerWidth < 700) togglePanel();
        }
      },
        h('span', { class: 'pick-mark' }),
        c,
        pg.title ? h('div', { class: 'thumb-name' }, pg.title) : null,
        h('div', { class: 'thumb-foot' },
          h('span', null, String(i + 1)),
          h('span', { class: 'grow' }),
          h('button', {
            class: 'ic sm' + (pg.bm ? ' star-on' : ''), type: 'button', title: pg.bm ? 'Remove bookmark' : 'Bookmark this page', html: pg.bm ? I.starOn : I.star,
            onclick: e => { e.stopPropagation(); toggleBookmark(pg); }
          }),
          h('button', {
            class: 'ic sm', type: 'button', title: 'Page options', html: I.more,
            onclick: e => {
              e.stopPropagation();
              popMenu(e.currentTarget, [
                { label: pg.title ? 'Rename this page' : 'Name this page', icon: I.edit, onClick: () => namePage(pg) },
                { label: 'Add page after', icon: I.plus, onClick: () => addPageAfter(pvs[i]) },
                { label: 'Duplicate', icon: I.copy, onClick: () => duplicatePage(i) },
                { label: 'Move up', icon: I.up, onClick: () => movePage(i, -1) },
                { label: 'Move down', icon: I.down, onClick: () => movePage(i, 1) },
                { label: 'Paste copied pages after', icon: I.paste, onClick: () => pastePages(i) },
                { label: 'Select several pages', icon: I.pages, onClick: () => { pickMode = true; picked.add(pg.id); lastPick = i; buildPanel(); } },
                '-',
                { label: 'Delete page', icon: I.trash, danger: true, onClick: () => deletePage(i) }
              ], { align: 'right' });
            }
          })));
      panelList.append(card);
      dragCard(card, i);
      thumbObs.observe(c);
    });
    if (!shown) panelList.append(h('p', { class: 'panel-empty' }, panelBm && !ql ? 'No bookmarked pages yet. Tap the star under a page.' : 'No pages match.'));
    const on = panelList.querySelector('.thumb.on');
    if (on && !ql && !pickMode) on.scrollIntoView({ block: 'center' });
    updatePick();
  }

  // --- the share button: everything that sends the notebook somewhere
  function shareMenu(anchor) {
    popMenu(anchor, [
      { label: 'Export as PDF', icon: I.pdf, onClick: async () => { commitText(); await flush().catch(saveFailed); exportFlow(doc.id); } },
      { label: 'Send a copy to a friend', icon: I.send, onClick: async () => { commitText(); await flush().catch(saveFailed); shareNotebook(doc.id); } },
      { label: 'This page as a picture', icon: I.image, onClick: pagePicture },
      { label: 'Print', icon: I.print, onClick: printDialog }
    ], { align: 'right' });
  }

  // --- tabs: the notebooks that are open, across the top
  const readTabs = () => { try { return JSON.parse(localStorage.getItem('inkleaf.tabs') || '[]').filter(x => typeof x === 'string'); } catch { return []; } };
  const saveTabs = ids => { try { localStorage.setItem('inkleaf.tabs', JSON.stringify(ids)); } catch { /* private mode */ } };

  async function drawTabs() {
    if (split) { tabsEl.replaceChildren(h('div', { class: 'tab on' }, titleBtn)); return; } // side by side: each side shows its own name
    let ids = readTabs();
    if (!ids.includes(doc.id)) ids.push(doc.id);
    while (ids.length > 10) ids.splice(ids.findIndex(id => id !== doc.id), 1); // the oldest other tab makes room
    const recs = (await Promise.all(ids.map(id => (id === doc.id ? doc : db.get('docs', id))))).filter(d => d && !d.deleted && !d.trashed);
    if (destroyed) return;
    saveTabs(recs.map(d => d.id));
    const x = d => h('button', { class: 'tab-x', type: 'button', title: 'Close this tab', html: I.close, onclick: e => { e.stopPropagation(); closeTab(d.id); } });
    tabsEl.replaceChildren(...recs.map(d => (d.id === doc.id
      ? h('div', { class: 'tab on' }, titleBtn, x(d))
      : h('div', { class: 'tab', title: d.title, onclick: () => switchTab(d.id) }, h('span', { class: 'tab-t' }, d.title), x(d)))));
    const on = tabsEl.querySelector('.tab.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async function switchTab(id) {
    commitText();
    await flush().catch(saveFailed);
    location.hash = '#/d/' + id;
  }

  async function closeTab(id) {
    const ids = readTabs(), i = ids.indexOf(id);
    saveTabs(ids.filter(x => x !== id));
    if (id !== doc.id) { drawTabs(); return; }
    const next = ids[i + 1] || ids[i - 1];
    commitText();
    await flush().catch(saveFailed);
    location.hash = next ? '#/d/' + next : doc.folderId ? '#/f/' + doc.folderId : '#/';
  }

  // --- read-only view
  function setReadOnly(on, quiet) {
    if (on) { commitText(); clearSel(); if (action) cancelAction(); }
    readOnly = on;
    try { localStorage.setItem('inkleaf.ro.' + doc.id, on ? '1' : '0'); } catch { /* private mode */ }
    el.classList.toggle('ro', on);
    roBtn.classList.toggle('on', on);
    roBtn.title = on ? 'Read-only is on: tap to write again' : 'Read-only: look without leaving marks';
    eraserCur.hidden = true;
    if (!quiet) toast(on ? 'Read-only: nothing you touch will draw. Tap the eye to write again.' : 'Writing is on again', 2600);
  }

  // --- timer: a stopwatch, or a countdown for timed practice. It keeps running when you switch notebooks.
  let timerEl = null, timerInt = 0;
  const tmNow = () => TM.acc + (TM.running ? Date.now() - TM.t0 : 0);
  const tmFmt = ms => { const s = Math.round(ms / 1000), hh = Math.floor(s / 3600); return (hh ? hh + ':' : '') + String(Math.floor(s % 3600 / 60)).padStart(hh ? 2 : 1, '0') + ':' + String(s % 60).padStart(2, '0'); };

  function toggleTimer(open = !TM.open) {
    TM.open = open;
    timerBtn.classList.toggle('on', open);
    clearInterval(timerInt);
    if (timerEl) { timerEl.remove(); timerEl = null; }
    if (!open) return;
    const time = h('button', { class: 'tm-time', type: 'button', title: 'Set a countdown', onclick: setCountdown });
    const play = h('button', { class: 'ic sm', type: 'button', onclick: () => { if (TM.running) { TM.acc = tmNow(); TM.running = false; } else { if (TM.dur && TM.acc >= TM.dur) TM.acc = 0; TM.t0 = Date.now(); TM.running = true; } tick(); } });
    const tick = () => {
      let ms = tmNow();
      if (TM.dur && TM.running && ms >= TM.dur) { // countdown finished
        TM.running = false;
        TM.acc = ms = TM.dur;
        timerEl.classList.add('done');
        toast('Time is up', 5000);
        beep();
      }
      time.textContent = tmFmt(TM.dur ? Math.max(0, TM.dur - ms) : ms);
      play.innerHTML = TM.running ? I.pause : I.play;
      play.title = TM.running ? 'Pause' : 'Start';
      if (TM.running) timerEl.classList.remove('done');
    };
    timerEl = h('div', { class: 'timer' }, time, play,
      h('button', { class: 'ic sm', type: 'button', title: 'Reset', html: I.rotate, onclick: () => { TM.acc = 0; TM.t0 = Date.now(); timerEl.classList.remove('done'); tick(); } }),
      h('button', { class: 'ic sm', type: 'button', title: 'Close the timer', html: I.close, onclick: () => { TM.running = false; TM.acc = 0; toggleTimer(false); } }));
    overlay.append(timerEl);
    tick();
    timerInt = setInterval(tick, 250);
    async function setCountdown() {
      const v = await promptText('Countdown in minutes (0 for a stopwatch)', TM.dur ? String(TM.dur / 60000) : '', 'For example 30');
      if (v == null) return;
      const m = parseFloat(v);
      TM.dur = m > 0 ? Math.round(m * 60000) : 0;
      TM.acc = 0;
      TM.running = false;
      timerEl.classList.remove('done');
      tick();
    }
  }

  function beep() {
    try {
      const A = new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < 3; i++) {
        const o = A.createOscillator(), g = A.createGain();
        o.frequency.value = 880;
        o.connect(g); g.connect(A.destination);
        g.gain.setValueAtTime(0.25, A.currentTime + i * 0.35);
        g.gain.setValueAtTime(0, A.currentTime + i * 0.35 + 0.2);
        o.start(A.currentTime + i * 0.35);
        o.stop(A.currentTime + i * 0.35 + 0.22);
      }
      setTimeout(() => A.close(), 1500);
    } catch { /* no sound available */ }
  }

  // --- notebook versions: how the notebook stood at the start of each writing session (kept on this device).
  // A session is one stretch of work; opening the notebook again within 20 minutes continues the same one.
  // Only pages that a session changes are stored, each as it was before the session touched it.
  const VER_GAP = 20 * 60e3, VER_MAX = 25, VER_DAYS = 60;
  const clonePg = p => ({ ...p, items: p.items.slice(), dels: {} });
  const sessNow = () => ({ order: pages.map(p => p.id), pages: new Map(pages.map(p => [p.id, clonePg(p)])) });
  let sessOrig = sessNow(), ver = null, verEntry = null, verList = null, verFresh = false, verChain = Promise.resolve();
  const verKey = t => `ver:${doc.id}:${t}`;
  const fmtVer = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  async function verOpen() {
    if (ver) return false;
    const list = (await db.getMeta('vers:' + doc.id)) || [];
    const lastE = list[list.length - 1];
    if (!verFresh && lastE && Date.now() - lastE.last < VER_GAP) {
      const rec = await db.getMeta(verKey(lastE.t));
      if (rec) { ver = rec; verEntry = lastE; verList = list; return false; }
    }
    const t = Date.now();
    ver = { t, order: sessOrig.order, pre: {} };
    verEntry = { t, last: t, n: 0 };
    list.push(verEntry);
    while (list.length > VER_MAX || (list.length > 1 && t - list[0].t > VER_DAYS * 864e5)) await db.setMeta(verKey(list.shift().t), null);
    verList = list;
    verFresh = false;
    return true;
  }

  // Called after every save with the pages that were just written.
  function verRecord(ps) {
    verChain = verChain.then(async () => {
      let write = await verOpen();
      for (const p of ps) if (!(p.id in ver.pre)) { ver.pre[p.id] = sessOrig.pages.get(p.id) || null; write = true; } // null = the page did not exist yet
      const now = Date.now(), stale = now - verEntry.last > 60e3;
      verEntry.last = now;
      verEntry.n = Object.keys(ver.pre).length;
      if (write) await db.setMeta(verKey(ver.t), ver);
      if (write || stale) await db.setMeta('vers:' + doc.id, verList);
    }).catch(e => console.warn('Version not saved', e));
    return verChain;
  }

  // Start a new version from the notebook as it is this moment (done before going back, so that can be undone too).
  async function verCut() {
    await verChain;
    ver = null;
    verFresh = true;
    sessOrig = sessNow();
  }

  const pgLook = p => JSON.stringify([p.template, p.paper, p.bg || null, p.pdf || null, p.w, p.h]);
  const samePg = (a, b) => sameList(a.items, b.items) && pgLook(a) === pgLook(b);

  // The pages of the notebook as they were at the start of version k (recs: every version, oldest first).
  async function verState(recs, k) {
    const out = [];
    for (const id of recs[k].order) {
      let rec = null;
      for (let j = k; j < recs.length && !rec; j++) rec = recs[j].pre[id] || null;
      if (!rec) rec = pages.find(p => p.id === id) || null;                 // not changed since: as it is now
      if (!rec) { const d = await db.get('pages', id); if (d && !d.deleted && d.docId === doc.id) rec = d; } // since moved to the bin
      if (rec) out.push(rec);
    }
    return out;
  }

  async function versionsDialog() {
    commitText();
    await flush().catch(saveFailed);
    await verChain;
    const recs = [];
    for (const e of (await db.getMeta('vers:' + doc.id)) || []) { const r = await db.getMeta(verKey(e.t)); if (r) recs.push(r); }
    if (!recs.length) { toast('No earlier versions yet. One is kept each time you start working on this notebook.', 3800); return; }
    let m = null;
    m = modal({
      title: 'Earlier versions', wide: true,
      body: h('div', null,
        h('p', { class: 'modal-text small' }, `The notebook as it stood at the start of each writing session on this device. The last ${VER_MAX} sessions are kept, for up to ${VER_DAYS} days.`),
        h('div', { class: 'menu flat pick-list' }, recs.map((r, k) => {
          const n = Object.keys(r.pre).length;
          return h('button', { class: 'mi', type: 'button', onclick: async () => { m.close(); versionView(recs, k); } },
            h('span', { class: 'mi-ic', html: I.history }), 'Before ' + fmtVer(r.t),
            h('span', { class: 'bk-sub' }, k === recs.length - 1 && ver && ver.t === r.t ? 'start of this session' : `${n} page${n === 1 ? '' : 's'} changed after it`));
        }).reverse()))
    });
  }

  async function versionView(recs, k) {
    const then = await verState(recs, k), when = fmtVer(recs[k].t);
    const nowIds = new Set(pages.map(p => p.id)), thenIds = new Set(then.map(r => r.id));
    const diff = then.map((r, i) => ({ r, i, cur: pages.find(p => p.id === r.id) })).filter(x => !x.cur || !samePg(x.r, x.cur));
    const added = pages.filter(p => !thenIds.has(p.id)).length;
    const moved = then.filter(r => nowIds.has(r.id)).map(r => r.id).join() !== pages.filter(p => thenIds.has(p.id)).map(p => p.id).join();
    if (!diff.length && !added && !moved) { toast('Nothing has changed since that version.'); return; }
    let m = null;
    const cards = diff.map(x => {
      const c = h('canvas', { class: 'hist-c zoomable', title: 'Tap to see it large', onclick: () => bigPreview(x.r, `Page ${x.i + 1} before ${when}`) });
      R.renderPageTo(x.r, c, 200).catch(() => {});
      return h('div', { class: 'ver-card' }, c,
        h('b', null, `Page ${x.i + 1}`),
        h('span', { class: 'bk-sub' }, x.cur ? 'changed since' : 'removed since'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => { m.close(); verRestorePage(then, x.r); } }, 'Restore this page'));
    });
    const notes = [added && `${added} page${added === 1 ? ' was' : 's were'} added since (restoring the whole notebook moves ${added === 1 ? 'it' : 'them'} to the bin)`, moved && 'the page order was different'].filter(Boolean);
    m = modal({
      title: 'As it was before ' + when, wide: true,
      body: h('div', null,
        h('p', { class: 'modal-text small' }, diff.length ? 'These pages were different then. This is how they looked.' : 'No page had different writing then.', notes.length ? ' Also: ' + notes.join('; ') + '.' : ''),
        h('div', { class: 'ver-grid' }, cards),
        h('p', { class: 'modal-text small' }, 'Going back can itself be undone: the notebook as it is now is kept as a new version first.')),
      actions: [
        { label: 'Close' },
        { label: 'Save as a copy', onClick: () => { verCopy(then, when); } },
        { label: 'Restore whole notebook', primary: true, onClick: () => { verRestoreAll(then, when); } }
      ]
    });
  }

  function putBack(cur, rec) {
    const old = cur.items.slice(), nu = rec.items.map(it => ({ ...it }));
    removeItems(cur, old);
    addItems(cur, nu);
    Object.assign(cur, { template: rec.template, paper: rec.paper, bg: rec.bg || null, pdf: rec.pdf || null, w: rec.w, h: rec.h });
    if (rec.tpl) cur.tpl = rec.tpl; else delete cur.tpl;
    dirty(cur);
  }

  function revive(rec) {
    const t = Date.now(), p = { ...rec, items: rec.items.map(it => ({ ...it, m: t })), dels: {}, modified: t };
    delete p.trashed;
    delete p.ti;
    gonePages.delete(p.id);
    dirtyPages.add(p);
    return p;
  }

  async function verBegin() {
    commitText();
    clearSel();
    await flush().catch(saveFailed);
    await verCut();
    undoStack.length = 0; // undo steps no longer match the pages
    redoStack.length = 0;
    updateUndoUi();
  }

  async function verRestoreAll(then, when) {
    if (!then.length) return;
    await verBegin();
    const keep = new Set(then.map(r => r.id)), extra = pages.filter(p => !keep.has(p.id));
    const next = then.map(rec => {
      const cur = pages.find(p => p.id === rec.id);
      if (!cur) return revive(rec);
      if (!samePg(rec, cur)) putBack(cur, rec);
      return cur;
    });
    if (extra.length) verRecord(extra);
    for (const pg of extra) { dirtyPages.delete(pg); gonePages.add(pg.id); await trashPage(pg, doc, pages.indexOf(pg)); }
    const at = clamp(pvs.indexOf(currentPv()), 0, next.length - 1);
    pages.splice(0, pages.length, ...next);
    structureChanged(at);
    toast(`The notebook is back to how it was before ${when}`, 3500);
  }

  async function verRestorePage(then, rec) {
    await verBegin();
    const cur = pages.find(p => p.id === rec.id);
    let at;
    if (cur) { putBack(cur, rec); at = pages.indexOf(cur); }
    else { at = clamp(then.indexOf(rec), 0, pages.length); pages.splice(at, 0, revive(rec)); }
    structureChanged(at);
    toast('That page is back to the earlier version');
  }

  async function verCopy(then, when) {
    const t = Date.now(), id = uid();
    const ps = then.map(r => {
      const p = { ...r, id: uid(), docId: id, dels: {}, modified: t, items: r.items.map(it => ({ ...it, id: uid(), m: t })) };
      delete p.trashed;
      delete p.ti;
      return p;
    });
    const copy = { ...doc, id, title: `${doc.title} (before ${when})`, pages: ps.map(p => p.id), created: t, modified: t, thumb: null };
    delete copy.journal;
    delete copy.fav;
    await db.putMany('pages', ps);
    await db.put('docs', copy);
    toast(`"${copy.title}" is in your library`, 3500);
  }

  // --- journal: a page per day, reached through a calendar
  function journalGo(key) {
    let i = pages.findIndex(p => p.day === key);
    if (i >= 0) { scrollToPage(i); return; }
    const pg = newDayPage(doc, key);
    i = dayIndex(pages, key);
    pages.splice(i, 0, pg);
    dirtyPages.add(pg);
    structureChanged(i);
  }

  function calendarDialog() {
    const today = dayKey(), cur = currentPv().page.day || today;
    let y = +cur.slice(0, 4), mo = +cur.slice(5, 7) - 1, m = null;
    const body = h('div', { class: 'cal' });
    const step = d => { mo += d; if (mo < 0) { mo = 11; y--; } else if (mo > 11) { mo = 0; y++; } draw(); };
    const draw = () => {
      const made = new Map(); // day -> does it have anything written on it
      for (const p of pages) if (p.day) made.set(p.day, made.get(p.day) || p.items.length > 0);
      const lead = (new Date(y, mo, 1).getDay() + 6) % 7, n = new Date(y, mo + 1, 0).getDate(); // weeks start on Monday
      const cells = [];
      for (let i = 0; i < lead; i++) cells.push(h('span'));
      for (let d = 1; d <= n; d++) {
        const key = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        cells.push(h('button', {
          class: 'cal-d' + (made.get(key) ? ' has' : made.has(key) ? ' made' : '') + (key === today ? ' today' : '') + (key === cur ? ' cur' : ''), type: 'button',
          onclick: () => { m.close(); journalGo(key); }
        }, String(d)));
      }
      fill(body,
        h('div', { class: 'cal-head' },
          h('button', { class: 'ic sm', type: 'button', title: 'Earlier month', html: I.back, onclick: () => step(-1) }),
          h('b', null, new Date(y, mo, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })),
          h('button', { class: 'ic sm', type: 'button', title: 'Later month', html: I.fwd, onclick: () => step(1) })),
        h('div', { class: 'cal-grid' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(w => h('span', { class: 'cal-w' }, w)), cells),
        h('p', { class: 'modal-text small' }, 'Filled days have writing on them. Tap any day to open its page; a new page is made if there is none.'));
    };
    draw();
    m = modal({ title: 'Journal', body, actions: [{ label: 'Close' }, { label: 'Today', primary: true, onClick: () => journalGo(today) }] });
  }

  // --- several pages at once (pages panel > Select pages)
  const pickedPages = () => pages.filter(p => picked.has(p.id)); // in notebook order
  const clonePage = (p, docId) => {
    const t = Date.now();
    return { ...p, id: uid(), docId, dels: {}, modified: t, items: p.items.map(it => ({ ...it, id: uid(), m: t })) };
  };

  // Tap = add or remove one page; Shift+click = everything from the last one tapped to this one.
  function pickCard(i, range) {
    if (range && lastPick >= 0) for (let k = Math.min(i, lastPick); k <= Math.max(i, lastPick); k++) picked.add(pages[k].id);
    else if (picked.has(pages[i].id)) picked.delete(pages[i].id);
    else picked.add(pages[i].id);
    lastPick = i;
    updatePick();
  }

  function updatePick() {
    const live = new Set(pages.map(p => p.id));
    for (const id of [...picked]) if (!live.has(id)) picked.delete(id);
    if (panelList) for (const c of panelList.querySelectorAll('.thumb')) c.classList.toggle('picked', picked.has(c.getAttribute('data-pid')));
    if (!pickBar) return;
    const n = picked.size, all = n === pages.length;
    pickBar.replaceChildren(
      h('b', null, n ? `${n} selected` : 'Tap pages'),
      h('div', { class: 'pick-row' },
        h('button', { class: 'chip sm', type: 'button', onclick: () => { if (all) picked.clear(); else for (const p of pages) picked.add(p.id); updatePick(); } }, all ? 'None' : 'All'),
        h('button', { class: 'btn sm primary', type: 'button', onclick: e => pickMenu(e.currentTarget) }, 'Actions')));
  }

  async function pickMenu(anchor) {
    const n = picked.size, clip = (await db.getMeta('clipPages')) || [];
    const need = fn => () => { if (!picked.size) { toast('Tap the pages you want first.'); return; } fn(); };
    const s = n === 1 ? '' : 's';
    popMenu(anchor, [
      { label: 'Copy', icon: I.copy, onClick: need(copyPicked) },
      clip.length ? { label: `Paste ${clip.length} copied page${clip.length === 1 ? '' : 's'}`, icon: I.paste, onClick: () => pastePages(n ? pages.indexOf(pickedPages().pop()) : pvs.indexOf(currentPv())) } : null,
      { label: 'Duplicate', icon: I.pages, onClick: need(duplicatePicked) },
      '-',
      { label: 'Move to the start', icon: I.up, onClick: need(() => movePicked('start')) },
      { label: 'Move to the end', icon: I.down, onClick: need(() => movePicked('end')) },
      {
        label: 'Move after page...', icon: I.move, onClick: need(async () => {
          const v = await promptText(`Move ${n} page${s} after page`, '', `0 (the start) to ${pages.length}`);
          if (v == null || v === '' || isNaN(parseInt(v, 10))) return;
          movePicked(clamp(parseInt(v, 10), 0, pages.length));
        })
      },
      '-',
      { label: 'Copy to another notebook', icon: I.book, onClick: need(() => pickedToNotebook(false)) },
      { label: 'Move to another notebook', icon: I.move, onClick: need(() => pickedToNotebook(true)) },
      { label: 'Export as PDF', icon: I.share, onClick: need(async () => { commitText(); await flush().catch(saveFailed); exportFlow(doc.id, pickedPages().map(p => p.id)); }) },
      { label: pickedPages().every(p => p.bm) && n ? 'Remove bookmarks' : 'Bookmark', icon: I.star, onClick: need(bookmarkPicked) },
      '-',
      { label: `Delete ${n || ''} page${s}`.replace('  ', ' '), icon: I.trash, danger: true, onClick: need(deletePicked) }
    ].filter(Boolean), { align: 'right' });
  }

  async function copyPicked() {
    const sel = pickedPages();
    await db.setMeta('clipPages', sel.map(p => ({ ...p, items: p.items.slice() })));
    toast(`Copied ${sel.length} page${sel.length === 1 ? '' : 's'}. Paste them here or in any notebook from the pages panel.`, 3200);
  }

  // Copied pages go in after page index i, in this or any other notebook.
  async function pastePages(i) {
    const src = (await db.getMeta('clipPages')) || [];
    if (!src.length) { toast('No pages copied yet. Use Select pages, then Actions > Copy.'); return; }
    const copies = src.map(p => { const c = clonePage(p, doc.id); delete c.trashed; delete c.ti; return c; });
    await Promise.all(copies.flatMap(p => [p.bg && R.loadImage(p.bg.a), ...p.items.filter(it => it.t === 'im').map(it => R.loadImage(it.a))]));
    const at = clamp(i, -1, pages.length - 1) + 1;
    pages.splice(at, 0, ...copies);
    for (const c of copies) dirtyPages.add(c);
    if (pickMode) { picked.clear(); for (const c of copies) picked.add(c.id); }
    structureChanged(at);
    toast(`Pasted ${copies.length} page${copies.length === 1 ? '' : 's'}`);
  }

  function duplicatePicked() {
    const sel = pickedPages(), at = pages.indexOf(sel[sel.length - 1]) + 1;
    const copies = sel.map(p => clonePage(p, doc.id));
    pages.splice(at, 0, ...copies);
    for (const c of copies) dirtyPages.add(c);
    picked.clear();
    for (const c of copies) picked.add(c.id);
    structureChanged(at);
  }

  // where: 'start', 'end', or n = after the page that is number n now.
  function movePicked(where) {
    const sel = pickedPages(), rest = pages.filter(p => !picked.has(p.id));
    const at = where === 'start' ? 0 : where === 'end' ? rest.length : rest.filter(p => pages.indexOf(p) < where).length;
    rest.splice(at, 0, ...sel);
    pages.splice(0, pages.length, ...rest);
    structureChanged(at);
  }

  function bookmarkPicked() {
    const sel = pickedPages(), all = sel.every(p => p.bm);
    for (const p of sel) { p.bm = !all; dirty(p); }
    updateIndicator();
    fillPanel();
  }

  async function deletePicked() {
    const sel = pickedPages(), n = sel.length;
    if (n >= pages.length) { toast('A notebook needs at least one page. Leave one unselected.'); return; }
    if (n > 1 && !await confirmBox('Delete pages', `Move ${n} pages to the bin? They can be restored for ${TRASH_DAYS} days.`, 'Delete', true)) return;
    commitText();
    await flush().catch(saveFailed);
    const first = pages.indexOf(sel[0]);
    const at = new Map(sel.map(p => [p, pages.indexOf(p)]));
    for (const pg of sel) {
      pages.splice(pages.indexOf(pg), 1);
      dirtyPages.delete(pg);
      gonePages.add(pg.id);
      verRecord([pg]);
      await trashPage(pg, doc, at.get(pg));
    }
    picked.clear();
    structureChanged(Math.min(first, pages.length - 1));
    toast(`${n} page${n === 1 ? ' is' : 's are'} in the bin for ${TRASH_DAYS} days`);
  }

  async function pickedToNotebook(move) {
    const sel = pickedPages(), n = sel.length;
    if (move && n >= pages.length) { toast('A notebook needs at least one page. Leave one unselected.'); return; }
    const d = await chooseNotebook(`${move ? 'Move' : 'Copy'} ${n} page${n === 1 ? '' : 's'} to`, doc.id);
    if (!d) return;
    commitText();
    await flush().catch(saveFailed);
    const dest = await db.get('docs', d.id);
    if (!dest || dest.deleted || dest.trashed) { toast('That notebook is no longer in your library.'); return; }
    const t = Date.now();
    let recs;
    if (move) {
      const first = pages.indexOf(sel[0]);
      for (const pg of sel) { pages.splice(pages.indexOf(pg), 1); dirtyPages.delete(pg); gonePages.add(pg.id); }
      recs = sel.map(pg => ({ ...pg, docId: dest.id, modified: t })); // the same pages, now belonging to the other notebook
      await db.putMany('pages', recs);
      picked.clear();
      structureChanged(Math.min(first, pages.length - 1));
    } else {
      recs = sel.map(p => clonePage(p, dest.id));
      await db.putMany('pages', recs);
    }
    await db.put('docs', { ...dest, pages: [...(dest.pages || []), ...recs.map(p => p.id)], modified: Date.now() });
    toast(`${n} page${n === 1 ? '' : 's'} ${move ? 'moved' : 'copied'} to the end of "${dest.title}"`, 3200);
  }

  const thumbTimers = new Map();
  function refreshThumb(page) {
    const c = thumbs.get(page.id);
    if (!c) return;
    clearTimeout(thumbTimers.get(page.id));
    thumbTimers.set(page.id, setTimeout(() => { if (!destroyed && panelOpen) R.renderPageTo(page, c, 220).catch(() => {}); }, 700));
  }

  // ------------------------------------------------------------------ toolbar
  const TOOLS = [
    ['pen', I.pen, 'Pen (P)'], ['hl', I.hl, 'Highlighter (H)'], ['eraser', I.eraser, 'Eraser (E)'],
    ['lasso', I.lasso, 'Select (L)'], ['shape', I.shape, 'Shapes (S)'], ['text', I.text, 'Text (T)'],
    ['tape', I.tape, 'Tape (A)'], ['laser', I.laser, 'Laser pointer (K)']
  ];

  function renderTools() {
    toolsEl.replaceChildren(
      ...TOOLS.map(([id, icon, title]) => h('button', {
        class: 'ic tool' + (prefs.tool === id ? ' on' : '') + (id === 'pen' ? ' more' : ''), type: 'button',
        title: id === 'pen' ? title + '. Tap again to choose the pen type' : title, html: icon,
        // Tapping the pen while it is already chosen opens the pen types.
        onclick: e => { if (id === 'pen' && prefs.tool === 'pen' && !readOnly) penTypeMenu(e.currentTarget); else setTool(id); }
      })),
      h('button', { class: 'ic tool', type: 'button', title: 'Insert: picture, scan, sticky note, table, saved element', html: I.insert, onclick: e => insertMenu(e.currentTarget) }));
  }

  function penTypeMenu(anchor) {
    const cur = prefs.pen.style || 'fountain';
    const hint = { ball: 'even line', fountain: 'follows pressure', brush: 'strong thick and thin', pencil: 'grainy' };
    popMenu(anchor, Object.keys(STYLE_NAMES).map(v => ({
      label: `${v === cur ? '✓ ' : '    '}${STYLE_NAMES[v]} (${hint[v]})`, icon: I.pen,
      onClick: () => { prefs.pen.style = v; savePrefs(); renderOpts(); }
    })));
  }

  function setTool(t) {
    commitText();
    if (t !== 'lasso') clearSel();
    prefs.tool = t;
    savePrefs();
    eraserCur.hidden = true;
    vp.dataset.tool = t;
    renderTools();
    renderOpts();
  }

  function swatches(key, colors) {
    const cur = prefs[key].color;
    const pick = c => {
      prefs[key].color = c;
      savePrefs();
      if (key === 'text' && textEd) { textEd.color = inkFor(textEd.pv, c); styleTa(); textEd.ta.focus(); }
      renderOpts();
    };
    const custom = h('label', { class: 'sw custom' + (colors.includes(cur) ? '' : ' on'), title: 'Custom colour', style: { '--c': colors.includes(cur) ? 'transparent' : cur } },
      h('input', { type: 'color', value: cur, onchange: e => pick(e.target.value) }));
    return colors.map(c => h('button', { class: 'sw' + (cur === c ? ' on' : ''), type: 'button', title: c, style: { '--c': c }, onclick: () => pick(c) })).concat(custom);
  }

  // Tip sizes are stored in page units (points) and shown in millimetres, as on paper.
  const fmtMm = pt => { const mm = pt * MM; return (mm < 1 ? String(Math.round(mm * 100) / 100) : mm.toFixed(1)) + ' mm'; };

  // Preset dots (given in mm) followed by a button showing the exact size, which opens a slider.
  function sizes(key, mms, dots, maxMm) {
    const cur = prefs[key].size;
    const btns = mms.map((mm, i) => {
      const s = mmToPt(mm);
      return h('button', {
        class: 'sz' + (Math.abs(cur - s) < 0.02 ? ' on' : ''), type: 'button', title: mm + ' mm',
        onclick: () => { prefs[key].size = s; savePrefs(); renderOpts(); }
      }, h('span', { class: 'dot', style: { width: dots[i] + 'px', height: dots[i] + 'px' } }));
    });
    return [...btns, h('button', { class: 'mm', type: 'button', title: 'Tip size', onclick: e => sizePopover(e.currentTarget, key, mms[0] >= 2 ? 1 : 0.1, maxMm) }, fmtMm(cur))];
  }

  function sizePopover(anchor, key, minMm, maxMm) {
    const val = h('b', null, fmtMm(prefs[key].size));
    const line = h('span');
    const show = () => {
      val.textContent = fmtMm(prefs[key].size);
      line.style.height = Math.max(1, prefs[key].size * scale) + 'px'; // as thick as it will be on the page right now
      line.style.background = key === 'eraser' ? 'var(--muted)' : prefs[key].color;
      const pill = optsEl.querySelector('.mm'); // the tool bar may have been redrawn since the slider opened
      if (pill) pill.textContent = fmtMm(prefs[key].size);
    };
    const rng = h('input', {
      type: 'range', class: 'mm-range', min: minMm, max: maxMm, step: maxMm > 4 ? 0.25 : 0.05,
      value: Math.round(prefs[key].size * MM * 100) / 100,
      oninput: () => { prefs[key].size = mmToPt(Number(rng.value)); show(); },
      onchange: () => { savePrefs(); renderOpts(); }
    });
    show();
    popover(anchor, h('div', { class: 'mm-pop' },
      h('div', { class: 'mm-head' }, h('span', null, 'Tip size'), val),
      rng,
      h('div', { class: 'mm-prev' }, line)));
  }

  const seg = (items, cur, onPick) => h('div', { class: 'seg' }, items.map(([v, label]) =>
    h('button', { class: v === cur ? 'on' : '', type: 'button', onclick: () => onPick(v) }, label)));

  // Favourite pens: saved colour + tip size + style, one tap to switch. Hold (or right-click) one to remove it.
  const STYLE_NAMES = { ball: 'Ballpoint', fountain: 'Fountain', brush: 'Brush', pencil: 'Pencil' };
  function favPens() {
    const cur = prefs.pen, favs = prefs.favs || (prefs.favs = []);
    const same = f => f.color === cur.color && Math.abs(f.size - cur.size) < 0.02 && (f.style || 'fountain') === (cur.style || 'fountain');
    const chips = favs.map((f, i) => {
      let held = false, t = 0;
      const remove = () => popMenu(b, [{ label: 'Remove this favourite', icon: I.trash, danger: true, onClick: () => { favs.splice(i, 1); savePrefs(); renderOpts(); } }]);
      const d = clamp(f.size * 3.4, 4, 17);
      const b = h('button', {
        class: 'fav' + (same(f) ? ' on' : ''), type: 'button',
        title: `${fmtMm(f.size)} ${STYLE_NAMES[f.style] || 'Fountain'} (hold to remove)`,
        onpointerdown: () => { held = false; clearTimeout(t); t = setTimeout(() => { held = true; remove(); }, 600); },
        onpointerup: () => clearTimeout(t),
        onpointerleave: () => clearTimeout(t),
        oncontextmenu: e => { e.preventDefault(); clearTimeout(t); if (!held) { held = true; remove(); } },
        onclick: () => {
          if (held) { held = false; return; }
          Object.assign(prefs.pen, { color: f.color, size: f.size, style: f.style || 'fountain' });
          savePrefs();
          renderOpts();
        }
      }, h('span', { class: 'dot', style: { width: d + 'px', height: d + 'px', background: f.color } }), h('small', null, fmtMm(f.size).replace(' mm', '')));
      return b;
    });
    const add = h('button', {
      class: 'ic sm', type: 'button', title: 'Save this pen as a favourite', html: I.star,
      onclick: () => {
        if (favs.some(same)) { toast('This pen is already a favourite.'); return; }
        if (favs.length >= 8) { toast('Eight favourites is the limit. Hold one to remove it.'); return; }
        favs.push({ color: cur.color, size: cur.size, style: cur.style || 'fountain' });
        savePrefs();
        renderOpts();
      }
    });
    return [...chips, add];
  }

  function renderOpts() {
    const t = prefs.tool;
    let kids = [];
    if (t === 'pen') {
      kids = [
        ...favPens(), h('div', { class: 'vsep' }),
        ...swatches('pen', PEN_COLORS), h('div', { class: 'vsep' }),
        ...sizes('pen', [0.3, 0.5, 0.7, 1, 1.5], [3, 5, 7, 10, 14], 3)
      ];
    }
    else if (t === 'hl') kids = [...swatches('hl', HL_COLORS), h('div', { class: 'vsep' }), ...sizes('hl', [3.5, 5.5, 8.5], [7, 11, 15], 14)];
    else if (t === 'eraser') {
      kids = [
        seg([['stroke', 'Whole stroke'], ['precise', 'Precise']], prefs.eraser.mode, v => { prefs.eraser.mode = v; savePrefs(); renderOpts(); }),
        h('div', { class: 'vsep' }),
        h('span', { class: 'lbl' }, 'Erases'),
        seg([['all', 'Everything'], ['pen', 'Pen only'], ['hl', 'Highlighter only']], prefs.eraser.only || 'all', v => { prefs.eraser.only = v; savePrefs(); renderOpts(); }),
        h('div', { class: 'vsep' }), ...sizes('eraser', [3, 5.5, 10.5], [7, 11, 16], 20)
      ];
    } else if (t === 'shape') {
      const fill = prefs.shape.fill;
      const fillPick = v => { prefs.shape.fill = v; savePrefs(); renderOpts(); };
      kids = [
        seg(SHAPES, prefs.shape.kind, v => { prefs.shape.kind = v; savePrefs(); renderOpts(); }),
        h('div', { class: 'vsep' }), ...swatches('shape', PEN_COLORS), h('div', { class: 'vsep' }), ...sizes('shape', [0.4, 0.8, 1.4], [5, 8, 12], 3),
        h('div', { class: 'vsep' }), h('span', { class: 'lbl' }, 'Fill'),
        h('button', { class: 'sw nofill' + (fill ? '' : ' on'), type: 'button', title: 'No fill', onclick: () => fillPick(null) }),
        ...FILL_COLORS.map(c => h('button', { class: 'sw' + (fill === c ? ' on' : ''), type: 'button', title: 'Fill', style: { '--c': c }, onclick: () => fillPick(c) }))
      ];
    } else if (t === 'text') {
      const cur = textEd ? { ...textEd, size: textEd.fs } : prefs.text; // the bar shows the box being typed in
      const tgl = (k, label, title) => h('button', {
        class: 'tgl ' + k + (cur[k] ? ' on' : ''), type: 'button', title, onclick: () => textStyle(k, !cur[k])
      }, label);
      kids = [...swatches('text', PEN_COLORS), h('div', { class: 'vsep' }),
        seg([[12, 'S'], [16, 'M'], [24, 'L'], [36, 'XL']], cur.size, v => textStyle('size', v)),
        tgl('b', 'B', 'Bold'), tgl('i', 'I', 'Italic'), tgl('u', 'U', 'Underline'),
        seg([['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']], cur.ff || 'sans', v => textStyle('ff', v)),
        seg([['l', 'Left'], ['c', 'Centre'], ['r', 'Right']], cur.al || 'l', v => textStyle('al', v)),
        h('button', { class: 'btn sm', type: 'button', title: 'Bulleted list', onclick: toggleBullet }, h('span', { class: 'btn-ic', html: I.list }), 'List'),
        h('span', { class: 'hint' }, 'Tap the page to type')];
    } else if (t === 'tape') {
      kids = [...swatches('tape', TAPE_COLORS), h('div', { class: 'vsep' }), ...sizes('tape', [4, 7, 11], [7, 11, 15], 20),
        h('span', { class: 'hint' }, 'Drag to cover something. Tap a strip to show or hide what is under it.')];
    } else if (t === 'laser') {
      kids = [...swatches('laser', LASER_COLORS), h('span', { class: 'hint' }, 'Point and draw: nothing is saved. Tap a link or a strip of tape to use it.')];
    } else {
      kids = [
        clipItems && clipItems.length ? h('button', { class: 'btn sm', type: 'button', title: 'Paste (Ctrl+V)', onclick: () => pasteClip() }, h('span', { class: 'btn-ic', html: I.paste }), 'Paste') : null,
        h('span', { class: 'hint' }, 'Circle items to select them, or tap one. Drag to move, pull the corner to resize.')
      ].filter(Boolean);
    }
    optsEl.replaceChildren(...kids);
  }

  async function rename() {
    const name = await promptText('Rename notebook', doc.title);
    if (!name || name === doc.title) return;
    doc.title = name;
    titleBtn.textContent = name;
    docDirty = true;
    changed = true;
    flush().catch(saveFailed);
  }

  function gestureHelp() {
    const rows = [
      ['Scribble over writing', 'Erase it'],
      ['Hold the pen still at the end of a line', 'Make it straight'],
      ['Hold still after closing a circle, box or triangle', 'Tidy the shape'],
      ['Pull up past the last page', 'Add a new page'],
      ['Tap a strip of tape with a finger', 'Show or hide what is under it'],
      ['Tap a link in a PDF with a finger', 'Follow it'],
      ['Start a line beside the ruler', 'It runs straight along the edge'],
      ['Hold a page in the pages panel, then drag', 'Move it to a new place'],
      ['Two-finger tap', 'Undo'],
      ['Three-finger tap', 'Redo'],
      ['Pinch', 'Zoom in and out'],
      ['Two-finger drag', 'Move around the page'],
      ['Double tap (when fingers scroll)', 'Zoom in on that spot, or back to full width'],
      ['Stylus side button', 'Erase while held'],
      ['Resting hand', 'Ignored while the stylus is writing or hovering']
    ];
    modal({
      title: 'Gestures',
      body: h('div', { class: 'gest' }, rows.map(([a, b]) => h('div', { class: 'gest-row' }, h('b', null, a), h('span', null, b)))),
      actions: [{ label: 'OK', primary: true }]
    });
  }

  function moreMenu(anchor) {
    const narrow = innerWidth <= 760 || full; // the tool row's own buttons are hidden on phones and in full screen
    const fd = prefs.fingerDraw;
    const label = fd === true ? 'Finger drawing: on' : fd === false ? 'Finger drawing: off' : `Finger drawing: auto (${fingerDraws() ? 'on' : 'off'})`;
    popMenu(anchor, [
      // On a wide screen these three have their own buttons in the tool row; a phone has no room for them there.
      narrow ? { label: readOnly ? 'Read-only: on' : 'Read-only: off', icon: I.eye, onClick: () => setReadOnly(!readOnly) } : null,
      narrow ? { label: 'Timer', icon: I.timer, onClick: () => toggleTimer() } : null,
      narrow ? { label: 'Find text', icon: I.search, onClick: openFind } : null,
      narrow ? '-' : null,
      pages.some(p => p.pdf && !p.tpl) ? { label: 'PDF contents', icon: I.list, onClick: outlineDialog } : null,
      { label: 'Earlier versions of this notebook', icon: I.history, onClick: versionsDialog },
      { label: 'History of this page', icon: I.history, onClick: historyDialog },
      { label: 'Notebook details', icon: I.info, onClick: async () => { commitText(); await flush().catch(saveFailed); detailsDialog('d', doc.id); } },
      { label: split ? 'Show another notebook beside' : 'Open another notebook beside', icon: I.split, onClick: openBeside },
      split ? { label: 'Close the other notebook', icon: I.close, onClick: () => { location.hash = '#/d/' + doc.id; } } : null,
      '-',
      { label: ruler ? 'Put the ruler away' : 'Ruler', icon: I.ruler, onClick: toggleRuler },
      { label: zw ? 'Close the zoom window' : 'Zoom window', icon: I.zoomwin, onClick: () => toggleZoom() },
      { label: hz ? 'Pages: side by side' : 'Pages: down the screen', icon: I.flow, onClick: () => setFlow(hz ? 'v' : 'h') },
      '-',
      { label: 'Page template', icon: I.template, onClick: templateDialog },
      { label: hz ? 'Fit whole page' : 'Fit page width', icon: I.fit, onClick: fitWidth },
      { label: full ? 'Leave full screen' : 'Full screen', icon: full ? I.fullExit : I.full, onClick: () => setFull(!full) },
      {
        label: 'Scribble to erase: ' + (prefs.scribble !== false ? 'on' : 'off'), icon: I.eraser, onClick: () => {
          prefs.scribble = prefs.scribble === false;
          savePrefs();
          toast(prefs.scribble ? 'Scribble over writing with the pen to erase it' : 'Scribble to erase is off');
        }
      },
      { label: 'Gestures', icon: I.finger, onClick: gestureHelp },
      { label: dbg ? 'Close input test' : 'Input test', icon: I.pen, onClick: toggleDebug },
      {
        label, icon: I.finger, onClick: () => {
          prefs.fingerDraw = fd == null ? !fingerDraws() : fd === true ? false : null;
          savePrefs();
          toast(prefs.fingerDraw === true ? 'Fingers draw' : prefs.fingerDraw === false ? 'Fingers scroll, stylus draws' : 'Automatic: fingers scroll once a stylus is used');
        }
      },
      '-',
      { label: 'Delete this page', icon: I.trash, danger: true, onClick: () => deletePage(pvs.indexOf(currentPv())) }
    ].filter(Boolean), { align: 'right' });
  }

  // ------------------------------------------------------------------ keyboard, lifecycle
  function onKey(e) {
    if (activeEd && activeEd !== me) return; // side by side: the other notebook has the keyboard
    if (e.target.closest && e.target.closest('input, textarea, dialog')) return;
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && (key === 'c' || key === 'x') && sel) { e.preventDefault(); copySel(key === 'x'); }
    else if (mod && key === 'v') { e.preventDefault(); if (!readOnly) pasteClip(); }
    else if (mod && key === 'y') { e.preventDefault(); redo(); }
    else if (mod && key === 'f') { e.preventDefault(); openFind(); }
    else if (e.key === 'PageDown' || (hz && e.key === 'ArrowRight')) { e.preventDefault(); goPage(1); }
    else if (e.key === 'PageUp' || (hz && e.key === 'ArrowLeft')) { e.preventDefault(); goPage(-1); }
    else if (e.key === ' ') { e.preventDefault(); spaceDown = true; vp.classList.add('grab'); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); deleteSel(); }
    else if (e.key === 'Escape') { if (sel) clearSel(); else if (find || !findBar.hidden) closeFind(); else setFull(false); }
    else if (!mod && !e.altKey) {
      const t = { p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', s: 'shape', t: 'text', a: 'tape', k: 'laser' }[key];
      if (t) { if (!readOnly) setTool(t); }
      else if (key === 'f') setFull(!full);
      else if (key === 'r') toggleRuler();
      else if (key === 'z') toggleZoom();
    }
  }

  function onKeyUp(e) {
    if (activeEd && activeEd !== me) return;
    if (e.key === ' ') { spaceDown = false; vp.classList.remove('grab'); }
  }

  // --- full screen: hides the title bar and, where the browser allows it, the browser's own bars too
  const nativeFull = () => document.fullscreenElement || document.webkitFullscreenElement;

  function leaveNativeFull() {
    try {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (nativeFull() && exit) { const r = exit.call(document); if (r && r.catch) r.catch(() => {}); }
    } catch { /* not supported */ }
  }

  function setFull(on) {
    if (full === on) return;
    full = on;
    el.classList.toggle('full', on);
    if (!on) setMini(false);
    keepAwake(on);
    if (on) {
      try {
        const de = document.documentElement, req = de.requestFullscreen || de.webkitRequestFullscreen;
        if (req && !nativeFull()) { const r = req.call(de); if (r && r.catch) r.catch(() => {}); }
      } catch { /* not supported (iPhone): hiding the title bar still gives more room */ }
    } else leaveNativeFull();
  }

  function setMini(on) {
    el.classList.toggle('mini', on);
    miniBtn.innerHTML = on ? I.expand : I.collapse;
    miniBtn.title = on ? 'Show the tool bar' : 'Shrink the tool bar';
  }

  // Full screen is for long writing sessions, so the screen is kept from dimming while it is on.
  let wake = null;
  async function keepAwake(on) {
    try {
      if (on && !wake && navigator.wakeLock) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
        if (!full) keepAwake(false);
      } else if (!on && wake) { const w = wake; wake = null; await w.release(); }
    } catch { /* not allowed or not supported */ }
  }

  // The browser left full screen by itself (Esc, back gesture): bring the title bar back.
  function onFsChange() {
    if (!nativeFull() && full) setFull(false);
  }

  // --- input test: an on-screen record of what the pen, fingers and mouse are sending
  function toggleDebug() {
    if (dbg) { dbg.el.remove(); dbg = null; return; }
    dbg = { el: h('pre', { class: 'dbg' }), n: {}, last: [], raf: 0 };
    overlay.append(dbg.el);
    dbgShow();
  }

  function dbgCount(k) {
    dbg.n[k] = (dbg.n[k] || 0) + 1;
    if (!dbg.raf) dbg.raf = requestAnimationFrame(dbgShow);
  }

  function dbgEv(e, note) {
    const kind = e.type.replace('pointer', '');
    if (kind === 'move') { if (!ptrs.has(e.pointerId)) dbgCount(e.pointerType + ' hover'); return; }
    if (!note && kind === 'down') return; // logged once the press has been classified
    dbgCount(e.pointerType + ' ' + kind);
    dbg.last.push(`${String(Math.round(e.timeStamp) % 100000).padStart(5)} ${e.pointerType} ${kind}${note ? ' -> ' + note : ''}  id ${e.pointerId} pr ${(e.pressure || 0).toFixed(2)} btn ${e.buttons}`);
    if (dbg.last.length > 12) dbg.last.shift();
  }

  function dbgShow() {
    if (!dbg) return;
    dbg.raf = 0;
    const counts = Object.keys(dbg.n).sort().map(k => `${k}: ${dbg.n[k]}`).join('\n');
    dbg.el.textContent = `INPUT TEST (More menu to close)\n${counts || 'write something...'}\n\n${dbg.last.join('\n')}`;
  }

  function onVisibility() {
    if (document.visibilityState !== 'hidden') { if (full) keepAwake(true); return; } // the lock is dropped while hidden
    commitText();
    flush().catch(saveFailed); // saving triggers the upload
  }

  const ro = new ResizeObserver(() => { measure(); if (zw) zoomLayout(); applyView(); });

  const findSoon = debounce(() => { if (!destroyed && !findBar.hidden) runFind(); }, 280);
  findInp.addEventListener('input', findSoon);
  findInp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (find) findStep(e.shiftKey ? -1 : 1); else runFind(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  // Tool bar buttons must not take the keyboard away from a text box that is being typed in.
  optsEl.addEventListener('mousedown', e => { if (textEd && !e.target.closest('input')) e.preventDefault(); });

  function exit() {
    if (split) { location.hash = '#/d/' + opts.other; return; } // closes just this side
    location.hash = doc.folderId ? '#/f/' + doc.folderId : '#/';
  }

  async function destroy() {
    commitText();
    clearSel();
    destroyed = true;
    findTok++;
    stopInertia();
    ro.disconnect();
    if (thumbObs) thumbObs.disconnect();
    clearInterval(timerInt);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    if (full) leaveNativeFull();
    keepAwake(false);
    offs.forEach(off => off());
    offImg();
    if (activeEd === me) activeEd = null;
    try {
      if (changed || !doc.thumb) {
        const c = document.createElement('canvas');
        await R.renderPageTo(pages[0], c, 320);
        doc.thumb = c.toDataURL('image/jpeg', 0.72);
        docDirty = true;
      }
      await flush();
    } catch (e) { saveFailed(e); }
    bus.emit('editor-close', doc.id);
    el.remove();
  }

  const offs = [bus.on('remote-record', onRemote), bus.on('sync-status', showSync)];
  showSync(syncStatus());
  bus.emit('editor-open', doc.id);
  bmBtn.classList.add('wide'); // on a phone the bookmark star lives in the pages panel only
  drawTabs();
  setReadOnly(readOnly, true);
  if (TM.open && !split) toggleTimer(true);

  vp.addEventListener('pointerdown', onDown);
  vp.addEventListener('pointermove', onMove);
  vp.addEventListener('pointerup', onUp);
  vp.addEventListener('pointercancel', onUp);
  vp.addEventListener('pointerleave', () => { if (!action) eraserCur.hidden = true; });
  vp.addEventListener('wheel', onWheel, { passive: false });
  vp.addEventListener('contextmenu', e => e.preventDefault());
  // Keep the browser's own touch gestures (double-tap zoom, magnifier, page pinch) away from the paper:
  // on iPad they can swallow the start of quick pen strokes.
  const stopNative = e => { if (e.cancelable) e.preventDefault(); };
  for (const t of ['touchstart', 'touchmove', 'gesturestart', 'gesturechange', 'dblclick']) vp.addEventListener(t, stopNative, { passive: false });
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  const offImg = R.onImageLoaded(id => {
    for (const pv of pvs) {
      if (!pv.rs) continue;
      if (pv.page.bg && pv.page.bg.a === id) renderPv(pv, true);
      else if (pv.page.items.some(it => it.t === 'im' && it.a === id)) queueInk(pv);
    }
  });

  // ------------------------------------------------------------------ start
  rebuild();
  vp.dataset.tool = prefs.tool;
  renderTools();
  renderOpts();
  updateUndoUi();
  measure();
  let startAt = 0;
  try { startAt = parseInt(localStorage.getItem('inkleaf.pos.' + doc.id) || '0', 10) || 0; } catch { /* ignore */ }
  if (opts.page) startAt = opts.page - 1;
  startAt = clamp(startAt, 0, pages.length - 1);
  scale = fitScale(pages[startAt], COARSE ? 2.5 : 1.6);
  tx = (vpRect.width - worldW * scale) / 2;
  scrollToPage(startAt);
  ro.observe(vp);
  if (opts.q) { findInp.value = opts.q; openFind(); } // opened from a library search: show the matches

  return { destroy };
}
