// Minimal service worker - exists mainly to satisfy the "installable PWA"
// requirement (a registered SW with a fetch handler) so the Settings >
// Install App tab's install button/instructions actually work, not to
// make the whole site work offline. Everything here is admin/kiosk data
// that must always be fresh (attendance, rosters, schedules, session-
// gated pages), so only genuinely static, same-origin files (css/js/
// images) are cache-first; every other request - HTML pages, form
// submits, JSON/API calls - goes straight to the network, uncached, so
// nobody ever sees yesterday's roster because of this file.
const STATIC_CACHE = 'sh-static-v1';
const STATIC_EXTENSIONS = ['.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico'];

function isStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;
  return STATIC_EXTENSIONS.some((ext) => url.pathname.endsWith(ext));
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== STATIC_CACHE).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return; // never intercept form posts/uploads/etc.

  const url = new URL(event.request.url);
  if (!isStaticAsset(url)) return; // let the browser handle everything else normally

  event.respondWith(
    caches.open(STATIC_CACHE).then((cache) =>
      cache.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        });
      })
    )
  );
});
