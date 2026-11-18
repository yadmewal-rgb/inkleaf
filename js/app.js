import { mountLibrary } from './library.js';
import { mountEditor } from './editor.js';
import { initSync, openSettings, fetchLiveDoc, openLiveGuestSocket, closeLiveGuestSocket } from './sync.js';
import { toast } from './ui.js';
import { h } from './util.js';

const root = document.getElementById('app');
let current = null;
let queue = Promise.resolve();

// Routes: #/  #/f/<folder>  #/bin  #/d/<notebook>[?p=<page>&q=<find>]  #/d/<left>+<right> (side by side)
async function route() {
  const hash = location.hash.slice(1) || '/';
  if (current) { try { await current.destroy(); } catch (e) { console.error(e); } current = null; }
  root.replaceChildren();
  const d = /^\/d\/([^?]+)(?:\?(.*))?$/.exec(hash);
  if (d) {
    const ids = d[1].split('+').filter(Boolean), q = new URLSearchParams(d[2] || '');
    if (ids.length === 2 && ids[0] !== ids[1]) {
      const panes = [h('div', { class: 'pane' }), h('div', { class: 'pane' })];
      root.append(h('div', { class: 'split' }, panes));
      const eds = [];
      for (let i = 0; i < 2; i++) eds.push(await mountEditor(panes[i], ids[i], { pane: i, other: ids[1 - i] }));
      current = { destroy: async () => { for (const e of eds) await e.destroy(); } };
    } else {
      current = await mountEditor(root, ids[0], { page: parseInt(q.get('p'), 10) || 0, q: q.get('q') || '' });
    }
  } else if (hash === '/bin') {
    current = await mountLibrary(root, null, { bin: true });
  } else if (hash === '/settings') {
    current = await mountLibrary(root, null);
    openSettings();
  } else if (/^\/live\//.test(hash)) {
    const liveMatch = /^\/live\/([^?]+)$/.exec(hash);
    const shareId = liveMatch ? liveMatch[1] : '';
    root.replaceChildren(h('div', { class: 'empty', style: 'padding: 80px 20px; text-align: center;' },
      h('h2', null, 'Connecting to live notebook...'),
      h('p', { class: 'modal-text' }, 'Fetching annotations and page data.')
    ));
    try {
      const { doc: liveDoc, canWrite } = await fetchLiveDoc(shareId);
      openLiveGuestSocket(shareId);
      root.replaceChildren();
      const ed = await mountEditor(root, liveDoc.id, { liveShare: shareId, readOnly: !canWrite });
      current = {
        destroy: async () => {
          closeLiveGuestSocket();
          if (ed && ed.destroy) await ed.destroy();
        }
      };
    } catch (e) {
      root.replaceChildren(h('div', { class: 'empty', style: 'padding: 60px 20px; text-align: center;' },
        h('h2', null, 'Could not open live notebook'),
        h('p', { class: 'modal-text' }, e.message || 'The link may have ended or expired.'),
        h('a', { class: 'btn primary', href: '#/', style: 'margin-top: 16px; display: inline-block;' }, 'Go to Inkleaf')
      ));
    }
  } else {
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
