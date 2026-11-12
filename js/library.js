// The library: folders, notebooks, PDF import, search, favourites and tags, the recycle bin.
import {
  db, newPage, createDoc, createFolder, duplicateDoc, loadPages, COVERS,
  trashDoc, trashFolder, restoreItem, restorePage, erasePage, deleteDoc, deleteFolder, purgeTrash, TRASH_DAYS
} from './db.js';
import { h, uid, bus, fmtDate, debounce, fill } from './util.js';
import { I } from './icons.js';
import { modal, promptText, confirmBox, popMenu, toast, busy, chipGroup, templatePicker, PAPER_OPTS } from './ui.js';
import { openPdf } from './pdfrender.js';
import { pdfPagesText } from './pdftools.js';
import { exportFlow } from './export.js';
import { renderPageTo } from './render.js';
import { openSettings, syncNow, syncStatus, shareNotebook, importBackup } from './sync.js';

const SIZE_OPTS = [{ v: 'a4', label: 'A4 portrait' }, { v: 'a4l', label: 'A4 landscape' }, { v: 'letter', label: 'Letter' }];
const SORTS = [['edited', 'Last edited'], ['opened', 'Last opened'], ['name', 'Name'], ['created', 'Date created']];

const lsGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
export const openedAt = id => Number(lsGet('inkleaf.opened.' + id, 0));
export const markOpened = id => lsSet('inkleaf.opened.' + id, String(Date.now()));

