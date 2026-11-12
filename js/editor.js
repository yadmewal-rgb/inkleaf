// The notebook editor: page layout, pan/zoom, stylus/finger/mouse input, tools, selection, undo.
import { db, newPage, loadPages } from './db.js';
import { h, uid, nextZ, clamp, bus } from './util.js';
import * as R from './render.js';
import { renderPdfPage } from './pdfrender.js';
import { I } from './icons.js';
import { popMenu, popover, confirmBox, promptText, toast, modal, chipGroup, templatePicker, PAPER_OPTS } from './ui.js';
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

const DEFAULTS = {
  tool: 'pen',
  pen: { color: INK, size: 2.2, style: 'fountain' },
  scribble: true, // a zigzag over ink erases it
  hl: { color: '#ffd43b', size: 16 },
  eraser: { size: 16, mode: 'stroke' },
  shape: { kind: 'rect', color: '#1971c2', size: 2.2 },
  text: { color: INK, size: 16 },
  fingerDraw: null, // null = automatic: fingers draw until a stylus has been seen
  penSeen: false
};

export async function mountEditor(root, docId) {
  const doc = await db.get('docs', docId);
  if (!doc || doc.deleted) { location.hash = '#/'; return { destroy() {} }; }
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
  const titleBtn = h('button', { class: 'title', type: 'button', title: 'Rename', onclick: rename }, doc.title);
  const pageInd = h('span', { class: 'pageind' });
  const undoBtn = h('button', { class: 'ic', type: 'button', title: 'Undo (Ctrl+Z)', onclick: () => undo(), html: I.undo });
  const redoBtn = h('button', { class: 'ic', type: 'button', title: 'Redo (Ctrl+Y)', onclick: () => redo(), html: I.redo });
  const toolsEl = h('div', { class: 'toolset' });
  const optsEl = h('div', { class: 'opts' });
  const fileInp = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: onImageFile });
  const syncBtn = h('button', { class: 'ic', type: 'button', html: I.sync, onclick: () => syncNow(true) });
  // Shown at the end of the tool bar while the title bar is hidden in full screen.
  const undoBtn2 = h('button', { class: 'ic', type: 'button', title: 'Undo', onclick: () => undo(), html: I.undo });
  const redoBtn2 = h('button', { class: 'ic', type: 'button', title: 'Redo', onclick: () => redo(), html: I.redo });
  const fullTools = h('div', { class: 'fullonly' },
    undoBtn2, redoBtn2,
    h('button', { class: 'ic', type: 'button', title: 'Add page', onclick: () => addPageAfter(currentPv()), html: I.plus }),
    h('button', { class: 'ic', type: 'button', title: 'Leave full screen (F)', onclick: () => setFull(false), html: I.fullExit }));
  const showSync = s => {
    syncBtn.hidden = s.state === 'off';
    syncBtn.classList.toggle('spin', s.state === 'syncing');
    syncBtn.classList.toggle('warn', s.state === 'error' || s.state === 'signin');
    syncBtn.title = s.text;
  };

  vp.append(world);
  const pullHint = h('div', { class: 'pullhint', hidden: true });
  overlay.append(eraserCur, selBox, selBar, pullHint);
  const el = h('div', { class: 'ed' },
    h('div', { class: 'bar' },
      h('button', { class: 'ic', type: 'button', title: 'Back to library', onclick: exit, html: I.back }),
      titleBtn, pageInd,
      h('div', { class: 'grow' }),
      syncBtn, undoBtn, redoBtn,
      h('button', { class: 'ic', type: 'button', title: 'Full screen (F)', onclick: () => setFull(true), html: I.full }),
      h('button', { class: 'ic', type: 'button', title: 'Pages', onclick: togglePanel, html: I.pages }),
      h('button', { class: 'ic', type: 'button', title: 'Add page', onclick: () => addPageAfter(currentPv()), html: I.plus }),
      h('button', { class: 'ic', type: 'button', title: 'More', onclick: e => moreMenu(e.currentTarget), html: I.more })),
    h('div', { class: 'bar tools' }, toolsEl, h('div', { class: 'vsep' }), optsEl, h('div', { class: 'grow' }), fullTools),
    h('div', { class: 'stage' }, vp, overlay, panel),
    fileInp);
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

  const fingerDraws = () => prefs.fingerDraw === true || (prefs.fingerDraw == null && !penSeen);
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
      const pv = { page, el: pel, bg, ink, img: null, hi: null, x: 0, y: 0, rs: 0, clip: null, bgRs: 0, bgTok: 0, hiTok: 0 };
      stylePv(pv);
      pvs.push(pv);
      world.append(pel);
    }
    layout();
  }

  // Round a CSS length to whole device pixels.
  const snap = v => { const d = window.devicePixelRatio || 1; return Math.round(v * d) / d; };

  function layout() {
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
      placeHi(pv);
    }
    if (livePv) place(live, livePv);
  }

  function measure() { vpRect = vp.getBoundingClientRect(); }

  function clampView() {
    const vw = vpRect.width, vh = vpRect.height, pad = 12;
    const cw = worldW * scale, ch = worldH * scale;
    tx = cw + 2 * pad <= vw ? (vw - cw) / 2 : clamp(tx, vw - cw - pad, pad);
    ty = ch <= vh ? 0 : clamp(ty, vh - ch, 0);
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
    const top = (-ty - margin) / scale, bot = (-ty + vpRect.height + margin) / scale;
    return pv.y + pv.page.h > top && pv.y < bot;
  }

  // Only pages near the viewport keep live canvases; the rest are released to save memory.
  function updateVisible() {
    const vh = vpRect.height;
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
    if (pv.hi) { pv.hi.remove(); pv.hi = null; pv.hiClip = null; }
    if (livePv === pv) { live.remove(); live.width = live.height = 0; livePv = null; }
  }

  function hiddenIds(pv) {
    if (sel && sel.pv === pv) return sel.ids;
    if (textEd && textEd.pv === pv && textEd.item) return new Set([textEd.item.id]);
    return null;
  }

  function paintInk(pv) {
    if (!pv.rs) return;
    const c = pv.ink.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, pv.ink.width, pv.ink.height);
    xf(c, pv);
    R.drawItems(c, pv.page.items, hiddenIds(pv), false, pv.clip);
    paintImg(pv);
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
    const wy = (cy - vpRect.top - ty) / scale;
    let best = pvs[0], bd = Infinity;
    for (const pv of pvs) {
      const d = wy < pv.y ? pv.y - wy : wy > pv.y + pv.page.h ? wy - pv.y - pv.page.h : 0;
      if (d < bd) { bd = d; best = pv; }
    }
    return best;
  }

  function currentPv() {
    const cy = (-ty + vpRect.height / 2) / scale;
    return pvs.find(pv => cy < pv.y + pv.page.h + GAP) || pvs[pvs.length - 1];
  }

  function fitWidth() {
    measure();
    const keep = pvs.length ? pvs.indexOf(currentPv()) : 0;
    scale = clamp((vpRect.width - 24) / worldW, MIN_S, 2.5);
    tx = (vpRect.width - worldW * scale) / 2;
    scrollToPage(keep);
  }

  function scrollToPage(i) {
    const pv = pvs[clamp(i, 0, pvs.length - 1)];
    ty = -(pv.y - GAP) * scale;
    applyView();
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
    pageInd.textContent = `${i + 1} / ${pvs.length}`;
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
  }

  function saveFailed(e) {
    console.error(e);
    toast('Could not save. Device storage may be full.');
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
    await db.putMany('pages', ps);
    if (writeDoc) {
      doc.modified = Date.now();
      await db.put('docs', doc);
    }
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
    if (i < 0) { // a page added on another device
      if (rec.deleted || gonePages.has(rec.id)) return;
      pages.push({ ...rec, items: rec.items || [], dels: rec.dels || {} });
      orderPages();
      remoteRebuild();
      return;
    }
    const P = pages[i];
    if (rec.deleted) {
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
    const restyle = P.template !== m.template || P.paper !== m.paper;
    P.items = m.items;
    P.dels = m.dels;
    P.template = m.template;
    P.paper = m.paper;
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
    if (m.deleted) { toast('This notebook was deleted on another device.'); exit(); return; }
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
    const off = cur ? ty + cur.y * scale : 0;
    rebuild();
    const now = cur ? pvs.find(v => v.page === cur.page) : null;
    if (now) ty = off - now.y * scale;
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
    if (textEd) { commitText(); return; } // this press just closes the text box
    try { vp.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const p = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, ignored: false };
    ptrs.set(e.pointerId, p);
    stopInertia();

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
    if (e.shiftKey && !e.deltaX) tx -= e.deltaY * k;
    else { tx -= e.deltaX * k; ty -= e.deltaY * k; }
    applyView();
  }

  // --- pan / pinch
  function stopInertia() {
    if (inertiaRaf) { cancelAnimationFrame(inertiaRaf); inertiaRaf = 0; }
  }

  function startPan(p) {
    pan = { pid: p.id, x: p.x, y: p.y, vx: 0, vy: 0, t: performance.now(), t0: performance.now(), moved: 0, pull: 0 };
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
    const want = ty + dy;
    ty = want;
    applyView();
    // Dragging up past the end of the last page: keep count of how far, to offer a new page.
    if (ty - want > 0.5) pan.pull += ty - want; else if (dy > 0) pan.pull = 0;
    pullHint.hidden = pan.pull < 14;
    pullHint.textContent = pan.pull >= PULL_PX ? 'Release to add a page' : 'Pull up to add a page';
    pullHint.classList.toggle('go', pan.pull >= PULL_PX);
  }

  function endPan(p, e) {
    const pn = pan;
    pan = null;
    pullHint.hidden = true;
    if (pn.pull >= PULL_PX) { addPageAfter(pvs[pvs.length - 1]); return; }
    const now = performance.now();
    if (p.type === 'touch' && pn.moved < 8 && now - pn.t0 < 350) { tapAt(e.clientX, e.clientY); return; }
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
    if (prefs.tool === 'text') startText(pv, topItemAt(pv.page, x, y, 'tx'), x, y);
    else if (prefs.tool === 'lasso') {
      const it = topItemAt(pv.page, x, y);
      clearSel();
      if (it) setSel(pv, [it]);
    } else {
      // Double tap: zoom in on that spot, or back out to the full page width.
      const now = performance.now();
      if (lastTap && now - lastTap.t < 320 && Math.hypot(cx - lastTap.x, cy - lastTap.y) < 40) {
        lastTap = null;
        const fit = clamp((vpRect.width - 24) / worldW, MIN_S, 2.5);
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
  function startAction(e, forceTool) {
    const tool = forceTool || prefs.tool;
    const pv = (tool === 'lasso' && sel && touchOnSelPoint(e)) ? sel.pv : pvAt(e.clientX, e.clientY);
    const [x, y] = toPage(pv, e.clientX, e.clientY);
    if (tool !== 'lasso' && sel) clearSel();
    action = { tool, pid: e.pointerId, ptype: e.pointerType, pv, x0: x, y0: y, cx0: e.clientX, cy0: e.clientY, far: false };
    if (tool === 'pen' || tool === 'hl') beginStroke(e, x, y);
    else if (tool === 'eraser') beginErase(e, x, y);
    else if (tool === 'lasso') beginLasso(x, y);
    else if (tool === 'shape') { action.c = useLive(pv); action.x1 = x; action.y1 = y; }
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
  }

  function endAction(e) {
    const a = action;
    action = null;
    if (a.tool === 'pen' || a.tool === 'hl') endStroke(a, e);
    else if (a.tool === 'eraser') endErase(a, e);
    else if (a.tool === 'lasso') endLasso(a);
    else if (a.tool === 'shape') endShape(a);
    else if (a.tool === 'text' && !a.far) startText(a.pv, topItemAt(a.pv.page, a.x0, a.y0, 'tx'), a.x0, a.y0);
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
    else clearLive();
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
    if (a.line) return;
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
    if (len < 24 / scale) return;
    let dev = 0, sum = 0;
    for (let i = 0; i < P.length; i += 3) {
      dev = Math.max(dev, Math.abs((P[i] - x0) * (y1 - y0) - (P[i + 1] - y0) * (x1 - x0)) / len);
      sum += P[i + 2];
    }
    if (dev > Math.max(3 / scale, len * 0.09)) return; // not a line: leave the handwriting alone
    a.line = true;
    const p = Math.round(sum / n * 100) / 100;
    a.pts = [x0, y0, p, x1, y1, p];
    drawLine(a);
  }

  function drawLine(a) {
    nextLive(() => {
      clearLive();
      R.drawItem(a.c, { t: 's', tool: a.tool, c: a.color, w: a.size, p: a.pts });
    });
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
    a.color = inkFor(a.pv, t.color);
    a.size = t.size;
    a.style = a.tool === 'pen' ? (t.style || 'fountain') : null;
    a.sp = inkPressure(a, e);
    a.pts = [x, y, a.sp];
    holdCheck(a, e);
    a.lx = x;
    a.ly = y;
    const c = a.c;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = a.color;
    c.fillStyle = a.color;
    if (a.tool === 'pen') {
      c.beginPath();
      c.arc(x, y, R.pw({ w: a.size }, a.sp) / 2, 0, 6.2832);
      c.fill();
    }
  }

  function moveStroke(e) {
    const a = action, P = a.pts, n = P.length;
    let [x, y] = toPage(a.pv, e.clientX, e.clientY);
    if (a.line) { // snapped straight: the far end follows the pen
      P[3] = x;
      P[4] = y;
      drawLine(a);
      return;
    }
    holdCheck(a, e);
    const px = P[n - 3], py = P[n - 2];
    if (Math.hypot(x - px, y - py) < 0.7 / scale) return;
    // light smoothing: steadier lines without visible lag
    const k = a.ptype === 'pen' ? 0.78 : 0.6;
    x = px + (x - px) * k;
    y = py + (y - py) * k;
    a.sp += (inkPressure(a, e) - a.sp) * 0.5;
    P.push(x, y, a.sp);
    if (a.tool === 'hl') {
      nextLive(() => {
        clearLive();
        R.drawItem(a.c, { t: 's', tool: 'hl', c: a.color, w: a.size, p: P });
      });
      return;
    }
    const m = P.length;
    if (m >= 9) {
      const cx = P[m - 6], cy = P[m - 5];
      const mx = (cx + x) / 2, my = (cy + y) / 2;
      const c = a.c;
      c.beginPath();
      c.moveTo(a.lx, a.ly);
      c.quadraticCurveTo(cx, cy, mx, my);
      c.lineWidth = R.pw({ w: a.size }, P[m - 4]);
      c.stroke();
      a.lx = mx;
      a.ly = my;
    }
  }

  // e is null when the stroke is closed without a proper pen-up (the system cancelled or lost it).
  function endStroke(a, e) {
    const page = a.pv.page;
    clearTimeout(a.holdT);
    if (e && !a.line) {
      // Smoothing trails slightly behind the tip, so finish exactly where the pen lifted.
      const [ex, ey] = toPage(a.pv, e.clientX, e.clientY);
      const n = a.pts.length;
      if (Math.hypot(ex - a.pts[n - 3], ey - a.pts[n - 2]) > 0.5 / scale) a.pts.push(ex, ey, a.sp);
    }
    const gone = a.tool === 'pen' && !a.line && prefs.scribble !== false ? scribbleTargets(a) : null;
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
    const it = {
      id: uid(), t: 's', tool: a.tool, c: a.color, w: a.size,
      p: a.pts.map(v => Math.round(v * 100) / 100), z: nextZ(), m: Date.now()
    };
    addItems(page, [it]);
    if (a.pv.rs) {
      const c = a.pv.ink.getContext('2d');
      xf(c, a.pv);
      if (a.tool === 'hl') c.globalCompositeOperation = 'destination-over'; // highlighter goes under ink
      R.drawItem(c, it);
      c.globalCompositeOperation = 'source-over';
    }
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
    showEraserCur(e.clientX, e.clientY);
  }

  function moveErase(e) {
    const a = action;
    const [x, y] = toPage(a.pv, e.clientX, e.clientY);
    const r = prefs.eraser.size / 2;
    const steps = Math.max(1, Math.ceil(Math.hypot(x - a.lx, y - a.ly) / (r * 0.5)));
    for (let i = 1; i <= steps; i++) eraseAt(a, a.lx + (x - a.lx) * i / steps, a.ly + (y - a.ly) * i / steps);
    a.lx = x;
    a.ly = y;
    showEraserCur(e.clientX, e.clientY);
  }

  function eraseAt(a, x, y) {
    const page = a.pv.page, r = prefs.eraser.size / 2;
    const precise = prefs.eraser.mode === 'precise';
    let hit = false;
    const out = [];
    for (const it of page.items) {
      if ((it.t !== 's' && it.t !== 'sh') || !R.hitsCircle(it, x, y, r)) { out.push(it); continue; }
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
      if (it.t === 'tx' || it.t === 'im') {
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
    live.classList.toggle('plain', items.every(it => it.t === 'im'));
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
      const ux = it.w / old[2], uy = it.h / old[3]; // page units per whole picture: the picture keeps its size on the page
      const nu = { ...it, x: r2(it.x + (l - old[0]) * ux), y: r2(it.y + (t - old[1]) * uy), w: r2(w * ux), h: r2(hh * uy), m: Date.now() };
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
      kids.push(h('button', {
        class: 'ic', type: 'button', title: 'Colour', html: I.palette,
        onclick: e => {
          let close = () => {};
          close = popover(e.currentTarget, h('div', { class: 'swrow' }, PEN_COLORS.concat(HL_COLORS.slice(0, 3)).map(c =>
            h('button', { class: 'sw', type: 'button', style: { '--c': c }, onclick: () => { close(); recolorSel(c); } }))));
        }
      }));
    }
    if (one && one.t === 'tx') {
      kids.push(h('button', {
        class: 'ic', type: 'button', title: 'Edit text', html: I.edit,
        onclick: () => { const pv = sel.pv; clearSel(); startText(pv, one); }
      }));
    }
    if (one && one.t === 'im') {
      kids.push(h('button', { class: 'ic', type: 'button', title: 'Crop', html: I.crop, onclick: () => cropDialog(one) }));
    }
    kids.push(
      h('button', { class: 'ic', type: 'button', title: 'Duplicate', html: I.copy, onclick: duplicateSel }),
      h('button', { class: 'ic danger', type: 'button', title: 'Delete', html: I.trash, onclick: deleteSel }));
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
  }

  // --- shapes
  function tempShape(a) {
    const t = prefs.shape;
    return { t: 'sh', k: t.kind, x1: a.x0, y1: a.y0, x2: a.x1, y2: a.y1, c: inkFor(a.pv, t.color), w: t.size };
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
    ta.style.fontFamily = R.FONT;
    ta.style.lineHeight = String(R.LH);
    textEd = { pv, item: item || null, x: px, y: py, w, fs, color: item ? item.c : inkFor(pv, t.color), ta };
    overlay.append(ta);
    if (item) paintInk(pv);
    positionOverlays();
    ta.addEventListener('input', growText);
    ta.addEventListener('keydown', e => { if (e.key === 'Escape') commitText(); });
    ta.focus();
  }

  function growText() {
    if (!textEd) return;
    const ta = textEd.ta;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function commitText() {
    const te = textEd;
    if (!te) return;
    textEd = null;
    const s = te.ta.value.replace(/\s+$/, '');
    te.ta.remove();
    const page = te.pv.page;
    if (te.item) {
      if (s === te.item.s) { paintInk(te.pv); return; }
      const old = te.item, add = [];
      removeItems(page, [old]);
      if (s) { const nu = { ...old, s }; addItems(page, [nu]); add.push(nu); }
      pushUndo({ pageId: page.id, remove: [old], add });
    } else if (s) {
      const r2 = v => Math.round(v * 100) / 100;
      const it = { id: uid(), t: 'tx', x: r2(te.x), y: r2(te.y), w: r2(te.w), s, fs: te.fs, c: te.color, z: nextZ(), m: Date.now() };
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
      const src = await loadBitmap(file);
      const MAXD = 3200;
      const k = Math.min(1, MAXD / Math.max(src.w, src.h));
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
        data = await blob.arrayBuffer();
      }
      const asset = { id: uid(), mime, name: file.name, data, modified: Date.now() };
      await db.put('assets', asset);
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
      toast('That image could not be added.');
    }
  }

  async function loadBitmap(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { img, w: img.naturalWidth, h: img.naturalHeight };
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
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
    const o = src.pdf
      ? { w: src.w, h: src.h, template: doc.template, paper: doc.paper }
      : { w: src.w, h: src.h, template: src.template, paper: src.paper };
    const pg = newPage(doc.id, o);
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
    if (!await confirmBox('Delete page', `Delete page ${i + 1}? This cannot be undone.`, 'Delete', true)) return;
    const pg = pages[i];
    pages.splice(i, 1);
    dirtyPages.delete(pg);
    gonePages.add(pg.id);
    await db.put('pages', { id: pg.id, docId: pg.docId, w: pg.w, h: pg.h, items: [], dels: {}, deleted: true, modified: Date.now() });
    structureChanged(Math.min(i, pages.length - 1));
  }

  function movePage(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= pages.length) return;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    structureChanged(j);
  }

  function templateDialog() {
    const pv = currentPv(), pg = pv.page;
    if (pg.pdf) { toast('PDF pages keep their own background.'); return; }
    const st = { template: pg.template, paper: pg.paper, all: false };
    const all = h('input', { type: 'checkbox', onchange: e => { st.all = e.target.checked; } });
    const tp = templatePicker(st.template, () => st.paper, v => { st.template = v; });
    modal({
      title: 'Page template',
      body: h('div', null,
        tp.el,
        chipGroup('Paper', PAPER_OPTS, st.paper, v => { st.paper = v; tp.redraw(); }),
        h('label', { class: 'check' }, all, 'Apply to every page in this notebook')),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Apply', primary: true, onClick: () => {
            for (const p of (st.all ? pages.filter(q => !q.pdf) : [pg])) {
              p.template = st.template;
              p.paper = st.paper;
              dirty(p);
            }
            doc.template = st.template;
            doc.paper = st.paper;
            docDirty = true;
            for (const v of pvs) { stylePv(v); if (v.rs) renderPv(v, true); }
            if (panelOpen) buildPanel();
          }
        }
      ]
    });
  }

  // ------------------------------------------------------------------ pages panel
  function togglePanel() {
    panelOpen = !panelOpen;
    panel.hidden = !panelOpen;
    buildPanel();
  }

  function buildPanel() {
    if (thumbObs) { thumbObs.disconnect(); thumbObs = null; }
    thumbs.clear();
    panel.replaceChildren();
    if (!panelOpen) return;
    thumbObs = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        thumbObs.unobserve(en.target);
        R.renderPageTo(en.target._page, en.target, 220).catch(() => {});
      }
    }, { root: panel, rootMargin: '300px' });
    const cur = pvs.indexOf(currentPv());
    pages.forEach((pg, i) => {
      const c = h('canvas', { class: 'thumb-c' });
      c._page = pg;
      c.width = 220;
      c.height = Math.round(220 * pg.h / pg.w);
      c.style.background = R.paperOf(pg).bg;
      thumbs.set(pg.id, c);
      const card = h('div', { class: 'thumb' + (i === cur ? ' on' : ''), onclick: () => { scrollToPage(i); if (innerWidth < 700) togglePanel(); } },
        c,
        h('div', { class: 'thumb-foot' },
          h('span', null, String(i + 1)),
          h('button', {
            class: 'ic sm', type: 'button', title: 'Page options', html: I.more,
            onclick: e => {
              e.stopPropagation();
              popMenu(e.currentTarget, [
                { label: 'Add page after', icon: I.plus, onClick: () => addPageAfter(pvs[i]) },
                { label: 'Duplicate', icon: I.copy, onClick: () => duplicatePage(i) },
                { label: 'Move up', icon: I.up, onClick: () => movePage(i, -1) },
                { label: 'Move down', icon: I.down, onClick: () => movePage(i, 1) },
                '-',
                { label: 'Delete page', icon: I.trash, danger: true, onClick: () => deletePage(i) }
              ], { align: 'right' });
            }
          })));
      panel.append(card);
      thumbObs.observe(c);
    });
    const on = panel.querySelector('.thumb.on');
    if (on) on.scrollIntoView({ block: 'center' });
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
    ['lasso', I.lasso, 'Select (L)'], ['shape', I.shape, 'Shapes (S)'], ['text', I.text, 'Text (T)']
  ];

  function renderTools() {
    toolsEl.replaceChildren(
      ...TOOLS.map(([id, icon, title]) => h('button', {
        class: 'ic tool' + (prefs.tool === id ? ' on' : ''), type: 'button', title, html: icon,
        onclick: () => setTool(id)
      })),
      h('button', { class: 'ic tool', type: 'button', title: 'Insert image', html: I.image, onclick: () => fileInp.click() }));
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
    const pick = c => { prefs[key].color = c; savePrefs(); renderOpts(); };
    const custom = h('label', { class: 'sw custom' + (colors.includes(cur) ? '' : ' on'), title: 'Custom colour', style: { '--c': colors.includes(cur) ? 'transparent' : cur } },
      h('input', { type: 'color', value: cur, onchange: e => pick(e.target.value) }));
    return colors.map(c => h('button', { class: 'sw' + (cur === c ? ' on' : ''), type: 'button', title: c, style: { '--c': c }, onclick: () => pick(c) })).concat(custom);
  }

  function sizes(key, list, dots) {
    return list.map((s, i) => h('button', {
      class: 'sz' + (prefs[key].size === s ? ' on' : ''), type: 'button', title: 'Size ' + s,
      onclick: () => { prefs[key].size = s; savePrefs(); renderOpts(); }
    }, h('span', { class: 'dot', style: { width: dots[i] + 'px', height: dots[i] + 'px' } })));
  }

  const seg = (items, cur, onPick) => h('div', { class: 'seg' }, items.map(([v, label]) =>
    h('button', { class: v === cur ? 'on' : '', type: 'button', onclick: () => onPick(v) }, label)));

  function renderOpts() {
    const t = prefs.tool;
    let kids = [];
    if (t === 'pen') {
      kids = [
        ...swatches('pen', PEN_COLORS), h('div', { class: 'vsep' }),
        ...sizes('pen', [0.8, 1.4, 2.2, 3.5, 6], [3, 5, 8, 11, 15]), h('div', { class: 'vsep' }),
        seg([['ball', 'Ballpoint'], ['fountain', 'Fountain'], ['brush', 'Brush']], prefs.pen.style || 'fountain', v => { prefs.pen.style = v; savePrefs(); renderOpts(); })
      ];
    }
    else if (t === 'hl') kids = [...swatches('hl', HL_COLORS), h('div', { class: 'vsep' }), ...sizes('hl', [10, 16, 24], [7, 11, 15])];
    else if (t === 'eraser') {
      kids = [
        seg([['stroke', 'Whole stroke'], ['precise', 'Precise']], prefs.eraser.mode, v => { prefs.eraser.mode = v; savePrefs(); renderOpts(); }),
        h('div', { class: 'vsep' }), ...sizes('eraser', [8, 16, 30], [7, 11, 16])
      ];
    } else if (t === 'shape') {
      kids = [
        seg(SHAPES, prefs.shape.kind, v => { prefs.shape.kind = v; savePrefs(); renderOpts(); }),
        h('div', { class: 'vsep' }), ...swatches('shape', PEN_COLORS), h('div', { class: 'vsep' }), ...sizes('shape', [1.2, 2.2, 4], [5, 8, 12])
      ];
    } else if (t === 'text') {
      kids = [...swatches('text', PEN_COLORS), h('div', { class: 'vsep' }),
        seg([[12, 'Small'], [16, 'Medium'], [24, 'Large']], prefs.text.size, v => { prefs.text.size = v; savePrefs(); renderOpts(); }),
        h('span', { class: 'hint' }, 'Tap the page to type')];
    } else {
      kids = [h('span', { class: 'hint' }, 'Circle items to select them, or tap one. Drag to move, pull the corner to resize.')];
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
      ['Pull up past the last page', 'Add a new page'],
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
    const fd = prefs.fingerDraw;
    const label = fd === true ? 'Finger drawing: on' : fd === false ? 'Finger drawing: off' : `Finger drawing: auto (${fingerDraws() ? 'on' : 'off'})`;
    popMenu(anchor, [
      { label: 'Export as PDF', icon: I.share, onClick: async () => { commitText(); await flush().catch(saveFailed); exportFlow(doc.id); } },
      { label: 'Page template', icon: I.template, onClick: templateDialog },
      { label: 'Fit page width', icon: I.fit, onClick: fitWidth },
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
    ], { align: 'right' });
  }

  // ------------------------------------------------------------------ keyboard, lifecycle
  function onKey(e) {
    if (e.target.closest && e.target.closest('input, textarea, dialog')) return;
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && key === 'y') { e.preventDefault(); redo(); }
    else if (e.key === ' ') { e.preventDefault(); spaceDown = true; vp.classList.add('grab'); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); deleteSel(); }
    else if (e.key === 'Escape') { if (sel) clearSel(); else setFull(false); }
    else if (!mod && !e.altKey) {
      const t = { p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', s: 'shape', t: 'text' }[key];
      if (t) setTool(t);
      else if (key === 'f') setFull(!full);
    }
  }

  function onKeyUp(e) {
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
    if (on) {
      try {
        const de = document.documentElement, req = de.requestFullscreen || de.webkitRequestFullscreen;
        if (req && !nativeFull()) { const r = req.call(de); if (r && r.catch) r.catch(() => {}); }
      } catch { /* not supported (iPhone): hiding the title bar still gives more room */ }
    } else leaveNativeFull();
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
    if (document.visibilityState !== 'hidden') return;
    commitText();
    flush().catch(saveFailed); // saving triggers the upload
  }

  const ro = new ResizeObserver(() => { measure(); applyView(); });

  function exit() {
    location.hash = doc.folderId ? '#/f/' + doc.folderId : '#/';
  }

  async function destroy() {
    commitText();
    clearSel();
    destroyed = true;
    stopInertia();
    ro.disconnect();
    if (thumbObs) thumbObs.disconnect();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    if (full) leaveNativeFull();
    offs.forEach(off => off());
    R.onImageLoaded(null);
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
  R.onImageLoaded(id => { for (const pv of pvs) if (pv.rs && pv.page.items.some(it => it.t === 'im' && it.a === id)) queueInk(pv); });

  // ------------------------------------------------------------------ start
  rebuild();
  vp.dataset.tool = prefs.tool;
  renderTools();
  renderOpts();
  updateUndoUi();
  measure();
  scale = clamp((vpRect.width - 24) / worldW, MIN_S, COARSE ? 2.5 : 1.6);
  tx = (vpRect.width - worldW * scale) / 2;
  let startAt = 0;
  try { startAt = parseInt(localStorage.getItem('inkleaf.pos.' + doc.id) || '0', 10) || 0; } catch { /* ignore */ }
  scrollToPage(startAt);
  ro.observe(vp);

  return { destroy };
}
