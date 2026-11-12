// Drawing of paper, ink, shapes, text and images, plus the geometry used for hit-testing and selection.
// Everything works in page units (1 unit = 1 PDF point); callers scale the canvas context.
import { db } from './db.js';
import { uid, distSeg, inPoly } from './util.js';
import { renderPdfPage } from './pdfrender.js';

export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';
export const LH = 1.3;
export const HL_ALPHA = 0.5;

export const PAPERS = {
  white: { bg: '#ffffff', line: '#c5d0de', accent: '#e9a3a3', dark: false },
  cream: { bg: '#fbf5e4', line: '#d6cba9', accent: '#e0a58f', dark: false },
  yellow: { bg: '#fdf7c4', line: '#b9c7d6', accent: '#e59a9a', dark: false },
  blue: { bg: '#eaf3fb', line: '#b5cbe2', accent: '#e3a0a8', dark: false },
  green: { bg: '#e9f4e6', line: '#b7d0b3', accent: '#dfa39a', dark: false },
  gray: { bg: '#ececec', line: '#c4c6ca', accent: '#dba0a0', dark: false },
  dark: { bg: '#1e1f22', line: '#3b3d44', accent: '#6e4046', dark: true }
};
export const paperOf = pg => PAPERS[pg.paper] || PAPERS.white;

// ---------- paper ----------

// lines: [x1, y1, x2, y2] in the paper's line colour; accent: the same in its margin colour; dots: [x, y].
export function templateGeometry(pg) {
  const lines = [], dots = [], accent = [];
  const { w, h } = pg, t = pg.template;
  const rule = (step, from = 72) => { for (let y = from; y < h - 24; y += step) lines.push([0, y, w, y]); };
  const grid = s => {
    const ox = (w % s) / 2, oy = (h % s) / 2;
    for (let x = ox; x <= w; x += s) lines.push([x, 0, x, h]);
    for (let y = oy; y <= h; y += s) lines.push([0, y, w, y]);
  };
  if (t === 'ruled') rule(26);
  else if (t === 'narrow') rule(19, 60);
  else if (t === 'wide') rule(34, 78);
  else if (t === 'fine') rule(14.17, 56);   // 5 mm
  else if (t === 'xfine') rule(11.34, 52);  // 4 mm
  else if (t === 'margin' || t === 'narrowmargin') {
    if (t === 'margin') rule(26); else rule(19, 60);
    accent.push([64, 0, 64, h]);
  } else if (t === 'cornell') {
    const cue = Math.round(w * 0.28), foot = h - 132;
    for (let y = 98; y < foot - 8; y += 26) lines.push([cue, y, w, y]);
    for (let y = foot + 26; y < h - 20; y += 26) lines.push([0, y, w, y]);
    accent.push([0, 72, w, 72], [cue, 72, cue, foot], [0, foot, w, foot]);
  } else if (t === 'grid') grid(21);
  else if (t === 'gridsmall') grid(12);
  else if (t === 'dots') {
    const s = 21, ox = (w % s) / 2, oy = (h % s) / 2;
    for (let y = oy; y <= h; y += s) for (let x = ox; x <= w; x += s) dots.push([x, y]);
  } else if (t === 'iso') {
    const s = 22, rowH = s * 0.866;
    let row = 0;
    for (let y = rowH / 2; y <= h; y += rowH, row++) for (let x = (row % 2 ? s / 2 : 0) + s / 2; x <= w; x += s) dots.push([x, y]);
  } else if (t === 'music') {
    const gap = 7, block = 78;
    for (let y = 70; y + gap * 4 < h - 30; y += block) for (let i = 0; i < 5; i++) lines.push([36, y + i * gap, w - 36, y + i * gap]);
  } else if (t === 'todo') {
    const b = 11;
    for (let y = 72; y < h - 24; y += 26) {
      lines.push([0, y, w, y]);
      const x = 40, top = y - 19;
      lines.push([x, top, x + b, top], [x + b, top, x + b, top + b], [x + b, top + b, x, top + b], [x, top + b, x, top]);
    }
  }
  return { lines, dots, accent };
}

