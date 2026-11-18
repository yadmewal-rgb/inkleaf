// Handwriting search. Pen strokes are grouped into lines and words, each short run of words is drawn as a picture
// and read by an offline handwriting model (js/hw-worker.js), and the text is kept on this device per page
// (meta "hw:<pageId>"). Searches then match typed words against it and point back at the strokes that were read.
// Off until switched on in Settings, because the model is a one-time download of about 90 MB.
import { db } from './db.js';
import { bus } from './util.js';

const VER = 1;
const KEY = 'inkleaf.hw';
const IDLE_MS = 45e3; // the worker (and the memory the model takes) is let go after this long without work

export const hwOn = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
export function setHwOn(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode */ }
  if (on) { status.state = 'idle'; indexAll(); } else { queue.clear(); stopWorker(); status.state = 'off'; }
  bus.emit('hw-status', status);
}

// ---------- the model, in a worker
let worker = null, seq = 0, idleT = 0;
const waiting = new Map();
export const status = { state: hwOn() ? 'idle' : 'off', done: 0, left: 0, loaded: 0, total: 0, err: '' };

let cloudOcrFn = null;
export const setCloudOcr = fn => { cloudOcrFn = fn; };

function imgToBase64(img) {
  if (!img) return '';
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d');
  ctx.putImageData(img, 0, 0);
  const dataUrl = cv.toDataURL('image/jpeg', 0.85);
  cv.width = cv.height = 0;
  return dataUrl.split(',')[1] || '';
}

function startWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./hw-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => {
    const m = e.data;
    if (m.progress) {
      status.state = 'loading';
      status.loaded = m.loaded; status.total = m.total;
      bus.emit('hw-status', status);
      return;
    }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error) w.rej(new Error(m.error)); else w.res(m.text);
  };
  worker.onerror = e => {
    for (const w of waiting.values()) w.rej(new Error(e.message || 'The handwriting reader stopped'));
    waiting.clear();
    stopWorker();
  };
  return worker;
}

function stopWorker() {
  if (worker) worker.terminate();
  worker = null;
  for (const w of waiting.values()) w.rej(new Error('stopped'));
  waiting.clear();
}

async function read(img) {
  if (!img) {
    const wk = startWorker(), id = ++seq;
    return new Promise(res => {
      waiting.set(id, { res: () => res(''), rej: () => res('') });
      wk.postMessage({ id });
    });
  }

  // 1. Try Cloud AI first when online (Gemini Flash)
  if (navigator.onLine) {
    try {
      const b64 = imgToBase64(img);
      if (b64) {
        // Direct key if set in settings
        const directKey = localStorage.getItem('inkleaf.geminiKey');
        if (directKey) {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${directKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: 'Transcribe all handwritten words and notes in this image. Return ONLY the transcribed text. Do not add quotes, markdown, or commentary.' },
                  { inline_data: { mime_type: 'image/jpeg', data: b64 } }
                ]
              }],
              generationConfig: { temperature: 0.1 }
            })
          });
          if (res.ok) {
            const j = await res.json();
            const txt = (j?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
            if (txt) return txt;
          }
        }
        // Cloudflare sync service /ocr
        if (cloudOcrFn) {
          const txt = await cloudOcrFn(b64);
          if (txt) return txt.trim();
        }
      }
    } catch (e) {
      console.warn('Cloud handwriting OCR skipped, using offline backup:', e);
    }
  }

  // 2. Offline backup (TrOCR Web Worker)
  clearTimeout(idleT);
  const wk = startWorker(), id = ++seq;
  return new Promise((res, rej) => {
    waiting.set(id, { res, rej });
    wk.postMessage({ id, w: img.width, h: img.height, data: img.data.buffer }, [img.data.buffer]);
  }).finally(() => { clearTimeout(idleT); idleT = setTimeout(() => { if (!waiting.size) stopWorker(); }, IDLE_MS); });
}

// ---------- splitting a page's ink into lines, words and runs of words
const isInk = it => it.t === 's' && it.tool !== 'hl' && it.p && it.p.length >= 3;

