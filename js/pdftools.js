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

// Which pages of a PDF carry annotations made in other apps (GoodNotes ink, highlights, notes): a Set of page indexes.
const annotCache = new Map();
export function annotPages(assetId) {
  if (!annotCache.has(assetId)) {
    const p = (async () => {
      const doc = await pdfDoc(assetId), out = new Set();
      for (let i = 0; i < doc.numPages; i++) {
        const an = await (await doc.getPage(i + 1)).getAnnotations();
        if (an.some(a => a.subtype !== 'Link' && a.subtype !== 'Popup')) out.add(i);
      }
      return out;
    })();
    p.catch(() => annotCache.delete(assetId));
    annotCache.set(assetId, p);
  }
  return annotCache.get(assetId);
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

// Scan a PDF's pages for chapter titles and section headings to generate a table of contents.
export async function generatePdfOutline(assetId) {
  const doc = await pdfDoc(assetId);
  const total = doc.numPages;
  const candidates = [];

  const chapPattern = /^(?:chapter|unit|part|module|lecture|lesson)\s+([0-9ivxlcdm]+)[:.\s\-]*(.*)$/i;
  const secPattern = /^([0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?)\s+([A-Za-z].*)$/;

  for (let idx = 0; idx < total; idx++) {
    try {
      const page = await doc.getPage(idx + 1);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      if (!tc || !tc.items || !tc.items.length) continue;

      const lines = [];
      let curLine = null;
      for (const it of tc.items) {
        if (typeof it.str !== 'string' || !it.str.trim()) continue;
        const tm = it.transform;
        const hgt = it.height || Math.hypot(tm[2], tm[3]) || 10;
        const [x, y] = vp.convertToViewportPoint(tm[4], tm[5]);
        if (!curLine || Math.abs(curLine.y - y) > 5) {
          curLine = { y, hgt, text: it.str.trim(), maxHgt: hgt };
          lines.push(curLine);
        } else {
          curLine.text += ' ' + it.str.trim();
          if (hgt > curLine.maxHgt) curLine.maxHgt = hgt;
        }
      }

      const topLines = lines.slice(0, 8);
      let found = false;
      for (const line of topLines) {
        const t = line.text.trim();
        if (t.length < 3 || t.length > 80) continue;
        if (chapPattern.test(t)) {
          candidates.push({ title: t.replace(/\s+/g, ' '), depth: 0, i: idx });
          found = true;
          break;
        }
        if (secPattern.test(t)) {
          candidates.push({ title: t.replace(/\s+/g, ' '), depth: 1, i: idx });
          found = true;
          break;
        }
      }

      if (!found && lines.length > 0) {
        const avgH = lines.reduce((acc, l) => acc + l.maxHgt, 0) / lines.length;
        const top = topLines[0];
        if (top && top.maxHgt >= avgH * 1.35 && top.text.length >= 4 && top.text.length <= 60 && !/^\d+$/.test(top.text)) {
          candidates.push({ title: top.text.replace(/\s+/g, ' '), depth: 0, i: idx });
        }
      }
    } catch {}
  }

  const unique = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = c.title.toLowerCase() + ':' + c.i;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }

  const directKey = localStorage.getItem('inkleaf.geminiKey');
  const model = localStorage.getItem('inkleaf.geminiModel') || 'gemini-3.5-flash-lite';
  if (directKey && navigator.onLine && unique.length > 0) {
    try {
      const prompt = `Here is a list of candidate headings extracted from a PDF document:\n${JSON.stringify(unique.map(u => ({ title: u.title, page: u.i + 1 })))}\nClean up, deduplicate, and format these into a clean Table of Contents JSON array of objects: [{"title": string, "depth": 0 or 1, "i": number (0-based page index)}]. Return ONLY the valid JSON array without commentary or code fences.`;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${directKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' }
        })
      });
      if (res.ok) {
        const j = await res.json();
        const raw = (j?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map(p => ({ title: String(p.title || '').trim(), depth: Number(p.depth) || 0, i: Number(p.i) }));
        }
      }
    } catch {}
  }

  return unique;
}
