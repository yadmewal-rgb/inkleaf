// Handwriting search. Pen strokes are grouped into lines and words, each short run of words is drawn as a picture
// and read by an offline handwriting model (js/hw-worker.js), and the text is kept on this device per page
// (meta "hw:<pageId>"). Searches then match typed words against it and point back at the strokes that were read.
// Off until switched on in Settings, because the model is a one-time download of about 90 MB.
import { db } from './db.js';
import { bus } from './util.js';

const VER = 2;
const KEY = 'inkleaf.hw';
const USAGE_KEY = 'inkleaf.hwUsage';
const DEFAULT_LIMIT = 1500;

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getHwUsage() {
  const tk = todayKey();
  let u = null;
  try { u = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}'); } catch {}
  const limit = Number(localStorage.getItem('inkleaf.hwLimit')) || DEFAULT_LIMIT;
  if (!u || u.date !== tk) {
    u = { date: tk, calls: 0, pages: 0, limit };
    try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch {}
  } else {
    u.limit = limit;
  }
  return u;
}

export function canMakeHwCall() {
  const u = getHwUsage();
  return (u.calls || 0) < (u.limit || DEFAULT_LIMIT);
}

export function recordHwCall(pages = 1) {
  const u = getHwUsage();
  u.calls = (u.calls || 0) + 1;
  u.pages = (u.pages || 0) + pages;
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch {}
  bus.emit('hw-usage', u);
  return u;
}

export function setHwLimit(n) {
  const lim = Math.max(1, Math.min(10000, Number(n) || DEFAULT_LIMIT));
  try { localStorage.setItem('inkleaf.hwLimit', String(lim)); } catch {}
  const u = getHwUsage();
  u.limit = lim;
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch {}
  bus.emit('hw-usage', u);
}

// Tiered model cascade in order of reasoning capability & efficiency:
// Tier 1: 3.8 Flash, 3.8 Flash Lite
// Tier 2: 3.7 Flash, 3.7 Flash Lite
// Tier 3: 3.6 Flash, 3.6 Flash Lite
// Tier 4: 3.5 Flash, 3.5 Flash Lite, 3.1 Flash Lite, 2.5 Flash
export const MODEL_CASCADE = [
  'gemini-3.8-flash',
  'gemini-3.8-flash-lite',
  'gemini-3.7-flash',
  'gemini-3.7-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.6-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash'
];

export const DEFAULT_MODEL = 'auto';
const IDLE_MS = 45e3; // the worker (and the memory the model takes) is let go after this long without work

// In-memory active model for this session: resets to top available model (gemini-3.8-flash) on every fresh load!
let sessionActiveModel = null;

export function getHwModelConfig() {
  return localStorage.getItem('inkleaf.geminiModel') || 'auto';
}

export function getActiveHwModel() {
  const cfg = getHwModelConfig();
  if (cfg !== 'auto' && MODEL_CASCADE.includes(cfg)) {
    return sessionActiveModel || cfg;
  }
  if (!sessionActiveModel) {
    sessionActiveModel = MODEL_CASCADE[0];
  }
  return sessionActiveModel;
}

export function resetSessionActiveModel() {
  const cfg = getHwModelConfig();
  if (cfg !== 'auto' && MODEL_CASCADE.includes(cfg)) {
    sessionActiveModel = cfg;
  } else {
    sessionActiveModel = MODEL_CASCADE[0];
  }
  bus.emit('hw-model-changed', { model: getActiveHwModel(), pref: cfg });
}

export function stepDownModel(failedModel) {
  const cur = sessionActiveModel || failedModel || MODEL_CASCADE[0];
  const idx = MODEL_CASCADE.indexOf(cur);
  if (idx >= 0 && idx < MODEL_CASCADE.length - 1) {
    const nextModel = MODEL_CASCADE[idx + 1];
    sessionActiveModel = nextModel;
    console.warn(`[AI Waterfall] Model ${cur} unavailable or limit hit -> stepping down to ${nextModel}`);
    bus.emit('hw-model-changed', { model: sessionActiveModel, fallbackFrom: cur, pref: getHwModelConfig() });
    return nextModel;
  }
  return null;
}

