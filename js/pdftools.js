// PDF extras: links, the table of contents and text search.
// Every position returned here is in page units with the origin at the top left, like the rest of the app.
import { pdfDoc } from './pdfrender.js';
import { db } from './db.js';

const linkCache = new Map(), textCache = new Map();
const mctx = document.createElement('canvas').getContext('2d');
mctx.font = '10px Helvetica, Arial, sans-serif';

// A PDF destination (named or explicit) -> page index in that PDF, or -1.
async function destIndex(doc, dest) {
  try {
    if (typeof dest === 'string') dest = await doc.getDestination(dest);
    if (!Array.isArray(dest) || dest[0] == null) return -1;
    const ref = dest[0];
    return typeof ref === 'object' ? await doc.getPageIndex(ref) : ref | 0;
  } catch { return -1; }
}

export async function resolveDest(assetId, dest) {
  return destIndex(await pdfDoc(assetId), dest);
}

// Links on a page: [{x, y, w, h, url} | {x, y, w, h, dest}]
export function pageLinks(assetId, index) {
  const key = assetId + ':' + index;
  if (!linkCache.has(key)) {
    const p = (async () => {
      const doc = await pdfDoc(assetId);
      const page = await doc.getPage(index + 1);
      const vp = page.getViewport({ scale: 1 });
      const out = [];
      for (const a of await page.getAnnotations()) {
        if (a.subtype !== 'Link' || !a.rect) continue;
        const [x0, y0, x1, y1] = vp.convertToViewportRectangle(a.rect);
        const l = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
        if (a.url) l.url = a.url; else if (a.dest) l.dest = a.dest; else continue;
        out.push(l);
      }
      return out;
    })();
    p.catch(() => linkCache.delete(key));
    linkCache.set(key, p);
  }
  return linkCache.get(key);
}

// The PDF's own table of contents, flattened: [{title, depth, i (page index in the PDF, or -1)}]
export async function pdfOutline(assetId) {
  const doc = await pdfDoc(assetId);
  const out = [];
  const walk = async (items, depth) => {
    for (const it of items || []) {
      out.push({ title: (it.title || '').trim() || 'Untitled', depth, i: it.dest ? await destIndex(doc, it.dest) : -1 });
      if (depth < 5) await walk(it.items, depth + 1);
    }
  };
  await walk(await doc.getOutline(), 0);
  return out;
}

// The text of a page: {s: all of it in lower case, parts: [{at, len, x, y, w, h}]} where each part is one run of
// text, "at" is where it starts in s and the rest is the box it occupies on the page.
export function pageText(assetId, index) {
  const key = assetId + ':' + index;
  if (!textCache.has(key)) {
    const p = (async () => {
      const doc = await pdfDoc(assetId);
      const page = await doc.getPage(index + 1);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      let s = '';
      const parts = [];
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue;
        const str = it.str.toLowerCase();
        if (str.trim()) {
          const tm = it.transform, hgt = it.height || Math.hypot(tm[2], tm[3]) || 10;
          const [ax, ay] = vp.convertToViewportPoint(tm[4], tm[5] - hgt * 0.22);
          const [bx, by] = vp.convertToViewportPoint(tm[4] + it.width, tm[5] + hgt * 0.85);
          parts.push({ at: s.length, len: str.length, t: it.str, x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) });
        }
        s += str;
        if (it.hasEOL && !/\s$/.test(s)) s += ' ';
      }
      return { s, parts };
    })();
    p.catch(() => textCache.delete(key));
    textCache.set(key, p);
  }
  return textCache.get(key);
}

// The text of every page of a PDF, in lower case, kept on this device after the first time (for library search).
const allText = new Map();
export function pdfPagesText(assetId) {
  if (!allText.has(assetId)) {
    const p = (async () => {
      const key = 'pdftext:' + assetId, saved = await db.getMeta(key);
      if (saved) return saved;
      const doc = await pdfDoc(assetId), out = [];
      for (let i = 0; i < doc.numPages; i++) out.push((await pageText(assetId, i)).s);
      await db.setMeta(key, out).catch(() => {});
      return out;
    })();
    p.catch(() => allText.delete(assetId));
    allText.set(assetId, p);
  }
  return allText.get(assetId);
}

// Every place q (lower case) occurs in a page's text. Each match is a list of boxes to highlight.
export function textMatches(t, q) {
  const out = [];
  if (!q) return out;
  for (let at = t.s.indexOf(q); at >= 0; at = t.s.indexOf(q, at + q.length)) {
    const end = at + q.length, rects = [];
    for (const p of t.parts) {
      if (p.at + p.len <= at) continue;
      if (p.at >= end) break;
      const a = Math.max(at, p.at) - p.at, b = Math.min(end, p.at + p.len) - p.at;
      if (b <= a) continue;
      // Where the match sits inside the run is estimated from the letter widths of an ordinary font.
      const full = mctx.measureText(p.t).width || 1;
      const fa = mctx.measureText(p.t.slice(0, a)).width / full, fb = mctx.measureText(p.t.slice(0, b)).width / full;
      rects.push({ x: p.x + p.w * fa, y: p.y, w: p.w * (fb - fa), h: p.h });
    }
    if (rects.length) out.push(rects);
  }
  return out;
}
