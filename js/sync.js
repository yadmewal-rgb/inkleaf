// Live sync through Inkleaf's own Cloudflare service (server/worker.js), plus backup files.
//
// How it works
// - Everything is saved on the device first (IndexedDB). Sync only ever runs in the background.
// - Each record (folder, notebook, page, attached file) is stored on the service as its own versioned blob,
//   so only what changed is transferred. Every change on the service gets the next sequence number.
// - Pushing: a moment after something is saved here, the changed records are uploaded. Each upload says which
//   version it builds on; if another device got there first, its version is fetched, merged and sent again.
// - Pulling: the service tells every open device about a change over a live connection (WebSocket), and the
//   device asks for what changed. A page edited on two devices is merged stroke by stroke, so nothing is lost.
// - Sign-in: Google, once per device. The service then gives this device its own key, which does not expire.
import { db, assetIdsOf } from './db.js';
import { h, uid, bus, loadScript, downloadBlob, bufToB64, b64ToBuf } from './util.js';
import { modal, toast, confirmBox, busy } from './ui.js';
import { I } from './icons.js';

const SERVER = 'https://inkleaf-sync.yadmewal.workers.dev';
const SCOPE = 'openid email';
const STORES = { a: 'assets', f: 'folders', d: 'docs', p: 'pages' };
const PART = 1_400_000; // pieces of large files (the service keeps at most 1.5 MB per piece)
const PUSH_MS = 250;    // delay between a local save and its upload
const POLL_LIVE = 60000, POLL_NOLIVE = 6000, POLL_IDLE = 30000; // checks besides the live connection

let http = (url, opts) => fetch(url, opts);
export const _setHttp = fn => { http = fn; };           // tests swap in a fake service
let makeSocket = url => new WebSocket(url);
export const _setSocket = fn => { makeSocket = fn; };

// Built-in Google OAuth client, so devices do not need one pasted in. A client ID is public by design.
const CLIENT_ID = '473809010149-3hhf0nu5aisisgvu3gnaee49lfgdlga2.apps.googleusercontent.com';

let server = SERVER;
let session = null;   // {token, email}
let off = false;      // sync turned off on this device
let st = {};          // "k_id" -> {lm: local "modified" when last in step, s: the service's version}
let cursor = 0;       // the newest change seen
const openDocs = new Set(); // notebooks open in the editor (two when side by side)
let pushT = 0, loopT = 0, stateT = 0, pullT = 0;
let chain = Promise.resolve();
let status = { state: 'off', text: 'Sync is not set up' };

export const syncStatus = () => status;
function setStatus(state, text) {
  if (status.state === state && status.text === text) return;
  status = { state, text };
  bus.emit('sync-status', status);
}

// One sync operation at a time.
const exclusive = fn => {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
};

function saveState() {
  clearTimeout(stateT);
  stateT = setTimeout(() => {
    db.setMeta('cloudState', st).catch(() => {});
    db.setMeta('cloudCursor', cursor).catch(() => {});
  }, 300);
}

// ---------------------------------------------------------------- sign-in
// Google is asked once, only to prove who this is; the service answers with this device's own key.
async function googleToken() {
  await loadScript('https://accounts.google.com/gsi/client');
  return new Promise((res, rej) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: r => { if (r.error) rej(new Error(r.error_description || r.error)); else res(r.access_token); },
      error_callback: e => rej(new Error(e && e.type === 'popup_closed' ? 'Sign-in was cancelled.' : 'Google sign-in could not open. Allow pop-ups and try again.'))
    });
    client.requestAccessToken({ prompt: '' });
  });
}

const deviceLabel = () => {
  const u = navigator.userAgent;
  return /iPad|Macintosh.*Mobile|Macintosh(?=.*Safari)(?=.*Version)/.test(u) && navigator.maxTouchPoints > 1 ? 'iPad'
    : /iPhone/.test(u) ? 'iPhone' : /Android/.test(u) ? (/Mobile/.test(u) ? 'Android phone' : 'Android tablet') : /Windows/.test(u) ? 'Windows' : 'Browser';
};

async function signIn() {
  const at = await googleToken();
  const r = await http(server + '/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: at, label: deviceLabel() }) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 403 && j.error === 'not-allowed') throw new Error(`${j.email} is not on Inkleaf's list of allowed accounts. Add it to ALLOWED in Cloudflare.`);
  if (!r.ok || !j.token) throw new Error(j.error === 'google-rejected' ? 'Google did not confirm the sign-in. Try again.' : 'The sync service did not answer (' + r.status + ').');
  session = { token: j.token, email: j.email };
  await db.setMeta('cloud', session);
}

async function signOut() {
  const s = session;
  session = null;
  closeLive();
  await db.setMeta('cloud', null);
  if (s) http(server + '/signout', { method: 'POST', headers: { Authorization: 'Bearer ' + s.token } }).catch(() => {});
}

async function call(path, opts = {}) {
  if (!session) { const e = new Error('Sign-in needed'); e.signin = true; throw e; }
  const r = await http(server + path, { ...opts, headers: { Authorization: 'Bearer ' + session.token, ...(opts.headers || {}) } });
  if (r.status === 401) {
    session = null;
    closeLive();
    db.setMeta('cloud', null).catch(() => {});
    const e = new Error('Sign-in needed');
    e.signin = true;
    throw e;
  }
  if (r.status === 409) { const e = new Error('Changed elsewhere'); e.conflict = (await r.json().catch(() => ({}))).s || 0; throw e; }
  if (!r.ok) {
    const e = new Error(`Sync service error ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
    e.status = r.status;
    throw e;
  }
  return r;
}

