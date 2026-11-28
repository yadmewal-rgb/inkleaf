// Annotated copies of BIG PDFs without rebuilding them (owner, 2026-11-28: a big book crashed Chrome with
// "Out of Memory" while its annotated PDF was being made). A PDF may be changed by adding a section at its end
// ("incremental update", the way signatures are added): the book's bytes stay exactly as they are, and only the new
// things are written after them: the writing on each page, blank or written pages, a new page list. So the book is
// in memory once, never unpacked into objects and written out again (that took 5-6 times its size).
//
// readPdf reads just the PDF's index (xref) and the few objects needed to find the pages; writeUpdate writes the
// section to add. Pages from the book keep their own object numbers, so links and bookmarks to them still work.

const N = (L, s) => L.PDFName.of(s);

export function readPdf(L, bytes) {
  const scratch = L.PDFContext.create();
  const dec = new TextDecoder('latin1');
  const text = (a, b) => dec.decode(bytes.subarray(Math.max(0, a), Math.min(bytes.length, b)));
  const find = (s, from) => {
    outer: for (let i = from; i <= bytes.length - s.length; i++) {
      for (let j = 0; j < s.length; j++) if (bytes[i + j] !== s.charCodeAt(j)) continue outer;
      return i;
    }
    return -1;
  };
  const tail = text(bytes.length - 4096, bytes.length), sx = tail.lastIndexOf('startxref');
  if (sx < 0) throw new Error('This PDF has no index (startxref)');
  const startxref = parseInt(tail.slice(sx + 9).trim(), 10);

  const parse = (buf, at) => L.PDFObjectParser.forBytes(buf.subarray(at), scratch).parseObject();
  const parseAt = off => {
    const m = /^\s*(\d+)\s+(\d+)\s+obj\b/.exec(text(off, off + 64));
    if (!m) throw new Error('This PDF\'s index points to the wrong place');
    return parse(bytes, off + m[0].length);
  };
  const num = x => { x = resolve(x); return x && x.asNumber ? x.asNumber() : undefined; };

  // ---- the index: object number -> where it is (newest section wins)
  const entries = new Map(); // n -> {t: 1, off, gen} | {t: 2, stm, idx} | {t: 0}
  let trailer = null, kind = null;
  const seen = new Set();
  const section = off => {
    if (!(off >= 0) || seen.has(off) || seen.size > 500) return;
    seen.add(off);
    if (text(off, off + 4) === 'xref') {
      kind = kind || 'table';
      const tp = find('trailer', off);
      if (tp < 0) throw new Error('This PDF\'s index has no trailer');
      const tok = text(off + 4, tp).trim().split(/\s+/);
      for (let i = 0; i + 1 < tok.length;) {
        const start = +tok[i++], cnt = +tok[i++];
        for (let k = 0; k < cnt && i + 2 < tok.length; k++, i += 3) {
          const n = start + k;
          if (!entries.has(n)) entries.set(n, tok[i + 2] === 'n' ? { t: 1, off: +tok[i], gen: +tok[i + 1] } : { t: 0 });
        }
      }
      const tr = parse(bytes, tp + 7);
      trailer = trailer || tr;
      const xs = tr.get(N(L, 'XRefStm'));
      if (xs) section(xs.asNumber());
      const prev = tr.get(N(L, 'Prev'));
      if (prev) section(prev.asNumber());
      return;
    }
    const st = parseAt(off);
    if (!(st instanceof L.PDFRawStream)) throw new Error('This PDF\'s index could not be read');
    kind = kind || 'stream';
    const d = st.dict;
    trailer = trailer || d;
    const W = d.get(N(L, 'W')).asArray().map(x => x.asNumber());
    const size = d.get(N(L, 'Size')).asNumber();
    const index = d.get(N(L, 'Index')) ? d.get(N(L, 'Index')).asArray().map(x => x.asNumber()) : [0, size];
    const data = unpredict(L.decodePDFRawStream(st).decode(), d.get(N(L, 'DecodeParms')), L);
    const rowLen = W[0] + W[1] + W[2];
    const field = (p, w, dflt) => { if (!w) return dflt; let v = 0; for (let i = 0; i < w; i++) v = v * 256 + data[p + i]; return v; };
    let p = 0;
    for (let s = 0; s + 1 < index.length; s += 2) {
      for (let k = 0; k < index[s + 1] && p + rowLen <= data.length; k++, p += rowLen) {
        const n = index[s] + k, t = field(p, W[0], 1), a = field(p + W[0], W[1], 0), b = field(p + W[0] + W[1], W[2], 0);
        if (entries.has(n)) continue;
        entries.set(n, t === 1 ? { t: 1, off: a, gen: b } : t === 2 ? { t: 2, stm: a, idx: b } : { t: 0 });
      }
    }
    const prev = d.get(N(L, 'Prev'));
    if (prev) section(prev.asNumber());
  };
  section(startxref);
  if (!trailer) throw new Error('This PDF\'s index could not be read');
  if (trailer.get(N(L, 'Encrypt'))) throw new Error('This PDF is protected (encrypted)');

  // ---- objects, read only when needed (big streams such as pictures are never read)
  const cache = new Map(), stms = new Map();
  function objStm(n) {
    if (stms.has(n)) return stms.get(n);
    const s = getObj(n);
    if (!(s instanceof L.PDFRawStream)) throw new Error('A part of this PDF could not be read');
    const data = L.decodePDFRawStream(s).decode();
    const first = s.dict.get(N(L, 'First')).asNumber(), cnt = s.dict.get(N(L, 'N')).asNumber();
    const tok = dec.decode(data.subarray(0, first)).trim().split(/\s+/);
    const offs = [];
    for (let i = 0; i < cnt; i++) offs.push(first + +tok[2 * i + 1]);
    const r = { data, offs };
    stms.set(n, r);
    return r;
  }
  function getObj(n) {
    if (cache.has(n)) return cache.get(n);
    const e = entries.get(n);
    let obj;
    if (e && e.t === 1) obj = parseAt(e.off);
    else if (e && e.t === 2) { const s = objStm(e.stm); obj = s.offs[e.idx] != null ? parse(s.data, s.offs[e.idx]) : undefined; }
    if (!(obj instanceof L.PDFRawStream)) { // streams are not kept (page contents can be big)
      cache.set(n, obj);
      if (obj) scratch.assign(L.PDFRef.of(n, (e && e.gen) || 0), obj);
    }
    return obj;
  }
  function resolve(x) {
    for (let i = 0; i < 32 && x instanceof L.PDFRef; i++) x = getObj(x.objectNumber);
    return x;
  }

  // ---- pages in order, with what they inherit from the page tree
  const rootRef = trailer.get(N(L, 'Root')), root = resolve(rootRef);
  if (!(root instanceof L.PDFDict)) throw new Error('This PDF has no page list');
  const pages = [], visited = new Set();
  const INH = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
  const visit = (ref, node, inh, depth) => {
    if (depth > 64 || !(node instanceof L.PDFDict) || (ref && visited.has(ref))) return;
    if (ref) visited.add(ref);
    const own = { ...inh };
    for (const k of INH) { const v = node.get(N(L, k)); if (v !== undefined) own[k] = v; }
    const kids = resolve(node.get(N(L, 'Kids')));
    if (node.get(N(L, 'Type')) !== N(L, 'Page') && kids instanceof L.PDFArray) {
      for (const k of kids.asArray()) visit(k instanceof L.PDFRef ? k : null, resolve(k), own, depth + 1);
    } else if (ref) pages.push({ ref, dict: node, inh: own });
  };
  const pagesRef = root.get(N(L, 'Pages'));
  visit(pagesRef instanceof L.PDFRef ? pagesRef : null, resolve(pagesRef), {}, 0);

  let size = 0;
  const ts = trailer.get(N(L, 'Size'));
  if (ts) size = ts.asNumber();
  for (const n of entries.keys()) size = Math.max(size, n + 1);
  return { L, bytes, startxref, kind, trailer, rootRef, root, pages, size, resolve, num };
}