function boxOf(it) {
  const p = it.p, r = (it.w || 1) / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { it, x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r, w: x1 - x0 + 2 * r, h: y1 - y0 + 2 * r, cy: (y0 + y1) / 2 };
}

const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// Runs of up to four words on one line; each is read in one go (the model reads short lines better than lone
// letters, and fewer pictures means less work). Returns [{ids, words: [ids...], b}].
export function segment(pg) {
  const all = pg.items.filter(isInk).map(boxOf);
  if (!all.length) return [];
  const H = Math.max(4, median(all.filter(s => s.h > 2).map(s => s.h))); // typical letter height
  const ink = all.filter(s => !(s.h > 4.5 * H && s.w > 3 * H) && !(s.w > 7 * H && s.h < 0.6 * H)); // not drawings or underlines
  const big = ink.filter(s => Math.max(s.w, s.h) >= 0.4 * H).sort((a, b) => a.cy - b.cy);
  const small = ink.filter(s => Math.max(s.w, s.h) < 0.4 * H);
  const lines = [];
  for (const s of big) {
    let best = null, bd = Infinity;
    for (const L of lines) {
      const d = Math.abs(s.cy - L.cy);
      if (d < 0.6 * Math.max(H, L.h) && s.x0 < L.x1 + 6 * H && s.x1 > L.x0 - 6 * H && d < bd) { best = L; bd = d; }
    }
    if (!best) { best = { cys: [], hs: [], x0: s.x0, x1: s.x1, cy: s.cy, h: s.h, s: [] }; lines.push(best); }
    best.s.push(s);
    best.cys.push(s.cy); best.hs.push(s.h);
    best.cy = best.cys.reduce((a, b) => a + b, 0) / best.cys.length;
    best.h = median(best.hs);
    best.x0 = Math.min(best.x0, s.x0); best.x1 = Math.max(best.x1, s.x1);
  }
  // Dots, commas and the like join the line they sit on (or just above, for i and j dots).
  for (const s of small) {
    let best = null, bd = Infinity;
    for (const L of lines) {
      const top = L.cy - 1.1 * Math.max(H, L.h), bot = L.cy + 0.8 * Math.max(H, L.h);
      if (s.cy < top || s.cy > bot || s.x1 < L.x0 - H || s.x0 > L.x1 + H) continue;
      const d = Math.abs(s.cy - L.cy);
      if (d < bd) { best = L; bd = d; }
    }
    if (best) best.s.push(s);
  }
  const runs = [];
  for (const L of lines) {
    const lh = Math.max(H * 0.8, L.h);
    L.s.sort((a, b) => a.x0 - b.x0);
    const words = [];
    for (const s of L.s) {
      const w = words[words.length - 1];
      if (w && s.x0 <= w.x1 + 0.42 * lh) { w.s.push(s); w.x1 = Math.max(w.x1, s.x1); continue; }
      words.push({ s: [s], x0: s.x0, x1: s.x1 });
    }
    let run = null;
    for (const w of words) {
      if (!run || run.w.length >= 4 || w.x0 - run.x1 > 2.5 * lh || w.x1 - run.x0 > 22 * lh) { run = { w: [], x0: w.x0, x1: w.x1, lh }; runs.push(run); }
      run.w.push(w);
      run.x1 = Math.max(run.x1, w.x1);
    }
  }
  return runs.map(r => {
    const ss = r.w.flatMap(w => w.s);
    return {
      ids: ss.map(s => s.it.id),
      words: r.w.map(w => w.s.map(s => s.it.id)),
      lh: r.lh,
      b: { x0: Math.min(...ss.map(s => s.x0)), y0: Math.min(...ss.map(s => s.y0)), x1: Math.max(...ss.map(s => s.x1)), y1: Math.max(...ss.map(s => s.y1)) },
      s: ss
    };
  });
}