// ---------------------------------------------------------------- blobs on the service
const canZip = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }

// Records go as JSON, compressed where the browser can (writing compresses about four times).
async function encode(rec) {
  const raw = new TextEncoder().encode(JSON.stringify(rec));
  return canZip ? { bytes: await pipe(raw, new CompressionStream('gzip')), gz: true } : { bytes: raw, gz: false };
}
async function decode(bytes, gz) {
  return JSON.parse(new TextDecoder().decode(gz ? await pipe(bytes, new DecompressionStream('gzip')) : bytes));
}

// Store bytes as kind k, id. o: base (the version this builds on; omitted = store regardless), info, gz.
async function putBlob(k, id, bytes, o = {}) {
  const q = new URLSearchParams({ size: String(bytes.byteLength) });
  if (o.base != null) q.set('base', String(o.base));
  if (o.info) q.set('info', o.info);
  if (o.gz) q.set('gz', '1');
  if (bytes.byteLength <= PART) {
    return (await call(`/blob/${k}/${encodeURIComponent(id)}?${q}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })).json();
  }
  const up = uid(), parts = Math.ceil(bytes.byteLength / PART);
  for (let n = 0; n < parts; n++) {
    await call(`/part/${up}/${n}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes.subarray(n * PART, (n + 1) * PART) });
  }
  return (await call(`/commit/${k}/${encodeURIComponent(id)}?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ up, parts }) })).json();
}

// item: a feed entry {k, id, s, parts, gz}.
async function getBlob(item) {
  const bufs = [];
  for (let n = 0; n < (item.parts || 1); n++) bufs.push(new Uint8Array(await (await call(`/blob/${item.k}/${encodeURIComponent(item.id)}/${n}`)).arrayBuffer()));
  if (bufs.length === 1) return bufs[0];
  const out = new Uint8Array(bufs.reduce((t, b) => t + b.length, 0));
  let o = 0;
  for (const b of bufs) { out.set(b, o); o += b.length; }
  return out;
}

const removeBlob = (k, id) => call(`/blob/${k}/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ---------------------------------------------------------------- merging
// Each merge returns one of its inputs untouched when that input already holds the full result,
// so callers can tell "nothing to do" from "needs saving / uploading".
const sameDels = (a, b) => {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
};
const sameItems = (items, other) => {
  if (items.length !== other.length) return false;
  const m = new Map(other.map(i => [i.id, i.m || 0]));
  for (const it of items) if (m.get(it.id) !== (it.m || 0)) return false;
  return true;
};

// The page's background and size (own templates and scans change these).
const looks = X => JSON.stringify([X.bg || null, X.pdf || null, X.tpl || null, X.w, X.h, X.pm || null, X.sec || '']);

export function mergePage(L, R) {
  if (L.deleted || R.deleted) return R.modified >= L.modified ? R : L;
  const base = R.modified >= L.modified ? R : L;
  const dels = { ...(L.dels || {}) };
  for (const k in (R.dels || {})) dels[k] = Math.max(dels[k] || 0, R.dels[k]);
  const map = new Map();
  for (const it of [...(L.items || []), ...(R.items || [])]) {
    const cur = map.get(it.id);
    if (!cur || (it.m || 0) > (cur.m || 0)) map.set(it.id, it);
  }
  const items = [...map.values()]
    .filter(it => !(dels[it.id] >= (it.m || 0)))
    .sort((x, y) => (x.z - y.z) || (x.id < y.id ? -1 : 1));
  const fits = X => sameItems(items, X.items || []) && sameDels(dels, X.dels || {})
    && X.template === base.template && X.paper === base.paper
    && !X.bm === !base.bm && (X.title || '') === (base.title || '') && (X.trashed || 0) === (base.trashed || 0)
    && looks(X) === looks(base);
  if (fits(R)) return R;
  if (fits(L)) return L;
  return { ...base, items, dels, modified: Date.now() };
}

// gone: page ids known to be deleted, which must not be brought back into the page list.
export function mergeDoc(L, R, gone) {
  const [nu, old] = R.modified >= L.modified ? [R, L] : [L, R];
  if (nu.deleted || old.deleted) return nu;
  const have = new Set(nu.pages || []);
  const extra = (old.pages || []).filter(id => !have.has(id) && !(gone && gone.has(id)));
  const cards = mergeCards(nu, old);
  if (!extra.length && !cards) return nu;
  const out = { ...nu, modified: Date.now() };
  if (extra.length) out.pages = [...(nu.pages || []), ...extra];
  if (cards) Object.assign(out, cards);
  return out;
}

// Flashcards are merged one by one, so cards made on two devices at once are all kept: per card the later
// change (m) wins, and cardDels (id -> when deleted) stops a deleted card coming back. null = nu already has it all.
function mergeCards(nu, old) {
  const a = nu.cards || [], b = old.cards || [];
  if (!b.length && !old.cardDels) return null;
  const dels = { ...(old.cardDels || {}), ...(nu.cardDels || {}) };
  for (const k in old.cardDels || {}) if (dels[k] < old.cardDels[k]) dels[k] = old.cardDels[k];
  const by = new Map();
  for (const c of a) by.set(c.id, c); // nu's order first, so an unchanged merge compares equal
  for (const c of b) { const o = by.get(c.id); if (!o || (c.m || 0) > (o.m || 0)) by.set(c.id, c); }
  const cards = [...by.values()].filter(c => !(dels[c.id] >= (c.m || 0)));
  const same = cards.length === a.length && cards.every((c, i) => c === a[i]) && Object.keys(dels).length === Object.keys(nu.cardDels || {}).length;
  return same ? null : { cards, cardDels: dels };
}

async function merge(kind, L, R) {
  if (kind === 'p') return mergePage(L, R);
  if (kind === 'd') {
    const gone = new Set();
    for (const id of new Set([...(L.pages || []), ...(R.pages || [])])) {
      const p = await db.get('pages', id);
      if (p && (p.deleted || p.trashed)) gone.add(id);
    }
    return mergeDoc(L, R, gone);
  }
  return R.modified >= L.modified ? R : L;
}

// ---------------------------------------------------------------- moving single records
// Send a folder / notebook / page. If another device changed it first, theirs is brought in and merged,
// and the merged record is sent instead.
async function pushRecord(kind, rec) {
  const name = kind + '_' + rec.id, store = STORES[kind];
  for (let tries = 0; tries < 4; tries++) {
    const s = st[name];
    try {
      const { bytes, gz } = await encode(rec);
      const j = await putBlob(kind, rec.id, bytes, { base: s ? s.s : 0, gz });
      st[name] = { lm: rec.modified, s: j.s };
      return;
    } catch (e) {
      if (e.conflict === undefined) throw e;
      const item = { k: kind, id: rec.id, s: e.conflict, parts: 0 };
      const meta = (await (await call(`/changes?since=${e.conflict - 1}&limit=1`)).json()).items.find(x => x.k === kind && x.id === rec.id);
      if (!meta) { st[name] = { lm: -1, s: e.conflict }; continue; } // changed again meanwhile: just retry
      Object.assign(item, meta);
      const R = await decode(await getBlob(item), item.gz);
      const L = (await db.get(store, rec.id)) || rec;
      const m = await merge(kind, L, R);
      if (m !== L) {
        if (!await db.putIf(store, m, L.modified)) { st[name] = { lm: -1, s: item.s }; rec = (await db.get(store, rec.id)) || rec; continue; }
        bus.emit('remote-record', { kind, rec: m });
      }
      if (m === R) { st[name] = { lm: R.modified, s: item.s }; return; } // theirs already had everything
      st[name] = { lm: -1, s: item.s };
      rec = m;
    }
  }
  throw new Error('This record keeps changing on another device; it will be sent on the next round.');
}

async function pushAsset(id) {
  const name = 'a_' + id;
  if (st[name]) return;
  const a = await db.get('assets', id);
  if (!a || a.deleted || !a.data) return;
  const j = await putBlob('a', id, new Uint8Array(a.data), { info: JSON.stringify({ mime: a.mime || '', name: a.name || '' }) });
  st[name] = { lm: a.modified, s: j.s };
}

async function pullAsset(id, item) {
  const name = 'a_' + id;
  const have = await db.get('assets', id);
  if (have && (have.data || have.deleted)) { st[name] = { lm: have.modified, s: item.s }; return false; }
  const bytes = await getBlob(item);
  let info = {};
  try { info = JSON.parse(item.info || '{}'); } catch { /* none */ }
  const rec = { id, mime: info.mime || 'application/octet-stream', name: info.name || '', data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), modified: Date.now() };
  await db.put('assets', rec, true);
  st[name] = { lm: rec.modified, s: item.s };
  bus.emit('remote-record', { kind: 'a', rec: { id } });
  return true;
}

// Attached files can be large, so they are moved in the background, two at a time, and never hold up
// the live syncing of pages. A failed transfer is retried after a pause.
const assetQ = [], assetBusy = new Set(), assetRetry = new Map();
let assetActive = 0;
const IDLE_TEXT = 'Live sync is on. Everything is up to date.';
const FILES_TEXT = 'Live sync is on. Still transferring files (PDFs, pictures)...';

function setIdle() {
  if (assetActive || assetQ.length) setStatus('syncing', FILES_TEXT); else setStatus('ok', IDLE_TEXT);
}

// job: 'up' to upload a local file, or the feed entry to download.
function queueAsset(id, job) {
  const r = assetRetry.get(id);
  if (assetBusy.has(id) || (r && r.at > Date.now())) return;
  assetBusy.add(id);
  assetQ.push([id, job]);
  pumpAssets();
}

function pumpAssets() {
  while (assetActive < 2 && assetQ.length) {
    const [id, job] = assetQ.shift();
    assetActive++;
    (job === 'up' ? pushAsset(id) : pullAsset(id, job))
      .then(() => { assetRetry.delete(id); saveState(); })
      .catch(e => {
        assetRetry.set(id, { at: Date.now() + 30000, job });
        if (!e.signin) console.warn('File transfer failed and will be retried', e);
      })
      .finally(() => {
        assetBusy.delete(id);
        assetActive--;
        pumpAssets();
        if (!assetActive && !assetQ.length && status.state === 'syncing') setIdle();
      });
  }
  if (assetActive && status.state === 'ok') setIdle();
}

function retryAssets() {
  for (const [id, r] of assetRetry) if (r.at <= Date.now()) { assetRetry.delete(id); queueAsset(id, r.job); }
}

// Bring one folder / notebook / page in from the service, merging with whatever is here.
async function applyRemote(item) {
  const kind = item.k, name = kind + '_' + item.id, store = STORES[kind], s = st[name];
  if (s && s.s === item.s) return false; // already in step with this version
  let R = null;
  try { R = await decode(await getBlob(item), item.gz); } catch (e) { if (e.signin || e.status || e.name === 'TypeError') throw e; }
  if (!R || R.id !== item.id) { st[name] = { lm: -1, s: item.s }; console.warn('Skipped an unreadable record', name); return false; }
  const L = await db.get(store, item.id);
  const m = L ? await merge(kind, L, R) : R;
  if (m === L) { // ours already contains everything theirs has
    st[name] = { lm: L.modified === R.modified ? L.modified : -1, s: item.s };
    if (L.modified !== R.modified) await pushRecord(kind, L);
    return false;
  }
  // Only store it if the local record did not change while we were downloading; otherwise retry next round.
  if (!await db.putIf(store, m, L ? L.modified : undefined)) return false;
  st[name] = { lm: m === R ? R.modified : -1, s: item.s };
  if (m !== R) await pushRecord(kind, m);
  bus.emit('remote-record', { kind, rec: m });
  return true;
}

async function pool(n, items, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// ---------------------------------------------------------------- sync passes
// What changed on the service since last time. Cheap: one small request when nothing did.
async function pullChanges() {
  let changed = false;
  for (;;) {
    const j = await (await call('/changes?since=' + cursor + '&limit=500')).json();
    const rank = { f: 0, d: 1, p: 2, a: 3 };
    const items = j.items.slice().sort((x, y) => rank[x.k] - rank[y.k] || x.s - y.s);
    let gone = null; // attached files removed on another device
    for (const it of items) {
      if (it.k === 'a') {
        if (it.size < 0) (gone = gone || []).push(it);
        else if (!st['a_' + it.id] || st['a_' + it.id].s !== it.s) queueAsset(it.id, it);
        continue;
      }
      if (await applyRemote(it)) changed = true;
    }
    if (gone) {
      // Keep (and send back) a file a page here still uses; otherwise drop it here as well.
      const used = assetIdsOf((await db.all('pages')).filter(p => !p.deleted));
      for (const it of gone) {
        delete st['a_' + it.id];
        if (used.has(it.id)) queueAsset(it.id, 'up');
        else if (await db.get('assets', it.id)) await db.put('assets', { id: it.id, deleted: true, modified: Date.now() }, true);
      }
    }
    if (j.items.length) cursor = Math.max(cursor, ...j.items.map(i => i.s));
    if (!j.more) break;
  }
  saveState();
  return changed;
}

// Everything, both directions: bring in what is new there, then send whatever here is not there yet.
// Used at start-up, on demand, and for library changes.
async function fullPass() {
  const changed = await pullChanges();
  for (const kind of ['f', 'd', 'p']) {
    const locals = await db.all(STORES[kind]);
    await pool(4, locals, async L => {
      const s = st[kind + '_' + L.id];
      if (!s || s.lm !== L.modified) await pushRecord(kind, L);
    });
  }
  const dels = (await db.getMeta('assetDels')) || [];
  for (const id of dels) { await removeBlob('a', id).catch(() => {}); delete st['a_' + id]; }
  if (dels.length) await db.setMeta('assetDels', []);
  for (const id of await db.keys('assets')) if (!st['a_' + id]) queueAsset(id, 'up');
  saveState();
  return changed;
}

// Upload what changed in one notebook (the one being written in). only = ids of the pages saved since the last
// push; reading just those back, not the whole notebook, keeps writing smooth in long notebooks.
async function pushDoc(docId, only) {
  const pages = only
    ? (await Promise.all([...only].map(id => db.get('pages', id)))).filter(p => p && p.docId === docId)
    : await db.byDoc(docId);
  for (const p of pages) {
    if (p.deleted) continue;
    if (p.pdf && !st['a_' + p.pdf.a]) queueAsset(p.pdf.a, 'up');
    if (p.bg && !st['a_' + p.bg.a]) queueAsset(p.bg.a, 'up');
    for (const it of p.items || []) if (it.t === 'im' && !st['a_' + it.a]) queueAsset(it.a, 'up');
  }
  for (const p of pages) {
    const s = st['p_' + p.id];
    if (!s || s.lm !== p.modified) await pushRecord('p', p);
  }
  const doc = await db.get('docs', docId);
  if (doc) {
    const s = st['d_' + doc.id];
    if (!s || s.lm !== doc.modified) await pushRecord('d', doc);
  }
  saveState();
}

// ---------------------------------------------------------------- live connection
let ws = null, wsLive = false, wsWait = 2000, wsT = 0, pingT = 0;

function openLive() {
  if (ws || !session || off || !navigator.onLine) return;
  clearTimeout(wsT);
  const u = session.token.split('.')[0];
  let sock;
  try { sock = makeSocket(server.replace(/^http/, 'ws') + '/ws?u=' + encodeURIComponent(u)); } catch { return; }
  ws = sock;
  sock.onopen = () => sock.send(JSON.stringify({ token: session && session.token }));
  sock.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.hello) { wsLive = true; wsWait = 2000; schedule(); }
    if ((m.s || 0) > cursor) pullSoon();
  };
  sock.onclose = e => {
    if (ws !== sock) return;
    ws = null;
    wsLive = false;
    if (e.code === 4001) { session = null; db.setMeta('cloud', null).catch(() => {}); setStatus('signin', 'Sync paused. Tap to sign in again.'); return; }
    if (session && !off) wsT = setTimeout(openLive, wsWait = Math.min(wsWait * 2, 60000));
    schedule();
  };
  sock.onerror = () => { /* onclose follows */ };
  clearInterval(pingT);
  pingT = setInterval(() => { if (ws && wsLive && document.visibilityState === 'visible') { try { ws.send('{"ping":1}'); } catch { /* closing */ } } }, 50000);
}

function closeLive() {
  clearTimeout(wsT);
  clearInterval(pingT);
  const s = ws;
  ws = null;
  wsLive = false;
  if (s) { try { s.close(1000, 'bye'); } catch { /* already closed */ } }
}

function pullSoon() {
  clearTimeout(pullT);
  pullT = setTimeout(() => {
    if (!ready()) return;
    exclusive(async () => {
      try { if (await pullChanges()) bus.emit('synced'); setIdle(); } catch (e) { fail(e, false); }
    });
  }, 120);
}

// ---------------------------------------------------------------- scheduling
const ready = () => !!session && !off && navigator.onLine;

function fail(e, interactive) {
  if (e.signin) { setStatus('signin', 'Sync paused. Tap to sign in again.'); return; }
  if (e.name === 'TypeError' || !navigator.onLine) { // the request never reached the service
    setStatus('error', 'Offline. Changes are saved here and will sync when you are back online.');
    return;
  }
  console.error('Sync problem:', e.name, e.message, e);
  setStatus('error', 'Sync problem: ' + e.message);
  if (interactive) toast('Sync problem: ' + e.message, 5000);
}

function run(fn, interactive) {
  return exclusive(async () => {
    try {
      setStatus('syncing', 'Syncing...');
      const changed = await fn();
      db.setMeta('lastSync', Date.now()).catch(() => {});
      setIdle();
      if (changed) bus.emit('synced');
      return true;
    } catch (e) {
      fail(e, interactive);
      return false;
    }
  });
}

function schedule() {
  clearTimeout(loopT);
  loopT = setTimeout(tick, wsLive ? POLL_LIVE : openDocs.size ? POLL_NOLIVE : POLL_IDLE);
}

async function tick() {
  if (ready() && document.visibilityState === 'visible') {
    if (!ws) openLive();
    await exclusive(async () => {
      try {
        const changed = await pullChanges();
        if (changed) bus.emit('synced');
        setIdle();
      } catch (e) { fail(e, false); }
    });
    retryAssets();
    if (writeSeq !== pushedSeq) await pushNow(); // something saved earlier has not reached the service yet
  } else if (session && !off && !navigator.onLine) {
    setStatus('error', 'Offline. Changes are saved here and will sync when you are back online.');
  }
  schedule();
}

// Local saves are counted; a push only counts as done if it finished with nothing newer waiting.
// Anything that could not be sent (offline, signed out) is retried by the loop.
let writeSeq = 0, pushedSeq = 0;
// Pages saved here since the last push. null = not known (just started, or a push failed): check every page.
let savedPages = null;

function pushNow() {
  const ids = [...openDocs], seq = writeSeq, only = savedPages;
  savedPages = new Set();
  return run(async () => {
    if (!ids.length) return fullPass();
    for (const id of ids) await pushDoc(id, only);
    return false;
  }, false)
    .then(ok => { if (ok) pushedSeq = Math.max(pushedSeq, seq); else savedPages = null; });
}

function pushSoon(delay = PUSH_MS) {
  clearTimeout(pushT);
  pushT = setTimeout(() => { if (ready()) pushNow(); }, delay);
}

// interactive = started by a tap, so a Google sign-in window may be opened.
export async function syncNow(interactive = false) {
  if (off) { if (interactive) openSettings(); return; }
  if (!navigator.onLine) { setStatus('error', 'Offline. Changes are saved here and will sync when you are back online.'); return; }
  if (!session) {
    if (!interactive) return;
    try { await signIn(); } catch (e) { fail(e, true); return; }
  }
  const ok = await run(fullPass, interactive);
  if (ok && interactive) toast('Synced');
  openLive();
  schedule();
}

let wired = false;
export async function initSync() {
  const cfg = (await db.getMeta('sync')) || {};
  off = !!cfg.off;
  server = (await db.getMeta('cloudServer')) || SERVER; // a test server can be set here
  session = (await db.getMeta('cloud')) || null;
  st = (await db.getMeta('cloudState')) || {};
  cursor = (await db.getMeta('cloudCursor')) || 0;

  if (!wired) {
    wired = true;
    bus.on('db-write', w => {                                                     // something was saved locally
      writeSeq++;
      if (savedPages && w && w.s === 'pages') for (const id of w.ids) savedPages.add(id);
      if (session && !off) pushSoon();
    });
    bus.on('editor-open', id => { openDocs.add(id); if (ready()) { run(pullChanges, false); } schedule(); });
    bus.on('editor-close', id => { openDocs.delete(id); schedule(); });
    window.addEventListener('online', () => { if (ready()) { run(fullPass, false); openLive(); } });
    setTimeout(() => autoBackup(), 8000);          // weekly snapshot, if one is due
    setInterval(() => autoBackup(), 3600e3);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') pushSoon(0);                       // leaving: upload right away
      else if (ready()) { openLive(); run(pullChanges, false); schedule(); }
    });
  }

  closeLive();
  if (off) { setStatus('off', 'Sync is turned off on this device'); clearTimeout(loopT); return; }
  if (!session) { setStatus('signin', 'Tap to sign in with Google once and start live sync.'); clearTimeout(loopT); return; }
  run(fullPass, false);
  openLive();
  schedule();
}