// bold thickens the pattern (used for the small previews in the pattern chooser).
export function drawPaper(ctx, pg, bold = 1) {
  const pap = paperOf(pg);
  ctx.fillStyle = pap.bg;
  ctx.fillRect(0, 0, pg.w, pg.h);
  if (pg.pdf) return;
  const g = templateGeometry(pg);
  if (g.lines.length) {
    ctx.strokeStyle = pap.line;
    ctx.lineWidth = 0.6 * bold;
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of g.lines) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
    ctx.stroke();
  }
  if (g.accent.length) {
    ctx.strokeStyle = pap.accent;
    ctx.lineWidth = 0.8 * bold;
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of g.accent) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
    ctx.stroke();
  }
  if (g.dots.length) {
    ctx.fillStyle = pap.line;
    ctx.beginPath();
    const r = bold > 1 ? 1.4 : 0.9;
    for (const [x, y] of g.dots) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.2832); }
    ctx.fill();
  }
}

// ---------- strokes ----------

// Width of a pen stroke at pressure p (0..1). p = 0.5 gives the nominal size.
export const pw = (s, p) => s.w * (0.35 + 1.3 * p);

function uniform(P) {
  const p0 = P[2];
  for (let i = 5; i < P.length; i += 3) if (P[i] !== p0) return false;
  return true;
}

function tracePath(ctx, P) {
  const n = P.length / 3;
  ctx.moveTo(P[0], P[1]);
  for (let i = 1; i < n - 1; i++) {
    const x = P[i * 3], y = P[i * 3 + 1];
    ctx.quadraticCurveTo(x, y, (x + P[i * 3 + 3]) / 2, (y + P[i * 3 + 4]) / 2);
  }
  ctx.lineTo(P[(n - 1) * 3], P[(n - 1) * 3 + 1]);
}

function drawStroke(ctx, s) {
  const P = s.p, n = P.length / 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.c;
  ctx.fillStyle = s.c;
  if (s.tool === 'hl') {
    ctx.globalAlpha = HL_ALPHA;
    ctx.lineWidth = s.w;
    ctx.beginPath();
    if (n === 1) { ctx.moveTo(P[0], P[1]); ctx.lineTo(P[0] + 0.01, P[1]); } else tracePath(ctx, P);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(P[0], P[1], pw(s, P[2]) / 2, 0, 6.2832);
    ctx.fill();
    return;
  }
  if (uniform(P)) {
    ctx.lineWidth = pw(s, P[2]);
    ctx.beginPath();
    tracePath(ctx, P);
    ctx.stroke();
    return;
  }
  // Pressure-sensitive: each curve piece gets its own width.
  let px = P[0], py = P[1];
  for (let i = 1; i < n - 1; i++) {
    const x = P[i * 3], y = P[i * 3 + 1];
    const mx = (x + P[i * 3 + 3]) / 2, my = (y + P[i * 3 + 4]) / 2;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.quadraticCurveTo(x, y, mx, my);
    ctx.lineWidth = pw(s, P[i * 3 + 2]);
    ctx.stroke();
    px = mx; py = my;
  }
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(P[(n - 1) * 3], P[(n - 1) * 3 + 1]);
  ctx.lineWidth = pw(s, P[(n - 1) * 3 + 2]);
  ctx.stroke();
}

