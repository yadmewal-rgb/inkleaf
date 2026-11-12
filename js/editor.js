// The notebook editor: page layout, pan/zoom, stylus/finger/mouse input, tools, selection, undo.
import { db, newPage, loadPages } from './db.js';
import { h, uid, nextZ, clamp, bus } from './util.js';
import * as R from './render.js';
import { renderPdfPage } from './pdfrender.js';
import { I } from './icons.js';
import { popMenu, popover, confirmBox, promptText, toast, modal, chipGroup, TEMPLATE_OPTS, PAPER_OPTS } from './ui.js';
import { exportFlow } from './export.js';
import { syncNow, syncStatus, mergePage, mergeDoc } from './sync.js';

const GAP = 14, MIN_S = 0.2, MAX_S = 6;
const COARSE = matchMedia('(pointer: coarse)').matches;
const MAXPX = COARSE ? 5.5e6 : 9e6; // cap on pixels per page canvas (memory on tablets)
const INK = '#1c1d21', INK_ON_DARK = '#f1f3f5';

const PEN_COLORS = [INK, '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#ffffff'];
const HL_COLORS = ['#ffd43b', '#8ce99a', '#74c0fc', '#faa2c1', '#ffa94d'];
const SHAPES = [['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['arrow', 'Arrow']];

const DEFAULTS = {
  tool: 'pen',
  pen: { color: INK, size: 2.2 },
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
  const showSync = s => {
    syncBtn.hidden = s.state === 'off';
    syncBtn.classList.toggle('spin', s.state === 'syncing');
    syncBtn.classList.toggle('warn', s.state === 'error' || s.state === 'signin');
    syncBtn.title = s.text;
  };

  vp.append(world);
  overlay.append(eraserCur, selBox, selBar);
  const el = h('div', { class: 'ed' },
    h('div', { class: 'bar' },
      h('button', { class: 'ic', type: 'button', title: 'Back to library', onclick: exit, html: I.back }),
      titleBtn, pageInd,
      h('div', { class: 'grow' }),
      syncBtn, undoBtn, redoBtn,
      h('button', { class: 'ic', type: 'button', title: 'Pages', onclick: togglePanel, html: I.pages }),
      h('button', { class: 'ic', type: 'button', title: 'Add page', onclick: () => addPageAfter(currentPv()), html: I.plus }),
      h('button', { class: 'ic', type: 'button', title: 'More', onclick: e => moreMenu(e.currentTarget), html: I.more })),
    h('div', { class: 'bar tools' }, toolsEl, h('div', { class: 'vsep' }), optsEl),
    h('div', { class: 'stage' }, vp, overlay, panel),
    fileInp);
  root.append(el);

  // ------------------------------------------------------------------ view state
  let scale = 1, tx = 0, ty = 0, vpRect = vp.getBoundingClientRect(), worldW = 0, worldH = 0;
  let zooming = false, zoomT = 0, rafView = 0;
  const pvs = []; // one "page view" per page: {page, el, bg, ink, x, y, rs, bgTok}

  let ptrs = new Map();
  let action = null, pan = null, pinch = null, spaceDown = false, inertiaRaf = 0;
  let penSeen = !!prefs.penSeen;
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
      const pv = { page, el: pel, bg, ink, img: null, x: 0, y: 0, rs: 0, bgTok: 0 };
      stylePv(pv);
      pvs.push(pv);
      world.append(pel);
    }
    layout();
  }

  function layout() {
    worldW = Math.max(...pages.map(p => p.w));
    let y = GAP;
    for (const pv of pvs) {
      pv.x = (worldW - pv.page.w) / 2;
      pv.y = y;
      y += pv.page.h + GAP;
      Object.assign(pv.el.style, { left: pv.x + 'px', top: pv.y + 'px', width: pv.page.w + 'px', height: pv.page.h + 'px' });
    }
    worldH = y;
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
    world.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
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

  function targetRs(page) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    return Math.min(scale * dpr, Math.sqrt(MAXPX / (page.w * page.h)));
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
        if (!pv.rs) renderPv(pv);
        else if (!zooming && Math.abs(pv.rs - targetRs(pv.page)) / pv.rs > 0.04) renderPv(pv);
      } else if (pv.rs && !inRange(pv, vh * 1.5) && !(sel && sel.pv === pv) && !(action && action.pv === pv) && !(textEd && textEd.pv === pv)) {
        releasePv(pv);
      }
    }
  }

  function renderPv(pv) {
    const rs = targetRs(pv.page);
    pv.rs = rs;
    const W = Math.max(1, Math.round(pv.page.w * rs)), H = Math.max(1, Math.round(pv.page.h * rs));
    pv.ink.width = W;
    pv.ink.height = H;
    paintInk(pv);
    paintBg(pv, rs, W, H);
    if (livePv === pv) {
      live.width = W;
      live.height = H;
      if (sel && sel.pv === pv) drawSelLive();
    }
  }

  function paintBg(pv, rs, W, H) {
    const tok = ++pv.bgTok, pg = pv.page;
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
    pv.bgTok++;
    pv.bg.width = pv.bg.height = 0;
    pv.ink.width = pv.ink.height = 0;
    if (pv.img) { pv.img.remove(); pv.img = null; }
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
    c.setTransform(pv.rs, 0, 0, pv.rs, 0, 0);
    R.drawItems(c, pv.page.items, hiddenIds(pv), false);
    paintImg(pv);
  }

  // Pictures live on their own opaque layer between the paper and the ink (created only when needed).
  function paintImg(pv) {
    if (!pv.rs || !pv.page.items.some(it => it.t === 'im')) {
      if (pv.img) { pv.img.remove(); pv.img = null; }
      return;
    }
    if (!pv.img) { pv.img = h('canvas', { class: 'img' }); pv.bg.after(pv.img); }
    if (pv.img.width !== pv.ink.width || pv.img.height !== pv.ink.height) {
      pv.img.width = pv.ink.width;
      pv.img.height = pv.ink.height;
    }
    const c = pv.img.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, pv.img.width, pv.img.height);
    c.setTransform(pv.rs, 0, 0, pv.rs, 0, 0);
    R.drawImages(c, pv.page.items, hiddenIds(pv));
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
      live.width = pv.ink.width;
      live.height = pv.ink.height;
      livePv = pv;
    }
    const c = live.getContext('2d');
    c.setTransform(pv.rs, 0, 0, pv.rs, 0, 0);
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
    if (livePv.rs) c.setTransform(livePv.rs, 0, 0, livePv.rs, 0, 0);
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
    zoomT = setTimeout(() => { zooming = false; if (!destroyed) updateVisible(); }, 180);
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
        if (pv.rs && ((pg.pdf && pg.pdf.a === rec.id) || pg.items.some(it => it.t === 'im' && it.a === rec.id))) renderPv(pv);
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
      if (restyle) { stylePv(pv); if (pv.rs) renderPv(pv); } else queueInk(pv);
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
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
  }

  // ------------------------------------------------------------------ pointer input
  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button === 2) return;
    measure();
    if (textEd) { commitText(); return; } // this press just closes the text box
    try { vp.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const p = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, ignored: false };
    ptrs.set(e.pointerId, p);
    stopInertia();

    if (e.pointerType === 'pen') {
      if (!penSeen) { penSeen = true; prefs.penSeen = true; savePrefs(); }
      for (const q of ptrs.values()) if (q.type === 'touch') q.ignored = true; // resting palm
      if (action) cancelAction();
      pan = null;
      pinch = null;
      const erasing = e.button === 5 || (e.buttons & 32) || e.button === 2 || (e.buttons & 2);
      startAction(e, erasing ? 'eraser' : null);
      return;
    }
    if (e.pointerType === 'mouse') {
      if (e.button === 1 || spaceDown) startPan(p);
      else if (e.button === 0) startAction(e);
      return;
    }
    // touch
    if (action && action.ptype === 'pen') { p.ignored = true; return; }
    const ts = [...ptrs.values()].filter(q => q.type === 'touch' && !q.ignored);
    if (ts.length >= 2) {
      if (action) cancelAction();
      pan = null;
      if (!pinch) startPinch(ts[0], ts[1]);
    } else if (fingerDraws() || touchOnSel(e)) startAction(e);
    else startPan(p);
  }

  function onMove(e) {
    const p = ptrs.get(e.pointerId);
    if (!p) { hover(e); return; }
    p.x = e.clientX;
    p.y = e.clientY;
    if (p.ignored) return;
    if (action && action.pid === e.pointerId) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (evs && evs.length > 1) for (const ev of evs) actionMove(ev); else actionMove(e);
    } else if (pinch && (pinch.a === e.pointerId || pinch.b === e.pointerId)) movePinch();
    else if (pan && pan.pid === e.pointerId) movePan(e);
  }

  function onUp(e) {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    ptrs.delete(e.pointerId);
    if (action && action.pid === e.pointerId) {
      if (e.type === 'pointercancel') cancelAction(); else endAction(e);
    } else if (pinch && (pinch.a === e.pointerId || pinch.b === e.pointerId)) {
      pinch = null;
      zooming = false;
      updateVisible();
      const rest = [...ptrs.values()].find(q => q.type === 'touch' && !q.ignored);
      if (rest) { startPan(rest); pan.moved = 99; }
    } else if (pan && pan.pid === e.pointerId) endPan(p, e);
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
    pan = { pid: p.id, x: p.x, y: p.y, vx: 0, vy: 0, t: performance.now(), t0: performance.now(), moved: 0 };
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
    ty += dy;
    applyView();
  }

  function endPan(p, e) {
    const pn = pan;
    pan = null;
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
    if (a.tool === 'eraser') endErase(a, null);
    else if (a.tool === 'lasso' && a.mode !== 'draw') endLasso(a);
    else clearLive();
    if (pendingRebuild) remoteRebuild();
  }

  // --- pen & highlighter
  const pressureOf = e => (e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5);

  function beginStroke(e, x, y) {
    const a = action, t = prefs[a.tool];
    a.c = useLive(a.pv);
    a.color = inkFor(a.pv, t.color);
    a.size = t.size;
    a.sp = pressureOf(e);
    a.pts = [x, y, a.sp];
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
    const px = P[n - 3], py = P[n - 2];
    if (Math.hypot(x - px, y - py) < 0.7 / scale) return;
    // light smoothing: steadier lines without visible lag
    const k = a.ptype === 'pen' ? 0.78 : 0.6;
    x = px + (x - px) * k;
    y = py + (y - py) * k;
    a.sp += (pressureOf(e) - a.sp) * 0.5;
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

  function endStroke(a, e) {
    const page = a.pv.page;
    // Smoothing trails slightly behind the tip, so finish exactly where the pen lifted.
    const [ex, ey] = toPage(a.pv, e.clientX, e.clientY);
    const n = a.pts.length;
    if (Math.hypot(ex - a.pts[n - 3], ey - a.pts[n - 2]) > 0.5 / scale) a.pts.push(ex, ey, a.sp);
    const it = {
      id: uid(), t: 's', tool: a.tool, c: a.color, w: a.size,
      p: a.pts.map(v => Math.round(v * 100) / 100), z: nextZ(), m: Date.now()
    };
    addItems(page, [it]);
    if (a.pv.rs) {
      const c = a.pv.ink.getContext('2d');
      c.setTransform(a.pv.rs, 0, 0, a.pv.rs, 0, 0);
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
    c.setTransform(pv.rs * k, 0, 0, pv.rs * k, pv.rs * (b.x * (1 - k) + sel.dx), pv.rs * (b.y * (1 - k) + sel.dy));
    R.drawItems(c, sel.items);
    c.setTransform(pv.rs, 0, 0, pv.rs, 0, 0);
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
      c.setTransform(a.pv.rs, 0, 0, a.pv.rs, 0, 0);
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
      const MAXD = 2000;
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
      const f = Math.min(1, pg.w * 0.6 / src.w, pg.h * 0.5 / src.h);
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
    modal({
      title: 'Page template',
      body: h('div', null,
        chipGroup('Lines', TEMPLATE_OPTS, st.template, v => { st.template = v; }),
        chipGroup('Paper', PAPER_OPTS, st.paper, v => { st.paper = v; }),
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
            for (const v of pvs) { stylePv(v); if (v.rs) renderPv(v); }
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
    if (t === 'pen') kids = [...swatches('pen', PEN_COLORS), h('div', { class: 'vsep' }), ...sizes('pen', [1.2, 2.2, 4], [5, 8, 12])];
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

  function moreMenu(anchor) {
    const fd = prefs.fingerDraw;
    const label = fd === true ? 'Finger drawing: on' : fd === false ? 'Finger drawing: off' : `Finger drawing: auto (${fingerDraws() ? 'on' : 'off'})`;
    popMenu(anchor, [
      { label: 'Export as PDF', icon: I.share, onClick: async () => { commitText(); await flush().catch(saveFailed); exportFlow(doc.id); } },
      { label: 'Page template', icon: I.template, onClick: templateDialog },
      { label: 'Fit page width', icon: I.fit, onClick: fitWidth },
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
    else if (e.key === 'Escape') clearSel();
    else if (!mod && !e.altKey) {
      const t = { p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', s: 'shape', t: 'text' }[key];
      if (t) setTool(t);
    }
  }

  function onKeyUp(e) {
    if (e.key === ' ') { spaceDown = false; vp.classList.remove('grab'); }
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
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  document.addEventListener('visibilitychange', onVisibility);
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