// ---------------------------------------------------------------- backup files
export async function exportBackup() {
  const b = busy('Building backup...');
  try {
    const [folders, docs, pages, assets] = await Promise.all(['folders', 'docs', 'pages', 'assets'].map(s => db.all(s)));
    const data = {
      app: 'inkleaf', version: 1, exported: Date.now(), folders, docs, pages,
      assets: assets.map(a => (a.data ? { ...a, data: bufToB64(a.data) } : a))
    };
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `inkleaf-backup-${stamp}.inkleaf`);
  } catch (e) {
    console.error(e);
    toast('Backup failed: ' + e.message);
  } finally {
    b.done();
  }
}

// One notebook as a file, to send to someone (they open it with "Open a notebook file").
export async function notebookFile(docId) {
  const doc = await db.get('docs', docId);
  const pages = (await db.byDoc(docId)).filter(p => !p.deleted && !p.trashed);
  const ids = assetIdsOf(pages);
  const assets = [];
  for (const id of ids) {
    const a = await db.get('assets', id);
    if (a && a.data) assets.push({ ...a, data: bufToB64(a.data) });
  }
  const { thumb, fav, tags, trashed, ...rest } = doc; // personal marks stay with the sender
  const data = { app: 'inkleaf', version: 1, kind: 'notebook', exported: Date.now(), folders: [], docs: [{ ...rest, folderId: null }], pages, assets };
  const name = (doc.title || 'notebook').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'notebook';
  return new File([JSON.stringify(data)], name + '.inkleaf', { type: 'application/octet-stream' });
}

