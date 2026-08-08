// Keeps the browser in fullscreen while navigating between pages.
//
// The Fullscreen API ties fullscreen state to the top-level document, and
// a normal full-page navigation destroys that document - so on many
// browsers, clicking any link while in fullscreen (e.g. a kiosk landing
// card, or "Return to Home Screen") silently kicks the viewer back out.
//
// Rather than special-case every kiosk page, this swaps the *content* of
// the current document in place (fetch the target page, replace
// <body>'s contents, update the title/history) instead of doing a real
// navigation - so the top-level document never unloads and fullscreen
// never breaks. It only kicks in while actually in fullscreen, so normal
// browsing (admin desktop use, testing, etc.) is completely unaffected
// and behaves exactly as a standard multi-page app.
(function () {
  // This script tag is inside <body>, so it gets re-executed by our own
  // swap() below on every navigation - guard against re-attaching
  // document/window-level listeners more than once per real page load.
  if (window.__fullscreenNavInstalled) return;
  window.__fullscreenNavInstalled = true;

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  // Anything that isn't a plain HTML page - CSV/Excel exports, template
  // downloads, print-generated files - must always go through a real
  // navigation so the browser actually downloads/saves it.
  function isSwappable(anchor, url) {
    if (url.origin !== window.location.origin) return false;
    if (anchor.target && anchor.target !== '_self') return false;
    if (anchor.hasAttribute('download')) return false;
    if (/\.(csv|xlsx|xls|pdf|zip|png|jpe?g|gif)(\?|#|$)/i.test(url.pathname)) return false;
    if (/\/export(\.|\/|$)/i.test(url.pathname) || /export\.csv/i.test(url.pathname)) return false;
    if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return false;
    return true;
  }

  function runScripts(root) {
    Array.from(root.querySelectorAll('script')).forEach((old) => {
      const fresh = document.createElement('script');
      Array.from(old.attributes).forEach((attr) => fresh.setAttribute(attr.name, attr.value));
      fresh.textContent = old.textContent;
      old.replaceWith(fresh);
    });
  }

  function swap(html, finalUrl, push) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (!doc.body) {
      window.location.href = finalUrl;
      return;
    }
    document.title = doc.title;
    document.body.className = doc.body.className;
    Array.from(document.body.attributes).forEach((attr) => {
      if (attr.name.indexOf('data-') === 0) document.body.removeAttribute(attr.name);
    });
    Array.from(doc.body.attributes).forEach((attr) => {
      if (attr.name.indexOf('data-') === 0) document.body.setAttribute(attr.name, attr.value);
    });
    document.body.innerHTML = doc.body.innerHTML;
    runScripts(document.body);
    if (push) history.pushState({ fsNav: true }, '', finalUrl);
    window.scrollTo(0, 0);
  }

  function go(url, push) {
    fetch(url, { credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error('nav failed: ' + res.status);
        return res.text().then((html) => ({ html, finalUrl: res.url }));
      })
      .then(({ html, finalUrl }) => swap(html, finalUrl, push))
      .catch(() => {
        window.location.href = url;
      });
  }

  document.addEventListener(
    'click',
    (e) => {
      if (!isFullscreen()) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = e.target.closest('a[href]');
      if (!anchor) return;
      let url;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch (err) {
        return;
      }
      if (!isSwappable(anchor, url)) return;
      e.preventDefault();
      go(url.pathname + url.search + url.hash, true);
    },
    true
  );

  window.addEventListener('popstate', () => {
    go(window.location.pathname + window.location.search, false);
  });
})();
