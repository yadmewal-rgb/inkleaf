// Import of GoodNotes notebooks (.goodnotes): the PDF pages with the handwriting on them.
//
// What a .goodnotes file is (worked out from real files; GoodNotes does not publish it):
// - a ZIP archive holding Protocol Buffers files, mostly as series of length-prefixed messages;
// - index.attachments.pb lists the attached files (the imported PDF, pictures) under attachments/;
// - index.events.pb is a log of the notebook's objects. A page record (field 2) holds the page id and its size
//   in GoodNotes units (e.g. 1091 x 1543 for A4). A page-content record (field 54) ties a page (54.3.1) to its
//   ink file (54.2, which differs from the notes/ file name only in its last byte) and to its PDF page (54.4.1,
//   e.g. "4WiJa056" = page 56 of the PDF named by the prefix). Outline entries (field 62) carry chapter titles;
//   field 230 holds timers.
// - notes/<id> is a log of the page's items: a header (field 1 = item id, field 3 = 1 when it was deleted)
//   followed by the item (field 7). A stroke's shape (7.2) is Apple "bv41" LZ4 data holding a "tpl" record
//   "vuA(v)A(S(uu))A(S(uuuu))vA(f)": kind, width (float bits), segment kinds, the start point, then quadratic
//   segments (control x, y, end x, y), all as float bits in page units.
// Colour is not stored per stroke in the files seen so far, so strokes come in as dark ink.
import { db, newPage } from './db.js';
import { uid, nextZ } from './util.js';
import { openPdf } from './pdfrender.js';
import { busy, toast } from './ui.js';

const INK = '#1c1d21';

// ---------------------------------------------------------------- ZIP
async function unzip(buf) {
  const b = new Uint8Array(buf), dv = new DataView(buf);
  let e = b.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('This is not a GoodNotes file (not a ZIP archive).');
  let count = dv.getUint16(e + 10, true), cd = dv.getUint32(e + 16, true);
  if (cd === 0xffffffff && e >= 20 && dv.getUint32(e - 20, true) === 0x07064b50) { // ZIP64
    const z = Number(dv.getBigUint64(e - 12, true));
    count = Number(dv.getBigUint64(z + 32, true));
    cd = Number(dv.getBigUint64(z + 48, true));
  }
  const files = new Map();
  let p = cd;
  for (let i = 0; i < count && dv.getUint32(p, true) === 0x02014b50; i++) {
    const method = dv.getUint16(p + 10, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    let csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true), lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
    for (let x = p + 46 + nl; x < p + 46 + nl + xl;) { // ZIP64 sizes live in extra field 1
      const id = dv.getUint16(x, true), len = dv.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (lho === 0xffffffff) lho = Number(dv.getBigUint64(q, true));
      }
      x += 4 + len;
    }
    files.set(name, { method, csize, usize, lho });
    p += 46 + nl + xl + cl;
  }
  return {
    names: [...files.keys()],
    async read(name) {
      const f = files.get(name);
      if (!f) return null;
      const q = f.lho, start = q + 30 + dv.getUint16(q + 26, true) + dv.getUint16(q + 28, true);
      const data = b.subarray(start, start + f.csize);
      if (f.method === 0) return data;
      if (f.method === 8) return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      throw new Error('Unsupported compression in the GoodNotes file');
    }
  };
}