export async function shareNotebook(docId) {
  const b = busy('Preparing the notebook file...');
  let file;
  try { file = await notebookFile(docId); } catch (e) { b.done(); toast('Could not make the file: ' + e.message); return; }
  b.done();
  const mb = (file.size / 1048576).toFixed(1);
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  const actions = [{ label: 'Download', primary: !canShare, onClick: () => downloadBlob(file, file.name) }];
  if (canShare) actions.push({ label: 'Share', primary: true, onClick: async () => { try { await navigator.share({ files: [file] }); } catch { /* cancelled */ } } });
  modal({
    title: 'Send a copy',
    body: h('div', null,
      h('p', { class: 'modal-text' }, `${file.name} (${mb} MB)`),
      h('p', { class: 'modal-text small' }, 'Send this file by WhatsApp, email or Drive. The other person opens Inkleaf, taps New, then "Open a notebook file". '
        + 'If they send it back after writing in it, opening it here merges their writing into yours.')),
    actions
  });
}

// Merges a backup (or a shared notebook) into the library: nothing local is removed. Returns the notebook ids in it.
export async function importBackup(file) {
  const b = busy('Opening file...');
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'inkleaf') throw new Error('This is not an Inkleaf file.');
    for (const a of data.assets || []) {
      const cur = await db.get('assets', a.id);
      if (!cur || (!cur.data && !cur.deleted && a.data)) await db.put('assets', a.data ? { ...a, data: b64ToBuf(a.data) } : a);
    }
    const folderIds = new Set((data.folders || []).map(f => f.id));
    for (const [store, kind] of [['pages', 'p'], ['folders', 'f'], ['docs', 'd']]) {
      for (let rec of data[store] || []) {
        // A notebook from someone else's folder lands at the top of the library.
        if (kind === 'd' && rec.folderId && !folderIds.has(rec.folderId) && !(await db.get('folders', rec.folderId))) rec = { ...rec, folderId: null };
        const cur = await db.get(store, rec.id);
        const m = cur ? await merge(kind, cur, rec) : rec;
        if (m !== cur) await db.put(store, m);
      }
    }
    bus.emit('synced');
    toast(data.kind === 'notebook' ? 'Notebook added' : 'Backup restored');
    return (data.docs || []).filter(d => !d.deleted && !d.sys).map(d => d.id);
  } catch (e) {
    console.error(e);
    toast('Could not open that file: ' + e.message, 5000);
    return [];
  } finally {
    b.done();
  }
}

