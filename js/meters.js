// This device's own meters (owner, 2026-11-28: "data meter, speed meter, ram usage ... progress bar"):
// - data: what Inkleaf itself sent and received (sync, Google Drive, AI), per day and month, kept on this device.
//   A web app cannot read the device's total data use, so only Inkleaf's own traffic is counted.
// - speed: measured on Inkleaf's real transfers of 128 KB or more (no speed test: that would use data for nothing).
// - memory: the drawn pages (every canvas, width x height x 4 bytes: what makes an iPad blank out writing or crash),
//   plus Chrome's own JavaScript figure where Chrome gives one (PC and Android; Chrome on iPad gives none).
// - Google Drive: what is being sent (or fetched) right now, how far, how fast.
// Never a guess: a figure the device does not give is shown as "not known".
import { bus } from './util.js';

const KEY = 'inkleaf.net', BADGE_KEY = 'inkleaf.meterBadge';
const dayNow = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ------------------------------------------------------------------ data
// Counts wait here and are added to the stored ones every few seconds, so two Inkleaf tabs never undo each other's.
const pending = { up: 0, down: 0 };
const session = { up: 0, down: 0, since: Date.now() };
let saveT = 0;
function stored() {
  let n = {};
  try { n = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* broken: start again */ }
  const d = dayNow(), m = d.slice(0, 7);
  if (n.day !== d) Object.assign(n, { day: d, up: 0, down: 0 });
  if (n.month !== m) Object.assign(n, { month: m, mUp: 0, mDown: 0 });
  for (const k of ['up', 'down', 'mUp', 'mDown']) n[k] = Number(n[k]) || 0;
  return n;
}
function save() {
  clearTimeout(saveT); saveT = 0;
  if (!pending.up && !pending.down) return;
  const n = stored();
  n.up += pending.up; n.mUp += pending.up; n.down += pending.down; n.mDown += pending.down;
  pending.up = pending.down = 0;
  try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* storage full: the counts of this moment are lost */ }
}
addEventListener('pagehide', save);
export function countData(dir, bytes) {
  if (!(bytes > 0)) return;
  pending[dir] += bytes; session[dir] += bytes;
  if (!saveT) saveT = setTimeout(save, 3000);
  changed();
}
export function dataNow() {
  const n = stored();
  return {
    today: { up: n.up + pending.up, down: n.down + pending.down },
    month: { up: n.mUp + pending.up, down: n.mDown + pending.down },
    session: { up: session.up, down: session.down, since: session.since }
  };
}
export function resetData() {
  pending.up = pending.down = 0; session.up = session.down = 0; session.since = Date.now();
  try { localStorage.removeItem(KEY); } catch { /* nothing kept */ }
  changed();
}

// ------------------------------------------------------------------ speed
const SPEED_MIN = 128 * 1024; // smaller transfers are mostly waiting, not moving data
const speed = { up: null, down: null }; // { bps, at, bytes }
export function noteSpeed(dir, bytes, ms) {
  if (bytes < SPEED_MIN || !(ms > 20)) return;
  speed[dir] = { bps: bytes * 8 / (ms / 1000), at: Date.now(), bytes };
  changed();
}
export function speedNow() {
  const c = navigator.connection; // Chrome on PC and Android only
  return { up: speed.up, down: speed.down, guess: c && c.downlink ? c.downlink * 1e6 : null };
}

// How many bytes a request body holds (null when it cannot be told).
function bodySize(b) {
  if (b == null) return 0;
  if (typeof b === 'string') return b.length < 4096 ? new TextEncoder().encode(b).length : new Blob([b]).size;
  if (b instanceof Blob) return b.size;
  if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return b.byteLength;
  if (b instanceof URLSearchParams) return b.toString().length;
  return null;
}

// fetch with counting: what went up when the answer came, what came down as it is read. A transfer that broke off
// is not counted (how much of it went is not known).
export async function countedFetch(doFetch, url, opts = {}) {
  const up = bodySize(opts && opts.body), t0 = performance.now();
  const r = await doFetch(url, opts);
  if (up) { countData('up', up); noteSpeed('up', up, performance.now() - t0); }
  return countBody(r, t0);
}
const NO_BODY = new Set([101, 103, 204, 205, 304]);
function countBody(r, t0, onBytes) {
  try {
    if (!(r instanceof Response) || !r.body || NO_BODY.has(r.status) || r.status < 200 || r.status > 599) return r;
    let n = 0;
    const ts = new TransformStream({
      transform(ch, c) { n += ch.byteLength; countData('down', ch.byteLength); if (onBytes) onBytes(n); c.enqueue(ch); },
      flush() { noteSpeed('down', n, performance.now() - t0); }
    });
    return new Response(r.body.pipeThrough(ts), { status: r.status, statusText: r.statusText, headers: r.headers });
  } catch { return r; } // never let the meter break a transfer
}

// The live connection: count its messages too (fake sockets in the check may lack parts; then nothing is counted).
const msgSize = d => typeof d === 'string' ? d.length : d && (d.byteLength ?? d.size) || 0;
export function countSocket(s) {
  try {
    if (s && typeof s.send === 'function') { const send = s.send.bind(s); s.send = d => { countData('up', msgSize(d)); return send(d); }; }
    if (s && s.addEventListener) s.addEventListener('message', e => countData('down', msgSize(e.data)));
  } catch { /* not counted */ }
  return s;
}

