// PDF page rendering through pdf.js (loaded on first use).
import { db } from './db.js';
import { loadScript } from './util.js';

const CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';
let libP = null;

export function pdfLib() {
  if (!libP) {
    libP = loadScript('vendor/pdf.min.js').then(() => {
      const L = window.pdfjsLib;
      L.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      return L;
    });
    libP.catch(() => { libP = null; });
  }
  return libP;
}

export async function openPdf(bytes) {
  const L = await pdfLib();
  return L.getDocument({
    data: bytes,
    cMapUrl: CDN + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: CDN + 'standard_fonts/'
  }).promise;
}

const docs = new Map(); // assetId -> Promise<PDFDocumentProxy>

export function pdfDoc(assetId) {
  if (!docs.has(assetId)) {
    const p = db.get('assets', assetId).then(a => {
      if (!a || !a.data) throw new Error('PDF file is not on this device yet');
      return openPdf(new Uint8Array(a.data));
    });
    p.catch(() => docs.delete(assetId));
    docs.set(assetId, p);
  }
  return docs.get(assetId);
}

// Renders are queued one at a time so scrolling stays responsive. isStale lets callers drop outdated jobs.
let chain = Promise.resolve();

// region ({x, y, w, h} in page units) renders just that part of the page, for sharp zoomed-in views.
// noAnnots leaves out the PDF's own annotations (ink, highlights and notes made in other apps).
// The caller owns the returned canvas and should set its width to 0 when done with it: iPads count every
// canvas against a fixed memory allowance until it is emptied, and blank out new ones once that is used up.
export function renderPdfPage(assetId, index, rs, isStale, region, noAnnots) {
  const job = chain.then(async () => {
    if (isStale && isStale()) return null;
    const doc = await pdfDoc(assetId);
    const page = await doc.getPage(index + 1);
    const vp = page.getViewport({ scale: rs });
    const c = document.createElement('canvas');
    const opts = { canvasContext: c.getContext('2d'), viewport: vp };
    if (noAnnots) opts.annotationMode = 0;
    if (region) {
      c.width = Math.max(1, Math.round(region.w * rs));
      c.height = Math.max(1, Math.round(region.h * rs));
      opts.transform = [1, 0, 0, 1, -region.x * rs, -region.y * rs];
    } else {
      c.width = Math.max(1, Math.ceil(vp.width));
      c.height = Math.max(1, Math.ceil(vp.height));
    }
    await page.render(opts).promise;
    try { page.cleanup(); } catch { /* still in use: it is cleaned up after a later render */ }
    return c;
  });
  chain = job.catch(() => {});
  return job;
}
