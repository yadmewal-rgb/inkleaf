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
import { db, assetIdsOf, loadPages } from './db.js';
import { h, uid, bus, loadScript, downloadBlob, bufToB64, b64ToBuf, editedAt } from './util.js';
import { modal, toast, confirmBox, busy } from './ui.js';
import { I } from './icons.js';
import { hwOn, setHwOn, status as hwStatus, setCloudOcr, setDirectOcrReport, getHwUsage, setHwLimit, setHwModel, getHwModelConfig, getActiveHwModel, formatModelName, updateHwUsageFromServer } from './hwsearch.js';
export { updateHwUsageFromServer };

export const APP_VER = 'v104';
const SERVER = 'https://inkleaf-sync.yadmewal.workers.dev';
// drive.appdata: Inkleaf's hidden app folder (files it syncs); drive.file: only files Inkleaf itself creates, used
// for the visible "Inkleaf" folder holding copies of the PDFs under their real names.
const SCOPE = 'openid email https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';
const DRIVE = 'https://www.googleapis.com';
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
export const isSignedIn = () => !!session;

// What the sync has done lately, for the health line in Settings: when a change last went out, when the service was
// last checked, and anything waiting or failing.
const health = { sent: 0, checked: 0, err: null };
export function syncHealth() {
  return {
    ...health, waiting: writeSeq !== pushedSeq,
    files: assetQ.length + assetActive, retrying: assetRetry.size, live: wsLive, signedIn: !!session && !off
  };
}
function setStatus(state, text) {
  if (status.state === state && status.text === text) return;
  status = { state, text };
  bus.emit('sync-status', status);
  scheduleTargetsUpdate();
}

// Per-notebook and per-folder sync indicator state (OneDrive-style).
const inFlightDocs = new Set(), inFlightFolders = new Set();
const pendingDocs = new Set(), pendingFolders = new Set();
const assetDocs = new Map(); // assetId -> Set<docId>
const readyAssets = new Set(); // assetId confirmed locally present (data or deleted)
let docFolderMap = null, folderParentMap = null;
const staleDocMeta = new Set(), staleFolderMeta = new Set();
let curTargets = { docs: new Set(), folders: new Set() };
let targetsRunning = false, targetsAgain = false;

export const syncTargets = () => curTargets;
export const _setSyncTargets = (docs = [], folders = []) => {
  curTargets = { docs: new Set(docs), folders: new Set(folders) };
  bus.emit('sync-targets', curTargets);
};

const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

function scheduleTargetsUpdate() {
  if (targetsRunning) { targetsAgain = true; return; }
  targetsRunning = true;
  Promise.resolve().then(refreshSyncTargets).finally(() => {
    targetsRunning = false;
    if (targetsAgain) { targetsAgain = false; scheduleTargetsUpdate(); }
  });
}

async function ensureTargetMaps() {
  if (!docFolderMap || !folderParentMap) {
    staleDocMeta.clear();
    staleFolderMeta.clear();
    const [allDocs, allFolders] = await Promise.all([db.all('docs').catch(() => []), db.all('folders').catch(() => [])]);
    docFolderMap = new Map(allDocs.map(d => [d.id, d.folderId || null]));
    folderParentMap = new Map(allFolders.map(f => [f.id, f.parentId || null]));
    return;
  }
  if (staleDocMeta.size) {
    const ids = [...staleDocMeta];
    staleDocMeta.clear();
    const recs = await Promise.all(ids.map(id => db.get('docs', id).catch(() => null)));
    for (let i = 0; i < ids.length; i++) {
      const r = recs[i];
      if (r && !r.deleted) docFolderMap.set(ids[i], r.folderId || null);
      else docFolderMap.delete(ids[i]);
    }
  }
  if (staleFolderMeta.size) {
    const ids = [...staleFolderMeta];
    staleFolderMeta.clear();
    const recs = await Promise.all(ids.map(id => db.get('folders', id).catch(() => null)));
    for (let i = 0; i < ids.length; i++) {
      const r = recs[i];
      if (r && !r.deleted) folderParentMap.set(ids[i], r.parentId || null);
      else folderParentMap.delete(ids[i]);
    }
  }
}

async function refreshSyncTargets() {
  const active = status.state === 'syncing' || assetActive > 0 || assetQ.length > 0 || inFlightDocs.size > 0 || inFlightFolders.size > 0;
  const docs = new Set();
  const folders = new Set();
  if (active) {
    for (const id of inFlightDocs) docs.add(id);
    for (const id of pendingDocs) docs.add(id);
    for (const id of inFlightFolders) folders.add(id);
    for (const id of pendingFolders) folders.add(id);
    const qAssetIds = [...assetBusy, ...assetQ.map(([id]) => id)];
    if (qAssetIds.length) {
      if (qAssetIds.some(aid => !assetDocs.has(aid))) {
        const pages = await db.all('pages').catch(() => []);
        for (const p of pages) {
          if (p.deleted || !p.docId) continue;
          for (const aid of assetIdsOf([p])) {
            if (!assetDocs.has(aid)) assetDocs.set(aid, new Set());
            assetDocs.get(aid).add(p.docId);
          }
        }
        for (const aid of qAssetIds) if (!assetDocs.has(aid)) assetDocs.set(aid, new Set());
      }
      for (const aid of qAssetIds) {
        const set = assetDocs.get(aid);
        if (set) for (const did of set) docs.add(did);
      }
    }
    if (docs.size || folders.size) {
      await ensureTargetMaps();
      const addAncestors = startFid => {
        const seen = new Set();
        let fid = startFid;
        while (fid && !seen.has(fid) && folderParentMap.has(fid)) {
          seen.add(fid);
          folders.add(fid);
          fid = folderParentMap.get(fid);
        }
      };
      for (const did of docs) {
        const fid = docFolderMap.get(did);
        if (fid) addAncestors(fid);
      }
      for (const fid of [...folders]) {
        const pid = folderParentMap.get(fid);
        if (pid) addAncestors(pid);
      }
    }
  }
  if (!sameSet(curTargets.docs, docs) || !sameSet(curTargets.folders, folders)) {
    curTargets = { docs, folders };
    bus.emit('sync-targets', curTargets);
  }
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
// Google is asked once per device. The authorization code goes to the sync service, which keeps a long-lasting
// Google pass for the person's Drive app folder (where PDFs and pictures are stored) and answers with this
// device's own key.
async function googleCode() {
  await loadScript('https://accounts.google.com/gsi/client');
  return new Promise((res, rej) => {
    const client = google.accounts.oauth2.initCodeClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      ux_mode: 'popup',
      callback: r => { if (r.error) rej(new Error(r.error_description || r.error)); else res(r.code); },
      error_callback: e => rej(new Error(e && e.type === 'popup_closed' ? 'Sign-in was cancelled.' : 'Google sign-in could not open. Allow pop-ups and try again.'))
    });
    client.requestCode();
  });
}

// The name a device shows under in Settings > Signed-in devices, e.g. "iPad · Chrome" or "Windows · Edge (app)".
const deviceLabel = () => {
  const u = navigator.userAgent;
  const dev = /iPad|Macintosh.*Mobile|Macintosh(?=.*Safari)(?=.*Version)/.test(u) && navigator.maxTouchPoints > 1 ? 'iPad'
    : /iPhone/.test(u) ? 'iPhone' : /Android/.test(u) ? (/Mobile/.test(u) ? 'Android phone' : 'Android tablet')
      : /Windows/.test(u) ? 'Windows' : /Mac OS X/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'Device';
  const app = /EdgiOS|EdgA|Edg\//.test(u) ? 'Edge' : /CriOS|Chrome\//.test(u) ? 'Chrome' : /FxiOS|Firefox\//.test(u) ? 'Firefox'
    : /SamsungBrowser/.test(u) ? 'Samsung Internet' : /Safari\//.test(u) ? 'Safari' : '';
  let standalone = false;
  try { standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { /* old browser */ }
  return dev + (app ? ' · ' + app : '') + (standalone ? ' (app)' : '');
};

export async function signIn() {
  const code = await googleCode();
  const r = await http(server + '/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, label: deviceLabel() }) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 403 && j.error === 'not-allowed') throw new Error(`${j.email} is not on Inkleaf's list of allowed accounts. Add it to ALLOWED in Cloudflare.`);
  if (j.error === 'no-google-secret') throw new Error('The sync service is missing its Google setting (GOOGLE_SECRET in Cloudflare).');
  if (!r.ok || !j.token) throw new Error(j.error === 'google-rejected' ? 'Google did not confirm the sign-in. Try again.' : 'The sync service did not answer (' + r.status + ').');
  const old = session;
  session = { token: j.token, email: j.email };
  // Signing in again on this device (e.g. "Link Google Drive") replaces its earlier sign-in instead of adding one.
  if (old && old.token !== j.token) http(server + '/signout', { method: 'POST', headers: { Authorization: 'Bearer ' + old.token } }).catch(() => {});
  gTok = null; driveOn = null; visibleOk = null; visFolder = null;
  await db.setMeta('cloud', session);
}

// ---------------------------------------------------------------- PDFs and pictures in the person's Google Drive
// Attached files are kept in the hidden Inkleaf app folder of the person's own Google Drive (named a_<id>, as the
// older Drive sync did, so files it uploaded are found and not sent again). The sync service only hands out
// hour-long Drive passes. If the person's Drive is not linked (signed in with an older version), files stay on
// the sync service as before.
let gTok = null, driveOn = null; // {t, exp}; driveOn: null = not asked yet
async function driveToken() {
  if (gTok && Date.now() < gTok.exp - 60000) return gTok.t;
  if (driveOn === false) return null;
  const r = await http(server + '/google-token', { headers: { Authorization: 'Bearer ' + session.token } });
  if (r.status === 404) { driveOn = false; return null; }
  if (r.status === 401) { const e = new Error('Sign-in needed'); e.signin = true; throw e; }
  if (!r.ok) throw new Error('Could not reach Google Drive just now (' + r.status + ')');
  const j = await r.json();
  driveOn = true;
  gTok = { t: j.access_token, exp: j.exp || Date.now() + 3000e3 };
  return gTok.t;
}

async function drive(path, opts = {}) {
  const t = await driveToken();
  const r = await http(DRIVE + path, { ...opts, headers: { Authorization: 'Bearer ' + t, ...(opts.headers || {}) } });
  if (r.status === 401) { gTok = null; throw new Error('Google Drive refused the pass; trying again later'); }
  if (!r.ok) { const e = new Error(`Google Drive error ${r.status}`); e.status = r.status; throw e; }
  return r;
}

async function driveFind(id) {
  const q = encodeURIComponent(`name = 'a_${id}' and trashed = false`);
  const j = await (await drive(`/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,size,mimeType,description)`)).json();
  return (j.files || [])[0] || null;
}

// Files over 5 MB go up in pieces (owner, 2026-11-28: "upload in small packets ... merge in google drive"): Drive
// joins the pieces into one file. After a break (network, Drive busy) Drive is asked how much arrived and only the
// rest is sent, so a 600 MB book on a shaky connection is not sent again from the start.
let PIECE = 8 * 1048576, PIECE_WAIT = 1000; // Drive wants pieces in multiples of 256 KB
export const _setPiece = (n, wait) => { PIECE = n; if (wait != null) PIECE_WAIT = wait; }; // tests use small pieces
export const _driveUpload = (...a) => driveUpload(...a); // for the check
const ONE_GO = 5 * 1048576; // Drive's limit for a file sent in one request
// Returns Drive's answer ({id}), or null when the upload address is not readable here (then: one request).
async function driveResumable(base, method, meta, blob) {
  const size = blob.size;
  const start = await drive(base + '?uploadType=resumable&fields=id', {
    method, body: JSON.stringify(meta),
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': meta.mimeType || 'application/octet-stream', 'X-Upload-Content-Length': String(size) }
  });
  const at = start.headers.get('location');
  if (!at) return null;
  const arrived = r => { const m = /bytes=0-(\d+)/.exec(r.headers.get('range') || ''); return m ? Number(m[1]) + 1 : null; };
  let sent = 0, breaks = 0;
  for (;;) {
    const end = Math.min(sent + PIECE, size);
    let r = null;
    try { r = await http(at, { method: 'PUT', headers: { 'Content-Range': `bytes ${sent}-${end - 1}/${size}` }, body: blob.slice(sent, end) }); } catch {}
    if (r && (r.status === 200 || r.status === 201)) return r.json();
    if (r && r.status === 308) { const a = arrived(r); sent = a == null ? end : a; continue; } // piece taken
    if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
      const e = new Error(`Google Drive error ${r.status}`); e.status = r.status; throw e; // e.g. the upload address ran out
    }
    // A break: wait a little longer each time, then ask Drive how much it has.
    if (++breaks > 6) throw new Error('The upload to Google Drive kept breaking off; trying again later');
    await new Promise(res => setTimeout(res, Math.min(30000, PIECE_WAIT * 2 ** (breaks - 1))));
    try {
      const q = await http(at, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` } });
      if (q.status === 200 || q.status === 201) return q.json();
      if (q.status === 308) sent = arrived(q) ?? 0;
    } catch {}
  }
}

async function driveUpload(id, data, mime, name, fileName, metaOver) {
  const metaObj = metaOver || { name: fileName || 'a_' + id, parents: ['appDataFolder'], mimeType: mime, description: name || '' };
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  if (blob.size > ONE_GO) {
    const j = await driveResumable('/upload/drive/v3/files', 'POST', metaObj, blob);
    if (j) return j;
  }
  const boundary = 'inkleaf' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify(metaObj);
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, data, `\r\n--${boundary}--`
  ]);
  return (await drive('/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body })).json();
}

// A visible "Inkleaf" folder in the person's Drive with a copy of every PDF under its real name, so they can be
// found and opened without Inkleaf. Needs the drive.file permission; a link made by an older version lacks it,
// and then visible copies wait until the person taps "Link Google Drive" again (visibleOk = false).
let visFolder = null, visibleOk = null;
async function visibleFolder() {
  if (visFolder) return visFolder;
  const q = encodeURIComponent("mimeType = 'application/vnd.google-apps.folder' and trashed = false and appProperties has { key='inkleaf' and value='files' }");
  const j = await (await drive(`/drive/v3/files?q=${q}&fields=files(id)`)).json();
  if (j.files && j.files[0]) return (visFolder = j.files[0].id);
  const r = await (await drive('/drive/v3/files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Inkleaf', mimeType: 'application/vnd.google-apps.folder', appProperties: { inkleaf: 'files' } })
  })).json();
  return (visFolder = r.id);
}
async function visibleCopy(a) {
  if (visibleOk === false || a.mime !== 'application/pdf') return true; // only PDFs get a visible copy
  try {
    const folder = await visibleFolder();
    const q = encodeURIComponent(`trashed = false and appProperties has { key='inkleaf' and value='${a.id}' }`);
    const j = await (await drive(`/drive/v3/files?q=${q}&fields=files(id)`)).json();
    if (!(j.files && j.files[0])) {
      let name = (a.name || 'Document').replace(/[\\/]+/g, ' ').trim() || 'Document';
      if (!/\.pdf$/i.test(name)) name += '.pdf';
      await driveUpload(a.id, a.data, a.mime, '', '', { name, parents: [folder], mimeType: a.mime, appProperties: { inkleaf: a.id } });
    }
    visibleOk = true;
    return true;
  } catch (e) {
    if (e.status === 403) { visibleOk = false; return true; } // no drive.file permission on this link yet
    throw e;
  }
}

