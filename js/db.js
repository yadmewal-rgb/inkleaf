// Local storage (IndexedDB) and the data model.
//
// folders: {id, name, parentId, modified, deleted}
// docs:    {id, title, folderId, cover, pages:[pageId], template, paper, w, h, thumb, created, modified, deleted,
//           fav, tags:[string], trashed, sys ('elements' | 'templates' for hidden library-wide notebooks)}
// pages:   {id, docId, w, h, template, paper, pdf:{a:assetId,i:pageIndex}|null, bg:{a:assetId}|null, tpl (own template id),
//           items:[], dels:{itemId:ts}, modified, deleted, trashed, ti (index before it was trashed)}
// assets:  {id, mime, name, data:ArrayBuffer, modified, deleted}
// meta:    {k, v}
//
// Records are never hard-deleted: "deleted" tombstones are what lets deletions travel through sync.
import { uid, bus } from './util.js';

// "?profile=name" opens a separate local library (handy for testing two "devices" on one computer).
const profile = (new URLSearchParams(location.search).get('profile') || '').replace(/[^a-z0-9]/gi, '');
const NAME = 'inkleaf' + (profile ? '-' + profile : ''), VERSION = 1;
let dbp = null;

function open() {
  if (!dbp) {
    const p = dbp = new Promise((res, rej) => {
      const drop = () => { if (dbp === p) dbp = null; }; // forget a connection that is no longer usable
      const r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('folders', { keyPath: 'id' });
        d.createObjectStore('docs', { keyPath: 'id' });
        d.createObjectStore('pages', { keyPath: 'id' }).createIndex('docId', 'docId');
        d.createObjectStore('assets', { keyPath: 'id' });
        d.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = () => {
        const d = r.result;
        // Phones and tablets close the storage connection when the app sits in the background or memory runs
        // short. The next read or write then opens a fresh one instead of failing.
        d.onclose = drop;
        d.onversionchange = () => { d.close(); drop(); };
        res(d);
      };
      r.onerror = () => { drop(); rej(r.error); };
    });
  }
  return dbp;
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// Run fn with the database. If the connection turns out to be dead ("the database connection is closing"),
// open a new one and try once more. Every operation here is safe to repeat.
const dead = e => !!e && e.name !== 'QuotaExceededError'
  && (e.name === 'InvalidStateError' || e.name === 'AbortError' || e.name === 'TransactionInactiveError' || e.name === 'UnknownError'
    || e.aborted || /clos(ing|ed)|connection.*lost/i.test(e.message || '')); // iPad also reports "Connection to Indexed Database server lost"
async function withDb(fn) {
  try {
    return await fn(await open());
  } catch (e) {
    if (!dead(e)) throw e;
    dbp = null;
    return fn(await open());
  }
}

// Coming back to the app (iPad: from another app, or after the screen was off) is when the connection is most
// often gone. Touch the database straight away so it is reconnected before anything needs saving.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') withDb(d => req(d.transaction('meta').objectStore('meta').get('prefs'))).catch(() => {});
});

function write(store, fn) {
  return withDb(d => new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite');
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || Object.assign(new Error('Storage write aborted'), { aborted: true }));
    fn(t.objectStore(store));
  }));
}

export const db = {
  _close: () => open().then(d => d.close()), // for tests: what a phone does to a backgrounded app
  get: (s, id) => withDb(d => req(d.transaction(s).objectStore(s).get(id))),
  all: s => withDb(d => req(d.transaction(s).objectStore(s).getAll())),
  keys: s => withDb(d => req(d.transaction(s).objectStore(s).getAllKeys())),
  byDoc: docId => withDb(d => req(d.transaction('pages').objectStore('pages').index('docId').getAll(docId))),
  // Saving announces "db-write" so sync can upload the change. Sync's own writes pass silent = true.
  // It names the records written, so sync can upload just those.
  put: (s, v, silent) => write(s, os => { os.put(v); }).then(() => { if (!silent && s !== 'meta') bus.emit('db-write', { s, ids: [v.id] }); }),
  putMany: (s, arr, silent) => (arr.length
    ? write(s, os => { for (const v of arr) os.put(v); }).then(() => { if (!silent && s !== 'meta') bus.emit('db-write', { s, ids: arr.map(v => v.id) }); })
    : Promise.resolve()),
  // Store rec only if the saved copy still has the expected "modified" stamp (undefined = must not exist yet).
  putIf: (s, rec, expectModified) => {
    let ok = false;
    return write(s, os => {
      ok = false;
      const g = os.get(rec.id);
      g.onsuccess = () => {
        const cur = g.result;
        if ((cur ? cur.modified : undefined) === expectModified) { os.put(rec); ok = true; }
      };
    }).then(() => ok);
  },
  getMeta: async k => { const r = await db.get('meta', k); return r ? r.v : undefined; },
  setMeta: (k, v) => db.put('meta', { k, v })
};