export function getHwModel() {
  return getActiveHwModel();
}

export function setHwModel(m) {
  if (!m || m === 'auto') {
    localStorage.removeItem('inkleaf.geminiModel');
    sessionActiveModel = MODEL_CASCADE[0];
  } else {
    localStorage.setItem('inkleaf.geminiModel', m.trim());
    sessionActiveModel = m.trim();
  }
  bus.emit('hw-model-changed', { model: getActiveHwModel(), pref: getHwModelConfig() });
}

export function formatModelName(m) {
  const model = m || getActiveHwModel();
  const map = {
    'gemini-3.8-flash': 'Gemini 3.8 Flash',
    'gemini-3.8-flash-lite': 'Gemini 3.8 Flash Lite',
    'gemini-3.7-flash': 'Gemini 3.7 Flash',
    'gemini-3.7-flash-lite': 'Gemini 3.7 Flash Lite',
    'gemini-3.6-flash': 'Gemini 3.6 Flash',
    'gemini-3.6-flash-lite': 'Gemini 3.6 Flash Lite',
    'gemini-3.5-flash': 'Gemini 3.5 Flash',
    'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
    'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
    'gemini-2.5-flash': 'Gemini 2.5 Flash'
  };
  return map[model] || model;
}

export const hwOn = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
export function setHwOn(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode */ }
  if (on) { status.state = 'idle'; failCount = 0; indexAll(); } else { queue.clear(); status.state = 'off'; }
  bus.emit('hw-status', status);
}

export const status = { state: hwOn() ? 'idle' : 'off', done: 0, left: 0, err: '' };

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

export function batchedPicture(runs) {
  if (!runs.length) return null;
  const rows = runs.map((r, i) => {
    let k = Math.min(44 / r.lh, 5), pad = 0.4 * r.lh;
    const rawW = r.b.x1 - r.b.x0 + 2 * pad;
    const rawH = r.b.y1 - r.b.y0 + 2 * pad;
    if (rawW * k > 1500) k = 1500 / rawW;
    if (rawH * k > 120) k = 120 / rawH;
    const rw = Math.max(8, Math.ceil(rawW * k));
    const rh = Math.max(40, Math.min(120, Math.ceil(rawH * k)));
    return { r, i: i + 1, k, pad, rw, rh };
  });

  const labelW = 55;
  const totalW = Math.max(400, Math.min(1600, labelW + Math.max(...rows.map(row => row.rw))));
  const totalH = rows.reduce((acc, row) => acc + row.rh, 0);

  const cv = document.createElement('canvas');
  cv.width = totalW; cv.height = totalH;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, totalW, totalH);

  let curY = 0;
  for (const row of rows) {
    // Red row number label
    g.fillStyle = '#d32f2f';
    g.font = 'bold 22px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(row.i), labelW / 2, curY + row.rh / 2);

    // Separator line
    g.strokeStyle = '#e0e0e0';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, curY + row.rh);
    g.lineTo(totalW, curY + row.rh);
    g.stroke();

    // Draw handwriting strokes
    g.strokeStyle = '#000000';
    g.fillStyle = '#000000';
    g.lineCap = g.lineJoin = 'round';
    const ox = row.r.b.x0 - row.pad, oy = row.r.b.y0 - row.pad;
    for (const { it } of row.r.s) {
      const p = it.p;
      g.lineWidth = Math.max(2, Math.min(it.w || 1.5, row.r.lh / 5) * row.k);
      g.beginPath();
      const sx0 = labelW + (p[0] - ox) * row.k;
      const sy0 = curY + (p[1] - oy) * row.k;
      g.moveTo(sx0, sy0);
      if (p.length === 3) g.lineTo(sx0 + 0.1, sy0);
      for (let j = 3; j < p.length; j += 3) {
        g.lineTo(labelW + (p[j] - ox) * row.k, curY + (p[j + 1] - oy) * row.k);
      }
      g.stroke();
    }
    curY += row.rh;
  }

  const dataUrl = cv.toDataURL('image/jpeg', 0.85);
  cv.width = cv.height = 0;
  return dataUrl.split(',')[1] || '';
}