// ---------------------------------------------------------------- annotated PDFs in the person's Google Drive
// Every notebook, writing included (a PDF with its ink, or a notebook of written pages), as a PDF in the visible
// folder Inkleaf > Annotated PDFs, so it can be opened and shared from Drive without Inkleaf (owner's wish,
// 2026-11-27: "it is very important"). Made with export.js buildPdf, one notebook at a time, never while a notebook
// is open; only notebooks whose writing changed since their Drive copy are made again (the copy keeps the notebook's
// edit time in appProperties.e), and the same Drive file is replaced, so any device may do it without duplicates.
// A renamed or moved notebook only renames its file; a binned or deleted one moves its copy to the Drive bin.
// No size limit (owner's choice): every device tries every notebook. If making one ever crashes the tab (a huge PDF on
// an iPad), the mark left in localStorage (inkleaf.annTrying) shows it after the reload, and this device then leaves
// that notebook (in that state) to another device instead of crashing again and again.
const ANN_FOLDER = 'Annotated PDFs', ANN_EVERY = 20 * 60e3;
const annState = { running: false, done: 0, total: 0, current: '', made: 0, waiting: 0, crashed: 0, crashedNames: [], err: null, last: 0, inDrive: null, all: null };
// How many notebooks have an up-to-date copy in Drive, of how many (kept, so Settings shows it before the first pass).
try { Object.assign(annState, JSON.parse(localStorage.getItem('inkleaf.annCount') || '{}')); } catch {}
const annCrashed = () => { try { return JSON.parse(localStorage.getItem('inkleaf.annCrashed') || '{}'); } catch { return {}; } };
// Closing or reloading Inkleaf on purpose is not a crash: the page says goodbye first (a crashed tab never does).
addEventListener('pagehide', () => { try { localStorage.removeItem('inkleaf.annTrying'); } catch {} });
// "Try again": forget the notebooks this device gave up on, and make them now.
export function annRetry() {
  try { localStorage.removeItem('inkleaf.annCrashed'); } catch {}
  annState.crashed = 0; annState.crashedNames = [];
  return annotatedPass({ now: true });
}
{ // a mark left from the last time Inkleaf ran: making that notebook did not finish (the tab crashed or was closed)
  let t = null;
  try { t = JSON.parse(localStorage.getItem('inkleaf.annTrying') || 'null'); } catch {}
  if (t && t.id) {
    const c = annCrashed(), n = (c[t.id] && c[t.id].e === t.e ? c[t.id].n : 0) + 1;
    c[t.id] = { e: t.e, n };
    try { localStorage.setItem('inkleaf.annCrashed', JSON.stringify(c)); localStorage.removeItem('inkleaf.annTrying'); } catch {}
  }
}
let annFolderId = null, annT = 0, annAgain = false;
export const annotatedOn = () => localStorage.getItem('inkleaf.annotated') !== 'off'; // on unless turned off on this device
export function setAnnotatedOn(v) { localStorage.setItem('inkleaf.annotated', v ? 'on' : 'off'); bus.emit('annotated', annotatedStatus()); if (v) annSoon(2000); }
export const annotatedStatus = () => ({ ...annState, on: annotatedOn(), linked: driveOn !== false && visibleOk !== false });

async function annFolder() {
  if (annFolderId) return annFolderId;
  const parent = await visibleFolder();
  const q = encodeURIComponent(`mimeType = 'application/vnd.google-apps.folder' and trashed = false and appProperties has { key='inkleaf' and value='annotated' }`);
  const j = await (await drive(`/drive/v3/files?q=${q}&fields=files(id)`)).json();
  if (j.files && j.files[0]) return (annFolderId = j.files[0].id);
  const r = await (await drive('/drive/v3/files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: ANN_FOLDER, parents: [parent], mimeType: 'application/vnd.google-apps.folder', appProperties: { inkleaf: 'annotated' } })
  })).json();
  return (annFolderId = r.id);
}

// The Drive copies there now: docId -> [{id, name, e}] (more than one only if two devices made one at the same moment).
async function annList(folder) {
  const out = new Map();
  let page = '';
  do {
    const q = encodeURIComponent(`'${folder}' in parents and trashed = false`);
    const j = await (await drive(`/drive/v3/files?q=${q}&pageSize=1000&fields=nextPageToken,files(id,name,appProperties)${page ? '&pageToken=' + page : ''}`)).json();
    for (const f of j.files || []) {
      const id = f.appProperties && f.appProperties.inkleafDoc;
      if (!id) continue;
      if (!out.has(id)) out.set(id, []);
      out.get(id).push({ id: f.id, name: f.name, e: Number(f.appProperties.e) || 0 });
    }
    page = j.nextPageToken || '';
  } while (page);
  return out;
}

// Upload: small files in one request, bigger ones in pieces (driveResumable; Drive's limit for one request is 5 MB).
async function annUpload(fileId, meta, blob) {
  const base = fileId ? `/upload/drive/v3/files/${fileId}` : '/upload/drive/v3/files', method = fileId ? 'PATCH' : 'POST';
  const multipart = async () => {
    const boundary = 'inkleaf' + Math.random().toString(36).slice(2);
    const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`, blob, `\r\n--${boundary}--`]);
    return (await drive(base + '?uploadType=multipart&fields=id', { method, headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body })).json();
  };
  if (blob.size <= ONE_GO) return multipart();
  return (await driveResumable(base, method, meta, blob)) || multipart(); // address not readable here: one request
}

// A notebook's name in Drive: its folders, then its title ("Polity - Laxmikanth.pdf"), so Drive sorts them by folder.
function annName(doc, folders) {
  const parts = [doc.title || 'Notebook'];
  for (let f = folders.get(doc.folderId), n = 0; f && n < 20; f = folders.get(f.parentId), n++) parts.unshift(f.name || 'Folder');
  return parts.join(' - ').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) + '.pdf';
}
const annBinned = (doc, folders) => {
  if (doc.deleted || doc.trashed || doc.sys) return true;
  for (let f = folders.get(doc.folderId), n = 0; f && n < 20; f = folders.get(f.parentId), n++) if (f.deleted || f.trashed) return true;
  return false;
};

function annSoon(ms = 15000) { clearTimeout(annT); annT = setTimeout(() => annotatedPass().catch(() => {}), ms); }

// opts.now ("Update now"): also when Inkleaf is in the background, and after a pass already under way.
let annRun = null;
export async function annotatedPass(opts = {}) {
  while (annRun) { if (!opts.now) { annAgain = true; return annotatedStatus(); } await annRun.catch(() => {}); }
  annRun = annWork(opts);
  try { return await annRun; } finally { annRun = null; }
}
async function annWork(opts) {
  if (!annotatedOn() || !ready() || openDocs.size || (!opts.now && document.visibilityState !== 'visible')) return annotatedStatus();
  if (!(await driveToken().catch(() => null))) return annotatedStatus();
  Object.assign(annState, { running: true, done: 0, total: 0, current: '', made: 0, waiting: 0, crashed: 0, crashedNames: [], err: null });
  bus.emit('annotated', annotatedStatus());
  try {
    const folder = await annFolder();
    const remote = await annList(folder);
    const [docs, folderRecs] = await Promise.all([db.all('docs'), db.all('folders')]);
    const folders = new Map(folderRecs.map(f => [f.id, f]));
    const todo = [];
    let all = 0, fresh = 0;
    for (const doc of docs) {
      const copies = remote.get(doc.id) || [];
      if (annBinned(doc, folders)) {
        for (const c of copies) await drive(`/drive/v3/files/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
        continue;
      }
      for (const c of copies.slice(1)) await drive(`/drive/v3/files/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
      const recs = await db.byDoc(doc.id);
      const stamp = Math.max(editedAt(doc), ...recs.map(p => p.modified || 0));
      const name = annName(doc, folders), copy = copies[0];
      all++;
      if (copy && copy.e >= stamp) {
        fresh++;
        if (copy.name !== name) await drive(`/drive/v3/files/${copy.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        continue;
      }
      todo.push({ doc, stamp, name, copy });
    }
    todo.sort((a, b) => b.stamp - a.stamp); // the latest writing first
    annState.total = todo.length;
    Object.assign(annState, { all, inDrive: fresh });
    bus.emit('annotated', annotatedStatus());
    const { buildPdf } = todo.length ? await import('./export.js') : {};
    for (const t of todo) {
      if (openDocs.size || !ready() || !annotatedOn()) break; // a notebook was opened: carry on later
      annState.current = t.doc.title || 'Notebook';
      bus.emit('annotated', annotatedStatus());
      const pages = await loadPages(t.doc);
      // Every PDF must be on this device, or its pages would be missing from the copy; another device (or this
      // one, once the files have arrived) makes it then.
      let missing = false;
      for (const aid of new Set(pages.filter(p => p.pdf).map(p => p.pdf.a))) {
        const a = await db.get('assets', aid);
        if (!a || !a.data) missing = true;
      }
      if (!pages.length || missing) { annState.waiting++; annState.done++; continue; }
      // Twice crashed here in this state: leave it to another device (new writing in it means a fresh try).
      const cr = annCrashed()[t.doc.id];
      if (cr && cr.e === t.stamp && cr.n >= 2) { annState.crashed++; annState.crashedNames.push(t.doc.title || 'Notebook'); annState.done++; continue; }
      try { localStorage.setItem('inkleaf.annTrying', JSON.stringify({ id: t.doc.id, e: t.stamp })); } catch {}
      try {
        const blob = await buildPdf(t.doc, pages);
        const meta = { name: t.name, mimeType: 'application/pdf', appProperties: { inkleafDoc: t.doc.id, e: String(t.stamp) } };
        await annUpload(t.copy && t.copy.id, t.copy ? meta : { ...meta, parents: [folder] }, blob);
        annState.made++; annState.inDrive++;
      } catch (e) {
        if (e.status === 401 || e.status === 403 || !navigator.onLine) throw e; // Drive itself is the problem: stop
        annState.err = { t: Date.now(), msg: `"${t.doc.title || 'Notebook'}" could not be made: ${e.message || e}` }; // the others go on
      } finally { try { localStorage.removeItem('inkleaf.annTrying'); } catch {} }
      annState.done++;
      bus.emit('annotated', annotatedStatus());
      await new Promise(r => setTimeout(r, 300)); // let the app breathe between notebooks
    }
  } catch (e) {
    annState.err = { t: Date.now(), msg: e.status === 403 ? 'Google Drive needs one more permission (Settings > Link Google Drive again)' : String(e.message || e) };
    if (e.status === 403) visibleOk = false;
  } finally {
    annState.running = false; annState.current = ''; annState.last = Date.now();
    if (annState.all != null) try { localStorage.setItem('inkleaf.annCount', JSON.stringify({ inDrive: annState.inDrive, all: annState.all })); } catch {}
    bus.emit('annotated', annotatedStatus());
    if (annAgain) { annAgain = false; annSoon(5000); }
  }
  return annotatedStatus();
}

export async function signOut() {
  const s = session;
  session = null;
  closeLive();
  clearTimeout(loopT);
  clearTimeout(pushT);
  clearTimeout(pullT);
  gTok = null; driveOn = null; visibleOk = null; visFolder = null;
  cachedSharedItems = null; cachedMyShares = null;
  lastSharedFetch = 0; lastMySharesFetch = 0;
  inFlightDocs.clear(); inFlightFolders.clear();
  pendingDocs.clear(); pendingFolders.clear();
  assetDocs.clear(); readyAssets.clear();
  docFolderMap = null; folderParentMap = null;
  staleDocMeta.clear(); staleFolderMeta.clear();
  st = {}; cursor = 0;
  await db.setMeta('cloud', null);
  await db.setMeta('cloudState', {});
  await db.setMeta('cloudCursor', 0);
  await db.setMeta('shared_items', []);
  await db.setMeta('my_shares', []);
  await db.setMeta('my_shared_folders', []);
  await db.setMeta('lastSync', 0);
  setStatus('signin', 'Signed out. Tap to sign in with Google and start live sync.');
  scheduleTargetsUpdate();
  bus.emit('synced');
  if (s) http(server + '/signout', { method: 'POST', headers: { Authorization: 'Bearer ' + s.token } }).catch(() => {});
}

// Today's use of Cloudflare's free daily limits, as Cloudflare itself counts it: the sync service asks Cloudflare's
// analytics (GET /meter, no sign-in, answers even when the day's rows have run out). Never a guess: a figure that
// could not be read stays null and is shown as "not known". On 2026-11-27 the old count (requests, 9% used) looked
// fine while the real limit, rows read, had run out.
const METER_NAMES = { rowsRead: 'rows read', rowsWritten: 'rows written', requests: 'requests' };
let meterLast = null; // { ...answer, got: when this device got it } or { ok: false, why: 'offline' | 'no-answer' }
export const lastMeter = () => meterLast;
export const meterParts = m => Object.keys(METER_NAMES).map(k => {
  const used = m && m.used ? m.used[k] : null, limit = (m && m.limits && m.limits[k]) || 0;
  return { k, name: METER_NAMES[k], used, limit, pct: used == null || !limit ? null : used / limit * 100 };
});
// When the limits start again, on this device's clock ("5:30 am").
export const meterResetAt = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
export const shortNum = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : Math.round(n).toLocaleString();

export async function readMeter() {
  if (!navigator.onLine) meterLast = { ok: false, why: 'offline' };
  else {
    try {
      const r = await http(server + '/meter');
      const j = await r.json();
      meterLast = { ...j, got: Date.now() };
    } catch { meterLast = { ok: false, why: 'no-answer' }; }
  }
  bus.emit('meter', meterLast);
  warnMeter(meterLast);
  return meterLast;
}

// One message per level (50%, 80%, used up) per day, for the figure closest to its limit.
function warnMeter(m) {
  if (!m || !m.ok) return;
  const top = meterParts(m).filter(x => x.pct != null).sort((a, b) => b.pct - a.pct)[0];
  if (!top) return;
  const level = top.pct >= 100 ? 100 : top.pct >= 80 ? 80 : top.pct >= 50 ? 50 : 0;
  let warned = {};
  try { warned = JSON.parse(localStorage.getItem('inkleaf.meterWarned') || '{}'); } catch {}
  if (warned.day !== m.day) warned = { day: m.day, level: 0 };
  if (level <= (warned.level || 0)) return;
  try { localStorage.setItem('inkleaf.meterWarned', JSON.stringify({ day: m.day, level })); } catch {}
  const fig = `${shortNum(top.used)} of ${shortNum(top.limit)} ${top.name}`;
  toast(level >= 100
    ? `Cloudflare's free limit for today is used up (${fig}). Sync pauses; your notes are safe on this device. It starts again at ${meterResetAt()}.`
    : `Cloudflare: ${Math.floor(top.pct)}% of today's free ${top.name} used (${fig}). It starts again at ${meterResetAt()}. Details: Settings > Sync.`, 12000);
}

// Cloudflare sync request usage tracking
export function getCfUsage() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const raw = localStorage.getItem('inkleaf.cfUsage');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.date === today) {
        if (typeof parsed.totalCalls !== 'number') parsed.totalCalls = parsed.calls || 0;
        return parsed;
      }
    }
  } catch {}
  const fresh = { date: today, calls: 0, totalCalls: 0, limit: 100000, monthlyLimit: 1000000, users: null };
  try { localStorage.setItem('inkleaf.cfUsage', JSON.stringify(fresh)); } catch {}
  return fresh;
}

