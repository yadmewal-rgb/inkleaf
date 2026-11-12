// Local storage (IndexedDB) and the data model.
//
// folders: {id, name, parentId, modified, deleted}
// docs:    {id, title, folderId, cover, pages:[pageId], template, paper, w, h, thumb, created, modified, deleted}
// pages:   {id, docId, w, h, template, paper, pdf:{a:assetId,i:pageIndex}|null, items:[], dels:{itemId:ts}, modified, deleted}
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
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('folders', { keyPath: 'id' });
        d.createObjectStore('docs', { keyPath: 'id' });
        d.createObjectStore('pages', { keyPath: 'id' }).createIndex('docId', 'docId');
        d.createObjectStore('assets', { keyPath: 'id' });
        d.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function write(store, fn) {
  return open().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite');
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Storage write aborted'));
    fn(t.objectStore(store));
  }));
}

export const db = {
  get: (s, id) => open().then(d => req(d.transaction(s).objectStore(s).get(id))),
  all: s => open().then(d => req(d.transaction(s).objectStore(s).getAll())),
  keys: s => open().then(d => req(d.transaction(s).objectStore(s).getAllKeys())),
  byDoc: docId => open().then(d => req(d.transaction('pages').objectStore('pages').index('docId').getAll(docId))),
  // Saving announces "db-write" so sync can upload the change. Sync's own writes pass silent = true.
  put: (s, v, silent) => write(s, os => { os.put(v); }).then(() => { if (!silent && s !== 'meta') bus.emit('db-write', s); }),
  putMany: (s, arr, silent) => (arr.length
    ? write(s, os => { for (const v of arr) os.put(v); }).then(() => { if (!silent && s !== 'meta') bus.emit('db-write', s); })
    : Promise.resolve()),
  // Store rec only if the saved copy still has the expected "modified" stamp (undefined = must not exist yet).
  putIf: (s, rec, expectModified) => {
    let ok = false;
    return write(s, os => {
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
    pdf: o.pdf || null, items: [], dels: {}, modified: Date.now()
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

function assetIdsOf(pages) {
  const ids = new Set();
  for (const p of pages) {
    if (p.pdf) ids.add(p.pdf.a);
    for (const it of p.items || []) if (it.t === 'im') ids.add(it.a);
  }
  return ids;
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
  const src = (await db.byDoc(doc.id)).filter(p => !p.deleted);
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
  const recs = (await db.byDoc(doc.id)).filter(p => !p.deleted);
  const byId = new Map(recs.map(p => [p.id, p]));
  const pages = doc.pages.map(id => byId.get(id)).filter(Boolean);
  const listed = new Set(doc.pages);
  for (const p of recs) if (!listed.has(p.id)) pages.push(p);
  for (const p of pages) { if (!p.items) p.items = []; if (!p.dels) p.dels = {}; }
  return pages;
}