// The same stroke as SVG path runs of constant width, for PDF export.
export function strokeRuns(s) {
  const P = s.p, n = P.length / 3;
  const f = v => Math.round(v * 100) / 100;
  if (n < 2) return [];
  if (s.tool === 'hl' || uniform(P)) {
    let d = `M${f(P[0])} ${f(P[1])}`;
    for (let i = 1; i < n - 1; i++) {
      const x = P[i * 3], y = P[i * 3 + 1];
      d += `Q${f(x)} ${f(y)} ${f((x + P[i * 3 + 3]) / 2)} ${f((y + P[i * 3 + 4]) / 2)}`;
    }
    d += `L${f(P[(n - 1) * 3])} ${f(P[(n - 1) * 3 + 1])}`;
    return [{ w: s.tool === 'hl' ? s.w : pw(s, P[2]), d }];
  }
  const runs = [];
  let cur = null;
  const q = w => Math.max(0.2, Math.round(w * 5) / 5);
  const add = (w, fromX, fromY, seg) => {
    w = q(w);
    if (!cur || cur.w !== w) { cur = { w, d: `M${f(fromX)} ${f(fromY)}` }; runs.push(cur); }
    cur.d += seg;
  };
  let px = P[0], py = P[1];
  for (let i = 1; i < n - 1; i++) {
    const x = P[i * 3], y = P[i * 3 + 1];
    const mx = (x + P[i * 3 + 3]) / 2, my = (y + P[i * 3 + 4]) / 2;
    add(pw(s, P[i * 3 + 2]), px, py, `Q${f(x)} ${f(y)} ${f(mx)} ${f(my)}`);
    px = mx; py = my;
  }
  add(pw(s, P[(n - 1) * 3 + 2]), px, py, `L${f(P[(n - 1) * 3])} ${f(P[(n - 1) * 3 + 1])}`);
  return runs;
}

// ---------- shapes ----------

function arrowHead(sh) {
  const a = Math.atan2(sh.y2 - sh.y1, sh.x2 - sh.x1);
  const L = Math.max(9, sh.w * 4.5);
  return [
    sh.x2 - L * Math.cos(a - 0.45), sh.y2 - L * Math.sin(a - 0.45),
    sh.x2 - L * Math.cos(a + 0.45), sh.y2 - L * Math.sin(a + 0.45)
  ];
}

function drawShape(ctx, sh) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = sh.c;
  ctx.lineWidth = sh.w;
  ctx.beginPath();
  if (sh.k === 'rect') {
    ctx.rect(Math.min(sh.x1, sh.x2), Math.min(sh.y1, sh.y2), Math.abs(sh.x2 - sh.x1), Math.abs(sh.y2 - sh.y1));
  } else if (sh.k === 'ellipse') {
    ctx.ellipse((sh.x1 + sh.x2) / 2, (sh.y1 + sh.y2) / 2, Math.abs(sh.x2 - sh.x1) / 2, Math.abs(sh.y2 - sh.y1) / 2, 0, 0, 6.2832);
  } else {
    ctx.moveTo(sh.x1, sh.y1);
    ctx.lineTo(sh.x2, sh.y2);
    if (sh.k === 'arrow') {
      const [ax, ay, bx, by] = arrowHead(sh);
      ctx.moveTo(ax, ay); ctx.lineTo(sh.x2, sh.y2); ctx.lineTo(bx, by);
    }
  }
  ctx.stroke();
}

export function shapeSvg(sh) {
  const f = v => Math.round(v * 100) / 100;
  if (sh.k === 'rect') {
    const x = Math.min(sh.x1, sh.x2), y = Math.min(sh.y1, sh.y2), w = Math.abs(sh.x2 - sh.x1), h = Math.abs(sh.y2 - sh.y1);
    return `M${f(x)} ${f(y)}L${f(x + w)} ${f(y)}L${f(x + w)} ${f(y + h)}L${f(x)} ${f(y + h)}Z`;
  }
  if (sh.k === 'ellipse') {
    const cx = (sh.x1 + sh.x2) / 2, cy = (sh.y1 + sh.y2) / 2, rx = Math.abs(sh.x2 - sh.x1) / 2, ry = Math.abs(sh.y2 - sh.y1) / 2;
    const k = 0.5523;
    return `M${f(cx + rx)} ${f(cy)}`
      + `C${f(cx + rx)} ${f(cy + k * ry)} ${f(cx + k * rx)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)}`
      + `C${f(cx - k * rx)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + k * ry)} ${f(cx - rx)} ${f(cy)}`
      + `C${f(cx - rx)} ${f(cy - k * ry)} ${f(cx - k * rx)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)}`
      + `C${f(cx + k * rx)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - k * ry)} ${f(cx + rx)} ${f(cy)}Z`;
  }
  let d = `M${f(sh.x1)} ${f(sh.y1)}L${f(sh.x2)} ${f(sh.y2)}`;
  if (sh.k === 'arrow') {
    const [ax, ay, bx, by] = arrowHead(sh);
    d += `M${f(ax)} ${f(ay)}L${f(sh.x2)} ${f(sh.y2)}L${f(bx)} ${f(by)}`;
  }
  return d;
}