export function updateCfUsageFromServer(serverCalls, serverLimit, merged = true, serverTotal = null, serverUsers = null) {
  const usage = getCfUsage();
  let changed = false;
  if (typeof serverCalls === 'number' && serverCalls >= (usage.calls || 0)) {
    usage.calls = serverCalls;
    changed = true;
  }
  if (Array.isArray(serverUsers)) {
    usage.users = serverUsers.map(x => ({
      me: !!x.me,
      label: x.label,
      cfCalls: x.me ? Math.max(Number(x.cfCalls) || 0, usage.calls || 0) : (Number(x.cfCalls) || 0)
    }));
    changed = true;
  } else if (Array.isArray(usage.users)) {
    const me = usage.users.find(x => x.me);
    if (me && (usage.calls || 0) > (me.cfCalls || 0)) {
      me.cfCalls = usage.calls;
      changed = true;
    }
  }
  const usersSum = Array.isArray(usage.users) ? usage.users.reduce((s, x) => s + (x.cfCalls || 0), 0) : 0;
  const bestTotal = Math.max(usage.totalCalls || 0, typeof serverTotal === 'number' ? serverTotal : 0, usage.calls || 0, usersSum);
  if (bestTotal !== (usage.totalCalls || 0)) {
    usage.totalCalls = bestTotal;
    changed = true;
  }
  if (typeof serverLimit === 'number' && serverLimit > 0) {
    usage.limit = serverLimit;
    changed = true;
  }
  if (merged) {
    usage.merged = true;
    changed = true;
  }
  if (changed) {
    try { localStorage.setItem('inkleaf.cfUsage', JSON.stringify(usage)); } catch {}
    bus.emit('cf-usage', usage);
  }
  return usage;
}

export function recordCfCall(endpoint = '') {
  const usage = getCfUsage();
  usage.calls = (usage.calls || 0) + 1;
  if (Array.isArray(usage.users)) {
    const me = usage.users.find(x => x.me);
    if (me) me.cfCalls = Math.max(me.cfCalls || 0, usage.calls);
  }
  const usersSum = Array.isArray(usage.users) ? usage.users.reduce((s, x) => s + (x.cfCalls || 0), 0) : 0;
  usage.totalCalls = Math.max((usage.totalCalls || 0) + 1, usage.calls, usersSum);
  usage.lastCall = Date.now();
  usage.lastEndpoint = endpoint;
  try {
    localStorage.setItem('inkleaf.cfUsage', JSON.stringify(usage));
  } catch {}
  bus.emit('cf-usage', usage);
  return usage;
}

export async function call(path, opts = {}) {
  if (!session) { const e = new Error('Sign-in needed'); e.signin = true; throw e; }
  recordCfCall(path);
  const r = await http(server + path, { ...opts, headers: { Authorization: 'Bearer ' + session.token, ...(opts.headers || {}) } });
  const cfH = r.headers.get('x-cf-calls-today');
  const cfTotH = r.headers.get('x-cf-total-today');
  const ocrH = r.headers.get('x-ocr-calls-today');
  const ocrTotH = r.headers.get('x-ocr-total-today');
  if (cfH || cfTotH) updateCfUsageFromServer(cfH ? Number(cfH) : null, 100000, true, cfTotH ? Number(cfTotH) : null);
  if (ocrH || ocrTotH) updateHwUsageFromServer(ocrH ? Number(ocrH) : null, 1500, ocrTotH ? Number(ocrTotH) : null);
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
    const raw = (await r.text().catch(() => '')).slice(0, 300);
    let msg = raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.message) msg = parsed.message;
    } catch {}
    if (msg.includes('Exceeded allowed rows read') || msg.includes('Durable Objects free tier')) {
      msg = 'Cloudflare free tier daily limit reached (rows read). Your notes are safe on this device and sync will resume automatically once quota resets.';
    }
    const e = new Error(`Sync service error ${r.status}: ${msg}`);
    e.status = r.status;
    e.serverMessage = msg;
    throw e;
  }
  return r;
}

export async function syncOcr(imageB64, n = 1, model = 'gemini-4-hydrogen') {
  if (!session || !navigator.onLine) return null;
  try {
    const r = await call('/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageB64, n, model })
    });
    const j = await r.json().catch(() => null);
    return j && j.text ? j.text : null;
  } catch (e) {
    return { error: e.status ? `HTTP_${e.status}` : 'network-failed', detail: e.serverMessage || e.message };
  }
}
setCloudOcr(syncOcr);
setDirectOcrReport(() => {
  if (session && !off && navigator.onLine) call('/usage-ocr', { method: 'POST' }).catch(() => {});
});

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
  const eL = editedAt(L), eR = editedAt(R), Rlater = R.modified >= L.modified;
  const [nu, old] = (eL === eR ? Rlater : eR > eL) ? [R, L] : [L, R]; // the later real change wins, however recently the other was read
  if (nu.deleted || old.deleted) return nu;
  const have = new Set(nu.pages || []);
  const extra = (old.pages || []).filter(id => !have.has(id) && !(gone && gone.has(id)));
  const cards = mergeCards(nu, old);
  const lastOpened = Math.max(nu.lastOpened || 0, old.lastOpened || 0);
  const lastPage = (nu.lastOpened || 0) >= (old.lastOpened || 0) ? (nu.lastPage || old.lastPage || 0) : (old.lastPage || nu.lastPage || 0);
  const thumb = (Rlater ? R.thumb || L.thumb : L.thumb || R.thumb) || null;
  // Nothing to add to the newer one: hand it back untouched. (A fresh copy here made every device think there was
  // something to upload, so two devices kept sending each other the same notebook without end.)
  if (!extra.length && !cards && lastOpened === (nu.lastOpened || 0) && lastPage === (nu.lastPage || 0) && thumb === (nu.thumb || null)) return nu;
  const t = Math.max(Date.now(), (nu.modified || 0) + 1, (old.modified || 0) + 1);
  const out = { ...nu, modified: t, rd: { m: t, e: editedAt(nu) } };
  if (extra.length) out.pages = [...(nu.pages || []), ...extra];
  if (cards) Object.assign(out, cards);
  if (lastOpened) out.lastOpened = lastOpened;
  if (lastPage) out.lastPage = lastPage;
  if (thumb) out.thumb = thumb;
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
  const targetDoc = kind === 'd' ? rec.id : kind === 'p' ? rec.docId : null;
  const targetFolder = kind === 'f' ? rec.id : null;
  if (targetDoc) { inFlightDocs.add(targetDoc); scheduleTargetsUpdate(); }
  if (targetFolder) { inFlightFolders.add(targetFolder); scheduleTargetsUpdate(); }
  try {
    for (let tries = 0; tries < 4; tries++) {
      const s = st[name];
      try {
        const { bytes, gz } = await encode(rec);
        const info = (kind === 'p' && rec.docId) ? JSON.stringify({ docId: rec.docId }) : undefined;
        const j = await putBlob(kind, rec.id, bytes, { base: s ? s.s : 0, gz, info });
        st[name] = { lm: rec.modified, s: j.s };
        if (kind === 'd') pendingDocs.delete(rec.id);
        if (kind === 'f') pendingFolders.delete(rec.id);
        health.sent = Date.now();
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
  } finally {
    if (targetDoc) inFlightDocs.delete(targetDoc);
    if (targetFolder) inFlightFolders.delete(targetFolder);
    scheduleTargetsUpdate();
  }
}

// Where a file is kept: under 500 MB on the sync service (fast edge CDN to fetch on every device),
// bigger ones in the hidden app folder of the person's Google Drive. Every PDF also gets a visible copy in
// the "Inkleaf" folder of their Drive, so Drive always holds a whole copy. If the service is full, a file goes to Drive instead.
let BIG = 500 * 1048576;
export const _setBig = n => { BIG = n; }; // tests use a small limit
function assetPlaced(s, linked) {
  if (!s || s.sz == null) return false;
  const kept = s.sz < BIG || !linked ? !!s.s || (s.full && !!s.drive) : !!s.drive;
  return kept && (!linked || s.vis || visibleOk === false);
}

async function pushAsset(id) {
  const name = 'a_' + id, linked = !!(await driveToken());
  if (assetPlaced(st[name], linked)) return;
  const a = await db.get('assets', id);
  if (!a || a.deleted || !a.data) return;
  const cur = { ...(st[name] || {}), sz: a.data.byteLength };
  const info = JSON.stringify({ mime: a.mime || '', name: a.name || '' });
  if ((cur.sz < BIG || !linked) && !cur.s && !cur.full) {
    try { cur.s = (await putBlob('a', id, new Uint8Array(a.data), { info })).s; }
    catch (e) { if (e.status !== 507 || !linked) throw e; cur.full = 1; } // the service is full: Drive takes it
  }
  if (linked && (cur.sz >= BIG || cur.full) && !cur.drive) {
    if (!await driveFind(id)) await driveUpload(id, a.data, a.mime || 'application/octet-stream', a.name || '');
    cur.drive = 1;
  }
  if (linked && cur.sz >= BIG) { // a big file does not stay on the service
    const r = await http(server + '/meta/a/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + session.token } });
    if (r.ok) await call('/blob/a/' + encodeURIComponent(id) + '?moved=1', { method: 'DELETE' }).catch(() => {});
    delete cur.s;
  }
  if (linked && (a.mime !== 'application/pdf' || (await visibleCopy(a) && visibleOk))) cur.vis = 1;
  st[name] = cur;
  health.sent = Date.now();
}

// Fetch a file this device lacks. Checks Cloudflare sync service first (fast edge CDN), then falls back to Drive.
async function pullAsset(id, item) {
  const name = 'a_' + id;
  const have = await db.get('assets', id);
  if (have && (have.data || have.deleted)) { readyAssets.add(id); if (!st[name]) st[name] = item && item.s ? { s: item.s } : { drive: 1 }; return false; }
  let rec = null;

  // 1. Try Cloudflare sync service first (super fast CDN edge streaming)
  if (!item || !item.parts) {
    try {
      const r = await http(server + '/meta/a/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + session.token } });
      if (r.ok) item = await r.json();
    } catch {}
  }
  if (item && item.parts) {
    try {
      const bytes = await getBlob(item);
      let info = {};
      try { info = JSON.parse(item.info || '{}'); } catch {}
      rec = { id, mime: info.mime || 'application/octet-stream', name: info.name || '', data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), modified: Date.now() };
      st[name] = { lm: rec.modified, s: item.s };
    } catch (e) {
      console.warn('Failed to fetch asset from sync service, trying Drive fallback', e);
    }
  }

  // 2. If not on sync service or failed, fall back to Google Drive
  if (!rec && await driveToken()) {
    try {
      const f = await driveFind(id);
      if (f) {
        const data = await (await drive(`/drive/v3/files/${f.id}?alt=media`)).arrayBuffer();
        rec = { id, mime: f.mimeType || 'application/octet-stream', name: f.description || '', data, modified: Date.now() };
        st[name] = { drive: 1 };
      }
    } catch (e) {
      console.warn('Failed to fetch asset from Google Drive', e);
    }
  }

  if (!rec) return false;
  await db.put('assets', rec, true);
  readyAssets.add(id);
  bus.emit('remote-record', { kind: 'a', rec: { id } });
  return true;
}

// Files the pages here use but this device does not have yet (they arrive by Drive, not in the change feed).
// Deduplicates by asset id first so a multi-hundred-page PDF triggers at most one IndexedDB lookup (and zero once cached).
async function fetchMissingFiles(pages, priority = false) {
  const byAsset = new Map();
  for (const p of pages) {
    if (p.deleted) continue;
    for (const id of assetIdsOf([p])) {
      let set = byAsset.get(id);
      if (!set) byAsset.set(id, set = new Set());
      if (p.docId) set.add(p.docId);
    }
  }
  for (const [id, docIds] of byAsset) {
    if (docIds.size) {
      let ad = assetDocs.get(id);
      if (!ad) assetDocs.set(id, ad = new Set());
      for (const did of docIds) ad.add(did);
    }
    if (readyAssets.has(id)) continue;
    const a = await db.get('assets', id);
    if (a && (a.data || a.deleted)) readyAssets.add(id);
    else queueAsset(id, 'pull', priority);
  }
}

// Attached files (PDFs, pictures) can be large. Moved in parallel with up to 6 simultaneous transfers
// for maximum speed, with priority given to the currently open notebook/PDF/folder.
const assetQ = [], assetBusy = new Set(), assetRetry = new Map();
let assetActive = 0;
const CONCURRENT_ASSETS = 6;
const IDLE_TEXT = 'Live sync is on. Everything is up to date.';
const FILES_TEXT = 'Live sync is on. Still transferring files (PDFs, pictures)...';

function setIdle() {
  syncFailCount = 0;
  if (assetActive || assetQ.length) setStatus('syncing', FILES_TEXT); else setStatus('ok', IDLE_TEXT);
}

// job: 'up' to upload a local file, or the feed entry to download.
// priority: true jumps to the very front of the queue (e.g. for open notebook or folder)
function queueAsset(id, job, priority = false, docId = null) {
  if (docId) {
    if (!assetDocs.has(id)) assetDocs.set(id, new Set());
    assetDocs.get(id).add(docId);
  }
  const r = assetRetry.get(id);
  if (r && r.at > Date.now()) return;
  const existingIdx = assetQ.findIndex(([qid]) => qid === id);
  if (existingIdx !== -1) {
    if (priority && existingIdx > 0) {
      const item = assetQ.splice(existingIdx, 1)[0];
      assetQ.unshift(item);
    }
    scheduleTargetsUpdate();
    return;
  }
  if (assetBusy.has(id)) { scheduleTargetsUpdate(); return; }
  assetBusy.add(id);
  if (priority) assetQ.unshift([id, job]);
  else assetQ.push([id, job]);
  pumpAssets();
  scheduleTargetsUpdate();
}

function pumpAssets() {
  while (assetActive < CONCURRENT_ASSETS && assetQ.length) {
    const [id, job] = assetQ.shift();
    assetActive++;
    (job === 'up' ? pushAsset(id) : pullAsset(id, job))
      .then(() => { assetRetry.delete(id); saveState(); })
      .catch(e => {
        assetRetry.set(id, { at: Date.now() + 30000, job });
        if (!e.signin) { console.warn('File transfer failed and will be retried', e); health.err = { t: Date.now(), msg: 'A file (PDF or picture) could not be transferred; it is tried again shortly. ' + (e.message || '') }; }
      })
      .finally(() => {
        assetBusy.delete(id);
        assetActive--;
        pumpAssets();
        if (!assetActive && !assetQ.length && status.state === 'syncing') setIdle();
        scheduleTargetsUpdate();
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
  let targetDoc = kind === 'd' ? item.id : null;
  const targetFolder = kind === 'f' ? item.id : null;
  if (kind === 'p' && item.info) {
    try { targetDoc = JSON.parse(item.info).docId || null; } catch {}
  }
  if (targetDoc) { inFlightDocs.add(targetDoc); scheduleTargetsUpdate(); }
  if (targetFolder) { inFlightFolders.add(targetFolder); scheduleTargetsUpdate(); }
  try {
    let R = null;
    try { R = await decode(await getBlob(item), item.gz); } catch (e) { if (e.signin || e.status || e.name === 'TypeError') throw e; }
    if (!R || R.id !== item.id) { st[name] = { lm: -1, s: item.s }; console.warn('Skipped an unreadable record', name); return false; }
    if (kind === 'p' && !targetDoc && R.docId) { targetDoc = R.docId; inFlightDocs.add(targetDoc); scheduleTargetsUpdate(); }
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
    if (kind === 'd' && docFolderMap) {
      if (m.deleted) docFolderMap.delete(m.id); else docFolderMap.set(m.id, m.folderId || null);
    } else if (kind === 'f' && folderParentMap) {
      if (m.deleted) folderParentMap.delete(m.id); else folderParentMap.set(m.id, m.parentId || null);
    }
    if (m !== R) await pushRecord(kind, m);
    bus.emit('remote-record', { kind, rec: m });
    if (kind === 'p') fetchMissingFiles([m]).catch(() => {});
    return true;
  } finally {
    if (targetDoc) inFlightDocs.delete(targetDoc);
    if (targetFolder) inFlightFolders.delete(targetFolder);
    scheduleTargetsUpdate();
  }
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
        readyAssets.delete(it.id);
        if (used.has(it.id)) queueAsset(it.id, 'up');
        else if (await db.get('assets', it.id)) await db.put('assets', { id: it.id, deleted: true, modified: Date.now() }, true);
      }
    }
    if (j.items.length) cursor = Math.max(cursor, ...j.items.map(i => i.s));
    if (!j.more) break;
  }
  health.checked = Date.now();
  saveState();
  return changed;
}

// Everything, both directions: bring in what is new there, then send whatever here is not there yet.
// Used at start-up, on demand, and for library changes.
async function fullPass() {
  const changed = await pullChanges();
  for (const kind of ['f', 'd', 'p']) {
    const locals = await db.all(STORES[kind]);
    await pool(6, locals, async L => {
      const s = st[kind + '_' + L.id];
      if (!s || s.lm !== L.modified) await pushRecord(kind, L);
    });
  }
  const dels = (await db.getMeta('assetDels')) || [];
  const gLinked = !!(await driveToken().catch(() => null));
  for (const id of dels) {
    await removeBlob('a', id).catch(() => {});
    if (gLinked) { const f = await driveFind(id).catch(() => null); if (f) await drive('/drive/v3/files/' + f.id, { method: 'DELETE' }).catch(() => {}); }
    delete st['a_' + id];
  }
  if (dels.length) await db.setMeta('assetDels', []);
  // Every file here goes to Drive once it is linked (files older versions put on the sync service move across);
  // files the pages use but this device lacks are fetched.
  const linked = !!(await driveToken().catch(() => null));
  for (const id of await db.keys('assets')) if (!assetPlaced(st['a_' + id], linked)) queueAsset(id, 'up');
  await fetchMissingFiles(await db.all('pages'));
  saveState();
  return changed;
}

// Upload what changed in one notebook (the one being written in). only = ids of the pages saved since the last
// push; reading just those back, not the whole notebook, keeps writing smooth in long notebooks.
export async function pushDoc(docId, only) {
  inFlightDocs.add(docId);
  scheduleTargetsUpdate();
  try {
    const pages = only
      ? (await Promise.all([...only].map(id => db.get('pages', id)))).filter(p => p && p.docId === docId)
      : await db.byDoc(docId);
    for (const p of pages) {
      if (p.deleted) continue;
      if (p.pdf && !st['a_' + p.pdf.a]) queueAsset(p.pdf.a, 'up', false, docId);
      if (p.bg && !st['a_' + p.bg.a]) queueAsset(p.bg.a, 'up', false, docId);
      for (const it of p.items || []) if (it.t === 'im' && !st['a_' + it.a]) queueAsset(it.a, 'up', false, docId);
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
  } finally {
    inFlightDocs.delete(docId);
    pendingDocs.delete(docId);
    scheduleTargetsUpdate();
  }
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
    if (m.live) bus.emit('live-message', m);
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
let syncFailCount = 0;

function fail(e, interactive) {
  syncFailCount++;
  inFlightDocs.clear();
  inFlightFolders.clear();
  pendingDocs.clear();
  pendingFolders.clear();
  if (!e.signin && e.name !== 'TypeError' && navigator.onLine) health.err = { t: Date.now(), msg: e.message };
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
      if (!assetActive && !assetQ.length) {
        pendingDocs.clear();
        pendingFolders.clear();
      }
      setIdle();
      scheduleTargetsUpdate();
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
  const base = wsLive ? POLL_LIVE : openDocs.size ? POLL_NOLIVE : POLL_IDLE;
  const delay = syncFailCount > 0 ? Math.min(60000, base * Math.pow(1.8, Math.min(syncFailCount, 4))) : base;
  loopT = setTimeout(tick, delay);
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
// Folders saved here since the last push. While a notebook is open only it is pushed, so a folder change (a colour, a
// folder made from the editor) waited until it closed; these go up with it now.
const savedFolders = new Set();

function pushNow() {
  const ids = [...openDocs], seq = writeSeq, only = savedPages, folders = [...savedFolders];
  savedPages = new Set();
  savedFolders.clear();
  return run(async () => {
    if (!ids.length) return fullPass();
    for (const id of folders) {
      const f = await db.get('folders', id), s = st['f_' + id];
      if (f && (!s || s.lm !== f.modified)) await pushRecord('f', f);
    }
    for (const id of ids) await pushDoc(id, only);
    return false;
  }, false)
    .then(ok => {
      if (ok) pushedSeq = Math.max(pushedSeq, seq);
      else { savedPages = null; for (const id of folders) savedFolders.add(id); }
    });
}

// A full pass also sends everything saved before it started, so those saves no longer count as waiting.
function fullRun(interactive) {
  const seq = writeSeq;
  return run(fullPass, interactive).then(ok => { if (ok) pushedSeq = Math.max(pushedSeq, seq); return ok; });
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
  const ok = await fullRun(interactive);
  if (ok && interactive) toast('Synced');
  openLive();
  schedule();
}

let wired = false;
export async function initSync() {
  const cfg = (await db.getMeta('sync')) || {};
  off = !!cfg.off;
  server = (await db.getMeta('cloudServer')) || SERVER; // a test server can be set here
  gTok = null; driveOn = null; visibleOk = null; visFolder = null; // ask Google afresh (a new link may have added permissions)
  session = (await db.getMeta('cloud')) || null;
  st = (await db.getMeta('cloudState')) || {};
  cursor = (await db.getMeta('cloudCursor')) || 0;

  if (!wired) {
    wired = true;
    bus.on('db-write', w => {                                                     // something was saved locally
      writeSeq++;
      if (w && w.s === 'assets') for (const id of w.ids || []) readyAssets.delete(id);
      if (w && w.s === 'docs' && docFolderMap) for (const id of w.ids || []) staleDocMeta.add(id);
      if (w && w.s === 'folders' && folderParentMap) for (const id of w.ids || []) staleFolderMeta.add(id);
      if (savedPages && w && w.s === 'pages') for (const id of w.ids) savedPages.add(id);
      if (w && w.s === 'folders') for (const id of w.ids || []) savedFolders.add(id);
      if (session && !off) {
        if (w && Array.isArray(w.docIds)) for (const id of w.docIds) pendingDocs.add(id);
        if (w && Array.isArray(w.folderIds)) for (const id of w.folderIds) pendingFolders.add(id);
        pushSoon();
      }
    });
    bus.on('editor-open', async (id, pages) => {
      openDocs.add(id);
      try {
        const docPages = Array.isArray(pages) ? pages : await db.byDoc(id);
        await fetchMissingFiles(docPages, true); // Prioritize open notebook/PDF assets
      } catch {}
      if (ready()) { run(pullChanges, false); }
      schedule();
    });
    bus.on('editor-close', id => { openDocs.delete(id); schedule(); annSoon(); }); // annotated PDF in Drive, soon after
    bus.on('folder-open', async folderId => {
      try {
        const docs = (await db.all('docs')).filter(d => !d.deleted && !d.trashed && (folderId ? d.folderId === folderId : true));
        const allPages = (await Promise.all(docs.map(d => db.byDoc(d.id)))).flat();
        await fetchMissingFiles(allPages, true); // Prioritize open folder's notebooks
      } catch {}
    });
    window.addEventListener('online', () => { if (ready()) { fullRun(false); openLive(); } });
    setTimeout(() => autoBackup(), 8000);          // weekly snapshot, if one is due
    setInterval(() => autoBackup(), 3600e3);
    // Cloudflare's free limits: checked soon after opening, then every 30 minutes while on screen (one small
    // request each; the service asks Cloudflare at most every 5 minutes for everyone together).
    const meterNow = () => { if (session && !off && document.visibilityState === 'visible') readMeter().catch(() => {}); };
    setTimeout(meterNow, 10000);
    setInterval(meterNow, 1800e3);
    // Annotated PDFs in Google Drive: a minute after opening, then every 20 minutes (only changed notebooks).
    setTimeout(() => annSoon(0), 60000);
    setInterval(() => annSoon(0), ANN_EVERY);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') pushSoon(0);                       // leaving: upload right away
      else if (ready()) { openLive(); run(pullChanges, false); schedule(); }
    });
  }

  closeLive();
  if (off) { setStatus('off', 'Sync is turned off on this device'); clearTimeout(loopT); return; }
  if (!session) { setStatus('signin', 'Tap to sign in with Google once and start live sync.'); clearTimeout(loopT); return; }
  fullRun(false);
  openLive();
  syncUserSettings().catch(() => {});
  schedule();
}

export async function syncUserSettings() {
  if (!session || off) return;
  try {
    const res = await http(server + '/settings', {
      headers: { Authorization: 'Bearer ' + session.token }
    });
    if (res.ok) {
      const data = await res.json();
      const localKey = localStorage.getItem('inkleaf.geminiKey') || '';
      if (!localKey && data.geminiKey) {
        localStorage.setItem('inkleaf.geminiKey', data.geminiKey);
      } else if (localKey && localKey !== data.geminiKey) {
        pushUserSettings({ geminiKey: localKey });
      }
      // The model choice is sent up the moment it is changed in Settings, so the server holds the latest one and wins
      // ('auto' included). This device's choice goes up only when the server has none; if each device pushed its own,
      // a choice made on one device would be undone by the next device that syncs.
      const localModel = localStorage.getItem('inkleaf.geminiModel') || 'auto';
      if (data.geminiModel) {
        if (data.geminiModel !== localModel) setHwModel(data.geminiModel);
      } else if (localModel !== 'auto') {
        pushUserSettings({ geminiModel: localModel });
      }
    }
  } catch {}
}

export async function pushUserSettings({ geminiKey, geminiModel }) {
  if (!session || off) return;
  try {
    await http(server + '/settings', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + session.token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ geminiKey, geminiModel })
    });
  } catch {}
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

export async function getLiveShare(docId) {
  if (!session || !navigator.onLine) return { shared: false };
  try {
    const r = await call('/share/' + encodeURIComponent(docId));
    return r.ok ? await r.json() : { shared: false };
  } catch { return { shared: false }; }
}

export async function startLiveShare(docId, canWrite = false, allowedEmails = '', extra = {}) {
  if (!session) throw new Error('Sign in to sync before sharing a live link');
  await pushDoc(docId).catch(() => {});
  const r = await call('/share/' + encodeURIComponent(docId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      canWrite: !!canWrite,
      allowedEmails: String(allowedEmails || '').trim(),
      title: extra.title || '',
      cover: extra.cover || '',
      kind: extra.kind || 'd',
      folderId: extra.folderId || '',
      folderName: extra.folderName || ''
    })
  });
  if (!r.ok) throw new Error('Could not create live share');
  const res = await r.json();
  try {
    const cur = new Set((await db.getMeta('my_shares')) || []);
    cur.add(docId);
    await db.setMeta('my_shares', [...cur]);
    const d = await db.get('docs', docId);
    if (d) { d.shared = true; await db.put('docs', d); }
  } catch {}
  return res;
}

