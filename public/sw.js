// Minimal service worker - exists mainly to satisfy the "installable PWA"
// requirement (a registered SW with a fetch handler) so the Settings >
// Install App tab's install button/instructions actually work, not to
// make the whole site work offline. Everything here is admin/kiosk data
// that must always be fresh (attendance, rosters, schedules, session-
// gated pages), so only genuinely static, same-origin files (css/js/
// images) are handled here at all; every other request - HTML pages, form
// submits, JSON/API calls - goes straight to the network, untouched, so
// nobody ever sees yesterday's roster because of this file.
//
// A real request, after chasing the same underlying bug three separate
// times across three different real reports ("downloading/installing the
// app isn't working - it did before" / "on the setup/cleanup team cards
// its showing the information circled twice" / "name tag printing is
// timing out, won't load all the pages" - three unrelated-looking
// symptoms, one root cause each time): "make sure all browsers and
// mobile, tablet and desktop always [get] updated automatically with the
// same settings/look." This used to be CACHE-FIRST with no expiry - a
// device that had ever fetched a given static file kept serving that
// exact cached response forever, even after the real file at that same
// path changed on the server, until a human remembered to change
// STATIC_CACHE's own version string (evicting everything on that
// device's next activate). That's a real, one-line fix each time it came
// up, but it depends entirely on a human remembering to make it, for
// every single change to anything under public/js or public/css, forever
// - exactly the kind of thing that's easy to forget under real day-to-day
// development, and each miss reads as "you said you fixed this but nothing
// changed" from the outside even though the real fix was already live on
// the server the whole time.
//
// NETWORK-FIRST instead: every static asset request tries the real network
// first, every time, and only falls back to whatever's in the cache if
// that fetch genuinely fails (actually offline) - so "does this device
// have the latest file" no longer depends on any version string, any
// human remembering anything, or any prior visit's cache state at all.
// `cache: 'no-store'` on the fetch additionally bypasses the browser's own
// ordinary HTTP cache (a separate layer from this file's Cache API
// storage below), so this isn't just "first try the network" while still
// risking a stale HTTP-cached response underneath - it's a genuine,
// uncached round-trip to the server every time, whenever the device has
// connectivity at all. The Cache API storage still gets a fresh copy
// written on every successful fetch, purely so the catch() fallback below
// has something real to serve if a request ever happens while offline -
// that's the only thing "offline-first" ever meant to buy this app, and
// it costs nothing now that freshness itself no longer depends on it.
const STATIC_CACHE = 'sh-static';
const STATIC_EXTENSIONS = ['.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico'];

function isStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;
  return STATIC_EXTENSIONS.some((ext) => url.pathname.endsWith(ext));
}

self.addEventListener('install', (_event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // One-time cleanup of the old cache-first design's version-named caches
  // (sh-static-v1 through v5) - harmless to still run this indefinitely,
  // and it's what actually clears out whatever a device was stuck on
  // right at the moment it picks up this rewrite.
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

  // Confirmed live, the hard way, in two stages:
  //
  // 1) A bare, un-awaited cache.put() inside the response .then() looked
  //    fine in every online test (the file really was still there next
  //    fetch) but never actually wrote anything - respondWith() already
  //    resolves the fetch event as far as the browser's concerned once the
  //    response is ready, so a fire-and-forget promise hanging off that
  //    same response with nothing else keeping the event alive can get
  //    torn down before it finishes, silently, with no error anywhere.
  //    event.waitUntil() is what extends a fetch event's lifetime for
  //    background work that isn't part of the response itself, so that
  //    became the fix.
  //
  // 2) Wrapping it in waitUntil() STILL left the cache empty, because both
  //    branches were reading off the same in-flight fetch() promise and
  //    calling response.clone() from inside the waitUntil branch - and a
  //    Response can only be cloned before ANY consumer has started reading
  //    its body. Once the browser started streaming that same response to
  //    the page (the respondWith side), clone() in the waitUntil side could
  //    lose that race and throw, and since nothing surfaces that failure
  //    anywhere visible, the cache write just silently never happened.
  //    The fix: clone the response synchronously in the single .then()
  //    that first receives it, before returning it to respondWith at all -
  //    that's the only point where nobody has touched the body yet.
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, copy)));
        }
        return response;
      })
      .catch(() => caches.open(STATIC_CACHE).then((cache) => cache.match(event.request)))
  );
});
