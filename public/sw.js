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
// A real bug report: "on the setup/cleanup team cards its showing the
// information circled twice" - a device that had visited before the
// print-only .team-print-meta row was added (and before it got its
// `display: none` base rule) kept serving that STALE cached styles.css
// forever per this same cache-first/no-expiry mechanism - the missing
// rule meant the print-only summary row had no CSS hiding it on screen
// at all, so it showed up as a plain visible block right underneath the
// three already-visible Leader/Time/Location fields, reading as the
// same info duplicated. The deployed HTML was already correct (pages
// are never cached here); only the cached CSS was stale. Bumping this
// forces every device to drop its old static cache and re-fetch
// styles.css fresh on next load.
// Bumped again: two more real bug reports ("name tag printing is timing
// out, won't load all the pages" and "setup/cleanup cards are still
// drifting") turned out to be the exact same stale-cache mechanism -
// both fixes (public/js/design-print-hub.js's chunked-merge scoping,
// and styles.css's .badge-sheet-page/.print-page `zoom: 1 !important`
// print floor) were already live on the server, but every device that
// had ever loaded the old JS/CSS kept serving its own cached copy
// forever with no expiry, so the fix was invisible to anyone who wasn't
// starting from a completely fresh browser profile. This cache-first-
// with-no-expiry design means ANY static JS/CSS change needs this bump
// to actually reach devices that have visited before - easy to forget
// (see the two bug reports above), so: if you're editing public/js/** or
// public/css/**, bump this too, in the same change.
const STATIC_CACHE = 'sh-static-v5';
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