// PNG predictors (index streams are usually stored with "Up"); pdf-lib's decoder does not undo them.
function unpredict(data, parms, L) {
  const p = parms instanceof L.PDFDict ? parms : null;
  const pred = p && p.get(N(L, 'Predictor')) ? p.get(N(L, 'Predictor')).asNumber() : 1;
  if (pred < 10) { if (pred === 2) throw new Error('This PDF uses an index format Inkleaf cannot read yet'); return data; }
  const cols = p.get(N(L, 'Columns')) ? p.get(N(L, 'Columns')).asNumber() : 1;
  const rows = Math.floor(data.length / (cols + 1)), out = new Uint8Array(rows * cols);
  let prev = new Uint8Array(cols);
  for (let r = 0; r < rows; r++) {
    const f = data[r * (cols + 1)], row = data.subarray(r * (cols + 1) + 1, (r + 1) * (cols + 1)), cur = out.subarray(r * cols, (r + 1) * cols);
    for (let i = 0; i < cols; i++) {
      const a = i ? cur[i - 1] : 0, b = prev[i], c = i ? prev[i - 1] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  return out;
}

// The first object number the new section may use. Call right after PDFDocument.create(), before anything is drawn.
export function startNumbers(out, src) {
  const C = out.context;
  C.largestObjectNumber = Math.max(C.largestObjectNumber, src.size - 1);
  return C.largestObjectNumber + 1;
}

const f = x => { const v = Math.round(x * 10000) / 10000; return Object.is(v, -0) ? '0' : String(v); };
const rgb = c => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c || ''), n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255].map(f).join(' ');
};