// ---------------------------------------------------------------- Protocol Buffers (structure only)
function varint(b, p) {
  let x = 0, s = 0, c;
  do { c = b[p.i++]; x += (c & 127) * 2 ** s; s += 7; } while (c & 128 && p.i < b.length);
  return x;
}
function msg(b, depth = 3) {
  const p = { i: 0 }, out = [];
  while (p.i < b.length) {
    const key = varint(b, p), f = Math.floor(key / 8), w = key & 7;
    if (!f || f > 4000 || w === 3 || w === 4 || w > 5) throw new Error('not a message');
    if (w === 0) out.push({ f, v: varint(b, p) });
    else if (w === 1) { if (p.i + 8 > b.length) throw new Error('short'); out.push({ f, d: new DataView(b.buffer, b.byteOffset + p.i, 8).getFloat64(0, true) }); p.i += 8; }
    else if (w === 5) { if (p.i + 4 > b.length) throw new Error('short'); out.push({ f, fl: new DataView(b.buffer, b.byteOffset + p.i, 4).getFloat32(0, true) }); p.i += 4; }
    else {
      const n = varint(b, p);
      if (p.i + n > b.length) throw new Error('short');
      const sub = b.subarray(p.i, p.i + n);
      p.i += n;
      let m = null;
      if (depth > 0 && n && !sub.every(c => c >= 32 && c < 127)) { try { m = msg(sub, depth - 1); } catch { /* bytes */ } }
      out.push({ f, raw: sub, m });
    }
  }
  return out;
}
function records(b) { // length-prefixed messages
  const p = { i: 0 }, out = [];
  while (p.i < b.length) { const n = varint(b, p); out.push(b.subarray(p.i, p.i + n)); p.i += n; }
  return out;
}
const field = (m, f) => (m ? m.find(e => e.f === f) : null);
const sub = (m, f) => { const e = field(m, f); return e ? e.m : null; };
const str = (m, f) => { const e = field(m, f); return e && e.raw ? new TextDecoder().decode(e.raw) : null; };