export async function importPdf(file, folderId) {
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
      id: docId, title: file.name.replace(/\.pdf$/i, '') || 'Imported PDF', folderId: folderId || null,
      cover: '#b23a48', pages: pages.map(p => p.id), template: 'blank', paper: 'white',
      w: pages[0].w, h: pages[0].h, thumb: null, created: t, modified: t
    };
    await db.putMany('pages', pages);
    await db.put('docs', doc);
    pdf.destroy();
    return doc;
  } catch (e) {
    console.error(e);
    toast(e && e.name === 'PasswordException' ? 'This PDF is password-protected.' : 'That file could not be opened as a PDF.');
    return null;
  } finally {
    b.done();
  }
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
  const grid = h('div', { class: 'grid' });
  const results = h('div', { class: 'results' });
  const crumbs = h('div', { class: 'crumbs' });
  const tools = h('div', { class: 'lib-tools' });
  const syncBtn = h('button', { class: 'ic', type: 'button', title: 'Sync with Google Drive', html: I.sync, onclick: () => syncNow(true) });
  const pdfInp = h('input', {
    type: 'file', accept: 'application/pdf,.pdf', hidden: true,
    onchange: async () => {
      const f = pdfInp.files[0];
      pdfInp.value = '';
      if (!f) return;
      const doc = await importPdf(f, folderId);
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
  const search = h('input', {
    class: 'search', type: 'search', placeholder: 'Search notebooks and pages',
    oninput: () => { query = search.value.trim().toLowerCase(); render(); deepSoon(); }
  });
  const binBtn = h('button', { class: 'ic', type: 'button', title: 'Recycle bin', html: I.trash, onclick: () => { location.hash = '#/bin'; } });

  const el = h('div', { class: 'lib' },
    h('header', { class: 'lib-head' },
      h('div', { class: 'brand' }, h('img', { src: 'icons/icon.svg', alt: '', width: 30, height: 30 }), h('span', null, 'Inkleaf')),
      bin ? h('div', { class: 'grow' }) : h('div', { class: 'search-wrap' }, h('span', { class: 'search-ic', html: I.search }), search),
      syncBtn, bin ? null : binBtn,
      h('button', { class: 'ic', type: 'button', title: 'Settings', html: I.settings, onclick: () => openSettings() }),
      bin ? null : h('button', { class: 'btn primary new', type: 'button', onclick: e => newMenu(e.currentTarget) }, h('span', { class: 'btn-ic', html: I.plus }), 'New')),
    crumbs, tools, grid, results, pdfInp, fileInp);
  root.append(el);

  function newMenu(anchor) {
    popMenu(anchor, [
      { label: 'Notebook', icon: I.book, onClick: newNotebook },
      { label: 'Folder', icon: I.folder, onClick: newFolder },
      { label: 'Import PDF', icon: I.pdf, onClick: () => pdfInp.click() },
      { label: 'Open a notebook file', icon: I.share, onClick: () => fileInp.click() }
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
      { label: 'Send a copy', icon: I.send, onClick: () => shareCopy(d) },
      '-',
      { label: 'Move to bin', icon: I.trash, danger: true, onClick: async () => { await trashDoc(d); toast(`"${d.title}" is in the bin for ${TRASH_DAYS} days`); render(); } }
    ], { align: 'right' });
  }

  function folderMenu(anchor, f) {
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
      '-',
      { label: 'Move to bin', icon: I.trash, danger: true, onClick: async () => { await trashFolder(f); toast(`"${f.name}" and its contents are in the bin`); render(); } }
    ], { align: 'right' });
  }

  function docCard(d) {
    const sub = fmtDate(d.modified) + (d.pages && d.pages.length > 1 ? ` · ${d.pages.length} pages` : '');
    return h('div', { class: 'card', onclick: () => { location.hash = '#/d/' + d.id; } },
      h('div', { class: 'cover', style: { '--cover': d.cover || COVERS[0] } },
        d.thumb ? h('img', { src: d.thumb, alt: '', draggable: false }) : h('div', { class: 'cover-blank' }),
        d.fav ? h('span', { class: 'fav-badge', html: I.starOn }) : null),
      h('div', { class: 'meta' },
        h('div', { class: 'name' }, d.title),
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
      onclick: () => { filter = filter === v && v !== 'all' ? 'all' : v; lsSet('inkleaf.filter', filter); render(); }
    }, icon ? h('span', { class: 'btn-ic', html: icon }) : null, label);
    const sel = h('select', { class: 'sort', title: 'Sort notebooks', onchange: () => { sort = sel.value; lsSet('inkleaf.sort', sort); render(); } },
      SORTS.map(([v, l]) => h('option', { value: v, selected: v === sort }, l)));
    fill(tools, 
      h('div', { class: 'chips' }, chip('all', 'All'), chip('fav', 'Favourites', I.star), [...tags].sort().map(t => chip('tag:' + t, '#' + t))),
      h('div', { class: 'grow' }),
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
      filter !== 'all' && !query ? [h('span', { class: 'crumb-sep' }, '/'), h('span', { class: 'crumb-note' }, filter === 'fav' ? 'Favourites, in every folder' : '#' + filter.slice(4) + ', in every folder')] : null);
    await renderTools(D);

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
      const count = D.filter(d => d.folderId === f.id).length + F.filter(x => x.parentId === f.id).length;
      cards.push(h('div', { class: 'card', onclick: () => { location.hash = '#/f/' + f.id; } },
        h('div', { class: 'cover folder' }, h('span', { html: I.folder })),
        h('div', { class: 'meta' },
          h('div', { class: 'name' }, f.name),
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
  const deepSoon = debounce(async () => {
    const tok = ++searchTok, q = query;
    if (!q || q.length < 2) { fill(results, ); return; }
    fill(results, h('h3', { class: 'res-head' }, 'In pages'), h('p', { class: 'muted-line' }, 'Searching...'));
    const hits = await searchPages(q, sortDocs(await liveDocs()), () => tok !== searchTok);
    if (!hits || tok !== searchTok) return;
    fill(results, 
      h('h3', { class: 'res-head' }, hits.length ? `In pages (${hits.length}${hits.length >= 300 ? '+' : ''})` : 'In pages'),
      hits.length ? null : h('p', { class: 'muted-line' }, 'No typed text, page names or PDF text match. Handwriting is not searchable yet.'),
      hits.map(r => h('a', { class: 'res', href: `#/d/${r.d.id}?p=${r.i + 1}&q=${encodeURIComponent(q)}` },
        h('div', { class: 'res-top' }, h('b', null, r.d.title), h('span', null, `page ${r.i + 1} · ${r.where}`)),
        h('div', { class: 'res-snip' }, r.s.pre, h('mark', null, r.s.hit), r.s.post))));
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
    if (await importPdf(f, folderId)) render();
  });

  const offs = [bus.on('synced', render), bus.on('sync-status', showSync)];
  showSync(syncStatus());
  purgeTrash(false).catch(e => console.warn('Bin clean-up failed', e));
  await render();

  return {
    destroy() {
      searchTok++;
      offs.forEach(off => off());
      el.remove();
    }
  };
}