async function callDirectGemini(b64, N, prompt, model, directKey) {
  return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${directKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: b64 } }
        ]
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: N > 1 ? 'application/json' : 'text/plain'
      }
    })
  });
}

async function readBatch(runs) {
  if (!runs.length) return [];
  if (!canMakeHwCall()) {
    throw new Error('Daily AI request limit reached. Indexing paused.');
  }

  const b64 = batchedPicture(runs);
  if (!b64) return runs.map(() => '');

  const N = runs.length;
  const prompt = `This image has ${N} numbered rows of handwriting (red number at the left of each row). Transcribe each row exactly as written. Reply with a JSON array of ${N} strings, one per row, in order. Use "" for a row with only ticks, crosses, lines or marks.`;
  const directKey = localStorage.getItem('inkleaf.geminiKey');

  let resultStrings = null;

  if (typeof navigator !== 'undefined' && navigator.onLine) {
    // ---------------------------------------------------------------------------------
    // Provider 1: Direct Gemini API (if user configured their own key in Settings)
    // ---------------------------------------------------------------------------------
    if (directKey) {
      let currentModel = getActiveHwModel();
      while (currentModel) {
        try {
          const res = await callDirectGemini(b64, N, prompt, currentModel, directKey);
          if (res.ok) {
            const j = await res.json();
            const raw = (j?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
            if (raw) {
              try {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr) && arr.length === N) {
                  resultStrings = arr.map(s => String(s || '').trim());
                  break; // Successful transcription with current model!
                }
              } catch {}
            }
          }

          // If direct call was not successful:
          if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            console.warn(`[Direct Gemini] Model ${currentModel} returned HTTP ${res.status}: ${errBody.slice(0, 100)}`);
            // Model not found (404), rate limit/quota (429), or temporary overload (503) -> step down to next model
            if (res.status === 404 || res.status === 429 || res.status === 503) {
              currentModel = stepDownModel(currentModel);
              continue;
            } else {
              // Bad API key (400, 401, 403) -> break direct loop and shift to Provider 2 (Cloudflare)
              console.warn('[Direct Gemini] Key error or permission issue. Shifting to Cloudflare.');
              break;
            }
          }
        } catch (netErr) {
          console.warn(`[Direct Gemini] Network error for model ${currentModel}:`, netErr);
          break; // network issue -> fall through to Cloudflare
        }
        currentModel = stepDownModel(currentModel);
      }
    }

    // ---------------------------------------------------------------------------------
    // Provider 2: Cloudflare Worker OCR (if direct Gemini not configured or failed)
    // ---------------------------------------------------------------------------------
    if (!resultStrings && cloudOcrFn) {
      let currentModel = getActiveHwModel();
      while (currentModel) {
        try {
          const raw = await cloudOcrFn(b64, N, currentModel);
          if (Array.isArray(raw) && raw.length === N) {
            resultStrings = raw.map(s => String(s || '').trim());
            break; // Successful transcription via Cloudflare!
          } else if (raw && raw.error) {
            console.warn(`[Cloudflare OCR] Model ${currentModel} returned error:`, raw.error);
            currentModel = stepDownModel(currentModel);
          } else {
            // Null or empty response
            currentModel = stepDownModel(currentModel);
          }
        } catch (cfErr) {
          console.warn(`[Cloudflare OCR] Exception for model ${currentModel}:`, cfErr);
          break;
        }
      }
    }
  }

  // If successful with either Gemini direct or Cloudflare worker
  if (resultStrings) {
    recordHwCall(1);
    return resultStrings;
  }

  // ---------------------------------------------------------------------------------
  // Provider 3: On-Device Fallback (Offline or Cloud limits exhausted)
  // ---------------------------------------------------------------------------------
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('Offline. Indexing will resume when online.');
  }

  throw new Error('AI transcription returned invalid format or failed');
}

