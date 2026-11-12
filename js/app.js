import { mountLibrary } from './library.js';
import { mountEditor } from './editor.js';
import { initSync } from './sync.js';
import { toast } from './ui.js';

const root = document.getElementById('app');
let current = null;
let queue = Promise.resolve();

async function route() {
  const hash = location.hash.slice(1) || '/';
  if (current) { try { await current.destroy(); } catch (e) { console.error(e); } current = null; }
  root.replaceChildren();
  const d = /^\/d\/(.+)$/.exec(hash);
  if (d) current = await mountEditor(root, d[1]);
  else {
    const f = /^\/f\/(.+)$/.exec(hash);
    current = await mountLibrary(root, f ? f[1] : null);
  }
}

const go = () => { queue = queue.then(route).catch(e => { console.error(e); toast('Something went wrong: ' + e.message); }); };

window.addEventListener('hashchange', go);

(async () => {
  // Ask the browser to keep our storage even when the device runs low on space.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(e => console.warn('Offline mode unavailable', e));
  await initSync().catch(e => console.error(e));
  go();
})();