// Outline of a shape as line segments, for hit-testing.
function shapeSegs(sh) {
  if (sh.k === 'rect') {
    return [sh.x1, sh.y1, sh.x2, sh.y1, sh.x2, sh.y1, sh.x2, sh.y2, sh.x2, sh.y2, sh.x1, sh.y2, sh.x1, sh.y2, sh.x1, sh.y1];
  }
  if (sh.k === 'ellipse') {
    const cx = (sh.x1 + sh.x2) / 2, cy = (sh.y1 + sh.y2) / 2, rx = Math.abs(sh.x2 - sh.x1) / 2, ry = Math.abs(sh.y2 - sh.y1) / 2;
    const out = [];
    for (let i = 0; i < 28; i++) {
      const a = i / 28 * 6.2832, b = (i + 1) / 28 * 6.2832;
      out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a), cx + rx * Math.cos(b), cy + ry * Math.sin(b));
    }
    return out;
  }
  return [sh.x1, sh.y1, sh.x2, sh.y2];
}

// ---------- text ----------

const mctx = document.createElement('canvas').getContext('2d');
const lineCache = new WeakMap();

function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const tok of para.split(/(\s+)/)) {
      if (!tok) continue;
      if (ctx.measureText(line + tok).width <= maxW) { line += tok; continue; }
      if (line.trim()) { out.push(line.replace(/\s+$/, '')); line = ''; }
      if (/^\s+$/.test(tok)) continue;
      let rest = tok;
      while (ctx.measureText(rest).width > maxW && rest.length > 1) {
        let i = rest.length - 1;
        while (i > 1 && ctx.measureText(rest.slice(0, i)).width > maxW) i--;
        out.push(rest.slice(0, i));
        rest = rest.slice(i);
      }
      line = rest;
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

export function textLines(it) {
  let l = lineCache.get(it);
  if (!l) {
    mctx.font = `${it.fs}px ${FONT}`;
    l = wrap(mctx, it.s, it.w);
    lineCache.set(it, l);
  }
  return l;
}

export const textHeight = it => textLines(it).length * it.fs * LH;

function drawText(ctx, it, ox = it.x, oy = it.y) {
  ctx.font = `${it.fs}px ${FONT}`;
  ctx.fillStyle = it.c;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const lh = it.fs * LH;
  textLines(it).forEach((l, i) => { if (l) ctx.fillText(l, ox, oy + (i + 0.5) * lh); });
}

// Text rendered to a transparent bitmap (PDF export uses this so any script, e.g. Devanagari, survives).
export function textBitmap(it, k = 3) {
  const th = textHeight(it);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(it.w * k));
  c.height = Math.max(1, Math.ceil(th * k));
  const ctx = c.getContext('2d');
  ctx.scale(k, k);
  drawText(ctx, it, 0, 0);
  return { canvas: c, h: th };
}

// ---------- images ----------

const imgs = new Map(); // assetId -> {img, p}
let imageListener = null;
export const onImageLoaded = fn => { imageListener = fn; };

