// The library: folders, notebooks, PDF import, search.
import { db, newPage, createDoc, createFolder, deleteDoc, deleteFolder, duplicateDoc, COVERS } from './db.js';
import { h, uid, bus, fmtDate } from './util.js';
import { I } from './icons.js';
import { modal, promptText, confirmBox, popMenu, toast, busy, chipGroup, templatePicker, PAPER_OPTS } from './ui.js';
import { openPdf } from './pdfrender.js';
import { exportFlow } from './export.js';
import { openSettings, syncNow, syncStatus } from './sync.js';

const SIZE_OPTS = [{ v: 'a4', label: 'A4 portrait' }, { v: 'a4l', label: 'A4 landscape' }, { v: 'letter', label: 'Letter' }];

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

export async function mountLibrary(root, folderId) {
  let query = '';
  const grid = h('div', { class: 'grid' });
  const crumbs = h('div', { class: 'crumbs' });
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
  const search = h('input', {
    class: 'search', type: 'search', placeholder: 'Search notebooks',
    oninput: () => { query = search.value.trim().toLowerCase(); render(); }
  });

  const el = h('div', { class: 'lib' },
    h('header', { class: 'lib-head' },
      h('div', { class: 'brand' }, h('img', { src: 'icons/icon.svg', alt: '', width: 30, height: 30 }), h('span', null, 'Inkleaf')),
      h('div', { class: 'search-wrap' }, h('span', { class: 'search-ic', html: I.search }), search),
      syncBtn,
      h('button', { class: 'ic', type: 'button', title: 'Settings', html: I.settings, onclick: () => openSettings() }),
      h('button', { class: 'btn primary new', type: 'button', onclick: e => newMenu(e.currentTarget) }, h('span', { class: 'btn-ic', html: I.plus }), 'New')),
    crumbs, grid, pdfInp);
  root.append(el);

  function newMenu(anchor) {
    popMenu(anchor, [
      { label: 'Notebook', icon: I.book, onClick: newNotebook },
      { label: 'Folder', icon: I.folder, onClick: newFolder },
      { label: 'Import PDF', icon: I.pdf, onClick: () => pdfInp.click() }
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
    const folders = (await db.all('folders')).filter(f => !f.deleted);
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

  function docMenu(anchor, d) {
    popMenu(anchor, [
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
      '-',
      {
        label: 'Delete', icon: I.trash, danger: true, onClick: async () => {
          if (await confirmBox('Delete notebook', `Delete "${d.title}" and all of its pages? This cannot be undone.`, 'Delete', true)) { await deleteDoc(d); render(); }
        }
      }
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
      {
        label: 'Delete', icon: I.trash, danger: true, onClick: async () => {
          if (await confirmBox('Delete folder', `Delete "${f.name}" and everything inside it? This cannot be undone.`, 'Delete', true)) { await deleteFolder(f); render(); }
        }
      }
    ], { align: 'right' });
  }

  async function render() {
    const [allF, allD] = await Promise.all([db.all('folders'), db.all('docs')]);
    const F = allF.filter(f => !f.deleted), D = allD.filter(d => !d.deleted);
    const cur = folderId ? F.find(f => f.id === folderId) : null;
    if (folderId && !cur) { location.hash = '#/'; return; }

    const trail = [];
    for (let f = cur; f; f = f.parentId ? F.find(x => x.id === f.parentId) : null) trail.unshift(f);
    crumbs.replaceChildren(
      h('a', { href: '#/', class: cur ? '' : 'here' }, 'Library'),
      trail.map((f, i) => [h('span', { class: 'crumb-sep' }, '/'), h('a', { href: '#/f/' + f.id, class: i === trail.length - 1 ? 'here' : '' }, f.name)]));

    let fs, ds;
    if (query) {
      fs = F.filter(f => f.name.toLowerCase().includes(query));
      ds = D.filter(d => d.title.toLowerCase().includes(query));
    } else {
      fs = F.filter(f => (f.parentId || null) === folderId);
      ds = D.filter(d => (d.folderId || null) === folderId);
    }
    fs.sort((a, b) => a.name.localeCompare(b.name));
    ds.sort((a, b) => b.modified - a.modified);

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
    for (const d of ds) {
      cards.push(h('div', { class: 'card', onclick: () => { location.hash = '#/d/' + d.id; } },
        h('div', { class: 'cover', style: { '--cover': d.cover || COVERS[0] } },
          d.thumb ? h('img', { src: d.thumb, alt: '', draggable: false }) : h('div', { class: 'cover-blank' })),
        h('div', { class: 'meta' },
          h('div', { class: 'name' }, d.title),
          h('div', { class: 'sub' }, fmtDate(d.modified) + (d.pages && d.pages.length > 1 ? ` · ${d.pages.length} pages` : ''))),
        h('button', { class: 'ic sm card-more', type: 'button', title: 'Notebook options', html: I.more, onclick: e => { e.stopPropagation(); docMenu(e.currentTarget, d); } })));
    }

    if (!cards.length) {
      grid.replaceChildren(h('div', { class: 'empty' },
        h('div', { class: 'empty-ic', html: I.book }),
        h('h2', null, query ? 'Nothing matches that search' : cur ? 'This folder is empty' : 'Your library is empty'),
        query ? null : h('p', null, 'Create a notebook to start writing, or import a PDF to annotate it.'),
        query ? null : h('div', { class: 'empty-actions' },
          h('button', { class: 'btn primary', type: 'button', onclick: newNotebook }, 'New notebook'),
          h('button', { class: 'btn', type: 'button', onclick: () => pdfInp.click() }, 'Import PDF'))));
    } else {
      grid.replaceChildren(...cards);
    }
  }

  function showSync(s) {
    syncBtn.classList.toggle('spin', s.state === 'syncing');
    syncBtn.classList.toggle('warn', s.state === 'error' || s.state === 'signin');
    syncBtn.title = s.text;
  }

  // Dropping a PDF anywhere on the library imports it.
  el.addEventListener('dragover', e => { e.preventDefault(); });
  el.addEventListener('drop', async e => {
    e.preventDefault();
    const f = [...(e.dataTransfer.files || [])].find(x => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
    if (!f) return;
    if (await importPdf(f, folderId)) render();
  });

  const offs = [bus.on('synced', render), bus.on('sync-status', showSync)];
  showSync(syncStatus());
  await render();

  return {
    destroy() {
      offs.forEach(off => off());
      el.remove();
    }
  };
}
