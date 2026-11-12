// Google Drive sync (live) and backup files.
//
// How it works
// - Everything is saved on the device first (IndexedDB). Sync only ever runs in the background.
// - Each record (folder, notebook, page, attached file) is one small file in the app's private Drive
//   folder ("appDataFolder"), so only what changed is transferred.
// - Pushing: about a second after something is saved locally, the changed records are uploaded.
// - Pulling: Drive is asked "what changed?" every few seconds; changed records are downloaded and merged.
//   A page edited on two devices is merged stroke by stroke, so nobody's writing is lost.
// - There is no server. The browser talks to Drive with a token that lasts about an hour, after which
//   Drive needs one tap to sign in again.
import { db, assetIdsOf } from './db.js';
import { h, bus, loadScript, downloadBlob, bufToB64, b64ToBuf } from './util.js';
import { modal, toast, confirmBox, busy } from './ui.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com';
const STORES = { a: 'assets', f: 'folders', d: 'docs', p: 'pages' };
const FILE_FIELDS = 'id,name,modifiedTime,mimeType,description';
const LIVE_MS = 1500;   // poll interval while a notebook is open
const IDLE_MS = 15000;  // poll interval in the library
const PUSH_MS = 250;    // delay between a local save and its upload

let http = (url, opts) => fetch(url, opts);
export const _setHttp = fn => { http = fn; }; // lets tests swap in a fake Drive

// Built-in Google OAuth client, so devices do not need one pasted in. A client ID is public by design.
const DEFAULT_CLIENT_ID = '473809010149-3hhf0nu5aisisgvu3gnaee49lfgdlga2.apps.googleusercontent.com';
// An ID typed into an older version's Settings is ignored: a mistyped one blocked sign-in ("invalid_client").
const effectiveId = cfg => (cfg.off ? '' : DEFAULT_CLIENT_ID);

let clientId = '';
let token = null, tokenExp = 0;
let st = {};          // name -> {fid, lm: local "modified" when last in step, rm: remote modifiedTime}
let cursor = null;    // Drive "changes" page token
const openDocs = new Set(); // notebooks open in the editor (two when side by side)
let pushT = 0, loopT = 0, stateT = 0;
let chain = Promise.resolve();
let status = { state: 'off', text: 'Google Drive sync is not set up' };

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
    db.setMeta('syncState', st).catch(() => {});
    db.setMeta('syncCursor', cursor).catch(() => {});
  }, 300);
}

// ---------------------------------------------------------------- auth
const tokenValid = () => !!token && Date.now() < tokenExp - 60000;

async function getToken(interactive) {
  if (tokenValid()) return token;
  if (!interactive) { const e = new Error('Sign-in needed'); e.signin = true; throw e; }
  if (!clientId) throw new Error('Add your Google client ID in Settings first.');
  await loadScript('https://accounts.google.com/gsi/client');
  return new Promise((res, rej) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: r => {
        if (r.error) { rej(new Error(r.error_description || r.error)); return; }
        token = r.access_token;
        tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        db.setMeta('syncToken', { token, exp: tokenExp }).catch(() => {});
        res(token);
      },
      error_callback: e => rej(new Error(e && e.type === 'popup_closed' ? 'Sign-in was cancelled.' : 'Google sign-in could not open. Allow pop-ups and try again.'))
    });
    client.requestAccessToken({ prompt: '' });
  });
}

async function api(path, opts = {}) {
  const t = await getToken(false);
  const r = await http(API + path, { ...opts, headers: { Authorization: 'Bearer ' + t, ...(opts.headers || {}) } });
  if (r.status === 401) {
    token = null;
    tokenExp = 0;
    db.setMeta('syncToken', null).catch(() => {});
    const e = new Error('Sign-in needed');
    e.signin = true;
    throw e;
  }
  if (!r.ok) {
    const e = new Error(`Google Drive error ${r.status}: ${(await r.text()).slice(0, 160)}`);
    e.status = r.status;
    throw e;
  }
  return r;
}