async function loadAsset(id) {
  const a = await db.get('assets', id);
  if (!a || !a.data) throw new Error('missing asset');
  const url = URL.createObjectURL(new Blob([a.data], { type: a.mime }));
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

export function loadImage(id) {
  let e = imgs.get(id);
  if (!e) {
    e = { img: null, p: null };
    imgs.set(id, e);
    e.p = loadAsset(id).then(img => {
      e.img = img;
      if (imageListener) imageListener(id);
      return img;
    }).catch(() => { imgs.delete(id); return null; });
  }
  return e.p;
}

function getImage(id) {
  const e = imgs.get(id);
  if (e) return e.img;
  loadImage(id);
  return null;
}

// ---------- items ----------

export function drawItem(ctx, it) {
  switch (it.t) {
    case 's': drawStroke(ctx, it); break;
    case 'sh': drawShape(ctx, it); break;
    case 'tx': drawText(ctx, it); break;
    case 'im': {
      const img = getImage(it.a);
      if (img) {
        ctx.imageSmoothingQuality = 'high';
        // it.cr = [left, top, width, height] of the kept part, as fractions of the picture (set by cropping)
        const cr = it.cr, nw = img.naturalWidth, nh = img.naturalHeight;
        if (cr) ctx.drawImage(img, cr[0] * nw, cr[1] * nh, cr[2] * nw, cr[3] * nh, it.x, it.y, it.w, it.h);
        else ctx.drawImage(img, it.x, it.y, it.w, it.h);
      } else { ctx.fillStyle = 'rgba(128,128,128,.22)'; ctx.fillRect(it.x, it.y, it.w, it.h); }
      break;
    }
  }
}

const isHl = it => it.t === 's' && it.tool === 'hl';

// clip ({x, y, w, h} in page units) lets callers that only show part of a page skip everything outside it.
function outside(it, clip) {
  if (!clip) return false;
  const b = bounds(it);
  return b.x > clip.x + clip.w || b.x + b.w < clip.x || b.y > clip.y + clip.h || b.y + b.h < clip.y;
}

export function drawImages(ctx, items, skip, clip) {
  for (const it of items) if (it.t === 'im' && !(skip && skip.has(it.id)) && !outside(it, clip)) drawItem(ctx, it);
}

// Layer order: pictures at the bottom, then highlighter, then writing, so nothing washes out the ink.
// The editor keeps pictures on their own opaque layer and passes images = false here.
export function drawItems(ctx, items, skip, images = true, clip = null) {
  if (images) drawImages(ctx, items, skip, clip);
  const vis = clip ? items.filter(it => !outside(it, clip)) : items;
  for (const it of vis) if (isHl(it) && !(skip && skip.has(it.id))) drawItem(ctx, it);
  for (const it of vis) if (!isHl(it) && it.t !== 'im' && !(skip && skip.has(it.id))) drawItem(ctx, it);
}

const bcache = new WeakMap();

export function bounds(it) {
  let b = bcache.get(it);
  if (b) return b;
  if (it.t === 's') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < it.p.length; i += 3) {
      const x = it.p[i], y = it.p[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const m = it.w;
    b = { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
  } else if (it.t === 'sh') {
    const m = it.k === 'arrow' ? Math.max(9, it.w * 4.5) : it.w;
    b = {
      x: Math.min(it.x1, it.x2) - m, y: Math.min(it.y1, it.y2) - m,
      w: Math.abs(it.x2 - it.x1) + 2 * m, h: Math.abs(it.y2 - it.y1) + 2 * m
    };
  } else if (it.t === 'tx') {
    b = { x: it.x, y: it.y, w: it.w, h: textHeight(it) };
  } else {
    b = { x: it.x, y: it.y, w: it.w, h: it.h };
  }
  bcache.set(it, b);
  return b;
}

export function unionBounds(items) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) {
    const b = bounds(it);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Does a circle (eraser tip / tap) touch the ink of this stroke or shape?
export function hitsCircle(it, x, y, r) {
  const b = bounds(it);
  if (x < b.x - r || x > b.x + b.w + r || y < b.y - r || y > b.y + b.h + r) return false;
  if (it.t === 's') {
    const P = it.p, rr = r + it.w / 2;
    if (P.length === 3) return Math.hypot(P[0] - x, P[1] - y) <= rr;
    for (let i = 0; i + 5 < P.length; i += 3) {
      if (distSeg(x, y, P[i], P[i + 1], P[i + 3], P[i + 4]) <= rr) return true;
    }
    return false;
  }
  if (it.t === 'sh') {
    const S = shapeSegs(it), rr = r + it.w / 2;
    for (let i = 0; i < S.length; i += 4) if (distSeg(x, y, S[i], S[i + 1], S[i + 2], S[i + 3]) <= rr) return true;
    return false;
  }
  return true;
}

// Lasso test: most of a stroke, or the centre of anything else, must be inside the loop.
export function inLasso(it, poly) {
  if (it.t === 's') {
    let inside = 0;
    const n = it.p.length / 3;
    for (let i = 0; i < it.p.length; i += 3) if (inPoly(it.p[i], it.p[i + 1], poly)) inside++;
    return inside / n >= 0.6;
  }
  const b = bounds(it);
  return inPoly(b.x + b.w / 2, b.y + b.h / 2, poly);
}

// Precise eraser: cut a stroke where the eraser circle passes and return the remaining pieces.
export function splitStroke(s, x, y, r) {
  const P = s.p, n = P.length / 3, rr = r + s.w / 2;
  const pieces = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= 6) pieces.push({ ...s, id: uid(), p: cur, m: Date.now() });
    cur = [];
  };
  for (let i = 0; i < n; i++) {
    const px = P[i * 3], py = P[i * 3 + 1];
    if (Math.hypot(px - x, py - y) <= rr) { flush(); continue; }
    if (cur.length && distSeg(x, y, P[i * 3 - 3], P[i * 3 - 2], px, py) <= rr) flush();
    cur.push(px, py, P[i * 3 + 2]);
  }
  flush();
  return pieces;
}