export async function setLiveSharePerm(docId, canWrite, allowedEmails, extra = {}) {
  const payload = { canWrite: !!canWrite };
  if (allowedEmails !== undefined) payload.allowedEmails = String(allowedEmails || '').trim();
  if (extra.title) payload.title = extra.title;
  if (extra.cover) payload.cover = extra.cover;
  if (extra.kind) payload.kind = extra.kind;
  if (extra.folderId) payload.folderId = extra.folderId;
  if (extra.folderName) payload.folderName = extra.folderName;
  const r = await call('/share/' + encodeURIComponent(docId) + '/permission', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return r.ok;
}

let lastSharedFetch = 0, lastMySharesFetch = 0;
let cachedSharedItems = null, cachedMyShares = null;

export async function fetchSharedWithMe(force = false) {
  if (!session) {
    try { return (await db.getMeta('shared_items')) || []; } catch { return []; }
  }
  const now = Date.now();
  if (!force && now - lastSharedFetch < 30000 && cachedSharedItems) {
    return cachedSharedItems;
  }
  if (!navigator.onLine && !force) {
    try { return (await db.getMeta('shared_items')) || []; } catch { return []; }
  }
  try {
    const r = await call('/shared-with-me');
    if (r.ok) {
      const data = await r.json();
      const shares = Array.isArray(data.shares) ? data.shares : [];
      lastSharedFetch = now;
      cachedSharedItems = shares;
      await db.setMeta('shared_items', shares);
      return shares;
    }
  } catch (e) {
    console.warn('Failed to fetch shared with me:', e);
  }
  try { return (await db.getMeta('shared_items')) || []; } catch { return []; }
}

export async function fetchMyShares(force = false) {
  if (!session) {
    try { return new Set((await db.getMeta('my_shares')) || []); } catch { return new Set(); }
  }
  const now = Date.now();
  if (!force && now - lastMySharesFetch < 30000 && cachedMyShares) {
    return cachedMyShares;
  }
  if (!navigator.onLine && !force) {
    try { return new Set((await db.getMeta('my_shares')) || []); } catch { return new Set(); }
  }
  try {
    const r = await call('/shares');
    if (r.ok) {
      const data = await r.json();
      const list = Array.isArray(data.shares) ? data.shares.map(s => s.docId) : [];
      lastMySharesFetch = now;
      cachedMyShares = new Set(list);
      await db.setMeta('my_shares', list);
      return cachedMyShares;
    }
  } catch (e) {}
  try { return new Set((await db.getMeta('my_shares')) || []); } catch { return new Set(); }
}

export async function stopLiveShare(docId) {
  const r = await call('/share/' + encodeURIComponent(docId), { method: 'DELETE' });
  try {
    const cur = new Set((await db.getMeta('my_shares')) || []);
    cur.delete(docId);
    await db.setMeta('my_shares', [...cur]);
    const d = await db.get('docs', docId);
    if (d) { d.shared = false; await db.put('docs', d); }
  } catch {}
  return r.ok;
}

export function sendLiveDelta(docId, pageId, delta) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ live: true, docId, pageId, delta }));
    } catch {}
  }
}

function joinBuffers(bufs) {
  if (bufs.length === 1) return bufs[0];
  const out = new Uint8Array(bufs.reduce((t, b) => t + b.length, 0));
  let o = 0;
  for (const b of bufs) { out.set(b, o); o += b.length; }
  return out;
}