async function read(img) {
  if (!img) return '';
  if (typeof navigator !== 'undefined' && navigator.onLine && canMakeHwCall()) {
    try {
      const b64 = imgToBase64(img);
      if (b64) {
        const directKey = localStorage.getItem('inkleaf.geminiKey');
        const prompt = 'Transcribe all handwritten words and notes in this image. Return ONLY the transcribed text. Do not add quotes, markdown, or commentary.';

        // Try direct Gemini with active model waterfall
        if (directKey) {
          let currentModel = getActiveHwModel();
          while (currentModel) {
            try {
              const res = await callDirectGemini(b64, 1, prompt, currentModel, directKey);
              if (res.ok) {
                const j = await res.json();
                const txt = (j?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
                if (txt) {
                  recordHwCall(0);
                  return txt;
                }
              }
              if (res.status === 404 || res.status === 429 || res.status === 503) {
                currentModel = stepDownModel(currentModel);
                continue;
              }
              break;
            } catch {
              break;
            }
          }
        }

        // Try Cloudflare worker with active model waterfall
        if (cloudOcrFn) {
          let currentModel = getActiveHwModel();
          while (currentModel) {
            try {
              const txt = await cloudOcrFn(b64, 1, currentModel);
              if (txt && typeof txt === 'string' && txt.trim()) {
                recordHwCall(0);
                return txt.trim();
              }
              if (Array.isArray(txt) && txt.length > 0 && String(txt[0] || '').trim()) {
                recordHwCall(0);
                return String(txt[0]).trim();
              }
              currentModel = stepDownModel(currentModel);
            } catch {
              break;
            }
          }
        }
      }
    } catch (e) {
      console.warn('Cloud handwriting OCR error:', e);
    }
  }
  return '';
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

const partialMem = new Map(); // pageId -> Map of signature -> run data (keeps partial work if a subsequent chunk fails)

export async function pageIndex(pageId) {
  if (mem.has(pageId)) return mem.get(pageId);
  // 1. Check if the page record itself has synced handwriting index from cloud:
  try {
    const pg = await db.get('pages', pageId);
    if (pg && pg.hw && pg.hw.v === VER && pg.hw.pm === (pg.modified || 0)) {
      mem.set(pageId, pg.hw);
      return pg.hw;
    }
  } catch {}
  // 2. Check local meta
  const x = await db.getMeta(keyOf(pageId));
  const v = x && x.v === VER ? x : null;
  mem.set(pageId, v);
  return v;
}

const upToDate = (x, pg) => x && x.v === VER && x.pm === (pg.modified || 0);

async function saveHw(pg, x) {
  // Save in local meta & memory
  await db.setMeta(keyOf(pg.id), x);
  mem.set(pg.id, x);

  // Sync to other devices (iPad/phone) by attaching to the page record WITHOUT changing modified time:
  try {
    const fresh = await db.get('pages', pg.id);
    if (fresh && !fresh.deleted && !fresh.trashed) {
      fresh.hw = x;
      await db.put('pages', fresh);
    }
  } catch (e) {
    console.warn('Could not sync hw index on page record:', e);
  }
}

async function indexPage(pg) {
  const old = await pageIndex(pg.id);
  if (upToDate(old, pg)) return false;

  const known = new Map((old ? old.r : []).map(r => [r.k, r]));
  const partial = partialMem.get(pg.id);
  if (partial) {
    for (const [k, r] of partial) known.set(k, r);
  }

  const runs = segment(pg);
  if (!runs.length) {
    const x = { v: VER, pm: pg.modified || 0, r: [] };
    await saveHw(pg, x);
    return true;
  }

  // Find runs that are not yet in known
  const needed = [];
  for (const run of runs) {
    const k = sig(run.ids);
    if (!known.has(k)) needed.push({ k, run });
  }

  if (needed.length > 0) {
    // Batch in chunks of up to 35 runs if page is huge
    const CHUNK = 35;
    for (let i = 0; i < needed.length; i += CHUNK) {
      const chunk = needed.slice(i, i + CHUNK);
      const texts = await readBatch(chunk.map(c => c.run));
      for (let j = 0; j < chunk.length; j++) {
        const text = (texts[j] || '').replace(/\s+/g, ' ').trim();
        const toks = text ? text.split(' ') : [];
        const run = chunk[j].run;
        const r = {
          k: chunk[j].k,
          t: text,
          w: toks.length === run.words.length ? run.words.map((ids, idx) => ({ ids, t: toks[idx] })) : null,
          ids: run.ids
        };
        known.set(chunk[j].k, r);
      }
      // Keep partial work in memory so subsequent chunk failure won't re-transcribe this chunk
      partialMem.set(pg.id, known);
    }
  }

  partialMem.delete(pg.id);
  const out = runs.map(run => known.get(sig(run.ids))).filter(Boolean);
  const x = { v: VER, pm: pg.modified || 0, r: out };
  await saveHw(pg, x);
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
let failCount = 0;

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    failCount = 0;
    status.err = '';
    console.log('[AI Search] Online connection restored. Resetting model waterfall to top tier and indexing pending pages...');
    resetSessionActiveModel();
    if (hwOn()) {
      indexAll();
    }
  });
}