// ------------------------------------------------------------------ memory
export function memoryNow() {
  let pages = 0, canvases = 0;
  for (const c of document.querySelectorAll('canvas')) { const b = c.width * c.height * 4; if (b > 0) { pages += b; canvases++; } }
  const pm = performance.memory; // Chrome on PC and Android only, rounded by Chrome
  return { pages, canvases, js: pm && pm.usedJSHeapSize || null, jsLimit: pm && pm.jsHeapSizeLimit || null, device: navigator.deviceMemory || null };
}

// ------------------------------------------------------------------ Google Drive transfers
const moving = new Set();
// kind: 'annotated' (an annotated PDF), 'file' (a library file), 'backup'; dir: 'up' or 'down'.
export function driveTrack(name, size, kind = 'file', dir = 'up') {
  const t = {
    name, size: size || 0, done: 0, kind, dir, t0: performance.now(), at: 0, whole: false,
    step(n) { t.done = t.size ? Math.min(t.size, n) : n; t.at = performance.now(); changed(); },
    end() { moving.delete(t); changed(); }
  };
  moving.add(t); changed();
  return t;
}
// whole: sent in one request, so there is nothing to show until it is done.
export const driveNow = () => [...moving].map(t => ({
  name: t.name, size: t.size, done: t.done, kind: t.kind, dir: t.dir, whole: t.whole,
  pct: t.size ? t.done / t.size * 100 : null,
  bps: t.done && t.at > t.t0 ? t.done * 8 / ((t.at - t.t0) / 1000) : null
}));
// A Drive download with progress (its size from Content-Length, when Drive gives it).
export function trackDownload(r, name) {
  const size = Number(r.headers && r.headers.get('content-length')) || 0;
  if (!(r instanceof Response) || !r.body) return r;
  const t = driveTrack(name, size, 'file', 'down');
  let n = 0;
  const ts = new TransformStream({ transform(ch, c) { n += ch.byteLength; t.step(n); c.enqueue(ch); }, flush() { t.end(); } });
  try { return new Response(r.body.pipeThrough(ts), { status: r.status, statusText: r.statusText, headers: r.headers }); } catch { t.end(); return r; }
}

// ------------------------------------------------------------------ words for the figures
export function fmtBytes(n) {
  if (n == null) return 'not known';
  if (n < 1024) return Math.round(n) + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
}
export const fmtSpeed = bps => bps == null ? 'not known' : bps >= 1e6 ? (bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1) + ' Mbps' : Math.max(1, Math.round(bps / 1e3)) + ' kbps';
export const fmtAgo = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
export function fmtLeft(bytesLeft, bps) {
  if (!bps || !(bytesLeft > 0)) return '';
  const s = bytesLeft * 8 / bps;
  return s < 60 ? 'under a minute left' : s < 3600 ? `about ${Math.round(s / 60)} min left` : `about ${(s / 3600).toFixed(1)} h left`;
}

// ------------------------------------------------------------------ change notices and the small on-screen meter
let emitT = 0;
function changed() { if (!emitT) emitT = setTimeout(() => { emitT = 0; bus.emit('meters'); }, 250); }

export const badgeOn = () => localStorage.getItem(BADGE_KEY) === 'on';
export function setBadgeOn(v) { localStorage.setItem(BADGE_KEY, v ? 'on' : 'off'); drawBadge(); }
// A small line in the bottom-right corner (bottom-left would hide the library's sidebar buttons), above everything, that touches nothing: taps and the pen go straight through it.
let badge = null, badgeT = 0;
export function badgeText() {
  const d = dataNow().today, s = speedNow(), m = memoryNow(), dr = driveNow();
  const parts = [`Data today ↑${fmtBytes(d.up)} ↓${fmtBytes(d.down)}`];
  const fresh = x => x && Date.now() - x.at < 60e3;
  if (fresh(s.up) || fresh(s.down)) parts.push([fresh(s.up) ? '↑' + fmtSpeed(s.up.bps) : '', fresh(s.down) ? '↓' + fmtSpeed(s.down.bps) : ''].filter(Boolean).join(' '));
  parts.push('Pages ' + fmtBytes(m.pages) + (m.js ? ' · JS ' + fmtBytes(m.js) : ''));
  for (const t of dr) parts.push(`Drive ${t.dir === 'up' ? '↑' : '↓'} ${t.pct == null || t.whole ? '…' : Math.floor(t.pct) + '%'}`);
  return parts.join(' · ');
}
function drawBadge() {
  clearInterval(badgeT); badgeT = 0;
  if (!badgeOn()) { if (badge) { badge.remove(); badge = null; } return; }
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'meter-badge';
    badge.setAttribute('aria-hidden', 'true');
    document.body.append(badge);
  }
  const draw = () => { if (document.visibilityState === 'visible' && badge) badge.textContent = badgeText(); };
  draw();
  badgeT = setInterval(draw, 2000);
}
if (document.body) drawBadge(); else addEventListener('DOMContentLoaded', drawBadge);
