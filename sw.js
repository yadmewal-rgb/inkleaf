// Offline support: network first, falling back to the cached copy.
const CACHE = 'inkleaf-v85';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/util.js', 'js/icons.js', 'js/ui.js', 'js/db.js', 'js/render.js',
  'js/pdfrender.js', 'js/pdftools.js', 'js/library.js', 'js/editor.js', 'js/export.js', 'js/sync.js', 'js/goodnotes.js', 'js/scan.js', 'js/pageshots.js', 'js/editor-consts.js',
  'js/hwsearch.js', 'js/spellcheck.js', 'js/vocab.js',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/pdf-lib.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // Web Share Target: incoming file shared from phone or other app
  if (e.request.method === 'POST') {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();
        let targetFile = null;
        const files = formData.getAll('files');
        if (files && files.length && files[0] && files[0].size > 0) {
          targetFile = files[0];
        } else {
          for (const [k, v] of formData.entries()) {
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
  e.respondWith(
    // "no-cache" re-checks with the server every time, so a newly published version shows up straight away.
    fetch(e.request.url, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