// ---------------------------------------------------------------- settings dialog
export async function openSettings() {
  const cfg = (await db.getMeta('sync')) || {};
  const last = await db.getMeta('lastSync');
  const fileInp = h('input', {
    type: 'file', accept: '.inkleaf,application/json', hidden: true,
    onchange: () => { const f = fileInp.files[0]; fileInp.value = ''; if (f) importBackup(f); }
  });
  const turnOn = async () => {
    if (cfg.off) {
      await db.setMeta('sync', {});
      await initSync();
    }
  };
  // How much of this person's space on the service is used (Cloudflare's free plan allows each person 1 GB).
  const usage = h('div', { class: 'usage', hidden: true });
  if (session && !cfg.off && navigator.onLine) {
    call('/me').then(r => r.json()).then(j => {
      const GB = 1024 ** 3, used = Number(j.bytes) || 0, pct = Math.min(100, used / GB * 100);
      const size = used >= GB ? (used / GB).toFixed(2) + ' GB' : used >= 1048576 ? Math.round(used / 1048576) + ' MB' : Math.max(1, Math.round(used / 1024)) + ' KB';
      usage.replaceChildren(
        h('div', { class: 'usage-text' }, `Space used on the sync service: ${size} of 1 GB (${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%)`,
          h('span', { class: 'bk-sub' }, ` · ${j.devices} device sign-in${j.devices === 1 ? '' : 's'}`)),
        h('div', { class: 'usage-bar' }, h('div', { class: 'usage-fill' + (pct > 85 ? ' warn' : ''), style: { width: Math.max(pct, 0.5) + '%' } })),
        pct > 85 ? h('p', { class: 'modal-text small' }, 'Nearly full. Removing PDFs you no longer need (and emptying the bin) frees space; or ask for more space to be set up.') : '');
      usage.hidden = false;
    }).catch(() => {});
  }
  const who = session && !cfg.off
    ? `This device is signed in as ${session.email}. It stays signed in; nothing needs doing again.`
    : cfg.off ? 'Sync is turned off on this device.' : 'This device is not signed in yet.';
  const m = modal({
    title: 'Settings',
    wide: true,
    body: h('div', null,
      h('h3', null, 'Live sync'),
      h('p', { class: 'modal-text' },
        'Notes are always kept on this device, so they open instantly and work offline. With sync on, every change is also ',
        'sent to Inkleaf\'s own sync service (on Cloudflare) and appears on your other devices within a second or two.'),
      h('p', { class: 'modal-text small' }, who),
      usage,
      h('div', { class: 'row' },
        h('button', {
          class: 'btn primary', type: 'button',
          onclick: async () => { await turnOn(); m.close(); syncNow(true); }
        }, session && !cfg.off ? 'Sync now' : 'Sign in with Google'),
        session && !cfg.off ? h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            if (!await confirmBox('Sign out', 'Sign this device out of sync? Notes stay on this device and on your other devices.', 'Sign out')) return;
            await signOut();
            await db.setMeta('cloudState', {});
            await db.setMeta('cloudCursor', 0);
            await initSync();
            m.close();
          }
        }, 'Sign out') : null),
      h('p', { class: 'modal-text small' }, last ? 'Last synced ' + new Date(last).toLocaleString() : 'Not synced yet on this device.'),
      h('h3', null, 'Backup file'),
      h('p', { class: 'modal-text' }, 'Save every notebook into one file, or restore one. Useful for moving notes without sync.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: exportBackup }, 'Save backup'),
        h('button', { class: 'btn', type: 'button', onclick: () => fileInp.click() }, 'Restore backup'),
        fileInp),
      h('h3', null, 'Automatic backups'),
      h('p', { class: 'modal-text' },
        'Once a week Inkleaf keeps a snapshot of every notebook by itself: the last 3 on this device and, with sync on, the last 8 on the sync service. ',
        'If something gets lost or damaged, you can bring a notebook back from a snapshot as a copy.'),
      h('p', { class: 'modal-text small' }, 'Snapshots hold your pages and writing. Imported PDFs and pictures are not duplicated in them; they stay with the library.'),
      bkList,
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: async e => { const b = e.currentTarget; b.disabled = true; await autoBackup(true); b.disabled = false; fillBk(); } }, 'Back up now')))
  });
  fillBk();
}