export function queuePages(ids, pri = 5) {
  if (!hwOn()) return;
  for (const id of ids) if (!queue.has(id) || queue.get(id) > pri) queue.set(id, pri);
  status.left = queue.size;
  run();
}

export function retryHw() {
  failCount = 0;
  status.err = '';
  run();
}

async function run() {
  if (running) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    status.state = 'idle';
    status.err = 'Offline. Indexing will resume when online.';
    bus.emit('hw-status', status);
    return;
  }
  running = true;
  try {
    while (queue.size && hwOn()) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        status.err = 'Offline. Indexing will resume when online.';
        break;
      }
      if (document.visibilityState === 'hidden') { await new Promise(r => setTimeout(r, 3000)); continue; }
      if (!canMakeHwCall()) {
        status.err = 'Daily AI request limit reached. Will resume tomorrow.';
        status.state = 'idle';
        bus.emit('hw-status', status);
        break;
      }
      let id = null, p = Infinity;
      for (const [k, v] of queue) if (v < p) { p = v; id = k; }
      queue.delete(id);
      status.left = queue.size;
      const pg = await db.get('pages', id);
      if (!pg || pg.deleted || pg.trashed || !pg.items) continue;
      try {
        if (!pg.items.some(isInk)) {
          const x = { v: VER, pm: pg.modified || 0, r: [] };
          if (!upToDate(await pageIndex(id), pg)) await saveHw(pg, x);
          continue;
        }
        status.state = 'working';
        bus.emit('hw-status', status);
        if (await indexPage(pg)) {
          status.done++;
          bus.emit('hw-page', { id, docId: pg.docId });
        }
        status.err = '';
        failCount = 0; // Success resets back-off
      } catch (e) {
        if (e.message === 'stopped') break;
        failCount++;
        status.err = e.message;
        console.warn('Handwriting search:', e);
        if (e.message.includes('limit reached')) break;
        queue.set(id, 9); // retry later

        // Exponential back-off: 5s, 30s. Pause after 3 failures to protect quota.
        if (failCount >= 3) {
          status.err = `Paused after 3 errors (${e.message}). Will retry when connection or notes change.`;
          break;
        }
        const delay = failCount === 1 ? 5000 : 30000;
        await new Promise(r => setTimeout(r, delay));
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
