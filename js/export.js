// Export a notebook as a PDF. Imported PDF pages are embedded as real vector pages; ink is drawn on top as vectors.
import { db, loadPages } from './db.js';
import { loadScript, h, safeName, downloadBlob } from './util.js';
import * as R from './render.js';
import { renderPdfPage } from './pdfrender.js';
import { busy, modal, toast } from './ui.js';

const canvasBytes = (canvas, type, q) =>
  new Promise((res, rej) => canvas.toBlob(b => (b ? b.arrayBuffer().then(res, rej) : rej(new Error('Canvas export failed'))), type, q));

export async function buildPdf(doc, pages, progress) {
  await loadScript('vendor/pdf-lib.min.js');
  const L = window.PDFLib;
  const { PDFDocument, LineCapStyle, LineJoinStyle, BlendMode } = L;
  const hex = c => {
    const m = /^#?([0-9a-f]{6})$/i.exec(c || '');
    const n = m ? parseInt(m[1], 16) : 0;
    return L.rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255);
  };

  const out = await PDFDocument.create();
  out.setTitle(doc.title);
  out.setCreator('Inkleaf');
  out.setProducer('Inkleaf');

  // Embed source PDF pages, one batch per source file so shared fonts and images are stored once.
  const embedded = new Map(); // page.id -> embedded page | 'blank'
  const bySrc = new Map();
  for (const pg of pages) {
    if (!pg.pdf) continue;
    if (!bySrc.has(pg.pdf.a)) bySrc.set(pg.pdf.a, []);
    bySrc.get(pg.pdf.a).push(pg);
  }
  for (const [aid, pgs] of bySrc) {
    try {
      const a = await db.get('assets', aid);
      const src = await PDFDocument.load(a.data, { updateMetadata: false });
      const ok = [], srcPages = [], boxes = [];
      for (const pg of pgs) {
        const sp = src.getPage(pg.pdf.i);
        if (sp.getRotation().angle % 360 !== 0) continue; // rotated pages fall back to an image
        if (!sp.node.Contents()) { embedded.set(pg.id, 'blank'); continue; }
        const cb = sp.getCropBox();
        ok.push(pg);
        srcPages.push(sp);
        boxes.push({ left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height });
      }
      if (srcPages.length) {
        const emb = await out.embedPages(srcPages, boxes);
        ok.forEach((pg, i) => embedded.set(pg.id, emb[i]));
      }
    } catch (e) {
      console.warn('PDF could not be embedded as vectors; using page images instead', e);
    }
  }

  const imageCache = new Map();
  async function embedAsset(id) {
    if (imageCache.has(id)) return imageCache.get(id);
    let im = null;
    try {
      const a = await db.get('assets', id);
      if (a && a.data) {
        if (a.mime === 'image/jpeg') im = await out.embedJpg(a.data);
        else if (a.mime === 'image/png') im = await out.embedPng(a.data);
        else {
          const img = await R.loadImage(id);
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          im = await out.embedPng(await canvasBytes(c, 'image/png'));
        }
      }
    } catch (e) { console.warn('Image skipped in export', e); }
    imageCache.set(id, im);
    return im;
  }

  for (let n = 0; n < pages.length; n++) {
    const pg = pages[n];
    if (progress) progress(n + 1, pages.length);
    const H = pg.h, pap = R.paperOf(pg);
    const page = out.addPage([pg.w, H]);
    page.drawRectangle({ x: 0, y: 0, width: pg.w, height: H, color: hex(pap.bg) });

    if (pg.pdf) {
      const e = embedded.get(pg.id);
      if (e && e !== 'blank') page.drawPage(e, { x: 0, y: 0, width: pg.w, height: H });
      else if (!e) {
        try {
          const c = await renderPdfPage(pg.pdf.a, pg.pdf.i, 2);
          const jpg = await out.embedJpg(await canvasBytes(c, 'image/jpeg', 0.9));
          page.drawImage(jpg, { x: 0, y: 0, width: pg.w, height: H });
        } catch (err) { console.warn('PDF page skipped in export', err); }
      }
    } else if (pg.bg) {
      const im = await embedAsset(pg.bg.a);
      if (im) page.drawImage(im, { x: 0, y: 0, width: pg.w, height: H });
    } else {
      const g = R.templateGeometry(pg), col = hex(pap.line);
      for (const [x1, y1, x2, y2] of g.lines) {
        page.drawLine({ start: { x: x1, y: H - y1 }, end: { x: x2, y: H - y2 }, thickness: 0.6, color: col });
      }
      for (const [x1, y1, x2, y2] of g.accent) {
        page.drawLine({ start: { x: x1, y: H - y1 }, end: { x: x2, y: H - y2 }, thickness: 0.8, color: hex(pap.accent) });
      }
      for (const [x, y] of g.dots) page.drawCircle({ x, y: H - y, size: 0.9, color: col });
    }

    if (L.setLineJoin) page.pushOperators(L.setLineJoin(LineJoinStyle.Round));
    const blend = pap.dark ? undefined : BlendMode.Multiply;
    const path = (d, color, width, opacity) => page.drawSvgPath(d, {
      x: 0, y: H, borderColor: hex(color), borderWidth: width,
      borderLineCap: LineCapStyle.Round, borderOpacity: opacity, blendMode: blend
    });

    const isHl = it => it.t === 's' && it.tool === 'hl';
    const ordered = [
      ...pg.items.filter(it => it.t === 'im'),
      ...pg.items.filter(isHl),
      ...pg.items.filter(it => !isHl(it) && it.t !== 'im' && it.t !== 'tp' && it.t !== 'nt'),
      ...pg.items.filter(it => it.t === 'tp' || it.t === 'nt')
    ];
    for (const it of ordered) {
      if (it.t === 'nt' || it.t === 'tb') {
        // Sticky notes and tables go in as pictures of themselves.
        const bm = R.itemBitmap(it, 3);
        const png = await out.embedPng(await canvasBytes(bm.canvas, 'image/png'));
        page.drawImage(png, { x: bm.x, y: H - bm.y - bm.h, width: bm.w, height: bm.h });
      } else if (it.t === 'tp') {
        // Tape: a flat strip over everything, faint if it has been tapped open.
        page.drawLine({
          start: { x: it.x1, y: H - it.y1 }, end: { x: it.x2, y: H - it.y2 }, thickness: it.w,
          color: hex(it.c), opacity: it.o ? 0.2 : 1, lineCap: LineCapStyle.Butt
        });
      } else if (it.t === 's') {
        if (it.p.length === 3) {
          if (it.tool !== 'hl') page.drawCircle({ x: it.p[0], y: H - it.p[1], size: R.pw(it, it.p[2]) / 2, color: hex(it.c), blendMode: blend });
        } else {
          for (const run of R.strokeRuns(it)) path(run.d, it.c, run.w, it.tool === 'hl' ? R.HL_ALPHA : it.st === 'pencil' ? 0.72 : 1);
        }
      } else if (it.t === 'sh') {
        if (it.f && (it.k === 'rect' || it.k === 'ellipse')) {
          page.drawSvgPath(R.shapeSvg(it), { x: 0, y: H, color: hex(it.f), blendMode: blend });
        }
        path(R.shapeSvg(it), it.c, it.w, 1);
      } else if (it.t === 'tx') {
        const bm = R.textBitmap(it, 3);
        const png = await out.embedPng(await canvasBytes(bm.canvas, 'image/png'));
        page.drawImage(png, { x: it.x, y: H - it.y - bm.h, width: it.w, height: bm.h });
      } else if (it.t === 'im') {
        if (it.cr || it.r) {
          // Cropped or rotated picture: draw it the way the page shows it and embed that.
          try {
            const a = await db.get('assets', it.a);
            if (await R.loadImage(it.a)) {
              const k = Math.min(4, 2400 / Math.max(it.w, it.h));
              const c = document.createElement('canvas');
              c.width = Math.max(1, Math.round(it.w * k));
              c.height = Math.max(1, Math.round(it.h * k));
              const ctx = c.getContext('2d');
              ctx.scale(k, k);
              ctx.translate(-it.x, -it.y);
              R.drawItem(ctx, it);
              const png = a && a.mime === 'image/png';
              const im = png ? await out.embedPng(await canvasBytes(c, 'image/png')) : await out.embedJpg(await canvasBytes(c, 'image/jpeg', 0.92));
              page.drawImage(im, { x: it.x, y: H - it.y - it.h, width: it.w, height: it.h });
            }
          } catch (e) { console.warn('Image skipped in export', e); }
          continue;
        }
        const im = await embedAsset(it.a);
        if (im) page.drawImage(im, { x: it.x, y: H - it.y - it.h, width: it.w, height: it.h });
      }
    }
  }

  const bytes = await out.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

export async function exportFlow(docId) {
  const b = busy('Preparing PDF...');
  let blob, name;
  try {
    const doc = await db.get('docs', docId);
    const pages = await loadPages(doc);
    name = safeName(doc.title) + '.pdf';
    blob = await buildPdf(doc, pages, (i, n) => b.set(`Preparing PDF... page ${i} of ${n}`));
  } catch (e) {
    console.error(e);
    b.done();
    toast('Export failed: ' + (e.message || e));
    return;
  }
  b.done();

  // Sharing must start from a tap, so the finished file is offered in a dialog.
  const file = new File([blob], name, { type: 'application/pdf' });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  const mb = (blob.size / 1048576).toFixed(blob.size > 1048576 ? 1 : 2);
  const actions = [{ label: 'Download', primary: !canShare, onClick: () => { downloadBlob(blob, name); } }];
  if (canShare) {
    actions.push({
      label: 'Share', primary: true, onClick: async () => {
        try { await navigator.share({ files: [file], title: name }); } catch (e) { if (e.name !== 'AbortError') downloadBlob(blob, name); }
      }
    });
  }
  modal({ title: 'PDF ready', body: h('p', { class: 'modal-text' }, `${name} (${mb} MB)`), actions });
}