export const COVERS = ['#2f6f5e', '#1d4e89', '#b23a48', '#d98324', '#6a4c93', '#3a3d45'];
export const SIZES = { a4: [595, 842], a4l: [842, 595], letter: [612, 792] };

export function newPage(docId, o) {
  return {
    id: uid(), docId, w: o.w, h: o.h,
    template: o.template || 'blank', paper: o.paper || 'white',
    pdf: o.pdf || null, bg: o.bg || null, ...(o.tpl ? { tpl: o.tpl } : {}), items: [], dels: {}, modified: Date.now()
  };
}

export async function createDoc({ title, folderId = null, cover = COVERS[0], size = 'a4', template = 'ruled', paper = 'white' }) {
  const [w, h] = SIZES[size] || SIZES.a4;
  const t = Date.now();
  const doc = { id: uid(), title, folderId, cover, pages: [], template, paper, w, h, thumb: null, created: t, modified: t };
  const page = newPage(doc.id, { w, h, template, paper });
  doc.pages.push(page.id);
  await db.put('pages', page);
  await db.put('docs', doc);
  return doc;
}

export async function createFolder(name, parentId = null) {
  const f = { id: uid(), name, parentId, modified: Date.now() };
  await db.put('folders', f);
  return f;
}

export function assetIdsOf(pages) {
  const ids = new Set();
  for (const p of pages) {
    if (p.pdf) ids.add(p.pdf.a);
    if (p.bg) ids.add(p.bg.a);
    for (const it of p.items || []) if (it.t === 'im') ids.add(it.a);
  }
  return ids;
}

// ---------- recycle bin ----------
// Deleting moves a notebook, folder or page to the bin ("trashed" = when). After TRASH_DAYS it is removed for good.
export const TRASH_DAYS = 30;

export async function trashDoc(doc) {
  const t = Date.now();
  await db.put('docs', { ...doc, trashed: t, modified: t });
}

export async function trashFolder(f) {
  const t = Date.now();
  await db.put('folders', { ...f, trashed: t, modified: t });
}

export async function restoreItem(store, rec) {
  const r = { ...rec, modified: Date.now() };
  delete r.trashed;
  await db.put(store, r);
}

// A page taken out of a notebook. "ti" remembers where it was, for putting it back.
export async function trashPage(page, doc, index) {
  const t = Date.now();
  const rec = { ...page, trashed: t, ti: index, modified: t };
  await db.put('pages', rec);
  return rec;
}

export async function restorePage(page) {
  const doc = await db.get('docs', page.docId);
  if (!doc || doc.deleted) throw new Error('Its notebook no longer exists.');
  const p = { ...page, modified: Date.now() };
  delete p.trashed;
  delete p.ti;
  const pages = (doc.pages || []).filter(id => id !== p.id);
  pages.splice(Math.min(page.ti || 0, pages.length), 0, p.id);
  await db.put('pages', p);
  await db.put('docs', { ...doc, pages, modified: Date.now() });
  return doc;
}

export async function erasePage(page) {
  await db.put('pages', { id: page.id, docId: page.docId, w: page.w, h: page.h, items: [], dels: {}, deleted: true, modified: Date.now() });
}

// Remove for good whatever has been in the bin too long (or everything, for "Empty bin").
export async function purgeTrash(all) {
  const cut = all ? Infinity : Date.now() - TRASH_DAYS * 864e5;
  const old = r => r.trashed && !r.deleted && (all || r.trashed < cut);
  const [folders, docs, pages] = await Promise.all([db.all('folders'), db.all('docs'), db.all('pages')]);
  for (const p of pages) if (old(p)) await erasePage(p);
  for (const d of docs) if (old(d)) await deleteDoc(d);
  for (const f of folders) if (old(f)) await deleteFolder(f);
}