// Scale by k around (ox, oy), then move by (dx, dy). Returns a new item with the same id.
export function transformItem(it, k, ox, oy, dx, dy) {
  const X = x => Math.round((ox + (x - ox) * k + dx) * 100) / 100;
  const Y = y => Math.round((oy + (y - oy) * k + dy) * 100) / 100;
  const o = { ...it, m: Date.now() };
  if (it.t === 's') {
    o.p = new Array(it.p.length);
    for (let i = 0; i < it.p.length; i += 3) { o.p[i] = X(it.p[i]); o.p[i + 1] = Y(it.p[i + 1]); o.p[i + 2] = it.p[i + 2]; }
    o.w = it.w * k;
  } else if (it.t === 'sh') {
    o.x1 = X(it.x1); o.y1 = Y(it.y1); o.x2 = X(it.x2); o.y2 = Y(it.y2); o.w = it.w * k;
  } else if (it.t === 'tx') {
    o.x = X(it.x); o.y = Y(it.y); o.w = it.w * k; o.fs = it.fs * k;
  } else {
    o.x = X(it.x); o.y = Y(it.y); o.w = it.w * k; o.h = it.h * k;
  }
  return o;
}

// Whole page (paper, PDF, ink) into a canvas pxW pixels wide. Used for thumbnails.
export async function renderPageTo(page, canvas, pxW) {
  const rs = pxW / page.w;
  canvas.width = Math.round(pxW);
  canvas.height = Math.max(1, Math.round(page.h * rs));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(rs, 0, 0, rs, 0, 0);
  drawPaper(ctx, page);
  if (page.pdf) {
    try {
      const c = await renderPdfPage(page.pdf.a, page.pdf.i, rs);
      if (c) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(c, 0, 0, canvas.width, canvas.height);
        ctx.setTransform(rs, 0, 0, rs, 0, 0);
      }
    } catch (e) { /* PDF not available yet: leave the paper blank */ }
  }
  await Promise.all(page.items.filter(it => it.t === 'im').map(it => loadImage(it.a)));
  drawImages(ctx, page.items);
  if (!paperOf(page).dark) ctx.globalCompositeOperation = 'multiply';
  drawItems(ctx, page.items, null, false);
  ctx.globalCompositeOperation = 'source-over';
}