// list: the notebook's pages in order: { leaf (pdf-lib page in `out` with the writing), base (page index in the book,
// or null for a page made wholly in `out`), w, h, box ({x, y, w, h}: where the book's page sits, as R.pdfBox), bg }.
// Returns the bytes to add after the book.
export async function writeUpdate(out, src, list, firstNew) {
  const { L, resolve, num } = src, C = out.context, n = s => N(L, s);
  const pagesRef = C.nextRef(), kids = [], replace = [], skip = new Set(), used = new Set();
  const box = v => {
    v = resolve(v);
    if (!(v instanceof L.PDFArray) || v.size() < 4) return null;
    const a = v.asArray().map(x => num(x));
    if (a.some(x => typeof x !== 'number' || !isFinite(x))) return null;
    return [Math.min(a[0], a[2]), Math.min(a[1], a[3]), Math.max(a[0], a[2]), Math.max(a[1], a[3])];
  };
  const listOf = v => { // a page's content streams: one, or an array of them
    if (v instanceof L.PDFArray) return v.asArray().filter(x => x instanceof L.PDFRef);
    if (v instanceof L.PDFRef) { const r = resolve(v); return r instanceof L.PDFArray ? listOf(r) : [v]; }
    return [];
  };
  const stream = s => C.register(C.stream(s));

  for (const it of list) {
    const sp = it.base != null ? src.pages[it.base] : null;
    if (!sp) { it.leaf.node.set(n('Parent'), pagesRef); kids.push(it.leaf.ref); continue; }
    skip.add(it.leaf.ref);
    const mb = box(sp.inh.MediaBox) || [0, 0, 612, 792];
    let cb = box(sp.inh.CropBox) || mb;
    cb = [Math.max(cb[0], mb[0]), Math.max(cb[1], mb[1]), Math.min(cb[2], mb[2]), Math.min(cb[3], mb[3])];
    if (cb[2] <= cb[0] || cb[3] <= cb[1]) cb = mb;
    const rot = (((num(sp.inh.Rotate) || 0) % 360) + 360) % 360;
    const w0 = cb[2] - cb[0], h0 = cb[3] - cb[1], visW = rot % 180 ? h0 : w0, visH = rot % 180 ? w0 : h0;
    const R = { 0: [1, 0, 0, 1, 0, 0], 90: [0, -1, 1, 0, 0, w0], 180: [-1, 0, 0, -1, w0, h0], 270: [0, 1, -1, 0, h0, 0] }[rot] || [1, 0, 0, 1, 0, 0];
    const H = it.h, b = it.box, sx = b.w / visW, sy = b.h / visH, tx = b.x, ty = H - b.y - b.h;
    // book page -> notebook page: move the crop box to 0,0, turn it as the PDF says, size it, put it in place
    const m = [sx * R[0], sy * R[1], sx * R[2], sy * R[3], sx * (R[4] - R[0] * cb[0] - R[2] * cb[1]) + tx, sy * (R[5] - R[1] * cb[0] - R[3] * cb[1]) + ty];
    // Not turned and not resized: keep the book's own coordinates (its links and notes stay in place) and move the
    // page's frame instead; the writing is moved the other way.
    const plain = rot === 0 && Math.abs(sx - 1) < 1e-4 && Math.abs(sy - 1) < 1e-4;
    const fr = plain ? [-m[4], -m[5], it.w - m[4], H - m[5]] : [0, 0, it.w, H];
    const clip = `${f(cb[0])} ${f(cb[1])} ${f(w0)} ${f(h0)} re W n`;
    const pre = stream(`q ${rgb(it.bg)} rg ${f(fr[0])} ${f(fr[1])} ${f(it.w)} ${f(H)} re f Q\nq ${plain ? '' : m.map(f).join(' ') + ' cm '}${clip}\n`);
    const mid = stream(plain ? `\nQ\nq 1 0 0 1 ${f(fr[0])} ${f(fr[1])} cm\n` : '\nQ\nq\n');
    const end = stream('\nQ\n');
    const ink = listOf(it.leaf.node.get(n('Contents')));

    // resources: the book page's own, plus what the writing uses (pictures, see-through settings)
    const res = C.obj({}), oRes = resolve(sp.inh.Resources), iRes = it.leaf.node.get(n('Resources'));
    if (oRes instanceof L.PDFDict) for (const [k, v] of oRes.entries()) res.set(k, v);
    if (iRes instanceof L.PDFDict) {
      for (const [k, v] of iRes.entries()) {
        if (k === n('ProcSet')) { if (!res.has(k)) res.set(k, v); continue; }
        const ov = resolve(res.get(k)), iv = resolve(v);
        if (ov instanceof L.PDFDict && iv instanceof L.PDFDict) {
          const mm = C.obj({});
          for (const [a, c] of ov.entries()) mm.set(a, c);
          for (const [a, c] of iv.entries()) mm.set(a, c);
          res.set(k, mm);
        } else res.set(k, v);
      }
    }
    const d = C.obj({});
    d.set(n('Type'), n('Page'));
    d.set(n('Parent'), pagesRef);
    d.set(n('MediaBox'), C.obj(fr));
    d.set(n('Resources'), res);
    d.set(n('Contents'), C.obj([pre, ...listOf(sp.dict.get(n('Contents'))), mid, ...ink, end]));
    const grp = sp.dict.get(n('Group'));
    if (grp) d.set(n('Group'), grp);
    const ann = sp.dict.get(n('Annots'));
    if (plain && ann) d.set(n('Annots'), ann);
    let ref = sp.ref;
    if (used.has(ref)) { ref = C.nextRef(); C.assign(ref, d); } else { used.add(ref); replace.push([ref, d]); }
    kids.push(ref);
  }
  C.assign(pagesRef, C.obj({ Type: 'Pages', Kids: kids, Count: kids.length }));
  const cat = C.obj({});
  for (const [k, v] of src.root.entries()) if (![n('Pages'), n('PageLabels'), n('StructTreeRoot'), n('MarkInfo')].includes(k)) cat.set(k, v);
  cat.set(n('Pages'), pagesRef);
  const rootRef = src.rootRef instanceof L.PDFRef ? src.rootRef : C.nextRef();
  if (rootRef === src.rootRef) replace.push([rootRef, cat]); else C.assign(rootRef, cat);

  await out.flush(); // pictures and the like are written into their objects now

  // ---- the bytes to add
  const enc = new TextEncoder(), parts = [], at = [];
  let pos = 0;
  const base = src.bytes.length;
  const put = x => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); pos += b.length; };
  const write = (ref, obj) => {
    at.push([ref.objectNumber, ref.generationNumber, base + pos]);
    put(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
    const b = new Uint8Array(obj.sizeInBytes());
    obj.copyBytesInto(b, 0);
    put(b);
    put('\nendobj\n');
  };
  put('\n');
  for (const [ref, obj] of C.enumerateIndirectObjects()) {
    if (ref.objectNumber < firstNew || skip.has(ref)) continue;
    write(ref, obj);
  }
  for (const [ref, obj] of replace) write(ref, obj);

  let size = src.size;
  for (const [nn] of at) size = Math.max(size, nn + 1);
  const tr = src.trailer, info = tr.get(n('Info')), id = tr.get(n('ID'));
  const extra = `/Root ${rootRef.toString()} /Prev ${src.startxref}${info ? ' /Info ' + info.toString() : ''}${id ? ' /ID ' + id.toString() : ''}`;
  const xrefAt = base + pos;
  const runs = list2runs(at);
  if (src.kind === 'table') {
    let s = 'xref\n';
    for (const r of runs) {
      s += `${r[0][0]} ${r.length}\n`;
      for (const [, g, o] of r) s += `${String(o).padStart(10, '0')} ${String(g).padStart(5, '0')} n\r\n`;
    }
    put(s + `trailer\n<< /Size ${size} ${extra} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  } else { // the book keeps its index as a stream: add one the same way
    const self = size++;
    at.push([self, 0, xrefAt]);
    const rs = list2runs(at), ow = xrefAt > 0xffffffff ? 5 : 4, row = 1 + ow + 2;
    const data = new Uint8Array(at.length * row);
    let p = 0;
    for (const r of rs) {
      for (const [, g, o] of r) {
        data[p] = 1;
        for (let i = ow; i >= 1; i--) data[p + i] = Math.floor(o / 256 ** (ow - i)) % 256;
        data[p + ow + 1] = (g >> 8) & 255; data[p + ow + 2] = g & 255;
        p += row;
      }
    }
    put(`${self} 0 obj\n<< /Type /XRef /Size ${size} /W [1 ${ow} 2] /Index [${rs.map(r => r[0][0] + ' ' + r.length).join(' ')}] ${extra} /Length ${data.length} >>\nstream\n`);
    put(data);
    put(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`);
  }
  const outBytes = new Uint8Array(pos);
  let o = 0;
  for (const b of parts) { outBytes.set(b, o); o += b.length; }
  return outBytes;
}

function list2runs(at) {
  const s = at.slice().sort((a, b) => a[0] - b[0]), runs = [];
  for (const e of s) {
    const r = runs[runs.length - 1];
    if (r && r[r.length - 1][0] + 1 === e[0]) r.push(e);
    else if (!r || r[r.length - 1][0] !== e[0]) runs.push([e]);
  }
  return runs;
}