// ---------- daily journal ----------
// One notebook (fixed id, so every device agrees on it) with a page per day: page.day = 'YYYY-MM-DD'.
const p2 = n => String(n).padStart(2, '0');
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const dayTitle = key => new Date(key + 'T12:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

// Where a new page for a day belongs: after every earlier day (and the extra pages that follow it).
export function dayIndex(pages, key) {
  let at = 0;
  for (let k = 0; k < pages.length; k++) {
    const p = pages[k];
    if (p.day) { if (p.day <= key) at = k + 1; else break; } else if (at === k) at = k + 1;
  }
  return at;
}

export function newDayPage(doc, key) {
  const pg = newPage(doc.id, { w: doc.w || 595, h: doc.h || 842, template: doc.template, paper: doc.paper });
  pg.day = key;
  pg.title = dayTitle(key);
  return pg;
}

// Makes sure the journal and the page for that day exist. Returns the page's position in the notebook.
export async function journalPage(key = dayKey()) {
  let d = await db.get('docs', 'journal');
  const t = Date.now();
  if (!d || d.deleted) {
    d = { id: 'journal', journal: true, title: 'Journal', folderId: null, cover: '#d98324', pages: [], template: 'ruled', paper: 'white', w: 595, h: 842, thumb: null, created: t, modified: t };
    await db.put('docs', d);
  } else if (d.trashed) {
    d = { ...d, modified: t };
    delete d.trashed;
    await db.put('docs', d);
  }
  const pages = await loadPages(d);
  let i = pages.findIndex(p => p.day === key);
  if (i < 0) {
    const pg = newDayPage(d, key);
    i = dayIndex(pages, key);
    const ids = pages.map(p => p.id);
    ids.splice(i, 0, pg.id);
    await db.put('pages', pg);
    await db.put('docs', { ...d, pages: ids, modified: Date.now() });
  }
  return i;
}

// ---------- hidden notebooks that hold library-wide things (saved elements, own templates) ----------
// They sync like any notebook but never show in the library. Each saved thing is one page.
export const SYS = { elements: 'sys-elements', templates: 'sys-templates' };

export async function sysDoc(kind) {
  const id = SYS[kind];
  let d = await db.get('docs', id);
  if (!d || d.deleted) {
    const t = Date.now();
    d = { id, sys: kind, title: kind, folderId: null, pages: [], template: 'blank', paper: 'white', w: 595, h: 842, created: t, modified: t };
    await db.put('docs', d);
  }
  return d;
}

export async function sysPages(kind) {
  const d = await db.get('docs', SYS[kind]);
  return d && !d.deleted ? loadPages(d) : [];
}

export async function addSysPage(kind, page) {
  const d = await sysDoc(kind);
  page.docId = d.id;
  await db.put('pages', page);
  await db.put('docs', { ...d, pages: [...d.pages, page.id], modified: Date.now() });
}

export async function removeSysPage(kind, page) {
  const d = await sysDoc(kind);
  await erasePage(page);
  await db.put('docs', { ...d, pages: d.pages.filter(id => id !== page.id), modified: Date.now() });
}

export async function deleteDoc(doc) {
  const t = Date.now();
  const pages = await db.byDoc(doc.id);
  const mine = assetIdsOf(pages);
  await db.putMany('pages', pages.map(p => ({
    id: p.id, docId: p.docId, w: p.w, h: p.h, items: [], dels: {}, deleted: true, modified: t
  })));
  await db.put('docs', { ...doc, pages: [], thumb: null, deleted: true, modified: t });
  // Drop files (PDFs, images) nothing else uses any more.
  if (mine.size) {
    const others = assetIdsOf((await db.all('pages')).filter(p => !p.deleted));
    const dead = [...mine].filter(id => !others.has(id));
    await db.putMany('assets', dead.map(id => ({ id, deleted: true, modified: t })));
    if (dead.length) await db.setMeta('assetDels', ((await db.getMeta('assetDels')) || []).concat(dead)); // sync removes them from Drive
  }
}

export async function deleteFolder(folder) {
  const t = Date.now();
  const [folders, docs] = await Promise.all([db.all('folders'), db.all('docs')]);
  const doomed = new Set([folder.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (!f.deleted && f.parentId && doomed.has(f.parentId) && !doomed.has(f.id)) { doomed.add(f.id); grew = true; }
    }
  }
  for (const d of docs) if (!d.deleted && d.folderId && doomed.has(d.folderId)) await deleteDoc(d);
  await db.putMany('folders', folders.filter(f => doomed.has(f.id)).map(f => ({ ...f, deleted: true, modified: t })));
}

export async function duplicateDoc(doc) {
  const t = Date.now();
  const src = (await db.byDoc(doc.id)).filter(p => !p.deleted && !p.trashed);
  const byId = new Map(src.map(p => [p.id, p]));
  const copyId = uid();
  const pages = [];
  for (const pid of doc.pages) {
    const p = byId.get(pid);
    if (!p) continue;
    pages.push({
      ...p, id: uid(), docId: copyId, dels: {}, modified: t,
      items: p.items.map(it => ({ ...it, id: uid(), m: t }))
    });
  }
  const copy = { ...doc, id: copyId, title: doc.title + ' copy', pages: pages.map(p => p.id), created: t, modified: t };
  await db.putMany('pages', pages);
  await db.put('docs', copy);
  return copy;
}

// Pages of a document in notebook order (tolerates records that sync has not delivered yet).
export async function loadPages(doc) {
  const recs = (await db.byDoc(doc.id)).filter(p => !p.deleted && !p.trashed);
  const byId = new Map(recs.map(p => [p.id, p]));
  const pages = doc.pages.map(id => byId.get(id)).filter(Boolean);
  const listed = new Set(doc.pages);
  for (const p of recs) if (!listed.has(p.id)) pages.push(p);
  for (const p of pages) { if (!p.items) p.items = []; if (!p.dels) p.dels = {}; }
  return pages;
}
