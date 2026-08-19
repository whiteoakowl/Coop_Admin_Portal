// Minimal service worker - exists mainly to satisfy the "installable PWA"
// requirement (a registered SW with a fetch handler) so the Settings >
// Install App tab's install button/instructions actually work, not to
// make the whole site work offline. Everything here is admin/kiosk data
// that must always be fresh (attendance, rosters, schedules, session-
// gated pages), so only genuinely static, same-origin files (css/js/
// images) are cache-first; every other request - HTML pages, form
// submits, JSON/API calls - goes straight to the network, uncached, so
// nobody ever sees yesterday's roster because of this file.
// A real bug report: "downloading/installing the app isn't working -
// it did before." Root cause: this cache name never changed, and the
// fetch handler below is cache-first with no expiry - once a device's
// service worker cached an icon under this name, it kept serving that
// exact cached response forever, even after the real file at that same
// path changed on the server (the app icons were replaced without this
// version bumping). Android's install/WebAPK-minting flow fetches the
// manifest's icons through the page's own service worker like any other
// image request, so a device that had already visited before the icons
// changed kept minting new "installs" from the stale, now-mismatched
// icon - which is exactly the kind of silent, no-error breakage that
// looks like "it says installed but nothing installs." Bumping this
// evicts every previously cached static asset on that device's next
// activate (see below) and forces a fresh fetch of everything, icons
// included. Bump it again any time a deployed static asset changes in a
// way that matters (icons, manifest-referenced files) - a plain content
// change at the same URL is invisible to this cache otherwise.
const STATIC_CACHE = 'sh-static-v2';
const STATIC_EXTENSIONS = ['.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico'];

function isStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;
  return STATIC_EXTENSIONS.some((ext) => url.pathname.endsWith(ext));
}

self.addEventListener('install', (_event) => {
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
