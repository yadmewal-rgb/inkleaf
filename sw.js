// Offline first: the app opens from the copy kept on this device, without waiting for the network (fast on weak
// Wi-Fi, and it opens when the connection is on but answers nothing). A new version comes as a new sw.js (every
// release raises CACHE): it fetches the whole new copy in the background, takes over, and the page offers a reload.
const CACHE = 'inkleaf-v101';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/util.js', 'js/icons.js', 'js/ui.js', 'js/db.js', 'js/render.js',
  'js/pdfrender.js', 'js/pdftools.js', 'js/library.js', 'js/editor.js', 'js/export.js', 'js/sync.js', 'js/goodnotes.js', 'js/scan.js', 'js/pageshots.js', 'js/editor-consts.js',
  'js/hwsearch.js', 'js/spellcheck.js', 'vendor/words/en.txt',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/pdf-lib.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];
const BASE = new URL('./', self.location).pathname;                    // '/inkleaf/' on GitHub Pages
const APP = new Set(SHELL.map(u => new URL(u, self.location).pathname)); // the files served from the kept copy

// Makes the whole copy of this version. 'reload' skips the browser's own cache, so it is not mixed with old files; a
// web server that still hands out another version's sync.js would also mix them, so then nothing is kept.
async function makeCopy() {
  const tmp = CACHE + '-new';
  await caches.delete(tmp);
  const c = await caches.open(tmp);
  await c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
  const sync = await (await c.match('js/sync.js')).text();
  if (!sync.includes(`APP_VER = '${CACHE.replace('inkleaf-', '')}'`)) { await caches.delete(tmp); throw new Error('mixed versions'); }
  const done = await caches.open(CACHE);
  for (const req of await c.keys()) await done.put(req, await c.match(req));
  await caches.delete(tmp);
}
let mending = null, mendFailed = 0; // a failed remake (e.g. a newer version is already out) is tried again after 10 min

self.addEventListener('install', e => {
  e.waitUntil(makeCopy().then(() => self.skipWaiting())); // fails as a whole: the browser tries again later
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== CACHE + '-new' && k !== 'inkleaf-shared').map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // Web Share Target: incoming file shared from phone or other app (manifest: POST to ./)
  if (e.request.method === 'POST' && url.pathname === BASE) {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();
        let targetFile = null;
        const files = formData.getAll('files');
        if (files && files.length && files[0] && files[0].size > 0) {
          targetFile = files[0];
        } else {
          for (const [, v] of formData.entries()) {
            if (v && (typeof v === 'object') && (v.size > 0 || v.name)) {
              targetFile = v;
              break;
            }
          }
        }
        if (targetFile) {
          const cache = await caches.open('inkleaf-shared');
          await cache.put('shared_file', new Response(targetFile, {
            headers: {
              'X-File-Name': encodeURIComponent(targetFile.name || 'shared.pdf'),
              'X-File-Type': targetFile.type || 'application/pdf'
            }
          }));
          return Response.redirect('./?shared=1', 303);
        }
      } catch (err) {
        console.error('Share target failed', err);
      }
      return Response.redirect('./', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET') return;
  const page = e.request.mode === 'navigate' && (url.pathname === BASE || url.pathname === BASE + 'index.html');
  if (!page && !APP.has(url.pathname)) return; // anything else (privacy page, other sites' files) goes to the network as usual
  e.respondWith((async () => {
    const hit = await caches.match(page ? './' : e.request, { cacheName: CACHE, ignoreSearch: true });
    if (hit) return hit;
    // Not kept (the very first visit while the copy is being made, or the browser threw the copy away): from the
    // network, and the whole copy is made again in the background, so the next start is fast and works offline.
    if (!mending && Date.now() - mendFailed > 6e5) mending = makeCopy().catch(() => { mendFailed = Date.now(); }).finally(() => { mending = null; });
    if (mending) e.waitUntil(mending);
    return fetch(e.request);
  })());
});