export async function fetchLiveDoc(shareId) {
  const base = server || SERVER;
  const authHeaders = session?.token ? { 'Authorization': 'Bearer ' + session.token } : {};
  const r = await http(base + '/live/' + encodeURIComponent(shareId) + '/doc', { headers: authHeaders });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    if (err.error === 'signin-required') throw new Error('SIGNIN_REQUIRED:' + (err.message || 'Please sign in with Google to view this private notebook.'));
    if (err.error === 'forbidden') throw new Error('FORBIDDEN:' + (err.message || 'Access denied: You do not have permission to view this notebook.'));
    if (err.error === 'doc-missing') throw new Error('Notebook is still syncing from the owner. Please try again in a moment.');
    throw new Error('Live share not found or expired');
  }
  const j = await r.json();

  const fetchBlob = async (k, id) => {
    const firstRes = await http(base + '/live/' + encodeURIComponent(shareId) + '/blob/' + k + '/' + encodeURIComponent(id) + '/0', { headers: authHeaders });
    if (!firstRes.ok) throw new Error('Could not load ' + k + '/' + id);
    const partsCount = Number(firstRes.headers.get('X-Parts') || '1');
    const isGz = firstRes.headers.get('X-Gz') === '1';
    const bufs = [new Uint8Array(await firstRes.arrayBuffer())];
    for (let n = 1; n < partsCount; n++) {
      const partRes = await http(base + '/live/' + encodeURIComponent(shareId) + '/blob/' + k + '/' + encodeURIComponent(id) + '/' + n, { headers: authHeaders });
      if (!partRes.ok) throw new Error('Part ' + n + ' missing');
      bufs.push(new Uint8Array(await partRes.arrayBuffer()));
    }
    return { bytes: joinBuffers(bufs), gz: isGz };
  };

  const docBlob = await fetchBlob('d', j.docId);
  const docData = await decode(docBlob.bytes, docBlob.gz || !!(j.doc && j.doc.gz));
  docData.liveShare = shareId;
  docData.canWrite = j.canWrite;
  await db.put('docs', docData);

  for (const pr of j.pages || []) {
    try {
      const pBlob = await fetchBlob('p', pr.id);
      const pageData = await decode(pBlob.bytes, pBlob.gz || !!pr.gz);
      await db.put('pages', pageData);

      const assetIds = new Set();
      if (pageData.pdf && pageData.pdf.a) assetIds.add(pageData.pdf.a);
      if (pageData.bg && pageData.bg.a) assetIds.add(pageData.bg.a);
      for (const it of pageData.items || []) if (it.t === 'im' && it.a) assetIds.add(it.a);
      for (const aid of assetIds) {
        const curAsset = await db.get('assets', aid);
        if (!curAsset || !curAsset.data) {
          try {
            const aBlob = await fetchBlob('a', aid);
            await db.put('assets', { id: aid, data: aBlob.bytes.buffer.slice(aBlob.bytes.byteOffset, aBlob.bytes.byteOffset + aBlob.bytes.byteLength), mime: 'application/octet-stream' });
          } catch {}
        }
      }
    } catch (e) {
      console.warn('Live page fetch error:', e);
    }
  }
  return { doc: docData, canWrite: j.canWrite };
}

let guestWs = null;
export function openLiveGuestSocket(shareId) {
  if (guestWs) { try { guestWs.close(); } catch {} guestWs = null; }
  const base = (server || SERVER).replace(/^http/, 'ws');
  const wsUrl = base + '/live/' + encodeURIComponent(shareId) + '/ws' + (session?.token ? '?token=' + encodeURIComponent(session.token) : '');
  guestWs = makeSocket(wsUrl);
  guestWs.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.live) bus.emit('live-message', m);
  };
  return guestWs;
}

export function closeLiveGuestSocket() {
  if (guestWs) { try { guestWs.close(); } catch {} guestWs = null; }
}

export function sendGuestLiveDelta(docId, pageId, delta) {
  if (guestWs && guestWs.readyState === WebSocket.OPEN) {
    try {
      guestWs.send(JSON.stringify({ live: true, docId, pageId, delta }));
    } catch {}
  }
}

export async function folderFile(folderId) {
  const allF = await db.all('folders');
  const root = allF.find(x => x.id === folderId);
  if (!root) throw new Error('Folder not found');

  const inside = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const x of allF) {
      if (!x.deleted && !x.trashed && x.parentId && inside.has(x.parentId) && !inside.has(x.id)) {
        inside.add(x.id); grew = true;
      }
    }
  }

  // Ensure root folder has null parent so it lands cleanly in recipient's library
  const exportFolders = allF.filter(f => inside.has(f.id) && !f.deleted && !f.trashed).map(f => {
    if (f.id === folderId) return { ...f, parentId: null };
    return f;
  });

  const allDocs = await db.all('docs');
  const exportDocs = allDocs.filter(d => inside.has(d.folderId) && !d.deleted && !d.trashed && !d.sys);

  const pages = [];
  const allAssetIds = new Set();
  for (const d of exportDocs) {
    const docPages = (await db.byDoc(d.id)).filter(p => !p.deleted && !p.trashed);
    pages.push(...docPages);
    for (const aid of assetIdsOf(docPages)) allAssetIds.add(aid);
  }

  const assets = [];
  for (const id of allAssetIds) {
    const a = await db.get('assets', id);
    if (a && a.data) assets.push({ ...a, data: bufToB64(a.data) });
  }

  const cleanDocs = exportDocs.map(d => {
    const { thumb, fav, tags, trashed, ...rest } = d;
    return rest;
  });

  const data = {
    app: 'inkleaf',
    version: 1,
    kind: 'folder',
    exported: Date.now(),
    folders: exportFolders,
    docs: cleanDocs,
    pages,
    assets
  };
  const name = (root.name || 'folder').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'folder';
  return new File([JSON.stringify(data)], name + '.inkleaf', { type: 'application/octet-stream' });
}

function emailPicker({ title, isFolder, getLiveUrl, getFile, initialEmail = '', onEmailChange = null }) {
  const getRecent = () => {
    try { return JSON.parse(localStorage.getItem('inkleaf.friends') || '[]'); } catch { return []; }
  };
  const saveRecent = (em) => {
    const trimmed = (em || '').trim();
    if (!trimmed || !trimmed.includes('@')) return;
    const list = getRecent().filter(e => e.toLowerCase() !== trimmed.toLowerCase());
    list.unshift(trimmed);
    localStorage.setItem('inkleaf.friends', JSON.stringify(list.slice(0, 8)));
  };

  let chosenEmail = initialEmail;
  const clearBtn = h('button', {
    class: 'ic sm',
    type: 'button',
    title: 'Clear email',
    html: I.close,
    style: 'display: ' + (chosenEmail ? 'inline-flex' : 'none') + '; margin-left: -28px; z-index: 2; color: var(--muted);',
    onclick: () => {
      chosenEmail = '';
      emailInp.value = '';
      clearBtn.style.display = 'none';
      if (onEmailChange) onEmailChange('');
      refreshChips();
    }
  });

  const emailInp = h('input', {
    class: 'inp sm',
    type: 'email',
    placeholder: "Friend's email (e.g. friend@gmail.com)",
    value: initialEmail,
    style: 'flex: 1; padding-right: 28px;',
    oninput: e => {
      chosenEmail = e.target.value.trim();
      clearBtn.style.display = chosenEmail ? 'inline-flex' : 'none';
      if (onEmailChange) onEmailChange(chosenEmail);
      refreshChips();
    }
  });

  const chipsBox = h('div', { class: 'chips', style: 'margin: 6px 0; gap: 6px;' });
  const refreshChips = (suggested = []) => {
    const recents = getRecent();
    const all = [...new Set([...suggested, ...recents])].filter(Boolean);
    chipsBox.replaceChildren(
      ...all.map(f => h('button', {
        class: 'chip sm' + (chosenEmail.toLowerCase() === f.toLowerCase() ? ' on' : ''),
        type: 'button',
        title: 'Share with ' + f,
        onclick: () => {
          if (chosenEmail.toLowerCase() === f.toLowerCase()) {
            chosenEmail = '';
            emailInp.value = '';
          } else {
            chosenEmail = f;
            emailInp.value = f;
          }
          clearBtn.style.display = chosenEmail ? 'inline-flex' : 'none';
          if (onEmailChange) onEmailChange(chosenEmail);
          refreshChips(suggested);
        }
      }, f))
    );
  };

  const sendEmailLink = async () => {
    const email = emailInp.value.trim();
    if (!email || !email.includes('@')) {
      toast('Please enter a friend email address');
      emailInp.focus();
      return;
    }
    saveRecent(email);
    const b = busy('Preparing share link...');
    try {
      const url = await getLiveUrl(email);
      b.done();
      const subject = encodeURIComponent(`Inkleaf: ${title}`);
      const body = encodeURIComponent(
        `Hi,\n\nHere is a private live link to view "${title}" on Inkleaf:\n\n${url}\n\nYou can open this link on your iPad, phone, or laptop and sign in to view.\n`
      );
      window.open(`mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`, '_blank');
      toast(`Email draft opened for ${email}`);
    } catch (e) {
      b.done();
      toast('Could not prepare link: ' + e.message);
    }
  };

  const sendEmailFile = async () => {
    const email = emailInp.value.trim();
    if (!email || !email.includes('@')) {
      toast('Please enter a friend email address');
      emailInp.focus();
      return;
    }
    saveRecent(email);
    const b = busy('Preparing file...');
    try {
      const file = await getFile();
      b.done();
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: title,
            text: `Inkleaf ${isFolder ? 'folder' : 'notebook'}: ${title}`
          });
          toast('Shared successfully!');
          return;
        } catch (err) {
          if (err.name === 'AbortError') return;
        }
      }
      downloadBlob(file, file.name);
      const subject = encodeURIComponent(`Inkleaf: ${title}`);
      const body = encodeURIComponent(
        `Hi,\n\nI have exported the Inkleaf ${isFolder ? 'folder' : 'notebook'} "${title}" for you (${file.name}).\n\nI've downloaded the file so you can attach it to this email. You can open and import it at https://yadmewal-rgb.github.io/inkleaf/ using the "Open a notebook file" option.\n`
      );
      window.open(`mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`, '_blank');
      toast(`Downloaded ${file.name} & opened email draft for ${email}`);
    } catch (e) {
      b.done();
      toast('Error: ' + e.message);
    }
  };

  return {
    el: h('div', { class: 'email-picker-wrap' },
      h('div', { class: 'row', style: 'align-items: center; gap: 0; margin: 8px 0; width: 100%;' }, emailInp, clearBtn),
      chipsBox
    ),
    emailInp,
    refreshChips,
    sendEmailLink,
    sendEmailFile,
    getEmail: () => chosenEmail
  };
}

