// Loaded on every page (see partials/head.ejs) - adds the CSRF token
// (middleware/csrfProtection.js) to every POST form automatically, and
// exposes it as window.CSRF_TOKEN for the app's admin fetch()-based POST
// routes (attendance-grid.js, library-checkout.js, name-tag-editor.js,
// schedule-card-editor.js) to send as an X-CSRF-Token header themselves.
//
// No-ops entirely on a public/kiosk page - the meta tag's content is
// empty there (no admin session to hold a token for, and those routes
// aren't CSRF-checked at all - see csrfProtection.js's own comment on
// why), so there's nothing to add and nothing would ever check it
// anyway.
//
// Uses event delegation on `document` (mirrors confirm-dialog.js's own
// pattern) rather than querying every form once at load - a fragment
// fetched and injected into a dialog later (e.g. the Class Schedule
// view-fragment's own form) still gets the token added the moment it's
// actually submitted, with no separate re-scan step needed after each
// injection.
(function () {
  const meta = document.querySelector('meta[name="csrf-token"]');
  const token = meta ? meta.content : '';
  window.CSRF_TOKEN = token;
  if (!token) return;

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    // A real bug report (found while building a new form with its own
    // Payment Method <select name="method">): a named form control
    // shadows the form element's own same-named IDL property (the
    // classic "DOM clobbering" gotcha) - form.method/form.enctype
    // silently stopped being the strings "post"/"" the moment a field
    // named "method" (or, in principle, "enctype") existed anywhere in
    // that form, throwing form.method.toLowerCase() is not a function
    // out of this very listener and aborting it before the _csrf field
    // ever got appended - every submission 403'd with "Session Expired"
    // instead. getAttribute() always reads the raw HTML attribute, never
    // a same-named control, so it can't be shadowed this way - the fix
    // here, not renaming every current and future field that happens to
    // collide with a form IDL property name (method/enctype/action/
    // target/name/elements/length...).
    if ((form.getAttribute('method') || 'get').toLowerCase() !== 'post') return;

    // Multipart forms (file uploads) hit the server before their body is
    // parsed - multer runs per-route, after the global csrfProtection
    // middleware, so a token sent as a normal form field isn't in
    // req.body yet when it's checked (see csrfProtection.js). The query
    // string IS available immediately, so multipart forms get the token
    // appended to the action URL instead of a hidden field.
    if ((form.getAttribute('enctype') || '').toLowerCase() === 'multipart/form-data') {
      if (!/[?&]_csrf=/.test(form.action)) {
        form.action += (form.action.includes('?') ? '&' : '?') + '_csrf=' + encodeURIComponent(token);
      }
      return;
    }

    if (form.querySelector('input[name="_csrf"]')) return;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = '_csrf';
    input.value = token;
    form.appendChild(input);
  });
})();