// ---------------------------------------------------------------- Drive files
async function listRemote() {
  const files = new Map();
  let pageToken = '';
  do {
    const q = `/drive/v3/files?spaces=appDataFolder&pageSize=1000&fields=nextPageToken,files(${FILE_FIELDS})`
      + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const j = await (await api(q)).json();
    for (const f of j.files || []) {
      const old = files.get(f.name);
      if (!old || f.modifiedTime > old.modifiedTime) files.set(f.name, f); // tolerate accidental duplicates
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function upload(name, fileId, blob, description) {
  const type = blob.type || 'application/octet-stream';
  if (fileId) {
    const r = await api(`/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,modifiedTime`, {
      method: 'PATCH', headers: { 'Content-Type': type }, body: blob
    });
    return r.json();
  }
  const boundary = 'inkleaf' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, parents: ['appDataFolder'], mimeType: type, description: description || '' });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: ${type}\r\n\r\n`, blob,
    `\r\n--${boundary}--`
  ]);
  const r = await api('/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime', {
    method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body
  });
  return r.json();
}

// Create or update, using what we already know about the file.
async function putFile(name, blob, description) {
  const s = st[name];
  if (s && s.fid) {
    try { return await upload(name, s.fid, blob); } catch (e) { if (e.status !== 404) throw e; } // gone: recreate
  }
  return upload(name, null, blob, description);
}

const download = fileId => api(`/drive/v3/files/${fileId}?alt=media`);
const removeRemote = fileId => api(`/drive/v3/files/${fileId}`, { method: 'DELETE' });
const toBlob = rec => new Blob([JSON.stringify(rec)], { type: 'application/json' });

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
const looks = X => JSON.stringify([X.bg || null, X.pdf || null, X.tpl || null, X.w, X.h]);

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
  if (!extra.length) return nu;
  return { ...nu, pages: [...(nu.pages || []), ...extra], modified: Date.now() };
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
async function pushRecord(kind, rec) {
  const name = kind + '_' + rec.id;
  const info = await putFile(name, toBlob(rec));
  st[name] = { fid: info.id, lm: rec.modified, rm: info.modifiedTime };
}

async function pushAsset(id) {
  const name = 'a_' + id;
  if (st[name]) return;
  const a = await db.get('assets', id);
  if (!a || a.deleted || !a.data) return;
  const info = await upload(name, null, new Blob([a.data], { type: a.mime || 'application/octet-stream' }), a.name || '');
  st[name] = { fid: info.id, lm: a.modified, rm: info.modifiedTime };
}

async function pullAsset(id, file) {
  const name = 'a_' + id;
  const have = await db.get('assets', id);
  if (have && (have.data || have.deleted)) { st[name] = { fid: file.id, lm: have.modified, rm: file.modifiedTime }; return false; }
  const data = await (await download(file.id)).arrayBuffer();
  const rec = { id, mime: file.mimeType || 'application/octet-stream', name: file.description || '', data, modified: Date.now() };
  await db.put('assets', rec, true);
  st[name] = { fid: file.id, lm: rec.modified, rm: file.modifiedTime };
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

// job: 'up' to upload a local file, or the Drive file info to download.
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

// Bring one remote folder / notebook / page record in, merging with whatever is here.
async function applyRemote(kind, id, file) {
  const name = kind + '_' + id, store = STORES[kind], s = st[name];
  if (s && s.rm === file.modifiedTime) return false; // already in step with this version
  const R = await (await download(file.id)).json();
  const L = await db.get(store, id);
  const m = L ? await merge(kind, L, R) : R;
  if (m === L) { // ours already contains everything the remote copy has
    const info = await putFile(name, toBlob(L));
    st[name] = { fid: info.id, lm: L.modified, rm: info.modifiedTime };
    return false;
  }
  // Only store it if the local record did not change while we were downloading; otherwise retry next round.
  if (!await db.putIf(store, m, L ? L.modified : undefined)) return false;
  st[name] = { fid: file.id, lm: m === R ? R.modified : -1, rm: file.modifiedTime };
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
// Everything, both directions. Used at start-up, on demand, and for library changes.
async function fullPass() {
  const start = (await (await api('/drive/v3/changes/startPageToken')).json()).startPageToken;
  const remote = await listRemote();
  let changed = false;
  const referenced = new Set();

  for (const kind of ['f', 'd', 'p']) {
    const store = STORES[kind];
    const locals = new Map((await db.all(store)).map(r => [kind + '_' + r.id, r]));
    if (kind === 'p') {
      for (const p of locals.values()) {
        if (p.deleted) continue;
        if (p.pdf) referenced.add(p.pdf.a);
        if (p.bg) referenced.add(p.bg.a);
        for (const it of p.items || []) if (it.t === 'im') referenced.add(it.a);
      }
    }
    const names = new Set(locals.keys());
    for (const n of remote.keys()) if (n[0] === kind && n[1] === '_') names.add(n);
    await pool(4, [...names], async name => {
      const L = locals.get(name), file = remote.get(name), s = st[name];
      if (L && !file) await pushRecord(kind, L);
      else if (file && (!L || !s || s.rm !== file.modifiedTime)) { if (await applyRemote(kind, name.slice(2), file)) changed = true; }
      else if (L && s.lm !== L.modified) await pushRecord(kind, L);
    });
  }

  // Attached files (PDFs, pictures). They never change: upload once, download once, or delete.
  const dels = (await db.getMeta('assetDels')) || [];
  for (const id of dels) {
    const name = 'a_' + id, file = remote.get(name);
    if (file) { await removeRemote(file.id).catch(() => {}); remote.delete(name); }
    delete st[name];
  }
  if (dels.length) await db.setMeta('assetDels', []);
  const localIds = new Set(await db.keys('assets'));
  for (const id of localIds) {
    const name = 'a_' + id, file = remote.get(name);
    if (file) { if (!st[name]) st[name] = { fid: file.id, lm: 0, rm: file.modifiedTime }; continue; }
    if (st[name]) {
      delete st[name];
      // Removed from Drive by another device. Keep it (and put it back) if a page here still uses it.
      if (!referenced.has(id)) { await db.put('assets', { id, deleted: true, modified: Date.now() }, true); continue; }
    }
    queueAsset(id, 'up');
  }
  for (const name of remote.keys()) {
    if (name.startsWith('a_') && !localIds.has(name.slice(2))) queueAsset(name.slice(2), remote.get(name));
  }

  cursor = start;
  saveState();
  return changed;
}

// Only what Drive says changed since last time. Cheap enough to run every few seconds.
async function pullChanges() {
  if (!cursor) return fullPass();
  let changed = false, tok = cursor;
  while (tok) {
    const j = await (await api(`/drive/v3/changes?pageToken=${encodeURIComponent(tok)}&spaces=appDataFolder&pageSize=200`
      + `&fields=newStartPageToken,nextPageToken,changes(fileId,removed,file(${FILE_FIELDS},trashed))`)).json();
    const files = (j.changes || []).filter(c => c.file && !c.removed && !c.file.trashed).map(c => c.file)
      .filter(f => f.name && f.name[1] === '_' && STORES[f.name[0]]);
    const rank = { f: 0, d: 1, p: 2, a: 3 };
    files.sort((x, y) => rank[x.name[0]] - rank[y.name[0]]);
    for (const f of files) {
      const kind = f.name[0], id = f.name.slice(2);
      if (kind === 'a') { if (!st[f.name]) queueAsset(id, f); continue; }
      if (await applyRemote(kind, id, f)) changed = true;
    }
    if (j.newStartPageToken) { cursor = j.newStartPageToken; tok = null; } else tok = j.nextPageToken || null;
  }
  saveState();
  return changed;
}

// Upload what changed in one notebook (the one being written in).
async function pushDoc(docId) {
  const pages = await db.byDoc(docId);
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

// ---------------------------------------------------------------- scheduling
const ready = () => !!clientId && tokenValid() && navigator.onLine;

function fail(e, interactive) {
  if (e.signin) { setStatus('signin', 'Sync paused. Tap to sign in to Google Drive again.'); return; }
  if (e.name === 'TypeError' || !navigator.onLine) { // the request never reached Google
    setStatus('error', 'Offline. Changes are saved here and will sync when you are back online.');
    return;
  }
  console.error(e);
  setStatus('error', 'Sync problem: ' + e.message);
  if (interactive) toast('Sync problem: ' + e.message, 5000);
}

function run(fn, interactive) {
  return exclusive(async () => {
    try {
      setStatus('syncing', 'Syncing with Google Drive...');
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
  loopT = setTimeout(tick, openDocs.size ? LIVE_MS : IDLE_MS);
}

async function tick() {
  if (ready() && document.visibilityState === 'visible') {
    await exclusive(async () => {
      try {
        const changed = await pullChanges();
        if (changed) bus.emit('synced');
        setIdle();
      } catch (e) { fail(e, false); }
    });
    retryAssets();
    if (writeSeq !== pushedSeq) await pushNow(); // something saved earlier has not reached Drive yet
  } else if (clientId && !tokenValid() && status.state !== 'signin') {
    setStatus('signin', 'Sync paused. Tap to sign in to Google Drive again.');
  } else if (clientId && !navigator.onLine) {
    setStatus('error', 'Offline. Changes are saved here and will sync when you are back online.');
  }
  schedule();
}

// Local saves are counted; a push only counts as done if it finished with nothing newer waiting.
// Anything that could not be sent (offline, signed out) is retried by the polling loop.
let writeSeq = 0, pushedSeq = 0;

function pushNow() {
  const ids = [...openDocs], seq = writeSeq;
  return run(async () => {
    if (!ids.length) return fullPass();
    for (const id of ids) await pushDoc(id);
    return false;
  }, false)
    .then(ok => { if (ok) pushedSeq = Math.max(pushedSeq, seq); });
}

function pushSoon(delay = PUSH_MS) {
  clearTimeout(pushT);
  pushT = setTimeout(() => { if (ready()) pushNow(); }, delay);
}

// interactive = started by a tap, so a Google sign-in window may be opened.
export async function syncNow(interactive = false) {
  if (!clientId) { if (interactive) openSettings(); return; }
  if (!navigator.onLine) { setStatus('error', 'Offline. Changes are saved here and will sync when you are back online.'); return; }
  try { await getToken(interactive); } catch (e) { fail(e, interactive); return; }
  const ok = await run(fullPass, interactive);
  if (ok && interactive) toast('Synced with Google Drive');
  schedule();
}

let wired = false;
export async function initSync() {
  const cfg = (await db.getMeta('sync')) || {};
  clientId = effectiveId(cfg);
  st =(await db.getMeta('syncState')) || {};
  cursor = (await db.getMeta('syncCursor')) || null;
  const saved = await db.getMeta('syncToken');
  if (saved && Date.now() < saved.exp - 60000) { token = saved.token; tokenExp = saved.exp; } else { token = null; tokenExp = 0; }

  if (!wired) {
    wired = true;
    bus.on('db-write', () => { writeSeq++; if (clientId) pushSoon(); });          // something was saved locally
    bus.on('editor-open', id => { openDocs.add(id); if (ready()) { run(pullChanges, false); } schedule(); });
    bus.on('editor-close', id => { openDocs.delete(id); schedule(); });
    window.addEventListener('online', () => { if (ready()) run(fullPass, false); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') pushSoon(0);                       // leaving: upload right away
      else if (ready()) { run(pullChanges, false); schedule(); }
    });
  }

  if (!clientId) { setStatus('off', 'Set up Google Drive sync'); clearTimeout(loopT); return; }
  if (!tokenValid()) { setStatus('signin', 'Tap to sign in to Google Drive and start syncing.'); schedule(); return; }
  run(fullPass, false);
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
  const m = modal({
    title: 'Settings',
    wide: true,
    body: h('div', null,
      h('h3', null, 'Google Drive sync'),
      h('p', { class: 'modal-text' },
        'Notes are always kept on this device, so they open instantly and work offline. With sync on, changes are also ',
        'sent to a private app folder in your own Google Drive within a few seconds and merged into your other devices.'),
      h('p', { class: 'modal-text small' },
        'Tap "Sync now" and sign in with a Google account that has been added as a test user. Nothing else needs setting up.'),
      h('div', { class: 'row' },
        h('button', {
          class: 'btn primary', type: 'button',
          onclick: async () => { await turnOn(); m.close(); syncNow(true); }
        }, 'Sync now'),
        effectiveId(cfg) ? h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            if (!await confirmBox('Turn off sync', 'Stop syncing on this device? Notes stay on this device and in Drive.', 'Turn off')) return;
            await db.setMeta('sync', { off: true });
            await db.setMeta('syncToken', null);
            await db.setMeta('syncState', {});
            await db.setMeta('syncCursor', null);
            await initSync();
            m.close();
          }
        }, 'Turn off') : null),
      h('p', { class: 'modal-text small' }, last ? 'Last synced ' + new Date(last).toLocaleString() : 'Not synced yet on this device.'),
      h('h3', null, 'Backup file'),
      h('p', { class: 'modal-text' }, 'Save every notebook into one file, or restore one. Useful for moving notes without Drive.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: exportBackup }, 'Save backup'),
        h('button', { class: 'btn', type: 'button', onclick: () => fileInp.click() }, 'Restore backup'),
        fileInp))
  });
}
