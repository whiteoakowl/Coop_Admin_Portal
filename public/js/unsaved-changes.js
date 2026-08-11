// Warns before leaving a page with typed-but-unsaved form input. Gated on
// window.CSRF_TOKEN (set by public/js/csrf.js, itself only ever non-empty
// for an authenticated admin session - see server.js) so this is active
// on admin pages only: kiosk and public-facing pages (check-in, absence
// form, name tag request) are single-field, immediately-submitted forms
// where a "did you mean to leave?" prompt would only ever be confusing,
// never protective.
//
// Tracks "dirty" per-form via a Set, set by a real 'input' event on a
// text-like field (actual typing) and cleared on that form's own
// 'submit' event. Deliberately NOT triggered by 'change' on
// select/checkbox/radio/date controls - several of those in this app
// auto-submit their own form the moment they change (the rank <select>
// in admin-volunteer-teams.ejs, the date-add <input type="date"> in
// admin-volunteers.ejs). Scoping to 'input' on text-like fields sidesteps
// needing to special-case any of them: none of this app's auto-submit
// controls are ever typed into, so they never mark anything dirty, and
// the one thing this guard exists to catch - someone typing a name/note/
// address and then navigating away - is exactly what an 'input' event on
// a text-like field is. (Those auto-submit controls call
// form.requestSubmit(), not the older .submit() - the distinction
// matters elsewhere: only requestSubmit() fires a real 'submit' event,
// which is what lets public/js/csrf.js's own delegated listener attach
// the CSRF token before the browser actually posts the form.)
(function () {
  if (!window.CSRF_TOKEN) return;

  const TEXTLIKE_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'number', 'password']);
  const dirtyForms = new Set();

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.form || !el.name) return;
    const isTextarea = el.tagName === 'TEXTAREA';
    const isTextLikeInput = el.tagName === 'INPUT' && TEXTLIKE_INPUT_TYPES.has(el.type);
    if (!isTextarea && !isTextLikeInput) return;
    dirtyForms.add(el.form);
  });

  document.addEventListener('submit', (e) => {
    if (e.target instanceof HTMLFormElement) dirtyForms.delete(e.target);
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirtyForms.size === 0) return;
    e.preventDefault();
    e.returnValue = '';
  });
})();
