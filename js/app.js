import { mountLibrary, promptImportPdf } from './library.js';
import { mountEditor } from './editor.js';
import { initSync, openSettings, fetchLiveDoc, openLiveGuestSocket, closeLiveGuestSocket, signIn, signOut } from './sync.js';
import { toast } from './ui.js';
import { db } from './db.js';
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
      const handle = h('div', { class: 'split-handle' });
      const splitEl = h('div', { class: 'split' }, [panes[0], handle, panes[1]]);
      root.append(splitEl);
      /* ---- draggable split handle ---- */
      panes[0].style.flex = '1 1 0'; panes[1].style.flex = '1 1 0';
      const startDrag = (e) => {
        e.preventDefault();
        document.body.classList.add('split-dragging');
        const vertical = getComputedStyle(splitEl).flexDirection === 'column';
        const rect = splitEl.getBoundingClientRect();
        const hSize = vertical ? handle.offsetHeight : handle.offsetWidth;
        const move = (ev) => {
          const pt = ev.touches ? ev.touches[0] : ev;
          let pos = vertical ? pt.clientY - rect.top : pt.clientX - rect.left;
          const total = vertical ? rect.height : rect.width;
          const min = 80, max = total - hSize - 80;
          pos = Math.max(min, Math.min(pos, max));
          panes[0].style.flex = '0 0 ' + pos + 'px';
          panes[1].style.flex = '0 0 ' + (total - pos - hSize) + 'px';
        };
        const stop = () => {
          document.body.classList.remove('split-dragging');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          window.removeEventListener('pointercancel', stop);
          /* tell each editor to recalculate its size */
          window.dispatchEvent(new Event('resize'));
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
      };
      handle.addEventListener('pointerdown', startDrag);
      const eds = [];
      for (let i = 0; i < 2; i++) eds.push(await mountEditor(panes[i], ids[i], { pane: i, other: ids[1 - i] }));
      current = { destroy: async () => { for (const e of eds) await e.destroy(); } };
    } else {
      const pParam = parseInt(q.get('p'), 10);
      let pSaved = 0;
      try {
        const loc = parseInt(localStorage.getItem('inkleaf.pos.' + ids[0]) || '-1', 10);
        if (!isNaN(loc) && loc >= 0) pSaved = loc + 1;
        else {
          const d = await db.get('docs', ids[0]);
          if (d && typeof d.lastPage === 'number' && d.lastPage > 0) pSaved = d.lastPage;
        }
      } catch {}
      const targetPage = pParam || pSaved || 1;
      current = await mountEditor(root, ids[0], { page: targetPage, q: q.get('q') || '' });
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
      const msg = e.message || '';
      if (msg.startsWith('SIGNIN_REQUIRED:')) {
        const text = msg.slice('SIGNIN_REQUIRED:'.length);
        root.replaceChildren(h('div', { class: 'empty', style: 'padding: 60px 20px; text-align: center;' },
          h('h2', null, 'Private notebook'),
          h('p', { class: 'modal-text' }, text),
          h('button', {
            class: 'btn primary',
            style: 'margin-top: 16px;',
            onclick: async () => {
              try {
                await signIn();
                route();
              } catch (err) {
                toast('Sign in failed: ' + err.message);
              }
            }
          }, 'Sign in with Google')
        ));
      } else if (msg.startsWith('FORBIDDEN:')) {
        const text = msg.slice('FORBIDDEN:'.length);
        root.replaceChildren(h('div', { class: 'empty', style: 'padding: 60px 20px; text-align: center;' },
          h('h2', null, 'Access denied'),
          h('p', { class: 'modal-text' }, text),
          h('div', { class: 'row', style: 'justify-content: center; gap: 8px; margin-top: 16px;' },
            h('button', {
              class: 'btn sm',
              onclick: async () => {
                try {
                  await signIn();
                  route();
              } catch (err) {
                toast('Sign in failed: ' + err.message);
              }
            }
          }, 'Sign in with another account'),
            h('button', {
              class: 'btn sm',
              onclick: async () => {
                await signOut();
                route();
              }
            }, 'Sign out'),
            h('a', { class: 'btn sm primary', href: '#/' }, 'Go to Inkleaf')
          )
        ));
      } else {
        root.replaceChildren(h('div', { class: 'empty', style: 'padding: 60px 20px; text-align: center;' },
          h('h2', null, 'Could not open live notebook'),
          h('p', { class: 'modal-text' }, e.message || 'The link may have ended or expired.'),
          h('a', { class: 'btn primary', href: '#/', style: 'margin-top: 16px; display: inline-block;' }, 'Go to Inkleaf')
        ));
      }
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

  // Handle incoming shared file from Web Share Target (shared from phone / other app)
  if (location.search.includes('shared=1')) {
    history.replaceState(null, '', location.pathname + location.hash);
    try {
      const cache = await caches.open('inkleaf-shared');
      const res = await cache.match('shared_file');
      if (res) {
        const blob = await res.blob();
        const name = decodeURIComponent(res.headers.get('X-File-Name') || 'shared.pdf');
        const type = res.headers.get('X-File-Type') || 'application/pdf';
        const file = new File([blob], name, { type });
        await cache.delete('shared_file');
        setTimeout(() => promptImportPdf(file), 400);
      }
    } catch (err) {
      console.warn('Failed to retrieve shared file', err);
    }
  }

  // Handle incoming file launched with PWA (File Handling API)
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async launchParams => {
      if (launchParams.files && launchParams.files.length) {
        for (const handle of launchParams.files) {
          const file = await handle.getFile();
          if (file) promptImportPdf(file);
        }
      }
    });
  }
})();
