// The library: folders, notebooks, PDF import, search, favourites and tags, the recycle bin.
import {
  db, newPage, createDoc, createFolder, duplicateDoc, loadPages, COVERS,
  assetIdsOf, trashDoc, trashFolder, restoreItem, restorePage, erasePage, deleteDoc, deleteFolder, purgeTrash, TRASH_DAYS, journalPage
} from './db.js';
import { h, uid, bus, fmtDate, debounce, fill } from './util.js';
import { I } from './icons.js';
import { modal, promptText, confirmBox, popMenu, toast, busy, chipGroup, templatePicker, PAPER_OPTS } from './ui.js';
import { openPdf } from './pdfrender.js';
import { importGoodnotes } from './goodnotes.js';
import { pdfPagesText } from './pdftools.js';
import { exportFlow } from './export.js';
import { renderPageTo } from './render.js';
import { openSettings, syncNow, syncStatus, shareNotebook, shareFolder, stopLiveShare, importBackup, fetchSharedWithMe, fetchLiveDoc, fetchMyShares } from './sync.js';
import { pageIndex, matchIndex, hwOn, getActiveHwModel, formatModelName } from './hwsearch.js';

const SIZE_OPTS = [{ v: 'a4', label: 'A4 portrait' }, { v: 'a4l', label: 'A4 landscape' }, { v: 'letter', label: 'Letter' }];
const SORTS = [['edited', 'Last edited'], ['opened', 'Last opened'], ['name', 'Name'], ['created', 'Date created']];

const lsGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
export const openedAt = id => Number(lsGet('inkleaf.opened.' + id, 0));
export const markOpened = id => lsSet('inkleaf.opened.' + id, String(Date.now()));

export async function importPdf(file, folderId, customTitle = null) {
  const b = busy('Importing PDF...');
  try {
    const buf = await file.arrayBuffer();
    const pdf = await openPdf(new Uint8Array(buf.slice(0)));
    const t = Date.now();
    const asset = { id: uid(), mime: 'application/pdf', name: file.name, data: buf, modified: t };
    await db.put('assets', asset);
    const docId = uid();
    const pages = [];
    const r2 = v => Math.round(v * 100) / 100;
    for (let i = 0; i < pdf.numPages; i++) {
      const p = await pdf.getPage(i + 1);
      const v = p.getViewport({ scale: 1 });
      pages.push(newPage(docId, { w: r2(v.width), h: r2(v.height), pdf: { a: asset.id, i } }));
      if (i % 10 === 0) b.set(`Importing PDF... page ${i + 1} of ${pdf.numPages}`);
    }
    const doc = {
      id: docId, title: (customTitle || file.name.replace(/\.pdf$/i, '') || 'Imported PDF').trim(),
      folderId: folderId || null,
      cover: '#b23a48', pages: pages.map(p => p.id), template: 'blank', paper: 'white',
      w: pages[0].w, h: pages[0].h, thumb: null, created: t, modified: t
    };
    await db.putMany('pages', pages);
    await db.put('docs', doc);
    pdf.destroy();
    bus.emit('synced');
    return doc;
  } catch (e) {
    console.error(e);
    toast(e && e.name === 'PasswordException' ? 'This PDF is password-protected.' : 'That file could not be opened as a PDF.');
    return null;
  } finally {
    b.done();
  }
}

export async function appendPdfToDoc(file, docId) {
  const b = busy('Adding PDF pages...');
  try {
    const doc = await db.get('docs', docId);
    if (!doc) return null;
    const buf = await file.arrayBuffer();
    const pdf = await openPdf(new Uint8Array(buf.slice(0)));
    const t = Date.now();
    const asset = { id: uid(), mime: 'application/pdf', name: file.name, data: buf, modified: t };
    await db.put('assets', asset);
    const newPages = [];
    const r2 = v => Math.round(v * 100) / 100;
    for (let i = 0; i < pdf.numPages; i++) {
      const p = await pdf.getPage(i + 1);
      const v = p.getViewport({ scale: 1 });
      newPages.push(newPage(docId, { w: r2(v.width), h: r2(v.height), pdf: { a: asset.id, i } }));
      if (i % 10 === 0) b.set(`Adding PDF page ${i + 1} of ${pdf.numPages}`);
    }
    await db.putMany('pages', newPages);
    doc.pages = [...(doc.pages || []), ...newPages.map(p => p.id)];
    doc.modified = t;
    await db.put('docs', doc);
    pdf.destroy();
    bus.emit('synced');
    toast(`Added ${newPages.length} pages to "${doc.title}"`, 3500);
    return doc;
  } catch (e) {
    console.error(e);
    toast(e && e.name === 'PasswordException' ? 'This PDF is password-protected.' : 'Could not add PDF to notebook.');
    return null;
  } finally {
    b.done();
  }
}

export async function promptImportPdf(file, currentFolderId = null) {
  if (!file) return null;
  const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    if (/\.(inkleaf|json)$/i.test(file.name)) {
      const ids = await importBackup(file);
      if (ids.length === 1) location.hash = '#/d/' + ids[0];
      return ids;
    }
    toast('Please select a PDF file.');
    return null;
  }

  const [allFolders, allDocs] = await Promise.all([db.all('folders'), db.all('docs')]);
  const liveFolders = allFolders.filter(f => !f.deleted && !f.trashed);
  const existingDocs = allDocs.filter(d => !d.deleted && !d.trashed && !d.sys);

  const baseName = file.name.replace(/\.pdf$/i, '') || 'Imported PDF';
  let mode = 'new';
  let selectedFolder = currentFolderId || '';
  let selectedDoc = existingDocs[0] ? existingDocs[0].id : '';

  return new Promise(resolve => {
    const titleInput = h('input', {
      type: 'text',
      value: baseName,
      placeholder: 'Notebook title',
      style: 'width: 100%; box-sizing: border-box; margin-top: 6px; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--surface-1); color: var(--text); font-size: 14px;'
    });

    const folderSelect = h('select', {
      style: 'width: 100%; box-sizing: border-box; margin-top: 6px; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--surface-1); color: var(--text); font-size: 14px;',
      onchange: e => { selectedFolder = e.target.value; }
    }, [
      h('option', { value: '' }, '📁 Library root (no folder)'),
      ...liveFolders.map(f => h('option', { value: f.id, selected: f.id === currentFolderId }, '📁 ' + f.name))
    ]);

    const docSelect = h('select', {
      style: 'width: 100%; box-sizing: border-box; margin-top: 6px; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--surface-1); color: var(--text); font-size: 14px;',
      onchange: e => { selectedDoc = e.target.value; }
    }, existingDocs.map(d => h('option', { value: d.id }, '📓 ' + d.title)));

    const newSec = h('div', { style: 'margin-top: 14px;' }, [
      h('label', { class: 'bk-sub', style: 'font-weight: 600;' }, 'Notebook name:'),
      titleInput,
      h('label', { class: 'bk-sub', style: 'font-weight: 600; margin-top: 10px; display: block;' }, 'Destination folder:'),
      folderSelect
    ]);

    const appendSec = h('div', { style: 'margin-top: 14px;', hidden: true }, [
      h('label', { class: 'bk-sub', style: 'font-weight: 600;' }, 'Select notebook to append to:'),
      docSelect,
      h('div', { class: 'bk-sub', style: 'margin-top: 6px;' }, 'All pages from this PDF will be added to the end of the notebook.')
    ]);

    const rNew = h('input', {
      type: 'radio', name: 'pdf-import-dest', checked: true,
      onchange: () => { mode = 'new'; newSec.hidden = false; appendSec.hidden = true; }
    });
    const rAppend = h('input', {
      type: 'radio', name: 'pdf-import-dest', disabled: !existingDocs.length,
      onchange: () => { mode = 'append'; newSec.hidden = true; appendSec.hidden = false; }
    });

    const m = modal({
      title: 'Open PDF in Inkleaf',
      wide: false,
      body: h('div', null, [
        h('div', { class: 'bk-sub', style: 'margin-bottom: 12px; font-size: 13.5px;' }, `Choose how to open or add "${file.name}":`),
        h('div', { style: 'padding: 12px 14px; background: var(--surface-2); border-radius: 10px; display: flex; flex-direction: column; gap: 10px;' }, [
          h('label', { style: 'display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 500;' }, [
            rNew,
            h('span', null, 'Create as a new notebook')
          ]),
          h('label', { style: 'display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 500;' }, [
            rAppend,
            h('span', null, existingDocs.length ? 'Add pages to an existing notebook' : 'Add to existing notebook (no notebooks yet)')
          ])
        ]),
        newSec,
        appendSec,
        h('div', { class: 'row', style: 'justify-content: flex-end; gap: 8px; margin-top: 20px;' }, [
          h('button', { class: 'btn', type: 'button', onclick: () => { m.close(); resolve(null); } }, 'Cancel'),
          h('button', {
            class: 'btn primary',
            type: 'button',
            onclick: async () => {
              m.close();
              if (mode === 'new') {
                const doc = await importPdf(file, selectedFolder || null, titleInput.value.trim() || baseName);
                if (doc) location.hash = '#/d/' + doc.id;
                resolve(doc);
              } else {
                const doc = await appendPdfToDoc(file, selectedDoc);
                if (doc) location.hash = '#/d/' + doc.id;
                resolve(doc);
              }
            }
          }, 'Open in Inkleaf')
        ])
      ])
    });
  });
}