// ---------------------------------------------------------------- Apple LZ4 ("bv41") and "tpl" records
function lz4(src, outLen) {
  const out = new Uint8Array(outLen);
  let i = 0, o = 0;
  while (i < src.length) {
    const t = src[i++];
    let lit = t >> 4;
    if (lit === 15) { let x; do { x = src[i++]; lit += x; } while (x === 255); }
    out.set(src.subarray(i, i + lit), o); i += lit; o += lit;
    if (i >= src.length) break;
    const off = src[i] | (src[i + 1] << 8); i += 2;
    let ml = t & 15;
    if (ml === 15) { let x; do { x = src[i++]; ml += x; } while (x === 255); }
    ml += 4;
    for (let k = 0; k < ml; k++, o++) out[o] = out[o - off];
  }
  return out.subarray(0, o);
}
function bv41(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), parts = [];
  let p = 0;
  while (p + 4 <= b.length) {
    const tag = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    if (tag === 'bv4$') break;
    if (tag === 'bv41') { const raw = dv.getUint32(p + 4, true), pk = dv.getUint32(p + 8, true); parts.push(lz4(b.subarray(p + 12, p + 12 + pk), raw)); p += 12 + pk; }
    else if (tag === 'bv4-') { const raw = dv.getUint32(p + 4, true); parts.push(b.subarray(p + 8, p + 8 + raw)); p += 8 + raw; }
    else return b; // not compressed
  }
  const out = new Uint8Array(parts.reduce((t, x) => t + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}
function tpl(u) {
  if (String.fromCharCode(u[0], u[1], u[2]) !== 'tpl') throw new Error('not tpl');
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let p = 8, fmt = '';
  while (u[p]) fmt += String.fromCharCode(u[p++]);
  p++;
  let k = 0;
  const parse = () => { const out = []; while (k < fmt.length && fmt[k] !== ')') { const c = fmt[k++]; if (c === 'A' || c === 'S') { k++; const kids = parse(); k++; out.push({ t: c, kids }); } else out.push({ t: c }); } return out; };
  const read = n => {
    switch (n.t) {
      case 'v': p += 2; return dv.getUint16(p - 2, true);
      case 'u': p += 4; return dv.getUint32(p - 4, true);
      case 'i': p += 4; return dv.getInt32(p - 4, true);
      case 'f': p += 8; return dv.getFloat64(p - 8, true);
      case 'c': return u[p++];
      case 'S': return n.kids.map(read);
      case 'A': { const c = dv.getUint32(p, true); p += 4; const a = new Array(c); for (let i = 0; i < c; i++) a[i] = n.kids.length === 1 ? read(n.kids[0]) : n.kids.map(read); return a; }
      default: throw new Error('tpl type ' + n.t);
    }
  };
  return { fmt, vals: parse().map(read) };
}
const fbits = (() => { const v = new DataView(new ArrayBuffer(4)); return x => { v.setUint32(0, x); return v.getFloat32(0); }; })();

// One GoodNotes stroke as an Inkleaf stroke; k = page units per GoodNotes unit.
function toStroke(t, k, t0) {
  if (t.fmt !== 'vuA(v)A(S(uu))A(S(uuuu))vA(f)') return null;
  const [, wBits, , starts, segs] = t.vals;
  const width = fbits(wBits);
  if (!(width > 0) || !starts.length) return null;
  const r = v => Math.round(v * k * 100) / 100;
  const P = [];
  let [sx, sy] = starts[0].map(fbits);
  P.push(r(sx), r(sy), 0.5);
  for (const q of segs) { // sample each quadratic piece at its middle and end; Inkleaf smooths between points
    const [cx, cy, ex, ey] = q.map(fbits);
    P.push(r(0.25 * sx + 0.5 * cx + 0.25 * ex), r(0.25 * sy + 0.5 * cy + 0.25 * ey), 0.5, r(ex), r(ey), 0.5);
    sx = ex; sy = ey;
  }
  if (P.some(v => !Number.isFinite(v))) return null;
  return { id: uid(), t: 's', tool: 'pen', c: INK, w: Math.max(0.3, Math.round(width * k * 100) / 100), p: P, z: nextZ(), m: t0 };
}

// ---------------------------------------------------------------- the import
export async function importGoodnotes(file, folderId) {
  const b = busy('Opening the GoodNotes file...');
  try {
    const zip = await unzip(await file.arrayBuffer());
    const read = async n => (await zip.read(n)) || new Uint8Array(0);
    const t0 = Date.now();

    // Attachments (PDFs first: they become the page backgrounds).
    const atts = [];
    for (const r of records(await read('index.attachments.pb'))) {
      try { const m = msg(r, 1); const path = str(m, 2); if (path) atts.push({ id: str(m, 1), path }); } catch { /* skip */ }
    }
    if (!atts.length) for (const n of zip.names) if (n.startsWith('attachments/') && !n.endsWith('/')) atts.push({ id: n, path: n });
    const pdfs = [];
    for (const a of atts) {
      const data = await zip.read(a.path);
      if (!data || String.fromCharCode(data[0], data[1], data[2], data[3]) !== '%PDF') continue;
      b.set('Reading the PDF...');
      const buf = data.slice().buffer;
      const pdf = await openPdf(new Uint8Array(buf.slice(0)));
      const sizes = [];
      for (let i = 0; i < pdf.numPages; i++) { const v = (await pdf.getPage(i + 1)).getViewport({ scale: 1 }); sizes.push([Math.round(v.width * 100) / 100, Math.round(v.height * 100) / 100]); }
      pdf.destroy();
      const asset = { id: uid(), mime: 'application/pdf', name: (file.name.replace(/\.goodnotes$/i, '') || 'GoodNotes') + (pdfs.length ? ' ' + (pdfs.length + 1) : '') + '.pdf', data: buf, modified: t0 };
      pdfs.push({ asset, sizes });
    }

    // Pages, their ink files and PDF pages, from the event log.
    b.set('Reading the pages...');
    const notesIds = new Set();
    for (const r of records(await read('index.notes.pb'))) { try { const id = str(msg(r, 1), 1); if (id) notesIds.add(id); } catch { /* skip */ } }
    for (const n of zip.names) if (n.startsWith('notes/') && n.length > 6) notesIds.add(n.slice(6));
    const inkFor = id => (notesIds.has(id) ? id : [...notesIds].find(n => n.slice(0, -2) === id.slice(0, -2)) || null);
    const pageOrder = [], pageSize = new Map(), content = new Map(), titles = new Map(), prefixes = [];
    for (const r of records(await read('index.events.pb'))) {
      let m; try { m = msg(r, 3); } catch { continue; }
      const pg = sub(m, 2), pc = sub(m, 54), ol = sub(m, 62);
      if (pg) {
        const id = str(pg, 2), sz = sub(pg, 8);
        if (id && !pageSize.has(id)) pageOrder.push(id);
        if (id && sz) pageSize.set(id, [field(sz, 1)?.fl || 0, field(sz, 2)?.fl || 0]);
      }
      if (pc) {
        const pid = str(sub(pc, 3), 1), code = str(sub(pc, 4), 1) || '', link = str(pc, 2);
        const mm = /^(.*?)(\d+)$/.exec(code);
        if (mm && !prefixes.includes(mm[1])) prefixes.push(mm[1]);
        if (pid) content.set(pid, { ink: link ? inkFor(link) : null, pdfNo: mm ? parseInt(mm[2], 10) : 0, prefix: mm ? mm[1] : '' });
      }
      if (ol) { const pid = str(ol, 2), title = str(ol, 5); if (pid && title) titles.set(pid, title); }
    }
    if (!pageOrder.length) throw new Error('No pages were found in this GoodNotes file.');

    const docId = uid(), pages = [];
    let inkCount = 0, skipped = 0;
    for (let n = 0; n < pageOrder.length; n++) {
      const pid = pageOrder[n], c = content.get(pid) || {}, gn = pageSize.get(pid) || [0, 0];
      if (n % 10 === 0) b.set(`Importing page ${n + 1} of ${pageOrder.length}...`);
      const src = pdfs[Math.max(0, prefixes.indexOf(c.prefix))] || pdfs[0];
      const pdfI = c.pdfNo ? c.pdfNo - 1 : -1;
      let w, hgt, pdf = null;
      if (src && pdfI >= 0 && pdfI < src.sizes.length) { [w, hgt] = src.sizes[pdfI]; pdf = { a: src.asset.id, i: pdfI }; }
      else { w = 595; hgt = gn[0] ? Math.round(595 * gn[1] / gn[0] * 100) / 100 : 842; }
      const page = newPage(docId, { w, h: hgt, pdf, template: pdf ? 'blank' : 'blank', paper: 'white' });
      if (titles.has(pid)) { page.title = titles.get(pid).slice(0, 120); page.bm = true; }
      const k = gn[0] ? w / gn[0] : 1;
      if (c.ink) {
        const items = new Map(), gone = new Set();
        for (const r of records(await read('notes/' + c.ink))) {
          let m; try { m = msg(r, 2); } catch { continue; }
          if (field(m, 1) && !field(m, 7)) { if (field(m, 3)) gone.add(str(m, 1)); continue; } // item header; field 3 = deleted
          const el = sub(m, 7);
          if (!el) continue;
          const id = str(el, 1), shape = field(el, 2);
          if (!id || !shape || !shape.raw || field(el, 14)) { if (id) gone.add(id); continue; }
          try { const s = toStroke(tpl(bv41(shape.raw)), k, t0); if (s) items.set(id, s); else skipped++; } catch { skipped++; }
        }
        for (const [id, s] of items) if (!gone.has(id)) { page.items.push(s); inkCount++; }
      }
      pages.push(page);
    }

    for (const p of pdfs) await db.put('assets', p.asset);
    const doc = {
      id: docId, title: file.name.replace(/\.goodnotes$/i, '') || 'GoodNotes notebook', folderId: folderId || null,
      cover: '#2f6f5e', pages: pages.map(p => p.id), template: 'blank', paper: 'white',
      w: pages[0].w, h: pages[0].h, thumb: null, created: t0, modified: t0
    };
    await db.putMany('pages', pages);
    await db.put('docs', doc);
    toast(`Imported ${pages.length} page${pages.length === 1 ? '' : 's'} with ${inkCount} pen stroke${inkCount === 1 ? '' : 's'}${skipped ? ` (${skipped} item${skipped === 1 ? '' : 's'} of a kind Inkleaf cannot read yet were left out)` : ''}.`, 5000);
    return doc;
  } catch (e) {
    console.error(e);
    toast('Could not import that GoodNotes file: ' + (e.message || e), 6000);
    return null;
  } finally {
    b.done();
  }
}