// ---------------------------------------------------------------- automatic backups
const BK_EVERY = 7 * 864e5, BK_LOCAL = 3, BK_CLOUD = 8;
let bkBusy = false;

// Snapshots on the sync service, newest first.
async function cloudBackups() {
  const j = await (await call('/list/b')).json();
  return (j.items || []).map(it => {
    let info = {};
    try { info = JSON.parse(it.info || '{}'); } catch { /* none */ }
    return { item: it, t: Number(it.id) || 0, bytes: it.size, docs: Number(info.docs) || 0 };
  }).filter(f => f.t).sort((a, b) => b.t - a.t);
}

// Takes a snapshot when a week has passed since the last one (or when forced), and copies the newest to the service.
export async function autoBackup(force) {
  if (bkBusy) return;
  bkBusy = true;
  try {
    const list = (await db.getMeta('autobk')) || []; // [{t, docs, bytes, drive}], oldest first
    const last = Math.max(list.length ? list[list.length - 1].t : 0, (await db.getMeta('autobkHold')) || 0);
    if (force || Date.now() - last >= BK_EVERY) {
      const [folders, docs, pages] = await Promise.all(['folders', 'docs', 'pages'].map(s => db.all(s)));
      const live = r => !r.deleted;
      const D = docs.filter(live);
      if (D.some(d => !d.sys)) {
        const t = Date.now();
        const text = JSON.stringify({
          app: 'inkleaf', version: 1, kind: 'auto', exported: t,
          folders: folders.filter(live), docs: D.map(({ thumb, ...d }) => d), pages: pages.filter(live)
        });
        await db.setMeta('autobk:' + t, text);
        list.push({ t, docs: D.filter(d => !d.sys && !d.trashed).length, bytes: text.length });
        while (list.length > BK_LOCAL) { const old = list.shift(); await db.setMeta('autobk:' + old.t, null); }
        await db.setMeta('autobk', list);
      }
    }
    const latest = list[list.length - 1];
    if (latest && !latest.cloud && ready()) {
      const text = await db.getMeta('autobk:' + latest.t);
      await exclusive(async () => {
        const raw = new TextEncoder().encode(text);
        const bytes = canZip ? await pipe(raw, new CompressionStream('gzip')) : raw;
        await putBlob('b', String(latest.t), bytes, { info: JSON.stringify({ docs: latest.docs }), gz: canZip });
        for (const f of (await cloudBackups()).slice(BK_CLOUD)) await removeBlob('b', f.item.id).catch(() => {});
      });
      latest.cloud = true;
      await db.setMeta('autobk', list);
    }
  } catch (e) {
    console.warn('Automatic backup failed', e);
  } finally {
    bkBusy = false;
  }
}

