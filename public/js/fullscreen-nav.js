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
    // The outgoing page's own document-level state (keepInputFocused's
    // interval/listeners, kiosk-checkin.js/kiosk-checkout.js's idle-timer
    // listeners) - see registerKioskPageCleanup's own comment in kiosk-
    // common.js for why this needs to happen, and why here specifically:
    // this is the one place body content actually gets replaced.
    if (window.__kioskPageCleanups) {
      window.__kioskPageCleanups.forEach((fn) => {
        try { fn(); } catch (err) { /* one page's bad cleanup shouldn't block the swap */ }
      });
      window.__kioskPageCleanups = [];
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

  // A real bug report: "when the kiosk screen times out it does not stay
  // in kiosk mode." The click interception above only ever catches real
  // <a href> clicks - it does nothing for the several kiosk scripts
  // (idle-redirect.js, and the "return to /kiosk after a few seconds"
  // timers in kiosk-checkin.js/kiosk-checkout.js/absence.js/name-tag.js/
  // kiosk-find-parent.js) that send the viewer back to the kiosk home
  // screen with a plain `window.location.href = ...` assignment instead
  // of a click - a real navigation exactly like typing a URL, which
  // destroys the top-level document (and with it, fullscreen) the same
  // as any other full page load. Exposed here so every one of those call
  // sites can go through the same in-place content swap the click
  // handler above uses, instead of each reimplementing its own
  // fullscreen-is-fullscreen check.
  window.fullscreenNavigate = function (url) {
    if (isFullscreen()) {
      go(url, true);
    } else {
      window.location.href = url;
    }
  };

  // Same problem, for a plain <form> submit instead of a link click or a
  // window.location.href assignment - a real bug report: "when you click
  // any done or continue buttons in kiosk mode it automatically exits
  // kiosk mode." A handful of kiosk screens (the Class Check-In/
  // Playground "Done" buttons that lock back to the PIN gate, and the PIN
  // form's own "Unlock") are plain <form method="POST"> elements with no
  // JS of their own at all - the browser's native submission is exactly
  // as real a navigation as clicking a link, and just as fatal to
  // fullscreen. Opt-in via data-preserve-fullscreen (rather than a
  // blanket listener on every form) so this never risks double-handling
  // a form that already manages its own submission via fetch elsewhere
  // in the app (e.g. kiosk-checkin.js's scan forms) - preventDefault()
  // here wouldn't stop that form's own submit listener from also
  // running.
  document.addEventListener(
    'submit',
    (e) => {
      if (!isFullscreen()) return;
      const form = e.target;
      if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-preserve-fullscreen')) return;
      // File uploads need a real multipart body - URLSearchParams would
      // silently drop the file data. None of today's opted-in forms
      // upload files, but skip instead of mangling one if that ever
      // changes.
      if ((form.enctype || '').toLowerCase() === 'multipart/form-data') return;
      let url;
      try {
        url = new URL(form.getAttribute('action') || '', window.location.href);
      } catch (err) {
        return;
      }
      if (url.origin !== window.location.origin) return;
      e.preventDefault();
      const method = (form.getAttribute('method') || 'GET').toUpperCase();
      if (method === 'GET') {
        const params = new URLSearchParams(new FormData(form));
        const qs = params.toString();
        go(url.pathname + (qs ? '?' + qs : ''), true);
        return;
      }
      const params = new URLSearchParams();
      new FormData(form).forEach((value, key) => {
        if (typeof value === 'string') params.append(key, value);
      });
      // A POST that just re-renders the same form with an error (e.g. an
      // incorrect PIN - no server-side redirect at all) has fetch's own
      // res.url equal to this same POST target, not a real destination
      // page. Pushing that non-navigable, POST-only URL into history
      // would be a live foot-gun the very next time this exact scenario
      // happens: hitting reload (or forward, after back) would issue a
      // GET to a URL only ever wired as a POST route, 404ing instead of
      // showing the retry form. Only push when the fetch actually landed
      // somewhere else (a genuine redirect to a real page).
      const requestHref = window.location.origin + url.pathname;
      fetch(url.pathname, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      })
        .then((res) => {
          if (!res.ok) throw new Error('form nav failed: ' + res.status);
          return res.text().then((html) => ({ html, finalUrl: res.url }));
        })
        .then(({ html, finalUrl }) => swap(html, finalUrl, finalUrl !== requestHref))
        .catch(() => { form.submit(); });
    },
    true
  );
})();
