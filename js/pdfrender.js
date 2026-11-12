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

export function renderPdfPage(assetId, index, rs, isStale) {
  const job = chain.then(async () => {
    if (isStale && isStale()) return null;
    const doc = await pdfDoc(assetId);
    const page = await doc.getPage(index + 1);
    const vp = page.getViewport({ scale: rs });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(vp.width));
    c.height = Math.max(1, Math.ceil(vp.height));
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c;
  });
  chain = job.catch(() => {});
  return job;
}