// Bring one notebook back from a snapshot, as a new notebook beside whatever is in the library now.
async function restoreCopy(data, d) {
  const t = Date.now(), id = uid();
  const byId = new Map((data.pages || []).map(p => [p.id, p]));
  const pages = (d.pages || []).map(pid => byId.get(pid)).filter(p => p && !p.trashed).map(p => ({
    ...p, id: uid(), docId: id, dels: {}, modified: t, items: (p.items || []).map(it => ({ ...it, id: uid(), m: t }))
  }));
  if (!pages.length) { toast('That notebook had no pages in this snapshot.'); return; }
  const copy = { ...d, id, title: d.title + ' (restored)', folderId: null, pages: pages.map(p => p.id), created: t, modified: t };
  delete copy.trashed;
  delete copy.journal;
  await db.putMany('pages', pages);
  await db.put('docs', copy);
  bus.emit('synced');
  toast(`"${copy.title}" is in your library`, 3200);
}

function snapshotDialog(text, when) {
  let data;
  try { data = JSON.parse(text); } catch { toast('That snapshot could not be read.'); return; }
  const docs = (data.docs || []).filter(d => !d.sys).sort((a, b) => a.title.localeCompare(b.title));
  modal({
    title: 'Snapshot from ' + when,
    body: h('div', null,
      h('p', { class: 'modal-text small' }, 'Tap a notebook to bring it back as a copy. Nothing in your library is replaced.'),
      h('div', { class: 'menu flat pick-list' }, docs.map(d => h('button', {
        class: 'mi', type: 'button', onclick: e => { e.currentTarget.disabled = true; restoreCopy(data, d); }
      }, d.title, h('span', { class: 'bk-sub' }, `${(d.pages || []).length} page${(d.pages || []).length === 1 ? '' : 's'}${d.trashed ? ' · was in the bin' : ''}`)))))
  });
}