// Notebooks that show in the library: not deleted, not in the bin, not inside a folder that is in the bin, not hidden.
export async function liveDocs() {
  const [F, D] = await Promise.all([db.all('folders'), db.all('docs')]);
  const hidden = hiddenFolders(F);
  return D.filter(d => !d.deleted && !d.trashed && !d.sys && !(d.folderId && hidden.has(d.folderId)));
}

function hiddenFolders(F) {
  const out = new Set(F.filter(f => f.deleted || f.trashed).map(f => f.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of F) if (!out.has(f.id) && f.parentId && out.has(f.parentId)) { out.add(f.id); grew = true; }
  }
  return out;
}

// A list of notebooks to choose one from. Resolves to the notebook, or null.
export function chooseNotebook(title, excludeId) {
  return new Promise(async res => {
    let out = null;
    const docs = (await liveDocs()).filter(d => d.id !== excludeId).sort((a, b) => (openedAt(b.id) || b.modified) - (openedAt(a.id) || a.modified));
    if (!docs.length) { toast('There are no other notebooks yet.'); res(null); return; }
    const q = h('input', { class: 'inp sm', type: 'search', placeholder: 'Search notebooks' });
    const list = h('div', { class: 'menu flat pick-list' });
    let m = null;
    const fill = () => {
      const s = q.value.trim().toLowerCase();
      list.replaceChildren(...docs.filter(d => !s || d.title.toLowerCase().includes(s)).slice(0, 80).map(d => h('button', {
        class: 'mi', type: 'button', onclick: () => { out = d; m.close(); }
      }, h('span', { class: 'mi-ic', html: I.book }), d.title)));
    };
    q.addEventListener('input', fill);
    fill();
    m = modal({ title, body: h('div', null, q, list), onClose: () => res(out) });
    q.focus();
  });
}