export async function shareNotebook(docId) {
  const d = await db.get('docs', docId);
  const title = d ? d.title : 'Notebook';
  const liveBox = h('div', { class: 'live-share-box', style: 'margin-bottom: 20px;' });

  // Get allowed friends from server /me
  let serverFriends = [];
  if (session && navigator.onLine) {
    try {
      const meRes = await call('/me');
      if (meRes.ok) {
        const meData = await meRes.json();
        serverFriends = meData.friends || [];
      }
    } catch {}
  }

  const drawLive = async () => {
    if (!session || !navigator.onLine) {
      liveBox.replaceChildren(
        h('h3', null, 'Real-time live sharing'),
        h('p', { class: 'modal-text small' }, 'Sign in to sync to get a live share link so friends can watch your annotations in real time.')
      );
      return;
    }
    const info = await getLiveShare(docId);
    let restrictedTo = info.allowedEmails || (serverFriends[0] || '');
    let shareMode = (info.shared && info.allowedEmails) || (!info.shared && serverFriends.length > 0) ? 'friend' : 'anyone';
    let initialCanWrite = false;

    const renderContent = () => {
      if (!info.shared) {
        const picker = emailPicker({
          title,
          isFolder: false,
          initialEmail: restrictedTo,
          onEmailChange: em => { restrictedTo = em; }
        });
        picker.refreshChips(serverFriends);

        const modeChips = h('div', { class: 'chips', style: 'margin: 8px 0 10px;' },
          h('button', {
            class: 'chip sm' + (shareMode === 'friend' ? ' on' : ''),
            type: 'button',
            onclick: () => { shareMode = 'friend'; renderContent(); }
          }, 'Specific friend (Google sign-in)'),
          h('button', {
            class: 'chip sm' + (shareMode === 'anyone' ? ' on' : ''),
            type: 'button',
            onclick: () => { shareMode = 'anyone'; renderContent(); }
          }, 'Anyone with link')
        );

        const permChips = h('div', { class: 'chips', style: 'margin: 8px 0 6px;' },
          h('button', {
            class: 'chip sm' + (!initialCanWrite ? ' on' : ''),
            type: 'button',
            onclick: () => { initialCanWrite = false; renderContent(); }
          }, '👁️ View only'),
          h('button', {
            class: 'chip sm' + (initialCanWrite ? ' on' : ''),
            type: 'button',
            onclick: () => { initialCanWrite = true; renderContent(); }
          }, '✏️ Can edit')
        );

        liveBox.replaceChildren(
          h('h3', null, 'Real-time live sharing'),
          h('p', { class: 'modal-text' }, 'Share with your friend so they can view the notebook and see your annotations live.'),
          modeChips,
          shareMode === 'friend' ? h('div', null,
            h('p', { class: 'modal-text small' }, "Only this email address can open the notebook (they must sign in with Google):"),
            picker.el
          ) : null,
          h('div', { style: 'margin-top: 10px;' },
            h('div', { class: 'modal-text small', style: 'font-weight: 600; margin-bottom: 4px;' }, 'Permission:'),
            permChips,
            h('p', { class: 'bk-sub', style: 'font-size: 12px; margin-top: 4px;' },
              initialCanWrite
                ? 'Can edit: friend can write and draw on this notebook together.'
                : 'View-only: friend can watch your live writing without leaving marks.'
            )
          ),
          h('div', { class: 'row', style: 'gap: 8px; margin-top: 14px;' },
            h('button', {
              class: 'btn primary', type: 'button',
              onclick: async e => {
                const btn = e.currentTarget; btn.disabled = true;
                btn.textContent = 'Preparing link...';
                try {
                  const allowed = shareMode === 'friend' ? (restrictedTo.trim() || serverFriends[0] || '') : '';
                  const docObj = await db.get('docs', docId);
                  const parentFolder = docObj?.folderId ? await db.get('folders', docObj.folderId) : null;
                  const extra = {
                    title: docObj?.title || title,
                    cover: docObj?.cover || '',
                    folderId: docObj?.folderId || '',
                    folderName: parentFolder ? parentFolder.name : ''
                  };
                  await startLiveShare(docId, initialCanWrite, allowed, extra);
                  drawLive();
                  if (allowed) toast(`Shared with ${allowed}! It will appear in their Shared tab.`);
                } catch (err) {
                  toast('Could not start live share: ' + err.message);
                  btn.disabled = false;
                  btn.textContent = 'Create live link';
                }
              }
            }, 'Create live link')
          )
        );
      } else {
        const shareUrl = location.origin + location.pathname + '#/live/' + info.shareId;
        const currentAllowed = info.allowedEmails || '';
        const allowedList = currentAllowed.split(',').map(s => s.trim()).filter(Boolean);

        const picker = emailPicker({
          title,
          isFolder: false,
          initialEmail: currentAllowed || serverFriends[0] || '',
          getLiveUrl: async () => shareUrl,
          getFile: () => notebookFile(docId)
        });
        picker.refreshChips(serverFriends);

        liveBox.replaceChildren(
          h('h3', null, 'Real-time live sharing'),
          h('div', { class: 'row', style: 'align-items: center; gap: 8px; margin: 8px 0;' },
            h('input', { class: 'inp sm', type: 'text', readonly: true, value: shareUrl, style: 'flex: 1;' }),
            h('button', {
              class: 'btn sm primary', type: 'button',
              onclick: () => {
                if (navigator.clipboard) navigator.clipboard.writeText(shareUrl);
                toast('Live link copied to clipboard!', 2500);
              }
            }, 'Copy link'),
            h('button', {
              class: 'btn sm', type: 'button',
              title: 'Email link to friend',
              onclick: picker.sendEmailLink
            }, 'Email link')
          ),
          h('div', { style: 'margin: 12px 0 8px;' },
            h('div', { class: 'modal-text small', style: 'font-weight: 600; margin-bottom: 6px;' }, 'People with access:'),
            ...allowedList.map(email => h('div', {
              class: 'row',
              style: 'align-items: center; justify-content: space-between; padding: 6px 10px; background: var(--surface-2); border-radius: 8px; margin-bottom: 4px; gap: 8px;'
            },
              h('div', { class: 'row', style: 'align-items: center; gap: 8px; min-width: 0; flex: 1;' },
                h('span', { html: I.users, style: 'color: var(--accent); display: flex; flex-shrink: 0;' }),
                h('span', { style: 'font-size: 13.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, email)
              ),
              h('div', { class: 'row', style: 'align-items: center; gap: 6px; flex-shrink: 0;' },
                h('select', {
                  class: 'inp sm',
                  style: 'width: auto; padding: 2px 8px; font-size: 12px; height: 28px; cursor: pointer; border-radius: 6px;',
                  onchange: async e => {
                    const val = e.target.value === 'edit';
                    const docObj = await db.get('docs', docId);
                    const parentFolder = docObj?.folderId ? await db.get('folders', docObj.folderId) : null;
                    const extra = {
                      title: docObj?.title || title,
                      cover: docObj?.cover || '',
                      folderId: docObj?.folderId || '',
                      folderName: parentFolder ? parentFolder.name : ''
                    };
                    await setLiveSharePerm(docId, val, info.allowedEmails, extra);
                    toast(val ? 'Changed to: Can edit' : 'Changed to: View only', 2000);
                    drawLive();
                  }
                },
                  h('option', { value: 'view', selected: !info.canWrite }, 'View only'),
                  h('option', { value: 'edit', selected: !!info.canWrite }, 'Can edit')
                ),
                h('button', {
                  class: 'ic sm danger',
                  type: 'button',
                  title: 'Remove access for ' + email,
                  html: I.close,
                  style: 'width: 28px; height: 28px; border-radius: 6px;',
                  onclick: async () => {
                    const remaining = allowedList.filter(e => e.toLowerCase() !== email.toLowerCase());
                    const docObj = await db.get('docs', docId);
                    const parentFolder = docObj?.folderId ? await db.get('folders', docObj.folderId) : null;
                    const extra = {
                      title: docObj?.title || title,
                      cover: docObj?.cover || '',
                      folderId: docObj?.folderId || '',
                      folderName: parentFolder ? parentFolder.name : ''
                    };
                    if (remaining.length === 0) {
                      if (!await confirmBox('Remove access', `Remove access for ${email}? This will stop sharing this notebook.`, 'Remove access', true)) return;
                      await stopLiveShare(docId);
                      toast(`Removed ${email}. Notebook is no longer shared.`);
                    } else {
                      await setLiveSharePerm(docId, info.canWrite, remaining.join(', '), extra);
                      toast(`Removed access for ${email}`);
                    }
                    drawLive();
                  }
                })
              )
            )),
            !allowedList.length ? h('div', {
              class: 'row',
              style: 'align-items: center; justify-content: space-between; padding: 6px 10px; background: var(--surface-2); border-radius: 8px; margin-bottom: 4px; gap: 8px;'
            },
              h('div', { class: 'row', style: 'align-items: center; gap: 8px; min-width: 0; flex: 1;' },
                h('span', { html: I.users, style: 'color: var(--accent); display: flex; flex-shrink: 0;' }),
                h('span', { style: 'font-size: 13.5px; font-weight: 500;' }, 'Anyone with the link')
              ),
              h('div', { class: 'row', style: 'align-items: center; gap: 6px; flex-shrink: 0;' },
                h('select', {
                  class: 'inp sm',
                  style: 'width: auto; padding: 2px 8px; font-size: 12px; height: 28px; cursor: pointer; border-radius: 6px;',
                  onchange: async e => {
                    const val = e.target.value === 'edit';
                    const docObj = await db.get('docs', docId);
                    const parentFolder = docObj?.folderId ? await db.get('folders', docObj.folderId) : null;
                    const extra = {
                      title: docObj?.title || title,
                      cover: docObj?.cover || '',
                      folderId: docObj?.folderId || '',
                      folderName: parentFolder ? parentFolder.name : ''
                    };
                    await setLiveSharePerm(docId, val, '', extra);
                    toast(val ? 'Anyone with link can now write' : 'Anyone with link is now view-only', 2000);
                    drawLive();
                  }
                },
                  h('option', { value: 'view', selected: !info.canWrite }, 'View only'),
                  h('option', { value: 'edit', selected: !!info.canWrite }, 'Can edit')
                )
              )
            ) : null
          ),
          h('div', { style: 'margin: 10px 0 6px;' },
            h('div', { class: 'modal-text small', style: 'margin-bottom: 4px;' },
              currentAllowed
                ? `Add or switch friend:`
                : 'Public link: anyone with the link can view without signing in.'
            ),
            h('div', { class: 'row', style: 'align-items: center; gap: 6px; flex-wrap: wrap;' },
              ...serverFriends.map(fr => {
                const isSelected = allowedList.some(e => e.toLowerCase() === fr.toLowerCase());
                return h('button', {
                  class: 'chip sm' + (isSelected ? ' on' : ''),
                  type: 'button',
                  onclick: async () => {
                    const docObj = await db.get('docs', docId);
                    const parentFolder = docObj?.folderId ? await db.get('folders', docObj.folderId) : null;
                    const extra = {
                      title: docObj?.title || title,
                      cover: docObj?.cover || '',
                      folderId: docObj?.folderId || '',
                      folderName: parentFolder ? parentFolder.name : ''
                    };
                    await setLiveSharePerm(docId, info.canWrite, fr, extra);
                    toast('Restricted to ' + fr + ' (will appear in their Shared tab)');
                    drawLive();
                  }
                }, 'Share with ' + fr);
              }),
              h('button', {
                class: 'chip sm' + (!currentAllowed ? ' on' : ''),
                type: 'button',
                onclick: async () => {
                  const docObj = await db.get('docs', docId);
                  const parentFolder = docObj?.folderId ? await db.get('folders', docObj.folderId) : null;
                  const extra = {
                    title: docObj?.title || title,
                    cover: docObj?.cover || '',
                    folderId: docObj?.folderId || '',
                    folderName: parentFolder ? parentFolder.name : ''
                  };
                  await setLiveSharePerm(docId, info.canWrite, '', extra);
                  toast('Changed to: anyone with link');
                  drawLive();
                }
              }, 'Anyone with link')
            )
          ),
          h('div', { class: 'row', style: 'align-items: center; justify-content: space-between; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line);' },
            h('span', { class: 'bk-sub', style: 'font-size: 12px;' },
              info.canWrite ? '✏️ Can edit: friend can write and draw live.' : '👁️ View-only: friend can only watch live writing.'
            ),
            h('button', {
              class: 'btn sm danger', type: 'button',
              onclick: async () => {
                if (!await confirmBox('Stop sharing', 'Stop sharing this notebook completely? Anyone looking at it will be disconnected and it will be removed from their Shared tab.', 'Stop sharing', true)) return;
                await stopLiveShare(docId);
                toast('Stopped sharing notebook');
                drawLive();
              }
            }, 'Stop sharing notebook')
          )
        );
      }
    };
    renderContent();
  };
  drawLive();

  // Export file copy option
  const fileSection = h('div', null,
    h('h3', null, 'Send a file copy'),
    h('p', { class: 'modal-text small' }, 'Export this notebook as a standalone .inkleaf file for backup or offline transfer.'),
    h('div', { class: 'row', style: 'gap: 8px; margin-top: 8px;' },
      h('button', {
        class: 'btn sm', type: 'button',
        onclick: async () => {
          const b = busy('Preparing notebook file...');
          try {
            const file = await notebookFile(docId);
            downloadBlob(file, file.name);
          } catch (e) { toast('Error: ' + e.message); }
          b.done();
        }
      }, 'Download .inkleaf file'),
      navigator.share ? h('button', {
        class: 'btn sm', type: 'button',
        onclick: async () => {
          const b = busy('Preparing notebook file...');
          try {
            const file = await notebookFile(docId);
            b.done();
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
              await navigator.share({ files: [file], title, text: `Inkleaf notebook: ${title}` });
            } else {
              downloadBlob(file, file.name);
            }
          } catch (e) { b.done(); if (e.name !== 'AbortError') toast('Error: ' + e.message); }
        }
      }, 'Share file via app...') : null
    )
  );

  modal({
    title: `Share "${title}"`,
    wide: true,
    body: h('div', null, liveBox, fileSection)
  });
}

export async function shareFolder(folderId) {
  const f = await db.get('folders', folderId);
  const title = f ? f.name : 'Folder';

  let serverFriends = [];
  if (session && navigator.onLine) {
    try {
      const meRes = await call('/me');
      if (meRes.ok) {
        const meData = await meRes.json();
        serverFriends = meData.friends || [];
      }
    } catch {}
  }

  // Count notebooks and pages
  const allF = await db.all('folders');
  const inside = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const x of allF) {
      if (!x.deleted && !x.trashed && x.parentId && inside.has(x.parentId) && !inside.has(x.id)) {
        inside.add(x.id); grew = true;
      }
    }
  }
  const allDocs = await db.all('docs');
  const docs = allDocs.filter(d => inside.has(d.folderId) && !d.deleted && !d.trashed && !d.sys);
  let pageCount = 0;
  for (const d of docs) {
    const pages = (await db.byDoc(d.id)).filter(p => !p.deleted && !p.trashed);
    pageCount += pages.length;
  }

  const picker = emailPicker({
    title,
    isFolder: true,
    getFile: () => folderFile(folderId)
  });
  picker.refreshChips(serverFriends);

  let targetFriend = serverFriends[0] || '';
  const myShares = new Set((await db.getMeta('my_shares')) || []);
  const mySharedFolders = new Set((await db.getMeta('my_shared_folders')) || []);
  const isFolderShared = mySharedFolders.has(folderId) || docs.some(d => myShares.has(d.id));

  const friendInp = h('input', {
    class: 'inp sm',
    type: 'email',
    placeholder: "Friend's email (e.g. friend@gmail.com)",
    value: targetFriend,
    style: 'flex: 1;'
  });
  friendInp.oninput = () => { targetFriend = friendInp.value.trim(); };

  let folderModal = null;
  const directShareBox = h('div', { style: 'margin-bottom: 20px;' },
    h('h3', null, 'Share directly to friend\'s Inkleaf'),
    h('p', { class: 'modal-text small' }, 'This folder will appear automatically under the "Shared" tab in your friend\'s Inkleaf:'),
    serverFriends.length ? h('div', { class: 'row', style: 'align-items: center; gap: 6px; margin: 8px 0; flex-wrap: wrap;' },
      h('span', { class: 'modal-text small', style: 'color: var(--muted);' }, 'Quick pick:'),
      serverFriends.map(fr => h('button', {
        class: 'chip sm' + (targetFriend.toLowerCase() === fr.toLowerCase() ? ' on' : ''),
        type: 'button',
        onclick: () => { targetFriend = fr; friendInp.value = fr; }
      }, fr))
    ) : null,
    h('div', { class: 'row', style: 'gap: 8px; margin-top: 8px;' },
      friendInp,
      h('button', {
        class: 'btn sm primary', type: 'button',
        onclick: async e => {
          const email = friendInp.value.trim();
          if (!email) { toast('Please enter your friend\'s email address'); return; }
          if (!session) { toast('Please sign in to sync before sharing'); return; }
          if (!docs.length) { toast('No notebooks to share in this folder'); return; }
          const btn = e.currentTarget; btn.disabled = true;
          const b = busy(`Sharing ${docs.length} notebooks with ${email}...`);
          try {
            for (const d of docs) {
              await startLiveShare(d.id, false, email, {
                title: d.title,
                cover: d.cover,
                folderId,
                folderName: title
              });
            }
            try {
              const fShares = new Set((await db.getMeta('my_shared_folders')) || []);
              fShares.add(folderId);
              await db.setMeta('my_shared_folders', [...fShares]);
            } catch {}
            b.done();
            btn.disabled = false;
            toast(`Folder "${title}" shared with ${email}! It will appear in their Shared tab.`);
            if (folderModal) folderModal.close();
          } catch (err) {
            b.done();
            btn.disabled = false;
            toast('Could not share folder: ' + err.message);
          }
        }
      }, 'Share folder with friend')
    ),
    isFolderShared ? h('div', { class: 'row', style: 'margin-top: 10px; justify-content: flex-end;' },
      h('button', {
        class: 'btn sm danger', type: 'button',
        onclick: async () => {
          if (!await confirmBox('Stop sharing folder', `Stop sharing all notebooks in "${title}"? They will be removed from your friend's Shared tab.`, 'Stop sharing', true)) return;
          const b = busy('Stopping folder share...');
          try {
            for (const d of docs) await stopLiveShare(d.id);
            const fShares = new Set((await db.getMeta('my_shared_folders')) || []);
            fShares.delete(folderId);
            await db.setMeta('my_shared_folders', [...fShares]);
            b.done();
            toast(`Stopped sharing folder "${title}"`);
            if (folderModal) folderModal.close();
          } catch (err) {
            b.done();
            toast('Error: ' + err.message);
          }
        }
      }, 'Stop sharing folder')
    ) : null
  );

  const overviewBox = h('div', { style: 'margin-bottom: 16px;' },
    h('p', { class: 'modal-text' },
      `This folder contains ${docs.length} ${docs.length === 1 ? 'notebook' : 'notebooks'} and ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}.`
    )
  );

  const emailBox = h('div', { style: 'margin-bottom: 20px;' },
    h('h3', null, 'Send folder to a friend'),
    h('p', { class: 'modal-text small' }, "Email the entire folder and all its notebooks as an .inkleaf package:"),
    picker.el,
    h('div', { class: 'row', style: 'gap: 8px; margin-top: 8px;' },
      h('button', {
        class: 'btn sm primary', type: 'button',
        onclick: picker.sendEmailFile
      }, 'Email folder to friend'),
      navigator.share ? h('button', {
        class: 'btn sm', type: 'button',
        onclick: async () => {
          const b = busy('Preparing folder...');
          try {
            const file = await folderFile(folderId);
            b.done();
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
              await navigator.share({ files: [file], title, text: `Inkleaf folder: ${title}` });
            } else {
              downloadBlob(file, file.name);
            }
          } catch (e) { b.done(); if (e.name !== 'AbortError') toast('Error: ' + e.message); }
        }
      }, 'Share via app...') : null
    )
  );

  const fileSection = h('div', null,
    h('h3', null, 'Download folder file'),
    h('p', { class: 'modal-text small' }, 'Download as a single .inkleaf file. Your friend can open Inkleaf and tap "Open a notebook file" to import all notebooks at once.'),
    h('button', {
      class: 'btn sm', type: 'button',
      onclick: async () => {
        const b = busy('Preparing folder package...');
        try {
          const file = await folderFile(folderId);
          downloadBlob(file, file.name);
        } catch (e) { toast('Error: ' + e.message); }
        b.done();
      }
    }, 'Download folder (.inkleaf)')
  );

  folderModal = modal({
    title: `Share folder "${title}"`,
    wide: true,
    body: h('div', null, overviewBox, directShareBox, emailBox, fileSection)
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
    toast(data.kind === 'notebook' ? 'Notebook added' : data.kind === 'folder' ? 'Folder added' : 'Backup restored');
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
function renderUserUsagePills(users, getVal, fmtVal) {
  if (!Array.isArray(users) || !users.length) return null;
  return h('div', { class: 'usage-users' },
    users.map(u => h('span', { class: 'usage-user-pill' + (u.me ? ' me' : '') },
      u.label + ': ', h('b', null, fmtVal(getVal(u)))))
  );
}

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
  const doSignOut = async () => {
    if (!await confirmBox('Sign out', 'Sign this device out of sync? Notes stay on this device and on your other devices.', 'Sign out')) return false;
    await signOut();
    await initSync();
    return true;
  };
  const accountCard = h('div', { class: 'account-card' });
  const drawAccount = () => {
    const signed = !!session;
    const statusText = signed
      ? `Signed in as ${session.email}` + (cfg.off ? ' (sync paused)' : '')
      : cfg.off ? 'Sync is turned off on this device.' : 'Not signed in to live sync yet.';
    accountCard.replaceChildren(
      h('div', { class: 'account-meta' },
        h('b', { style: 'font-size: 13.5px;' }, signed ? session.email : 'Sync account'),
        h('span', { class: 'bk-sub' }, statusText)
      ),
      h('div', { class: 'row', style: 'gap: 8px; flex-shrink: 0;' },
        signed ? h('button', {
          class: 'btn sm primary', type: 'button',
          onclick: async () => { await turnOn(); m.close(); syncNow(true); }
        }, 'Sync now') : h('button', {
          class: 'btn sm primary', type: 'button',
          onclick: async () => { await turnOn(); m.close(); syncNow(true); }
        }, 'Sign in with Google'),
        signed ? h('button', {
          class: 'btn sm danger', type: 'button',
          onclick: async () => { if (await doSignOut()) m.close(); }
        }, 'Sign out') : null
      )
    );
  };
  drawAccount();

  // The devices signed in to this account, with a way to sign any of them out (e.g. a lost phone, or an old
  // sign-in left over on this device).
  const devicesEl = h('div', { class: 'devices' });
  const when = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  async function drawDevices() {
    if (!session || cfg.off || !navigator.onLine) { devicesEl.replaceChildren(); return; }
    let items;
    try { items = (await (await call('/sessions')).json()).items; } catch { devicesEl.replaceChildren(); return; }
    devicesEl.replaceChildren(
      h('b', { class: 'dev-title' }, `Signed-in devices (${items.length})`),
      ...items.map(d => h('div', { class: 'dev-row' },
        h('div', { class: 'dev-meta' },
          h('span', null, d.label, d.current ? h('span', { class: 'dev-me' }, ' · this device') : ''),
          h('span', { class: 'bk-sub' }, `Signed in ${when(d.created)} · last used ${Date.now() - d.seen < 3600e3 ? 'within the hour' : when(d.seen)}`)),
        d.current ? h('button', {
          class: 'btn sm', type: 'button', onclick: async () => {
            if (await doSignOut()) m.close();
          }
        }, 'Sign out') : h('button', {
          class: 'btn sm', type: 'button', onclick: async e => {
            if (!await confirmBox('Sign out a device', `Sign out "${d.label}" (signed in ${when(d.created)})? It stops syncing until someone signs in on it again. Notes already on it stay there.`, 'Sign out')) return;
            const btn = e.target; btn.disabled = true;
            try { await call('/sessions/' + d.id, { method: 'DELETE' }); toast(`"${d.label}" is signed out`); } catch (err) { toast('Could not sign it out: ' + err.message); }
            drawDevices();
          }
        }, 'Sign out'))));
  }
  drawDevices();
  // Sync health: when changes last went out and came in, and anything waiting or failing. Refreshed while open.
  const healthEl = h('div', { class: 'health' });
  const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 10 ? 'just now' : s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  const drawHealth = () => {
    const x = syncHealth();
    if (!x.signedIn) { healthEl.replaceChildren(); return; }
    const okNow = !x.waiting && !x.files && !x.retrying && !(x.err && x.err.t > Math.max(x.sent, x.checked));
    const rows = [
      h('div', null, h('span', { class: 'dot ' + (okNow ? 'ok' : x.err && !x.waiting ? 'bad' : 'busy') }), okNow ? 'All in step.' : x.waiting ? 'Changes waiting to be sent.' : 'Working on it.'),
      h('div', { class: 'bk-sub' }, `Last change sent: ${x.sent ? ago(x.sent) : 'none since Inkleaf opened'} · Checked for changes: ${x.checked ? ago(x.checked) : 'not yet'} · Live connection: ${x.live ? 'on' : 'off (checking every few seconds)'}`)
    ];
    if (x.files) rows.push(h('div', { class: 'bk-sub' }, `${x.files} file${x.files === 1 ? '' : 's'} (PDFs, pictures) being transferred.`));
    if (x.retrying) rows.push(h('div', { class: 'bk-sub' }, `${x.retrying} file${x.retrying === 1 ? '' : 's'} will be tried again shortly.`));
    if (x.err && x.err.t > Math.max(x.sent, x.checked) - 60e3) {
      let emsg = x.err.msg;
      if (emsg.includes('Exceeded allowed rows read') || emsg.includes('free tier')) {
        emsg = 'Cloudflare free tier daily limit reached (rows read). Your notes are safe on this device and sync resumes when quota resets.';
      }
      rows.push(h('div', { class: 'bk-sub warn' }, `Last problem (${ago(x.err.t)}): ${emsg}`));
    }
    healthEl.replaceChildren(...rows);
  };
  drawHealth();
  const healthT = setInterval(() => { if (!healthEl.isConnected) { clearInterval(healthT); return; } drawHealth(); }, 2000);

  // Cloudflare's free daily limits, as Cloudflare itself counts them (all users together).
  const cfUsageBox = h('div', { class: 'field meter', style: 'margin: 8px 0 12px; padding: 10px 12px; background: var(--surface-2); border-radius: 8px;' });
  const drawCfUsage = () => {
    const m = lastMeter();
    const lastErrMsg = health.err?.msg || '';
    const isQuotaExceeded = lastErrMsg.includes('free tier daily limit') || lastErrMsg.includes('Exceeded allowed rows read');
    const whyNot = !m ? 'checking…'
      : m.why === 'offline' ? 'not known (no internet)'
        : m.why === 'no-key' ? 'not known (the sync service has no Cloudflare key yet)'
          : m.why === 'no-answer' ? 'not known (the sync service did not answer)' : 'not known (Cloudflare did not give it)';
    const kids = [h('b', { style: 'font-size: 13px; display: block; margin-bottom: 4px;' }, 'Cloudflare free limits today (all users):')];
    for (const x of meterParts(m)) {
      const pct = x.pct == null ? 0 : Math.min(100, x.pct);
      kids.push(
        h('div', { class: 'row', style: 'align-items: center; justify-content: space-between; margin-top: 6px;' },
          h('span', { style: 'font-size: 12.5px;' }, x.name[0].toUpperCase() + x.name.slice(1)),
          h('span', { class: 'bk-sub meter-fig' }, x.pct == null ? whyNot : `${shortNum(x.used)} of ${shortNum(x.limit)} (${x.pct < 1 ? x.pct.toFixed(1) : Math.floor(x.pct)}%)`)
        ),
        h('div', { class: 'usage-bar', style: 'margin: 4px 0;' },
          h('div', { class: 'usage-fill' + (x.pct == null ? ' none' : x.pct >= 80 ? ' warn' : x.pct >= 50 ? ' mid' : ''), style: { width: (x.pct == null ? 0 : Math.max(pct, 1)) + '%' } }))
      );
    }
    const ago = m && m.at ? Math.max(0, Math.round((Date.now() - m.at) / 60000)) : null;
    kids.push(h('div', { class: 'bk-sub', style: 'font-size: 11.5px; color: var(--muted); margin-top: 4px;' },
      (ago == null ? '' : `Cloudflare's own figures, ${ago < 1 ? 'just now' : ago + ' min old'} (they run a few minutes behind). `) +
      `Starts again at ${meterResetAt()} (00:00 UTC). A message appears at 50% and 80%.`));
    if (isQuotaExceeded) kids.push(h('div', { style: 'margin-top: 8px; padding: 6px 10px; background: rgba(224, 49, 49, 0.12); border-left: 3px solid #e03131; border-radius: 4px; font-size: 12px; color: #ff6b6b; line-height: 1.4;' },
      `⚠️ Cloudflare's free limit for today is used up. Your writing is safe on this device and syncs again after ${meterResetAt()}.`));
    cfUsageBox.replaceChildren(...kids);
  };
  drawCfUsage();
  if (session && !cfg.off) readMeter().catch(() => {});
  const offCfUsage = bus.on('meter', () => drawCfUsage());

  // Annotated PDFs in Google Drive (folder Inkleaf > Annotated PDFs): on/off for this device, progress, Update now.
  const annBox = h('div', { class: 'field annotated', style: 'margin: 8px 0 12px; padding: 10px 12px; background: var(--surface-2); border-radius: 8px;' });
  const drawAnn = () => {
    const a = annotatedStatus();
    const ago = a.last ? Math.max(0, Math.round((Date.now() - a.last) / 60000)) : null;
    const line = !session || cfg.off ? 'Needs sync to be signed in.'
      : !a.linked ? 'Google Drive is not linked on this sign-in (see below).'
        : !a.on ? 'Off on this device.'
          : a.running ? (a.total ? `Making ${Math.min(a.done + 1, a.total)} of ${a.total}${a.current ? ': "' + a.current + '"' : ''}…` : 'Checking which notebooks changed…')
            : a.last ? `Up to date ${ago < 1 ? 'just now' : ago + ' min ago'}${a.made ? ` (${a.made} made)` : ''}. Checked again after you close a notebook, and every 20 minutes.`
              : 'Starts a minute after Inkleaf opens, and after you close a notebook.';
    const notes = [];
    if (a.all != null && session && !cfg.off && a.linked) notes.push(a.all && a.inDrive >= a.all ? `In Google Drive: all ${a.all} notebook${a.all === 1 ? '' : 's'}, up to date.` : `In Google Drive: ${a.inDrive} of ${a.all} notebook${a.all === 1 ? '' : 's'} up to date.`);
    if (a.waiting) notes.push(`${a.waiting} notebook${a.waiting === 1 ? '' : 's'} wait${a.waiting === 1 ? 's' : ''} for ${a.waiting === 1 ? 'its' : 'their'} PDF to arrive on this device.`);
    const crashedNote = a.crashed ? h('div', { class: 'bk-sub ann-crashed' },
      `Left out on this device: ${a.crashedNames.map(n => '"' + n + '"').join(', ')} (Inkleaf stopped twice while making ${a.crashed === 1 ? 'it' : 'them'}). `,
      h('button', { class: 'btn sm', type: 'button', disabled: a.running, onclick: () => { annRetry(); } }, 'Try again')) : null;
    annBox.replaceChildren(...[ // (a null here would show as the word "null")
      h('div', { class: 'row', style: 'align-items: center; justify-content: space-between; margin-bottom: 4px;' },
        h('label', { class: 'chip check' + (a.on ? ' on' : ''), style: 'cursor: pointer;' },
          h('input', { type: 'checkbox', checked: a.on, hidden: true, onchange: e => { setAnnotatedOn(e.target.checked); drawAnn(); } }),
          'Annotated PDFs in Google Drive'),
        a.on && session && !cfg.off && a.linked ? h('button', { class: 'btn sm', type: 'button', disabled: a.running, onclick: () => { annotatedPass({ now: true }); } }, a.running ? 'Working…' : 'Update now') : null),
      h('p', { class: 'modal-text small', style: 'margin: 4px 0;' }, 'Every notebook with your writing on it, as a PDF in your Drive folder Inkleaf > Annotated PDFs, to open or share without Inkleaf.'),
      h('div', { class: 'bk-sub ann-line' }, line),
      ...notes.map(n => h('div', { class: 'bk-sub' }, n)),
      crashedNote,
      a.err ? h('div', { class: 'bk-sub warn' }, 'Last problem: ' + a.err.msg) : null
    ].filter(Boolean));
  };
  drawAnn();
  const offAnn = bus.on('annotated', () => drawAnn());

  // Owner-only user manager (add/remove allowed emails without opening Cloudflare)
  const allowedUsersBox = h('div', { class: 'allowed-users', hidden: true });
  async function drawAllowedUsers() {
    try {
      const r = await call('/admin/users');
      const data = await r.json();
      const envSet = new Set(data.envUsers || []);
      const all = [...new Set([...(data.envUsers || []), ...(data.extraUsers || [])])];
      const inp = h('input', {
        type: 'email', class: 'inp sm', placeholder: "Friend's Gmail address (e.g. friend@gmail.com)",
        style: 'flex: 1;'
      });
      const addUser = async () => {
        const email = inp.value.trim().toLowerCase();
        if (!email || !email.includes('@')) { toast('Please enter a valid email address.'); inp.focus(); return; }
        try {
          await call('/admin/users', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
          });
          toast(`Added ${email}. They can sign in now.`);
          drawAllowedUsers();
        } catch (err) {
          toast(err.serverMessage || err.message || 'Could not add user');
        }
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addUser(); } });
      allowedUsersBox.replaceChildren(
        h('b', { class: 'dev-title' }, `Allowed users (${all.length})`),
        h('p', { class: 'modal-text small', style: 'margin-bottom: 8px;' }, 'Add or remove friends who can sign in to this sync server without opening Cloudflare.'),
        h('div', { class: 'row', style: 'gap: 8px; margin-bottom: 10px;' },
          inp,
          h('button', { class: 'btn sm primary', type: 'button', onclick: addUser }, 'Add user')
        ),
        ...all.map(email => {
          const isOwnerEmail = email === data.owner;
          const inCloudflare = envSet.has(email);
          return h('div', { class: 'allowed-row' },
            h('span', { class: 'allowed-email' }, email),
            h('span', { class: 'allowed-tag' }, isOwnerEmail ? 'Owner' : inCloudflare ? 'Cloudflare' : 'Added here'),
            !inCloudflare ? h('button', {
              class: 'btn sm', type: 'button',
              onclick: async () => {
                if (!await confirmBox('Remove user', `Stop allowing ${email} to sign in?`, 'Remove', true)) return;
                try {
                  await call('/admin/users', {
                    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
                  });
                  toast(`Removed ${email}`);
                  drawAllowedUsers();
                } catch (err) {
                  toast(err.serverMessage || err.message || 'Could not remove user');
                }
              }
            }, 'Remove') : null
          );
        })
      );
      allowedUsersBox.hidden = false;
    } catch {
      allowedUsersBox.hidden = true;
    }
  }

  // How much of Cloudflare's total 5 GB storage and this person's share is used, plus Google Drive status.
  const usage = h('div', { class: 'usage', hidden: true });
  if (session && !cfg.off && navigator.onLine) {
    call('/me').then(r => r.json()).then(j => {
      if (j.cfCallsToday != null || j.cfTotalToday != null) {
        updateCfUsageFromServer(j.cfCallsToday, j.cfLimit, true, j.cfTotalToday, j.usageUsers);
      }
      if (j.ocrCallsToday != null || j.ocrTotalToday != null) {
        updateHwUsageFromServer(j.ocrCallsToday, j.ocrLimit, j.ocrTotalToday, j.usageUsers);
      }
      if (j.isOwner) drawAllowedUsers();
      const fmt = b => (b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? Math.round(b / 1048576) + ' MB' : Math.max(0, Math.round(b / 1024)) + ' KB');
      const quota = Number(j.quota) || 500 * 1048576, used = Number(j.bytes) || 0;
      const totalAll = Number(j.totalBytesAll) || used;
      const cfLimit = Number(j.cfStorageLimit) || 5 * 1024 * 1048576;
      const totalPct = Math.min(100, totalAll / cfLimit * 100);
      const myPct = Math.min(100, used / quota * 100);
      usage.replaceChildren(
        h('div', { class: 'field', style: 'margin: 8px 0 10px; padding: 10px 12px; background: var(--surface-2); border-radius: 8px;' },
          h('div', { class: 'row', style: 'align-items: center; justify-content: space-between; margin-bottom: 4px;' },
            h('b', { style: 'font-size: 13px;' }, 'Cloudflare Storage (All users):'),
            h('span', { class: 'bk-sub' }, `${fmt(totalAll)} / ${fmt(cfLimit)} (${totalPct < 1 ? totalPct.toFixed(1) : Math.round(totalPct)}%)`)
          ),
          h('div', { class: 'usage-bar', style: 'margin: 6px 0;' },
            h('div', { class: 'usage-fill' + (totalPct > 85 ? ' warn' : ''), style: { width: Math.max(totalPct, 0.5) + '%' } })
          ),
          renderUserUsagePills(j.usageUsers, u => u.bytes, fmt),
          h('div', { class: 'bk-sub', style: 'font-size: 11.5px; color: var(--muted); margin-top: 4px;' },
            `Your share cap: ${fmt(used)} of ${fmt(quota)} (${myPct < 1 ? myPct.toFixed(1) : Math.round(myPct)}%) · Free plan total: 5 GB`
          )
        ),
        j.drive
          ? h('div', null,
            h('p', { class: 'modal-text small' }, 'Large files (500 MB+) and daily full backups are stored in your Google Drive. Smaller PDFs and writing sync through Cloudflare for quick access.'),
            visibleOk === false ? h('p', { class: 'modal-text small' }, 'To put PDFs in the visible Inkleaf folder, Google needs one more permission:', ' ', h('button', { class: 'btn sm', type: 'button', onclick: async () => { m.close(); try { await signIn(); toast('Done. PDFs are copied to the Inkleaf folder in your Drive.', 3500); syncNow(false); } catch (e) { fail(e, true); } } }, 'Link Google Drive again')) : '')
          : h('div', null,
            h('p', { class: 'modal-text small' }, 'Your Google Drive is not linked yet, so files stay on the sync service. Sign in again to keep large files and a daily full copy in your Google Drive.'),
            h('button', { class: 'btn sm', type: 'button', onclick: async () => { m.close(); try { await signIn(); toast('Google Drive linked. Files move there in the background.', 3500); syncNow(false); } catch (e) { fail(e, true); } } }, 'Link Google Drive')),
        totalPct > 85 || myPct > 85 ? h('p', { class: 'modal-text small' }, 'Nearly full. Removing notebooks you no longer need (and emptying the bin) frees space.') : '');
      usage.hidden = false;
    }).catch(() => {});
  }
  const who = session && !cfg.off
    ? `This device is signed in as ${session.email}. It stays signed in; nothing needs doing again.`
    : cfg.off ? 'Sync is turned off on this device.' : 'This device is not signed in yet.';
  // Handwriting search row and status
  const hwBox = h('div', { class: 'hw-settings', style: 'margin: 10px 0 16px;' });
  const drawHw = () => {
    const on = hwOn();
    const st = hwStatus;
    const curPref = getHwModelConfig();
    const activeModel = getActiveHwModel();
    const activeName = formatModelName(activeModel);
    const txt = !on ? 'Turn on to search handwritten notes by typing in the find bar.'
      : st.err ? `Status: ${st.err}`
      : st.state === 'working' ? `Reading handwriting with ${activeName} (${st.left} left)...`
      : `Ready. Active model: ${activeName} (${curPref === 'auto' ? 'Auto best tier' : 'Custom locked'}) with offline sync.`;
    const gemKey = localStorage.getItem('inkleaf.geminiKey') || '';
    const hw = getHwUsage();
    const totalHw = Math.max(hw.totalCalls || 0, hw.calls || 0);
    const pct = Math.min(100, Math.round((totalHw / (hw.limit || 1500)) * 100));

    const keyInp = h('input', {
      type: 'password', class: 'inp sm', placeholder: 'Optional Gemini API Key (or leave blank for Cloudflare)', value: gemKey,
      style: 'margin-top: 4px; width: 100%;',
      onchange: e => {
        const val = e.target.value.trim();
        if (val) localStorage.setItem('inkleaf.geminiKey', val);
        else localStorage.removeItem('inkleaf.geminiKey');
        pushUserSettings({ geminiKey: val });
      }
    });

    const modelSelect = h('select', {
      class: 'inp sm',
      style: 'margin-top: 4px; width: 100%;',
      onchange: e => {
        setHwModel(e.target.value);
        drawHw();
        pushUserSettings({ geminiModel: e.target.value });
      }
    }, [
      h('option', { value: 'auto', selected: curPref === 'auto' || !curPref }, 'Auto (Best Available: Hydrogen ➔ Flash fallback) — Recommended'),
      h('option', { value: 'gemini-4-hydrogen', selected: curPref === 'gemini-4-hydrogen' }, 'Gemini 4 Hydrogen (Ultra-fast · Low latency)'),
      h('option', { value: 'gemini-3.8-flash', selected: curPref === 'gemini-3.8-flash' }, 'Gemini 3.8 Flash (Latest · deep reasoning)'),
      h('option', { value: 'gemini-3.8-flash-lite', selected: curPref === 'gemini-3.8-flash-lite' }, 'Gemini 3.8 Flash Lite (Fast reasoning)'),
      h('option', { value: 'gemini-3.7-flash', selected: curPref === 'gemini-3.7-flash' }, 'Gemini 3.7 Flash'),
      h('option', { value: 'gemini-3.7-flash-lite', selected: curPref === 'gemini-3.7-flash-lite' }, 'Gemini 3.7 Flash Lite'),
      h('option', { value: 'gemini-3.6-flash', selected: curPref === 'gemini-3.6-flash' }, 'Gemini 3.6 Flash'),
      h('option', { value: 'gemini-3.6-flash-lite', selected: curPref === 'gemini-3.6-flash-lite' }, 'Gemini 3.6 Flash Lite'),
      h('option', { value: 'gemini-3.5-flash', selected: curPref === 'gemini-3.5-flash' }, 'Gemini 3.5 Flash'),
      h('option', { value: 'gemini-3.5-flash-lite', selected: curPref === 'gemini-3.5-flash-lite' }, 'Gemini 3.5 Flash Lite (Low quota & fast)')
    ]);

    const activeModelBadge = h('div', { class: 'bk-sub', style: 'font-size: 11px; margin-top: 4px; color: var(--muted);' },
      `Active now: ${activeModel}${curPref === 'auto' && activeModel !== 'gemini-4-hydrogen' ? ' (auto fallback)' : ''} · Fallback path: 4 ➔ 3.8 ➔ 3.7 ➔ 3.6 ➔ 3.5 ➔ Cloudflare`
    );

    const limitInp = h('input', {
      type: 'number', class: 'inp sm', min: '10', max: '10000', step: '50',
      value: String(hw.limit || 1500),
      style: 'width: 85px; text-align: center;',
      onchange: e => {
        setHwLimit(parseInt(e.target.value, 10));
        drawHw();
      }
    });

    const usageCard = h('div', { class: 'field', style: 'margin-top: 10px; padding: 10px 12px; background: var(--surface-2); border-radius: 8px;' },
      h('div', { class: 'row', style: 'align-items: center; justify-content: space-between; margin-bottom: 4px;' },
        h('b', { style: 'font-size: 13px;' }, 'Daily AI Request Usage (All users):'),
        h('span', { class: 'bk-sub' }, `${totalHw.toLocaleString()} / ${(hw.limit || 1500).toLocaleString()} requests`)
      ),
      h('div', { class: 'usage-bar', style: 'margin: 6px 0;' },
        h('div', { class: 'usage-fill' + (pct > 85 ? ' warn' : ''), style: { width: Math.max(pct, 1) + '%' } })
      ),
      renderUserUsagePills(hw.users, u => u.ocrCalls, n => n.toLocaleString()),
      h('div', { class: 'row', style: 'align-items: center; justify-content: space-between; font-size: 12px; color: var(--muted); margin-top: 4px;' },
        h('span', null, `Cumulative across all users · ${hw.pages || 0} pages read here today`),
        h('div', { class: 'row', style: 'align-items: center; gap: 6px;' },
          h('span', null, 'Daily limit:'),
          limitInp
        )
      )
    );

    hwBox.replaceChildren(
      ...[
        h('div', { class: 'row', style: 'align-items: center; justify-content: space-between; margin-bottom: 6px;' },
          h('label', { class: 'chip check' + (on ? ' on' : ''), style: 'cursor: pointer;' },
            h('input', {
              type: 'checkbox', checked: on, hidden: true,
              onchange: e => {
                setHwOn(e.target.checked);
                drawHw();
              }
            }),
            'Search handwriting'
          ),
          on ? h('span', { class: 'hw-ai-badge', style: 'position: static; transform: none;' }, activeName)
             : h('span', { class: 'bk-sub' }, 'Disabled')
        ),
        h('p', { class: 'modal-text small', style: 'margin-bottom: 6px;' }, txt),
        on ? h('div', { class: 'field', style: 'margin-top: 6px;' },
          h('label', { class: 'small' }, 'Handwriting AI Model:'),
          modelSelect,
          activeModelBadge
        ) : null,
        on ? h('div', { class: 'field', style: 'margin-top: 8px;' },
          h('label', { class: 'small' }, 'Direct Gemini API Key (optional):'),
          keyInp,
          h('span', { class: 'bk-sub' }, 'Leave blank to use your Cloudflare server automatically.')
        ) : null,
        on ? usageCard : null
      ].filter(Boolean)
    );
  };
  drawHw();

  const offUsage = bus.on('hw-usage', () => drawHw());
  const offHwStatus = bus.on('hw-status', () => drawHw());
  const offModelChanged = bus.on('hw-model-changed', () => drawHw());

  const m = modal({
    title: 'Settings (' + APP_VER + ')',
    wide: true,
    onClose: () => { offUsage(); offHwStatus(); offModelChanged(); offCfUsage(); offAnn(); },
    body: h('div', null,
      h('div', {
        class: 'row',
        style: 'align-items: center; justify-content: space-between; padding: 10px 14px; background: var(--surface-2); border-radius: 10px; margin-bottom: 12px;'
      },
        h('div', null,
          h('div', { style: 'font-weight: 600; font-size: 14.5px;' }, 'Inkleaf ' + APP_VER),
          h('div', { class: 'bk-sub', style: 'margin-top: 2px;' }, 'Handwriting notes · Real-time sync · PWA')
        ),
        h('button', {
          class: 'btn sm', type: 'button',
          title: 'Update or reload app cache',
          onclick: () => {
            if ('serviceWorker' in navigator) {
              navigator.serviceWorker.getRegistrations().then(regs => {
                for (const r of regs) r.update();
              });
            }
            location.reload();
          }
        }, 'Check for updates')
      ),
      accountCard,
      h('h3', null, 'Handwriting search'),
      h('p', { class: 'modal-text' },
        'Search your handwritten notes as you type. Uses fast Cloud AI (Gemini Flash) with 1 call per page when online, and syncs search index across devices.'),
      hwBox,
      h('h3', null, 'Live sync'),
      h('p', { class: 'modal-text' },
        'Notes are always kept on this device, so they open instantly and work offline. With sync on, every change is also ',
        'sent to Inkleaf\'s own sync service (on Cloudflare) and appears on your other devices within a second or two.'),
      h('p', { class: 'modal-text small' }, who),
      usage, cfUsageBox, annBox, allowedUsersBox, healthEl, devicesEl,
      h('div', { class: 'row' },
        h('button', {
          class: 'btn primary', type: 'button',
          onclick: async () => { await turnOn(); m.close(); syncNow(true); }
        }, session && !cfg.off ? 'Sync now' : 'Sign in with Google'),
        session ? h('button', {
          class: 'btn', type: 'button',
          onclick: async () => { if (await doSignOut()) m.close(); }
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
        h('button', { class: 'btn', type: 'button', onclick: async e => { const b = e.currentTarget; b.disabled = true; await autoBackup(true); b.disabled = false; fillBk(); } }, 'Back up now')),
      h('div', { style: 'margin-top: 24px; padding-top: 14px; border-top: 1px solid var(--line); text-align: center; color: var(--muted); font-size: 12.5px;' },
        'Inkleaf ' + APP_VER + ' · Build 2026.11'
      )
    )
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
    return { item: it, t: parseInt(it.id, 10) || 0, bytes: it.size, docs: Number(info.docs) || 0 };
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
        // The service name gets a random tail, so two devices backing up in the same millisecond do not overwrite each other.
        list.push({ t, id: t + '-' + Math.random().toString(36).slice(2, 8), docs: D.filter(d => !d.sys && !d.trashed).length, bytes: text.length });
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
        await putBlob('b', latest.id || String(latest.t), bytes, { info: JSON.stringify({ docs: latest.docs }), gz: canZip });
        for (const f of (await cloudBackups()).slice(BK_CLOUD)) await removeBlob('b', f.item.id).catch(() => {});
      });
      latest.cloud = true;
      await db.setMeta('autobk', list);
    }
    await driveDaily(force);
  } catch (e) {
    console.warn('Automatic backup failed', e);
  } finally {
    bkBusy = false;
  }
}

