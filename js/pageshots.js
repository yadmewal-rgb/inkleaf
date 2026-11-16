// Pictures of parts of a page (for highlights, flashcards and the highlights document) and the grouping of a PDF
// page's text into lines. These only read the page they are given; the editor decides where to show the results.
import * as R from './render.js';
import { clamp } from './util.js';
import { pageText } from './pdftools.js';

// A piece of a page as a picture (k = pixels per page unit, pad = extra around it). One page render is reused
// for several pieces of the same page.
let regionCache = null;
export async function regionCanvas(pg, r, k = 2, pad = 6, mask) {
  const key = pg.id + ':' + pg.modified + ':' + k;
  if (!regionCache || regionCache.key !== key) {
    const whole = document.createElement('canvas');
    if (regionCache) regionCache.p.then(c => { c.width = c.height = 0; }).catch(() => {});
    regionCache = { key, p: R.renderPageTo(pg, whole, pg.w * k).then(() => whole) };
  }
  const whole = await regionCache.p;
  const x = clamp(r.x - pad, 0, pg.w), y = clamp(r.y - pad, 0, pg.h), w = Math.min(pg.w, r.x + r.w + pad) - x, hgt = Math.min(pg.h, r.y + r.h + pad) - y;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(hgt * k));
  const g = c.getContext('2d');
  g.drawImage(whole, -Math.round(x * k), -Math.round(y * k));
  if (mask) { // a covered patch: the question side of a flashcard made from a highlight
    g.fillStyle = '#e9d8a6';
    g.fillRect((mask.x - x) * k, (mask.y - y) * k, mask.w * k, mask.h * k);
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.font = `700 ${Math.min(mask.h * k * 0.8, 30)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('?', (mask.x - x + mask.w / 2) * k, (mask.y - y + mask.h / 2) * k);
  }
  return c;
}

// Text runs of a PDF page grouped into lines (per column), as boxes in page units.
export function textLines(page, t) {
  const pb = R.pdfBox(page), lines = [];
  const parts = t.parts.map(p => ({ x: p.x + pb.x, y: p.y + pb.y, w: p.w, h: p.h })).filter(p => p.w > 0.5 && p.h > 2).sort((m, n) => m.y - n.y || m.x - n.x);
  for (const p of parts) {
    const cy = p.y + p.h / 2;
    const L = lines.find(l => cy > l.y && cy < l.y + l.h && p.x < l.x + l.w + 3 * l.h && p.x + p.w > l.x - 3 * l.h);
    if (!L) { lines.push({ ...p }); continue; }
    const x1 = Math.max(L.x + L.w, p.x + p.w), y1 = Math.max(L.y + L.h, p.y + p.h);
    L.x = Math.min(L.x, p.x); L.y = Math.min(L.y, p.y); L.w = x1 - L.x; L.h = y1 - L.y;
  }
  return lines;
}

// The PDF text lying under a highlight.
export function textUnder(pg, t, items) {
  const pb = R.pdfBox(pg), out = [];
  for (const p of t.parts) {
    const px = p.x + pb.x, py = p.y + pb.y, cy = py + p.h / 2;
    let a = 1, b = 0; // the covered stretch of this run, as fractions of its width
    for (const it of items) {
      const ib = R.bounds(it), m = it.w * 0.5; // bounds carry a margin all round: take it off sideways
      if (cy < ib.y || cy > ib.y + ib.h) continue;
      const f0 = clamp((ib.x + m - px) / p.w, 0, 1), f1 = clamp((ib.x + ib.w - m - px) / p.w, 0, 1);
      if (f1 > f0) { a = Math.min(a, f0); b = Math.max(b, f1); }
    }
    if (b - a < 0.04) continue;
    const s = p.t, i0 = Math.round(a * s.length), i1 = Math.round(b * s.length);
    // Snap to whole words.
    let s0 = i0, s1 = i1;
    while (s0 > 0 && /\S/.test(s[s0 - 1]) && i0 - s0 < 12) s0--;
    while (s1 < s.length && /\S/.test(s[s1]) && s1 - i1 < 12) s1++;
    const piece = s.slice(s0, s1).trim();
    if (piece) out.push(piece);
  }
  return out.join(' ').replace(/\s+/g, ' ').slice(0, 600);
}

// Highlighter strokes that touch (a highlight over several lines, or done in two passes) count as one highlight.
export function hlGroups(pg) {
  const groups = [];
  const hls = pg.items.filter(it => it.t === 's' && it.tool === 'hl').map(it => ({ it, b: R.bounds(it) }));
  for (const it of hls.sort((m, n) => m.b.y - n.b.y || m.b.x - n.b.x)) {
    const near = groups.filter(g2 => it.b.x < g2.b.x + g2.b.w + 4 && it.b.x + it.b.w > g2.b.x - 4 && it.b.y < g2.b.y + g2.b.h + 3 && it.b.y + it.b.h > g2.b.y - 3);
    const g = { items: [it.it, ...near.flatMap(n => n.items)] }; // it may join groups that were apart until now
    g.b = R.unionBounds(g.items);
    for (const n of near) groups.splice(groups.indexOf(n), 1);
    groups.push(g);
  }
  return groups;
}

// The part of the page that shows a highlight: the highlighted lines plus one line above and one below.
// On PDF pages the real text lines are used; elsewhere the highlighter's width stands in for a line.
export async function hlRegion(pg, items) {
  const b = R.unionBounds(items), w = Math.max(...items.map(it => it.w || 12));
  // bounds reach a whole stroke width past the ink's middle; the ink itself covers half of that
  let y0 = b.y + w / 2 - w * 1.15, y1 = b.y + b.h - w / 2 + w * 1.15;
  // Every picture spans the page's whole text width, so all of them come out the same width and the same size
  // of writing: on a PDF page from its leftmost to its rightmost text, elsewhere the whole page.
  let x0 = 0, x1 = pg.w;
  if (pg.pdf && !pg.tpl) {
    try {
      const all = textLines(pg, await pageText(pg.pdf.a, pg.pdf.i));
      if (all.length) { x0 = Math.min(...all.map(l => l.x)) - 16; x1 = Math.max(...all.map(l => l.x + l.w)) + 16; } // the same margin for every highlight
      const L = all.filter(l => l.x < b.x + b.w && l.x + l.w > b.x);
      const mid = l => l.y + l.h / 2, inside = L.filter(l => mid(l) > b.y && mid(l) < b.y + b.h);
      if (inside.length) {
        const top = Math.min(...inside.map(l => l.y)), bot = Math.max(...inside.map(l => l.y + l.h));
        const lh = inside.reduce((s, l) => s + l.h, 0) / inside.length;
        const above = L.filter(l => mid(l) < top).sort((p, q) => mid(q) - mid(p))[0];
        const below = L.filter(l => mid(l) > bot).sort((p, q) => mid(p) - mid(q))[0];
        // a line far away (the gap before the next question) is not "the line above": show a line's worth of space
        y0 = above && top - (above.y + above.h) < lh * 2.5 ? above.y - 2 : top - lh * 1.4;
        y1 = below && below.y - bot < lh * 2.5 ? below.y + below.h + 2 : bot + lh * 1.4;
        y0 = Math.min(y0, b.y + w / 2 - 2); y1 = Math.max(y1, b.y + b.h - w / 2 + 2); // never cut the highlight itself
      }
    } catch { /* PDF text not on this device yet: keep the estimate */ }
  }
  x0 = clamp(x0, 0, pg.w); x1 = clamp(x1, 0, pg.w);
  y0 = clamp(y0, 0, pg.h); y1 = clamp(y1, 0, pg.h);
  return { x: Math.round(x0), y: Math.round(y0), w: Math.max(1, Math.round(x1 - x0)), h: Math.max(1, Math.round(y1 - y0)) };
}

let shotChain = Promise.resolve();
export function hlShot(pg, items, mask) {
  const p = shotChain.then(async () => regionCanvas(pg, await hlRegion(pg, items), 3.5, 0, mask)); // sharp at full screen width
  shotChain = p.catch(() => {});
  return p;
}