// The words drawn black on white, about 44 px per letter height.
function picture(run) {
  const k = Math.min(44 / run.lh, 6), pad = 0.5 * run.lh;
  const W = Math.min(2400, Math.ceil((run.b.x1 - run.b.x0 + 2 * pad) * k)), Hh = Math.ceil((run.b.y1 - run.b.y0 + 2 * pad) * k);
  const cv = document.createElement('canvas');
  cv.width = Math.max(8, W); cv.height = Math.max(8, Hh);
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  g.strokeStyle = '#000'; g.fillStyle = '#000'; g.lineCap = g.lineJoin = 'round';
  const ox = run.b.x0 - pad, oy = run.b.y0 - pad;
  for (const { it } of run.s) {
    const p = it.p;
    g.lineWidth = Math.max(2, Math.min(it.w || 1.5, run.lh / 5) * k);
    g.beginPath();
    g.moveTo((p[0] - ox) * k, (p[1] - oy) * k);
    if (p.length === 3) g.lineTo((p[0] - ox) * k + 0.1, (p[1] - oy) * k);
    for (let i = 3; i < p.length; i += 3) g.lineTo((p[i] - ox) * k, (p[i + 1] - oy) * k);
    g.stroke();
  }
  const img = g.getImageData(0, 0, cv.width, cv.height);
  cv.width = cv.height = 0;
  return img;
}

// Short, order-free name for a set of strokes, so a run already read is not read again.
function sig(ids) {
  let h1 = 0x811c9dc5, h2 = 0;
  for (const id of [...ids].sort()) for (let i = 0; i < id.length; i++) { const c = id.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = (h2 * 31 + c) | 0; }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + ids.length;
}

// ---------- the per-page index
const mem = new Map(); // pageId -> saved index, for searches that must answer at once (pages panel)
const keyOf = id => 'hw:' + id;

export async function pageIndex(pageId) {
  if (mem.has(pageId)) return mem.get(pageId);
  const x = await db.getMeta(keyOf(pageId));
  const v = x && x.v === VER ? x : null;
  mem.set(pageId, v);
  return v;
}

const upToDate = (x, pg) => x && x.v === VER && x.pm === (pg.modified || 0);

async function indexPage(pg) {
  const old = await pageIndex(pg.id);
  if (upToDate(old, pg)) return false;
  const known = new Map((old ? old.r : []).map(r => [r.k, r]));
  const out = [];
  for (const run of segment(pg)) {
    const k = sig(run.ids);
    let r = known.get(k);
    if (!r) {
      const text = (await read(picture(run))).replace(/\s+/g, ' ').trim();
      const toks = text ? text.split(' ') : [];
      r = { k, t: text, w: toks.length === run.words.length ? run.words.map((ids, i) => ({ ids, t: toks[i] })) : null, ids: run.ids };
    }
    out.push(r);
  }
  const x = { v: VER, pm: pg.modified || 0, r: out };
  await db.setMeta(keyOf(pg.id), x);
  mem.set(pg.id, x);
  return true;
}

// All the handwriting read on a page, as one string (for snippets).
export const indexText = x => (x ? x.r.map(r => r.t).filter(Boolean).join('  ') : '');

