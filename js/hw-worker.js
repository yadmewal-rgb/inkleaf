// Handwriting recognition, run in a background worker so writing never waits for it.
// The model (TrOCR small, trained on handwritten English) and its runtime live in vendor/hw/ and work offline
// once the browser has them. Messages in: {id, w, h, data (RGBA bytes)}; out: {id, text} or {id, error}.
import { pipeline, env, RawImage } from '../vendor/hw/transformers.min.js';

const base = new URL('../vendor/hw/', import.meta.url).href;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = base;
env.useBrowserCache = false; // the service worker keeps vendor/hw/ in its own cache
env.backends.onnx.wasm.wasmPaths = base;
env.backends.onnx.wasm.numThreads = 1;

let ready = null;
const load = () => ready || (ready = pipeline('image-to-text', 'model', {
  dtype: 'q8', device: 'wasm',
  progress_callback: p => { if (p.status === 'progress' && p.total) postMessage({ progress: p.file, loaded: p.loaded, total: p.total }); }
}));

self.onmessage = async e => {
  const { id, w, h, data } = e.data;
  try {
    const rec = await load();
    if (!data) { postMessage({ id, text: '' }); return; } // warm-up call
    const img = new RawImage(new Uint8ClampedArray(data), w, h, 4);
    const out = await rec(img, { max_new_tokens: 24 });
    postMessage({ id, text: (out[0] && out[0].generated_text || '').trim() });
  } catch (err) {
    ready = null;
    postMessage({ id, error: String(err && err.message || err) });
  }
};