// ---------- details of a notebook or folder
const fmtSize = b => (b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b / 1024) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB');
const fmtWhen = t => (t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not recorded');
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many || one + 's'}`;

// What a set of notebooks holds: pages, kinds of content, and the space it takes on this device.
async function measure(docs) {
  const st = { pages: 0, ink: 0, strokes: 0, hl: 0, text: 0, pics: 0, notes: 0, tables: 0, shapes: 0, tape: 0, bm: 0, assets: new Set(), files: [], fileBytes: 0, missing: 0 };
  for (const d of docs) {
    const pages = await loadPages(d);
    st.pages += pages.length;
    st.ink += new Blob([JSON.stringify(pages)]).size + (d.thumb ? d.thumb.length : 0);
    for (const p of pages) {
      if (p.bm) st.bm++;
      for (const it of p.items) {
        if (it.t === 's') { if (it.tool === 'hl') st.hl++; else st.strokes++; }
        else if (it.t === 'tx') st.text++;
        else if (it.t === 'im') st.pics++;
        else if (it.t === 'nt') st.notes++;
        else if (it.t === 'tb') st.tables++;
        else if (it.t === 'sh') st.shapes++;
        else if (it.t === 'tp') st.tape++;
      }
    }
    for (const id of assetIdsOf(pages)) st.assets.add(id);
  }
  for (const id of st.assets) {
    const a = await db.get('assets', id);
    if (!a || !a.data) { st.missing++; continue; } // not downloaded to this device yet
    st.fileBytes += a.data.byteLength;
    if (a.mime === 'application/pdf') st.files.push(`${a.name || 'PDF'} (${fmtSize(a.data.byteLength)})`);
  }
  return st;
}

function contentsLine(st) {
  const parts = [
    st.strokes && plural(st.strokes, 'pen stroke'), st.hl && plural(st.hl, 'highlight'), st.text && plural(st.text, 'text box', 'text boxes'),
    st.pics && plural(st.pics, 'picture'), st.shapes && plural(st.shapes, 'shape'), st.notes && plural(st.notes, 'sticky note'),
    st.tables && plural(st.tables, 'table'), st.tape && plural(st.tape, 'strip of tape', 'strips of tape')
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Nothing written yet';
}

// kind: 'd' (notebook) or 'f' (folder)
export async function detailsDialog(kind, id) {
  const b = busy('Measuring...');
  let rows, title;
  try {
    const allF = await db.all('folders');
    const pathOf = fid => {
      const names = [];
      for (let f = allF.find(x => x.id === fid); f; f = f.parentId ? allF.find(x => x.id === f.parentId) : null) names.unshift(f.name);
      return ['Library', ...names].join(' / ');
    };
    const sizeRows = st => [
      ['Size on this device', fmtSize(st.ink + st.fileBytes)],
      ['', `Writing ${fmtSize(st.ink)} · PDFs and pictures ${fmtSize(st.fileBytes)}`],
      st.missing ? ['', `${plural(st.missing, 'file')} not downloaded to this device yet`] : null
    ];
    if (kind === 'd') {
      const d = await db.get('docs', id), st = await measure([d]);
      const first = (await loadPages(d))[0];
      title = d.title;
      rows = [
        ['Kind', d.journal ? 'Journal notebook' : st.files.length ? 'Notebook with an imported PDF' : 'Notebook'],
        ['Location', pathOf(d.folderId)],
        ['Pages', plural(st.pages, 'page') + (st.bm ? ` (${st.bm} bookmarked)` : '')],
        ...sizeRows(st),
        ['Contents', contentsLine(st)],
        st.files.length ? ['PDF files', st.files.join(', ')] : null,
        first ? ['Page size', `${Math.round(first.w * 0.3528)} × ${Math.round(first.h * 0.3528)} mm`] : null,
        ['Created', fmtWhen(d.created)],
        ['Last edited', fmtWhen(d.modified)],
        ['Last opened here', openedAt(d.id) ? fmtWhen(openedAt(d.id)) : 'Not on this device'],
        ['Favourite', d.fav ? 'Yes' : 'No'],
        d.tags && d.tags.length ? ['Tags', d.tags.map(t => '#' + t).join('  ')] : null
      ];
    } else {
      const f = allF.find(x => x.id === id);
      const inside = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const x of allF) if (!x.deleted && !x.trashed && x.parentId && inside.has(x.parentId) && !inside.has(x.id)) { inside.add(x.id); grew = true; }
      }
      const docs = (await db.all('docs')).filter(d => !d.deleted && !d.trashed && !d.sys && inside.has(d.folderId));
      const st = await measure(docs);
      const newest = docs.reduce((m, d) => Math.max(m, d.modified || 0), 0), oldest = docs.reduce((m, d) => Math.min(m, d.created || Infinity), Infinity);
      title = f.name;
      rows = [
        ['Kind', 'Folder'],
        ['Location', pathOf(f.parentId)],
        ['Contains', `${plural(docs.length, 'notebook')}, ${plural(inside.size - 1, 'folder')}`],
        ['Pages', plural(st.pages, 'page')],
        ...sizeRows(st),
        ['Contents', contentsLine(st)],
        ['Oldest notebook created', docs.length && isFinite(oldest) ? fmtWhen(oldest) : 'None'],
        ['Last edited', newest ? fmtWhen(newest) : fmtWhen(f.modified)]
      ];
    }
  } catch (e) {
    console.error(e);
    b.done();
    toast('Could not read the details: ' + e.message);
    return;
  }
  b.done();
  modal({
    title: 'Details: ' + title,
    body: h('div', { class: 'gest details' }, rows.filter(Boolean).map(([k, v]) => h('div', { class: 'gest-row' + (k ? '' : ' sub') }, h('b', null, k), h('span', null, v)))),
    actions: [{ label: 'OK', primary: true }]
  });
}

const snippet = (text, q) => {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return null;
  const a = Math.max(0, i - 28), b = Math.min(text.length, i + q.length + 40);
  return { pre: (a ? '...' : '') + text.slice(a, i), hit: text.slice(i, i + q.length), post: text.slice(i + q.length, b) + (b < text.length ? '...' : '') };
};

// Search inside every page: page names, typed text, sticky notes, tables and the text of PDF pages.
async function searchPages(q, docs, isStale) {
  const out = [];
  for (const d of docs) {
    const pages = await loadPages(d);
    for (let i = 0; i < pages.length && out.length < 300; i++) {
      const pg = pages[i];
      const add = (where, text) => { const s = snippet(text, q); if (s) out.push({ d, i, where, s }); return !!s; };
      if (pg.title && add('Page name', pg.title)) continue;
      let found = false;
      for (const it of pg.items) {
        if (it.t === 'tx' || it.t === 'nt') found = add(it.t === 'nt' ? 'Sticky note' : 'Typed text', it.s || '');
        else if (it.t === 'tb') found = add('Table', (it.cells || []).map(r => r.join('  ')).join('  '));
        if (found) break;
      }
      if (hwOn()) {
        try {
          const hw = await pageIndex(pg.id);
          if (hw) {
            const hm = matchIndex(hw, q);
            if (hm.length) { add('Handwriting', hm.map(h => h.text).join(' · ')); found = true; }
          }
        } catch {}
      }
      if (found || !pg.pdf || pg.tpl) continue;
      try {
        const all = await pdfPagesText(pg.pdf.a);
        if (isStale()) return null;
        add('PDF text', all[pg.pdf.i] || '');
      } catch { /* that PDF is not on this device yet */ }
    }
    if (isStale()) return null;
  }
  return out;
}

export async function mountLibrary(root, folderId, opts = {}) {
  const bin = !!opts.bin;
  let query = '', filter = lsGet('inkleaf.filter', 'all'), sort = lsGet('inkleaf.sort', 'edited'), searchTok = 0;
  let activeSharedFolder = null;
  let sharedItems = [];
  let myShares = new Set();
  let mySharedFolders = new Set();
  try {
    sharedItems = (await db.getMeta('shared_items')) || [];
    myShares = new Set((await db.getMeta('my_shares')) || []);
    mySharedFolders = new Set((await db.getMeta('my_shared_folders')) || []);
  } catch {}
  fetchSharedWithMe().then(sh => {
    if (Array.isArray(sh)) {
      const changed = sh.length !== sharedItems.length;
      sharedItems = sh;
      if (changed || filter === 'shared') render();
    }
  }).catch(() => {});
  fetchMyShares().then(sh => {
    if (sh && sh.size !== myShares.size) {
      myShares = sh;
      render();
    }
  }).catch(() => {});
  const grid = h('div', { class: 'grid' });
  const results = h('div', { class: 'results' });
  const crumbs = h('div', { class: 'crumbs' });
  const tools = h('div', { class: 'lib-tools' });
  const syncBtn = h('button', { class: 'ic', type: 'button', title: 'Sync', html: I.sync, onclick: () => syncNow(true) });
  const pdfInp = h('input', {
    type: 'file', accept: 'application/pdf,.pdf', hidden: true,
    onchange: async () => {
      const f = pdfInp.files[0];
      pdfInp.value = '';
      if (!f) return;
      const doc = await promptImportPdf(f, folderId);
      if (doc) location.hash = '#/d/' + doc.id;
    }
  });
  const fileInp = h('input', {
    type: 'file', accept: '.inkleaf,application/json,application/octet-stream', hidden: true,
    onchange: async () => {
      const f = fileInp.files[0];
      fileInp.value = '';
      if (!f) return;
      const ids = await importBackup(f);
      if (ids.length === 1) location.hash = '#/d/' + ids[0]; else render();
    }
  });
  // No file type filter: iPads grey out .goodnotes files when one is given.
  const gnInp = h('input', {
    type: 'file', hidden: true,
    onchange: async () => {
      const f = gnInp.files[0];
      gnInp.value = '';
      if (!f) return;
      const doc = await importGoodnotes(f, folderId);
      if (doc) location.hash = '#/d/' + doc.id;
    }
  });
  const search = h('input', {
    class: 'search', type: 'search', placeholder: 'Search notebooks and pages',
    oninput: () => { query = search.value.trim().toLowerCase(); render(); deepSoon(); }
  });
  const binBtn = h('button', { class: 'ic wide', type: 'button', title: 'Recycle bin', html: I.trash, onclick: () => { location.hash = '#/bin'; } });

  const hwAiBadge = h('button', {
    class: 'hw-ai-badge',
    type: 'button',
    onclick: e => { e.stopPropagation(); openSettings(); }
  });
  const updateAiBadge = () => {
    const on = hwOn();
    if (on) {
      search.classList.add('has-ai-pill');
      hwAiBadge.textContent = formatModelName(getActiveHwModel()).replace('Gemini ', '');
      hwAiBadge.title = `Handwriting Search AI: ${formatModelName(getActiveHwModel())} (Click to open Settings)`;
      hwAiBadge.style.display = '';
    } else {
      search.classList.remove('has-ai-pill');
      hwAiBadge.style.display = 'none';
    }
  };
  updateAiBadge();
  bus.on('hw-model-changed', updateAiBadge);
  bus.on('hw-status', updateAiBadge);

  const el = h('div', { class: 'lib' },
    h('header', { class: 'lib-head' },
      h('div', { class: 'brand', title: 'Inkleaf Home', onclick: () => { location.hash = '#/'; } }, h('img', { src: 'icons/icon.svg', alt: 'Inkleaf', width: 30, height: 30 }), h('span', null, 'Inkleaf')),
      bin ? h('div', { class: 'grow' }) : h('div', { class: 'search-wrap' }, h('span', { class: 'search-ic', html: I.search }), search, hwAiBadge),
      bin ? null : h('button', {
        class: 'ic wide', type: 'button', title: 'Journal: open today\'s page', html: I.calendar,
        onclick: async () => { const i = await journalPage(); location.hash = '#/d/journal?p=' + (i + 1); }
      }),
      syncBtn, bin ? null : binBtn,
      h('button', { class: 'ic', type: 'button', title: 'Settings', html: I.settings, onclick: () => openSettings() }),
      bin ? null : h('button', { class: 'btn primary new', type: 'button', onclick: e => newMenu(e.currentTarget) }, h('span', { class: 'btn-ic', html: I.plus }), 'New')),
    crumbs, tools, grid, results, pdfInp, fileInp, gnInp);
  root.append(el);

  function newMenu(anchor) {
    const narrow = innerWidth <= 760;
    popMenu(anchor, [
      { label: 'Notebook', icon: I.book, onClick: newNotebook },
      { label: 'Folder', icon: I.folder, onClick: newFolder },
      narrow ? { label: 'Today\'s journal page', icon: I.calendar, onClick: async () => { const i = await journalPage(); location.hash = '#/d/journal?p=' + (i + 1); } } : null,
      { label: 'Auto-sort library', icon: I.folder, onClick: autoSortDialog },
      { label: 'Import PDF', icon: I.pdf, onClick: () => pdfInp.click() },
      { label: 'Import a GoodNotes file', icon: I.book, onClick: () => gnInp.click() },
      { label: 'Open a notebook file', icon: I.share, onClick: () => fileInp.click() },
      narrow ? '-' : null,
      narrow ? { label: 'Recycle bin', icon: I.trash, onClick: () => { location.hash = '#/bin'; } } : null
    ], { align: 'right' });
  }

  function newNotebook() {
    const st = { cover: COVERS[0], size: 'a4', template: 'ruled', paper: 'white' };
    const title = h('input', { class: 'inp', placeholder: 'Untitled notebook', maxLength: 80, autofocus: true });
    const create = async () => {
      const doc = await createDoc({ ...st, title: title.value.trim() || 'Untitled notebook', folderId });
      location.hash = '#/d/' + doc.id;
    };
    const tp = templatePicker(st.template, () => st.paper, v => { st.template = v; });
    const m = modal({
      title: 'New notebook',
      body: h('div', null,
        h('div', { class: 'field' }, h('label', null, 'Name'), title),
        chipGroup('Cover', COVERS.map(c => ({ v: c, label: '', swatch: c })), st.cover, v => { st.cover = v; }),
        chipGroup('Page size', SIZE_OPTS, st.size, v => { st.size = v; }),
        tp.el,
        chipGroup('Paper', PAPER_OPTS, st.paper, v => { st.paper = v; tp.redraw(); })),
      actions: [{ label: 'Cancel' }, { label: 'Create', primary: true, onClick: create }]
    });
    title.addEventListener('keydown', e => { if (e.key === 'Enter') { m.close(); create(); } });
    title.focus();
  }

  async function newFolder() {
    const name = await promptText('New folder', '', 'Folder name');
    if (!name) return;
    await createFolder(name, folderId);
    render();
  }

  async function autoSortDialog() {
    const allD = await liveDocs();
    const allF = await db.all('folders');
    const hidden = hiddenFolders(allF);
    const F = allF.filter(f => !hidden.has(f.id));

    const unsorted = allD.filter(d => !d.folderId || !(d.tags && d.tags.length));
    if (!unsorted.length) {
      toast('Your library is already well organized! All notebooks have folders and tags.');
      return;
    }

    const b = busy('Analyzing library with AI...');
    const categories = [
      { name: 'Math', pattern: /(?:math|calculus|algebra|geometry|stats|trig|equation|theorem)/i, tag: 'Math' },
      { name: 'Physics', pattern: /(?:physics|mechanics|kinematics|thermo|optics|quantum|circuit|halliday)/i, tag: 'Physics' },
      { name: 'Science', pattern: /(?:chemistry|biology|science|lab|experiment)/i, tag: 'Science' },
      { name: 'Study', pattern: /(?:lecture|class|exam|course|semester|syllabus|homework|revision)/i, tag: 'Study' },
      { name: 'Finance', pattern: /(?:budget|finance|money|expense|invoice|bill|tax|bank|accounts)/i, tag: 'Finance' },
      { name: 'Work', pattern: /(?:work|project|meeting|todo|client|company|contract)/i, tag: 'Work' },
      { name: 'Personal', pattern: /(?:journal|diary|daily|thoughts|ideas|plan|routine)/i, tag: 'Personal' }
    ];

    const folderMap = new Map();
    const tagMap = new Map();

    for (const doc of unsorted) {
      const title = doc.title || '';
      let matched = false;

      for (const f of F) {
        if (title.toLowerCase().includes(f.name.toLowerCase()) || f.name.toLowerCase().includes(title.toLowerCase())) {
          if (!doc.folderId || doc.folderId !== f.id) {
            const list = folderMap.get(f.name) || [];
            list.push({ doc, existingFolder: f });
            folderMap.set(f.name, list);
            matched = true;
            break;
          }
        }
      }

      for (const cat of categories) {
        if (cat.pattern.test(title)) {
          if (!doc.folderId) {
            const list = folderMap.get(cat.name) || [];
            if (!list.some(x => x.doc.id === doc.id)) {
              list.push({ doc, existingFolder: F.find(f => f.name.toLowerCase() === cat.name.toLowerCase()) });
              folderMap.set(cat.name, list);
            }
          }
          if (!(doc.tags || []).includes(cat.tag)) {
            const list = tagMap.get(cat.tag) || [];
            if (!list.some(d => d.id === doc.id)) {
              list.push(doc);
              tagMap.set(cat.tag, list);
            }
          }
          matched = true;
        }
      }

      if (!matched && (!doc.tags || !doc.tags.length)) {
        const list = tagMap.get('Notes') || [];
        if (!list.some(d => d.id === doc.id)) {
          list.push(doc);
          tagMap.set('Notes', list);
        }
      }
    }

    const suggestions = [];
    for (const [folderName, items] of folderMap) {
      if (items.length > 0) {
        suggestions.push({
          type: 'folder',
          folderName,
          existingFolder: items[0].existingFolder,
          docs: items.map(x => x.doc)
        });
      }
    }

    for (const [tag, docs] of tagMap) {
      if (docs.length > 0) {
        suggestions.push({
          type: 'tag',
          tag,
          docs
        });
      }
    }

    b.done();

    if (!suggestions.length) {
      toast('No new organization suggestions found.');
      return;
    }

    const body = h('div', { class: 'auto-sort-dialog' },
      h('p', { class: 'modal-text', style: { marginBottom: '12px' } },
        `AI scanned ${unsorted.length} unsorted ${unsorted.length === 1 ? 'notebook' : 'notebooks'}. Suggested organization:`
      ),
      h('div', { class: 'auto-sort-list', style: { display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' } },
        suggestions.map(s => {
          if (s.type === 'folder') {
            return h('div', { class: 'sugg-box' },
              h('div', { class: 'sugg-head' },
                h('span', null, s.existingFolder ? '📁 Move to folder: ' : '📁 Create folder: '),
                h('b', null, s.folderName)
              ),
              h('div', { class: 'sugg-desc' },
                `Move ${s.docs.map(d => d.title).join(', ')} here.`
              )
            );
          } else {
            return h('div', { class: 'sugg-box' },
              h('div', { class: 'sugg-head' },
                h('span', null, '🏷️ Add Tag: '),
                h('b', null, '#' + s.tag)
              ),
              h('div', { class: 'sugg-desc' },
                `Tag ${s.docs.map(d => d.title).join(', ')} for quick filtering.`
              )
            );
          }
        })
      )
    );

    async function applyAll() {
      let count = 0;
      for (const s of suggestions) {
        if (s.type === 'folder') {
          let fid = s.existingFolder ? s.existingFolder.id : null;
          if (!fid) {
            const newF = await createFolder(s.folderName);
            fid = newF.id;
          }
          for (const d of s.docs) {
            d.folderId = fid;
            d.modified = Date.now();
            await db.put('docs', d);
            count++;
          }
        } else if (s.type === 'tag') {
          for (const d of s.docs) {
            const tags = new Set(d.tags || []);
            tags.add(s.tag);
            d.tags = [...tags];
            d.modified = Date.now();
            await db.put('docs', d);
            count++;
          }
        }
      }
      toast(`Library organized (${count} updates applied)`);
      render();
    }

    modal({
      title: '✨ Smart Auto-Sort',
      body,
      actions: [
        { label: 'Cancel' },
        { label: `Apply Suggestions (${suggestions.length})`, primary: true, onClick: applyAll }
      ]
    });
  }

  // Folder picker used by "Move to".
  async function pickFolder(excludeId) {
    const all = await db.all('folders');
    const gone = hiddenFolders(all);
    const folders = all.filter(f => !gone.has(f.id));
    const banned = new Set();
    if (excludeId) {
      banned.add(excludeId);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of folders) if (f.parentId && banned.has(f.parentId) && !banned.has(f.id)) { banned.add(f.id); grew = true; }
      }
    }
    return new Promise(res => {
      let out;
      const rows = [];
      const m = { close: () => {} };
      const add = (id, name, depth) => rows.push(h('button', {
        class: 'mi', type: 'button', style: { paddingLeft: 12 + depth * 18 + 'px' },
        onclick: () => { out = id; m.close(); }
      }, h('span', { class: 'mi-ic', html: I.folder }), name));
      add(null, 'Library', 0);
      const walk = (parent, depth) => {
        for (const f of folders.filter(x => (x.parentId || null) === parent && !banned.has(x.id)).sort((a, b) => a.name.localeCompare(b.name))) {
          add(f.id, f.name, depth);
          walk(f.id, depth + 1);
        }
      };
      walk(null, 1);
      m.close = modal({ title: 'Move to', body: h('div', { class: 'menu flat' }, rows), onClose: () => res(out) }).close;
    });
  }

  async function allTags() {
    const set = new Set();
    for (const d of await liveDocs()) for (const t of d.tags || []) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  async function tagsDialog(d) {
    const cur = new Set(d.tags || []);
    const known = new Set([...(await allTags()), ...cur]);
    const row = h('div', { class: 'chips' });
    const draw = () => row.replaceChildren(...[...known].sort((a, b) => a.localeCompare(b)).map(t => h('button', {
      class: 'chip' + (cur.has(t) ? ' on' : ''), type: 'button',
      onclick: () => { if (cur.has(t)) cur.delete(t); else cur.add(t); draw(); }
    }, '#' + t)));
    const inp = h('input', { class: 'inp', placeholder: 'New tag, e.g. physics', maxLength: 30 });
    const addTag = () => {
      const t = inp.value.trim().replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase();
      if (!t) return;
      known.add(t); cur.add(t); inp.value = ''; draw();
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });
    draw();
    modal({
      title: 'Tags for "' + d.title + '"',
      body: h('div', null, row, h('div', { class: 'field row' }, inp, h('button', { class: 'btn', type: 'button', onclick: addTag }, 'Add'))),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save', primary: true, onClick: async () => {
            addTag();
            const fresh = await db.get('docs', d.id);
            await db.put('docs', { ...fresh, tags: [...cur].sort(), modified: Date.now() });
            render();
          }
        }
      ]
    });
  }

  const shareCopy = d => shareNotebook(d.id);

  function docMenu(anchor, d) {
    const isShared = !!d.shared || myShares.has(d.id);
    popMenu(anchor, [
      {
        label: d.fav ? 'Remove from favourites' : 'Add to favourites', icon: d.fav ? I.starOn : I.star, onClick: async () => {
          await db.put('docs', { ...d, fav: !d.fav, modified: Date.now() });
          render();
        }
      },
      { label: 'Tags', icon: I.tag, onClick: () => tagsDialog(d) },
      {
        label: 'Rename', icon: I.edit, onClick: async () => {
          const name = await promptText('Rename notebook', d.title);
          if (name && name !== d.title) { await db.put('docs', { ...d, title: name, modified: Date.now() }); render(); }
        }
      },
      {
        label: 'Move to', icon: I.move, onClick: async () => {
          const dest = await pickFolder(null);
          if (dest !== undefined && dest !== (d.folderId || null)) { await db.put('docs', { ...d, folderId: dest, modified: Date.now() }); render(); }
        }
      },
      { label: 'Duplicate', icon: I.copy, onClick: async () => { await duplicateDoc(d); render(); } },
      { label: 'Export as PDF', icon: I.share, onClick: () => exportFlow(d.id) },
      { label: 'Share', icon: I.send, onClick: () => shareCopy(d) },
      isShared ? {
        label: 'Stop sharing', icon: I.close, danger: true, onClick: async () => {
          if (!await confirmBox('Stop sharing', `Stop sharing "${d.title}"? Anyone looking at it will be disconnected.`, 'Stop sharing', true)) return;
          await stopLiveShare(d.id);
          toast(`Stopped sharing "${d.title}"`);
          render();
        }
      } : null,
      { label: 'Details', icon: I.info, onClick: () => detailsDialog('d', d.id) },
      '-',
      { label: 'Move to bin', icon: I.trash, danger: true, onClick: async () => { await trashDoc(d); toast(`"${d.title}" is in the bin for ${TRASH_DAYS} days`); render(); } }
    ].filter(Boolean), { align: 'right' });
  }

  function folderMenu(anchor, f) {
    const isFolderShared = mySharedFolders.has(f.id);
    popMenu(anchor, [
      {
        label: 'Rename', icon: I.edit, onClick: async () => {
          const name = await promptText('Rename folder', f.name);
          if (name && name !== f.name) { await db.put('folders', { ...f, name, modified: Date.now() }); render(); }
        }
      },
      {
        label: 'Move to', icon: I.move, onClick: async () => {
          const dest = await pickFolder(f.id);
          if (dest !== undefined && dest !== (f.parentId || null)) { await db.put('folders', { ...f, parentId: dest, modified: Date.now() }); render(); }
        }
      },
      { label: 'Share', icon: I.send, onClick: () => shareFolder(f.id) },
      isFolderShared ? {
        label: 'Stop sharing folder', icon: I.close, danger: true, onClick: async () => {
          if (!await confirmBox('Stop sharing folder', `Stop sharing all notebooks in "${f.name}"?`, 'Stop sharing', true)) return;
          const allDocs = await db.all('docs');
          for (const d of allDocs.filter(x => x.folderId === f.id)) await stopLiveShare(d.id);
          mySharedFolders.delete(f.id);
          await db.setMeta('my_shared_folders', [...mySharedFolders]);
          toast(`Stopped sharing folder "${f.name}"`);
          render();
        }
      } : null,
      { label: 'Details', icon: I.info, onClick: () => detailsDialog('f', f.id) },
      '-',
      { label: 'Move to bin', icon: I.trash, danger: true, onClick: async () => { await trashFolder(f); toast(`"${f.name}" and its contents are in the bin`); render(); } }
    ].filter(Boolean), { align: 'right' });
  }

  function sharedDocCard(item) {
    const sub = `Shared by ${item.ownerEmail || 'friend'}${item.canWrite ? ' · Can edit' : ' · View only'}`;
    const openDoc = () => { location.hash = '#/live/' + item.shareId; };
    return h('div', { class: 'card', onclick: openDoc },
      h('div', { class: 'cover', style: { '--cover': item.cover || COVERS[0] } },
        h('div', { class: 'cover-blank' }),
        h('span', { class: 'shared-badge', title: 'Shared with me', html: I.share })
      ),
      h('div', { class: 'meta' },
        h('div', { class: 'name' }, item.title || 'Shared notebook'),
        h('div', { class: 'sub' }, sub)
      ),
      h('button', {
        class: 'ic sm card-more', type: 'button', title: 'Shared notebook options', html: I.more,
        onclick: e => {
          e.stopPropagation();
          popMenu(e.currentTarget, [
            { label: 'Open live notebook', icon: I.book, onClick: openDoc },
            {
              label: 'Copy link', icon: I.link, onClick: () => {
                const url = location.origin + location.pathname + '#/live/' + item.shareId;
                if (navigator.clipboard) navigator.clipboard.writeText(url);
                toast('Live share link copied to clipboard!');
              }
            },
            {
              label: 'Save a personal copy', icon: I.copy, onClick: async () => {
                const b = busy('Downloading copy...');
                try {
                  const { doc: liveDoc } = await fetchLiveDoc(item.shareId);
                  const fresh = await db.get('docs', liveDoc.id);
                  if (fresh) {
                    delete fresh.liveShare;
                    fresh.title = (item.title || fresh.title) + ' (Copy)';
                    fresh.id = Math.random().toString(36).slice(2, 18);
                    fresh.modified = Date.now();
                    fresh.created = Date.now();
                    await db.put('docs', fresh);
                  }
                  b.done();
                  toast(`Saved copy of "${item.title}" to your Library!`);
                } catch (err) {
                  b.done();
                  toast('Could not save copy: ' + err.message);
                }
              }
            },
            '-',
            {
              label: 'Remove from Shared', icon: I.close, danger: true, onClick: async () => {
                if (!await confirmBox('Remove shared notebook', `Remove "${item.title || 'this notebook'}" from your Shared tab?`, 'Remove', true)) return;
                sharedItems = sharedItems.filter(x => x.shareId !== item.shareId);
                await db.setMeta('shared_items', sharedItems);
                toast('Removed from your Shared tab');
                render();
              }
            }
          ], { align: 'right' });
        }
      })
    );
  }

  function docCard(d) {
    const isShared = !!d.shared || myShares.has(d.id);
    const sub = fmtDate(d.modified) + (d.pages && d.pages.length > 1 ? ` · ${d.pages.length} pages` : '');
    return h('div', { class: 'card', onclick: () => { location.hash = '#/d/' + d.id; } },
      h('div', { class: 'cover', style: { '--cover': d.cover || COVERS[0] } },
        d.thumb ? h('img', { src: d.thumb, alt: '', draggable: false }) : h('div', { class: 'cover-blank' }),
        isShared ? h('span', { class: 'shared-mark-badge', title: 'Shared notebook', html: I.users }) : null,
        d.fav ? h('span', { class: 'fav-badge', html: I.starOn }) : null),
      h('div', { class: 'meta' },
        h('div', { class: 'name' },
          d.title,
          isShared ? h('span', { class: 'shared-name-icon', title: 'Shared notebook', html: I.users }) : null
        ),
        h('div', { class: 'sub' }, sub),
        d.tags && d.tags.length ? h('div', { class: 'tags' }, d.tags.map(t => h('span', { class: 'tag' }, '#' + t))) : null),
      h('button', { class: 'ic sm card-more', type: 'button', title: 'Notebook options', html: I.more, onclick: e => { e.stopPropagation(); docMenu(e.currentTarget, d); } }));
  }

  function sortDocs(ds) {
    const by = {
      edited: (a, b) => b.modified - a.modified,
      opened: (a, b) => (openedAt(b.id) || 0) - (openedAt(a.id) || 0) || b.modified - a.modified,
      name: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }),
      created: (a, b) => (b.created || 0) - (a.created || 0)
    }[sort] || ((a, b) => b.modified - a.modified);
    return ds.sort(by);
  }

  async function renderTools(D) {
    const tags = new Set();
    for (const d of D) for (const t of d.tags || []) tags.add(t);
    if (filter.startsWith('tag:') && !tags.has(filter.slice(4))) filter = 'all';
    const chip = (v, label, icon) => h('button', {
      class: 'chip sm' + (filter === v ? ' on' : ''), type: 'button',
      onclick: () => {
        filter = filter === v && v !== 'all' ? 'all' : v;
        if (filter !== 'shared') activeSharedFolder = null;
        lsSet('inkleaf.filter', filter);
        render();
      }
    }, icon ? h('span', { class: 'btn-ic', html: icon }) : null, label);
    const sel = h('select', { class: 'sort', title: 'Sort notebooks', onchange: () => { sort = sel.value; lsSet('inkleaf.sort', sort); render(); } },
      SORTS.map(([v, l]) => h('option', { value: v, selected: v === sort }, l)));
    fill(tools, 
      h('div', { class: 'chips' },
        chip('all', 'All'),
        chip('fav', 'Favourites', I.star),
        chip('shared', sharedItems.length ? `Shared (${sharedItems.length})` : 'Shared', I.share),
        [...tags].sort().map(t => chip('tag:' + t, '#' + t))
      ),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn sm', type: 'button', title: 'Auto-sort library with AI', onclick: autoSortDialog }, '✨ Auto-sort'),
      sel);
  }

  async function render() {
    if (bin) { await renderBin(); return; }
    const allF = await db.all('folders');
    const hidden = hiddenFolders(allF);
    const F = allF.filter(f => !hidden.has(f.id));
    const D = await liveDocs();
    const cur = folderId ? F.find(f => f.id === folderId) : null;
    if (folderId && !cur) { location.hash = '#/'; return; }

    const trail = [];
    for (let f = cur; f; f = f.parentId ? F.find(x => x.id === f.parentId) : null) trail.unshift(f);
    fill(crumbs, 
      h('a', { href: '#/', class: cur ? '' : 'here' }, 'Library'),
      trail.map((f, i) => [h('span', { class: 'crumb-sep' }, '/'), h('a', { href: '#/f/' + f.id, class: i === trail.length - 1 ? 'here' : '' }, f.name)]),
      filter === 'shared' && !query
        ? [h('span', { class: 'crumb-sep' }, '/'),
           activeSharedFolder
             ? h('a', { href: '#/', onclick: e => { e.preventDefault(); activeSharedFolder = null; render(); } }, 'Shared with me')
             : h('span', { class: 'crumb-note' }, 'Shared with me, from friends'),
           activeSharedFolder ? [h('span', { class: 'crumb-sep' }, '/'), h('span', { class: 'crumb-note' }, activeSharedFolder)] : null
          ]
        : filter !== 'all' && !query
          ? [h('span', { class: 'crumb-sep' }, '/'), h('span', { class: 'crumb-note' }, filter === 'fav' ? 'Favourites, in every folder' : '#' + filter.slice(4) + ', in every folder')]
          : null);
    await renderTools(D);

    if (filter === 'shared') {
      try { sharedItems = await fetchSharedWithMe(); } catch {}
      const items = (sharedItems || []).filter(item => {
        if (!query) return true;
        const q = query.toLowerCase();
        return (item.title || '').toLowerCase().includes(q) ||
               (item.folderName || '').toLowerCase().includes(q) ||
               (item.ownerEmail || '').toLowerCase().includes(q);
      });

      if (!items.length) {
        grid.replaceChildren(h('div', { class: 'empty' },
          h('div', { class: 'empty-ic', html: I.share }),
          h('h2', null, query ? 'No matching shared items' : 'Nothing shared with you yet'),
          h('p', null, query ? 'Try a different search term.' : 'When a friend shares a notebook or folder with your email, it appears here automatically.'),
          query ? null : h('div', { class: 'empty-actions' },
            h('button', { class: 'btn primary', type: 'button', onclick: async () => { await syncNow(true); render(); } }, 'Check for new shares')
          )
        ));
        if (!query) fill(results, );
        return;
      }

      const cards = [];
      if (activeSharedFolder) {
        const folderDocs = items.filter(it => (it.folderName || '') === activeSharedFolder);
        for (const it of folderDocs) cards.push(sharedDocCard(it));
      } else {
        const folderGroups = new Map();
        const standalone = [];
        for (const it of items) {
          if (it.folderName) {
            if (!folderGroups.has(it.folderName)) folderGroups.set(it.folderName, []);
            folderGroups.get(it.folderName).push(it);
          } else {
            standalone.push(it);
          }
        }

        // Shared folder cards
        for (const [fName, fDocs] of folderGroups.entries()) {
          const owner = fDocs[0]?.ownerEmail || 'friend';
          const cnt = fDocs.length;
          cards.push(h('div', {
            class: 'card',
            onclick: () => { activeSharedFolder = fName; render(); }
          },
            h('div', { class: 'cover folder' },
              h('span', { html: I.folder }),
              h('span', { class: 'shared-badge', title: 'Shared folder', html: I.share })
            ),
            h('div', { class: 'meta' },
              h('div', { class: 'name' }, fName),
              h('div', { class: 'sub' }, `Shared by ${owner} · ${cnt} ${cnt === 1 ? 'notebook' : 'notebooks'}`)
            )
          ));
        }

        // Standalone notebook cards
        for (const it of standalone) {
          cards.push(sharedDocCard(it));
        }
      }

      grid.replaceChildren(...cards);
      if (!query) fill(results, );
      return;
    }

    let fs, ds;
    if (query) {
      fs = F.filter(f => f.name.toLowerCase().includes(query));
      ds = D.filter(d => d.title.toLowerCase().includes(query) || (d.tags || []).some(t => t.includes(query.replace(/^#/, ''))));
    } else if (filter !== 'all') {
      fs = [];
      ds = D.filter(d => (filter === 'fav' ? d.fav : (d.tags || []).includes(filter.slice(4))));
    } else {
      fs = F.filter(f => (f.parentId || null) === folderId);
      ds = D.filter(d => (d.folderId || null) === folderId);
    }
    fs.sort((a, b) => a.name.localeCompare(b.name));
    sortDocs(ds);
    if (filter === 'all' && !query) ds.sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0)); // favourites first

    const cards = [];
    for (const f of fs) {
      const isFolderShared = mySharedFolders.has(f.id) || D.some(d => d.folderId === f.id && (d.shared || myShares.has(d.id)));
      const count = D.filter(d => d.folderId === f.id).length + F.filter(x => x.parentId === f.id).length;
      cards.push(h('div', { class: 'card', onclick: () => { location.hash = '#/f/' + f.id; } },
        h('div', { class: 'cover folder' },
          h('span', { html: I.folder }),
          isFolderShared ? h('span', { class: 'shared-mark-badge', title: 'Shared folder', html: I.users }) : null
        ),
        h('div', { class: 'meta' },
          h('div', { class: 'name' },
            f.name,
            isFolderShared ? h('span', { class: 'shared-name-icon', title: 'Shared folder', html: I.users }) : null
          ),
          h('div', { class: 'sub' }, count === 1 ? '1 item' : count + ' items')),
        h('button', { class: 'ic sm card-more', type: 'button', title: 'Folder options', html: I.more, onclick: e => { e.stopPropagation(); folderMenu(e.currentTarget, f); } })));
    }
    for (const d of ds) cards.push(docCard(d));

    if (!cards.length) {
      grid.replaceChildren(query ? h('p', { class: 'muted-line' }, 'No notebook names match.') : h('div', { class: 'empty' },
        h('div', { class: 'empty-ic', html: I.book }),
        h('h2', null, filter !== 'all' ? 'Nothing here yet' : cur ? 'This folder is empty' : 'Your library is empty'),
        filter !== 'all' ? h('p', null, filter === 'fav' ? 'Use a notebook\'s menu to add it to your favourites.' : 'No notebook has this tag.') : h('p', null, 'Create a notebook to start writing, or import a PDF to annotate it.'),
        filter !== 'all' ? null : h('div', { class: 'empty-actions' },
          h('button', { class: 'btn primary', type: 'button', onclick: newNotebook }, 'New notebook'),
          h('button', { class: 'btn', type: 'button', onclick: () => pdfInp.click() }, 'Import PDF'))));
    } else {
      grid.replaceChildren(...cards);
    }
    if (!query) fill(results, );
  }

  // Search inside pages, a moment after typing stops.
  let searchFilter = lsGet('inkleaf.searchFilter', 'all');

  const deepSoon = debounce(async () => {
    const tok = ++searchTok, q = query;
    if (!q || q.length < 2) { fill(results); return; }
    fill(results, h('h3', { class: 'res-head' }, 'In pages'), h('p', { class: 'muted-line' }, 'Searching...'));
    const hits = await searchPages(q, sortDocs(await liveDocs()), () => tok !== searchTok);
    if (!hits || tok !== searchTok) return;

    const renderHits = () => {
      const hwHits = hits.filter(r => r.where === 'Handwriting');
      const txtHits = hits.filter(r => r.where !== 'Handwriting');
      const shown = searchFilter === 'hw' ? hwHits : searchFilter === 'txt' ? txtHits : hits;

      const makeChip = (id, label) => h('button', {
        class: 'chip sm' + (searchFilter === id ? ' on' : ''),
        type: 'button',
        onclick: () => {
          searchFilter = id;
          lsSet('inkleaf.searchFilter', id);
          renderHits();
        }
      }, label);

      const chips = hits.length ? h('div', { class: 'chips', style: 'margin: 6px 0 10px;' },
        makeChip('all', `All (${hits.length}${hits.length >= 300 ? '+' : ''})`),
        makeChip('hw', `Handwriting (${hwHits.length})`),
        makeChip('txt', `Text (${txtHits.length})`)
      ) : null;

      fill(results,
        h('h3', { class: 'res-head' }, hits.length ? `In pages (${shown.length})` : 'In pages'),
        chips,
        shown.length ? null : h('p', { class: 'muted-line' }, hits.length ? 'No matches under this filter.' : 'No typed text, page names, PDF text or handwriting match.'),
        shown.map(r => h('a', { class: 'res', href: `#/d/${r.d.id}?p=${r.i + 1}&q=${encodeURIComponent(q)}` },
          h('div', { class: 'res-top' }, h('b', null, r.d.title), h('span', null, `page ${r.i + 1} · ${r.where}`)),
          h('div', { class: 'res-snip' }, r.s.pre, h('mark', null, r.s.hit), r.s.post)))
      );
    };

    renderHits();
  }, 350);

  // ---------- the recycle bin
  async function renderBin() {
    fill(crumbs, h('a', { href: '#/' }, 'Library'), h('span', { class: 'crumb-sep' }, '/'), h('span', { class: 'here' }, 'Recycle bin'));
    const [F, D, P] = await Promise.all([db.all('folders'), db.all('docs'), db.all('pages')]);
    const fs = F.filter(f => f.trashed && !f.deleted);
    const ds = D.filter(d => d.trashed && !d.deleted && !d.sys);
    const alive = new Map(D.filter(d => !d.deleted && !d.trashed).map(d => [d.id, d]));
    const ps = P.filter(p => p.trashed && !p.deleted && alive.has(p.docId));
    const all = [...fs.map(f => ['f', f]), ...ds.map(d => ['d', d]), ...ps.map(p => ['p', p])].sort((a, b) => b[1].trashed - a[1].trashed);
    fill(tools, 
      h('p', { class: 'muted-line' }, `Deleted notebooks, folders and pages stay here for ${TRASH_DAYS} days, then are removed for good.`),
      h('div', { class: 'grow' }),
      all.length ? h('button', {
        class: 'btn sm danger', type: 'button', onclick: async () => {
          if (!await confirmBox('Empty the bin', `Remove all ${all.length} item${all.length > 1 ? 's' : ''} for good? This cannot be undone.`, 'Empty bin', true)) return;
          await purgeTrash(true);
          render();
        }
      }, 'Empty bin') : null);
    if (!all.length) { grid.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: I.trash }), h('h2', null, 'The bin is empty'))); return; }
    const left = t => Math.max(0, Math.ceil((t + TRASH_DAYS * 864e5 - Date.now()) / 864e5));
    grid.replaceChildren(...all.map(([k, r]) => {
      let cover, name, sub;
      if (k === 'f') { cover = h('div', { class: 'cover folder' }, h('span', { html: I.folder })); name = r.name; sub = 'Folder'; }
      else if (k === 'd') {
        cover = h('div', { class: 'cover', style: { '--cover': r.cover || COVERS[0] } }, r.thumb ? h('img', { src: r.thumb, alt: '' }) : h('div', { class: 'cover-blank' }));
        name = r.title; sub = 'Notebook';
      } else {
        const c = h('canvas', { class: 'bin-thumb' });
        renderPageTo(r, c, 200).catch(() => {});
        cover = h('div', { class: 'cover page-cover' }, c);
        name = 'Page ' + ((r.ti || 0) + 1) + (r.title ? ': ' + r.title : '');
        sub = 'From "' + alive.get(r.docId).title + '"';
      }
      return h('div', { class: 'card bin-card' }, cover,
        h('div', { class: 'meta' }, h('div', { class: 'name' }, name), h('div', { class: 'sub' }, `${sub} · ${left(r.trashed)} days left`)),
        h('div', { class: 'bin-acts' },
          h('button', {
            class: 'btn sm', type: 'button', onclick: async () => {
              try {
                if (k === 'p') await restorePage(r); else await restoreItem(k === 'f' ? 'folders' : 'docs', r);
                toast('Restored');
              } catch (e) { toast(e.message); }
              render();
            }
          }, 'Restore'),
          h('button', {
            class: 'ic sm danger', type: 'button', title: 'Delete for good', html: I.trash, onclick: async () => {
              if (!await confirmBox('Delete for good', `Remove "${name}" for good? This cannot be undone.`, 'Delete', true)) return;
              if (k === 'p') await erasePage(r); else if (k === 'd') await deleteDoc(r); else await deleteFolder(r);
              render();
            }
          })));
    }));
  }

  function showSync(s) {
    syncBtn.classList.toggle('spin', s.state === 'syncing');
    syncBtn.classList.toggle('warn', s.state === 'error' || s.state === 'signin');
    syncBtn.title = s.text;
  }

  // Dropping a PDF (or a notebook file) anywhere on the library imports it.
  el.addEventListener('dragover', e => { e.preventDefault(); });
  el.addEventListener('drop', async e => {
    e.preventDefault();
    const files = [...(e.dataTransfer.files || [])];
    const nb = files.find(x => /\.inkleaf$/i.test(x.name));
    if (nb) { await importBackup(nb); render(); return; }
    const f = files.find(x => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
    if (!f) return;
    if (await promptImportPdf(f, folderId)) render();
  });

  const offs = [bus.on('synced', render), bus.on('sync-status', showSync)];
  showSync(syncStatus());
  purgeTrash(false).catch(e => console.warn('Bin clean-up failed', e));
  bus.emit('folder-open', folderId);
  await render();

  return {
    destroy() {
      searchTok++;
      offs.forEach(off => off());
      el.remove();
    }
  };
}