const bkList = h('div', { class: 'bk-list' });
async function fillBk() {
  const rows = new Map(); // t -> {t, docs, bytes, local, item (on the service)}
  for (const b of (await db.getMeta('autobk')) || []) rows.set(b.t, { ...b, local: true });
  if (ready()) {
    try { for (const f of await cloudBackups()) rows.set(f.t, { ...(rows.get(f.t) || f), item: f.item }); } catch { /* offline: show what is on this device */ }
  }
  const all = [...rows.values()].sort((a, b) => b.t - a.t);
  const textOf = async b => {
    if (b.local) return db.getMeta('autobk:' + b.t);
    const bytes = await getBlob(b.item);
    return new TextDecoder().decode(b.item.gz ? await pipe(bytes, new DecompressionStream('gzip')) : bytes);
  };
  const fmt = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  bkList.replaceChildren(...(all.length ? all.map(b => h('div', { class: 'bk-row' },
    h('div', { class: 'bk-meta' },
      h('b', null, fmt(b.t)),
      h('span', { class: 'bk-sub' }, `${b.docs} notebook${b.docs === 1 ? '' : 's'} · ${b.local && b.item ? 'this device and the sync service' : b.local ? 'this device' : 'sync service'}`)),
    h('button', {
      class: 'btn sm', type: 'button', onclick: async () => {
        try { snapshotDialog(await textOf(b), fmt(b.t)); } catch (e) { toast('Could not open that snapshot: ' + e.message); }
      }
    }, 'Restore from it'),
    h('button', {
      class: 'btn sm', type: 'button', onclick: async () => {
        try { downloadBlob(new Blob([await textOf(b)], { type: 'application/json' }), `inkleaf-snapshot-${new Date(b.t).toISOString().slice(0, 10)}.inkleaf`); } catch (e) { toast('Could not download it: ' + e.message); }
      }
    }, 'Download'),
    h('button', {
      class: 'ic sm danger', type: 'button', title: 'Delete this snapshot', html: I.trash, onclick: async () => {
        if (!await confirmBox('Delete snapshot', `Delete the snapshot from ${fmt(b.t)}${b.item ? ', here and on the sync service' : ''}? Your notebooks are not affected.`, 'Delete', true)) return;
        await dropBackups([b]);
        fillBk();
      }
    }))) : [h('p', { class: 'modal-text small' }, 'No snapshots at the moment. One is made at the next weekly backup, or tap "Back up now".')]),
    all.length > 1 ? h('button', {
      class: 'btn sm bk-all', type: 'button', onclick: async () => {
        if (!await confirmBox('Delete all snapshots', `Delete all ${all.length} snapshots, on this device and on the sync service? Your notebooks are not affected. A new snapshot is made at the next weekly backup.`, 'Delete all', true)) return;
        await dropBackups(all);
        fillBk();
      }
    }, 'Delete all snapshots') : '');
}

// Remove snapshots from this device and, where they are there, from the sync service. A fresh weekly one is not made at once.
async function dropBackups(items) {
  const gone = new Set(items.map(b => b.t));
  let list = (await db.getMeta('autobk')) || [];
  for (const b of items) {
    if (b.local) await db.setMeta('autobk:' + b.t, null);
    if (b.item) { try { await removeBlob('b', b.item.id); } catch (e) { toast('Could not delete the copy on the sync service: ' + e.message); } }
  }
  list = list.filter(b => !gone.has(b.t));
  await db.setMeta('autobk', list);
  // Keep the weekly rhythm: without this, deleting the newest snapshot would make a new one within the hour.
  await db.setMeta('autobkHold', Math.max(...gone, (await db.getMeta('autobkHold')) || 0));
}