// A whole copy of every notebook (folders, notebooks, pages and writing) goes to the person's own Google Drive
// once a day, and the last 30 are kept there. With the PDFs and pictures already in Drive, Drive holds a complete
// copy of the library, independent of the sync service.
const DRIVE_EVERY = 864e5, DRIVE_KEEP = 30;
async function driveBackups() {
  const q = encodeURIComponent("name contains 'zbackup' and trashed = false");
  const j = await (await drive(`/drive/v3/files?spaces=appDataFolder&pageSize=200&q=${q}&fields=files(id,name,size,description)`)).json();
  return (j.files || [])
    .map(f => ({ id: f.id, t: Number((/^zbackup-(\d+)/.exec(f.name) || [])[1]) || 0, bytes: Number(f.size) || 0, docs: Number(f.description) || 0 }))
    .filter(f => f.t).sort((a, b) => b.t - a.t);
}
async function driveDaily(force) {
  if (!ready() || !(await driveToken().catch(() => null))) return;
  const last = (await db.getMeta('driveCopy')) || 0;
  if (!force && Date.now() - last < DRIVE_EVERY) return;
  const [folders, docs, pages] = await Promise.all(['folders', 'docs', 'pages'].map(s => db.all(s)));
  const live = r => !r.deleted, D = docs.filter(live);
  if (!D.some(d => !d.sys)) return;
  const t = Date.now();
  const text = JSON.stringify({ app: 'inkleaf', version: 1, kind: 'auto', exported: t, folders: folders.filter(live), docs: D.map(({ thumb, ...d }) => d), pages: pages.filter(live) });
  await driveUpload(null, new Blob([text]), 'application/json', String(D.filter(d => !d.sys && !d.trashed).length), `zbackup-${t}.json`);
  for (const f of (await driveBackups()).slice(DRIVE_KEEP)) await drive('/drive/v3/files/' + f.id, { method: 'DELETE' }).catch(() => {});
  await db.setMeta('driveCopy', t);
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
    try { if (await driveToken()) for (const f of await driveBackups()) rows.set(f.t, { ...(rows.get(f.t) || f), driveId: f.id }); } catch { /* Drive not reachable */ }
  }
  const all = [...rows.values()].sort((a, b) => b.t - a.t);
  const textOf = async b => {
    if (b.local) return db.getMeta('autobk:' + b.t);
    if (b.driveId && !b.item) return (await drive('/drive/v3/files/' + b.driveId + '?alt=media')).text();
    const bytes = await getBlob(b.item);
    return new TextDecoder().decode(b.item.gz ? await pipe(bytes, new DecompressionStream('gzip')) : bytes);
  };
  const fmt = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  bkList.replaceChildren(...(all.length ? all.map(b => h('div', { class: 'bk-row' },
    h('div', { class: 'bk-meta' },
      h('b', null, fmt(b.t)),
      h('span', { class: 'bk-sub' }, `${b.docs} notebook${b.docs === 1 ? '' : 's'} · ${[b.local && 'this device', b.item && 'sync service', b.driveId && 'Google Drive'].filter(Boolean).join(' and ')}`)),
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
    if (b.driveId) { try { await drive('/drive/v3/files/' + b.driveId, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) toast('Could not delete the Google Drive copy: ' + e.message); } }
  }
  list = list.filter(b => !gone.has(b.t));
  await db.setMeta('autobk', list);
  // Keep the weekly rhythm: without this, deleting the newest snapshot would make a new one within the hour.
  await db.setMeta('autobkHold', Math.max(...gone, (await db.getMeta('autobkHold')) || 0));
}