// ---------- matching
const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < low) low = cur[j];
    }
    if (low > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// A written word matches a searched one if it contains it, or (for longer words) is one or two letters off,
// since the reader sometimes gets a letter wrong.
function tokMatch(word, q, last) {
  if (!word) return false;
  if (word === q || (last && word.startsWith(q)) || (q.length >= 3 && word.includes(q))) return true;
  if (q.length < 4) return false;
  const max = q.length >= 7 ? 2 : 1;
  if (lev(word, q, max) <= max) return true;
  return last && word.length > q.length && lev(word.slice(0, q.length), q, max) <= max;
}

// Matches on one page: [{ids, text}], ids = the strokes to mark.
export function matchIndex(x, q) {
  const qs = norm(q).split(' ').filter(Boolean);
  if (!x || !qs.length) return [];
  const hits = [];
  for (const r of x.r) {
    if (!r.t) continue;
    const words = r.w ? r.w.map(w => ({ ids: w.ids, n: norm(w.t) })) : norm(r.t).split(' ').map(n => ({ ids: r.ids, n }));
    // Words the reader joined ("ofthe") or split are flattened so each piece can be compared.
    for (let i = 0; i + qs.length <= words.length; i++) {
      let ok = true;
      for (let j = 0; j < qs.length && ok; j++) ok = tokMatch(words[i + j].n, qs[j], j === qs.length - 1);
      if (!ok) continue;
      const ids = [...new Set(words.slice(i, i + qs.length).flatMap(w => w.ids))];
      hits.push({ ids, text: r.t });
      i += qs.length - 1;
    }
    if (qs.length > 1 && !hits.some(hh => hh.text === r.t) && norm(r.t).replace(/ /g, '').includes(qs.join(''))) hits.push({ ids: r.ids, text: r.t });
  }
  return hits;
}

// Matches on a page from what is already known in memory (the pages panel filters as you type).
export const matchSync = (pg, q) => matchIndex(mem.get(pg.id), q);

export async function matchPage(pg, q) {
  const x = await pageIndex(pg.id);
  return x && x.pm !== (pg.modified || 0) ? matchIndex(x, q).filter(hh => hh.ids.every(id => pg.items.some(it => it.id === id))) : matchIndex(x, q);
}

// ---------- reading pages in the background
const queue = new Map(); // pageId -> priority (lower first)
let running = false;

export function queuePages(ids, pri = 5) {
  if (!hwOn()) return;
  for (const id of ids) if (!queue.has(id) || queue.get(id) > pri) queue.set(id, pri);
  status.left = queue.size;
  run();
}

async function run() {
  if (running) return;
  running = true;
  try {
    while (queue.size && hwOn()) {
      if (document.visibilityState === 'hidden') { await new Promise(r => setTimeout(r, 3000)); continue; }
      let id = null, p = Infinity;
      for (const [k, v] of queue) if (v < p) { p = v; id = k; }
      queue.delete(id);
      status.left = queue.size;
      const pg = await db.get('pages', id);
      if (!pg || pg.deleted || pg.trashed || !pg.items) continue;
      try {
        if (!pg.items.some(isInk)) {
          const x = { v: VER, pm: pg.modified || 0, r: [] };
          if (!upToDate(await pageIndex(id), pg)) { await db.setMeta(keyOf(id), x); mem.set(id, x); }
          continue;
        }
        status.state = 'working';
        bus.emit('hw-status', status);
        if (await indexPage(pg)) { status.done++; bus.emit('hw-page', { id, docId: pg.docId }); }
        status.err = '';
      } catch (e) {
        if (e.message === 'stopped') break;
        status.err = e.message;
        console.warn('Handwriting search:', e);
        await new Promise(r => setTimeout(r, 5000));
      }
      await new Promise(r => setTimeout(r, 30)); // give the page a breath between pages
    }
  } finally {
    running = false;
    status.state = hwOn() ? 'idle' : 'off';
    status.left = queue.size;
    bus.emit('hw-status', status);
  }
}

// Every page of every notebook, oldest index work last; started a little after Inkleaf opens.
export async function indexAll() {
  if (!hwOn()) return;
  const [docs, pages] = await Promise.all([db.all('docs'), db.all('pages')]);
  const live = new Set(docs.filter(d => !d.deleted && !d.trashed).map(d => d.id));
  const todo = [];
  for (const pg of pages) {
    if (pg.deleted || pg.trashed || !live.has(pg.docId)) continue;
    const x = await pageIndex(pg.id);
    if (!upToDate(x, pg)) todo.push(pg.id);
  }
  queuePages(todo, 9);
}

// Saved pages are read again a little after the writing stops.
let changed = new Set(), changeT = 0;
bus.on('db-write', e => {
  if (!e || e.s !== 'pages' || !hwOn()) return;
  for (const id of e.ids || []) changed.add(id);
  clearTimeout(changeT);
  changeT = setTimeout(() => { const ids = [...changed]; changed = new Set(); queuePages(ids, 3); }, 4000);
});
// Pages written on another device arrive through sync.
bus.on('remote-record', e => { if (e && e.kind === 'p' && e.rec && hwOn()) queuePages([e.rec.id], 6); });

if (hwOn()) setTimeout(() => indexAll().catch(() => {}), 8000);

// Used by tests and by the Settings row.
export const _read = read;
export const _picture = picture;
