// Powers the "View" button on each Class Schedule card: fetches that
// class's info + roster as an HTML fragment and shows it in a shared
// dialog, via the shared public/js/fragment-dialog.js helper, so viewing
// (and, once unlocked, editing) a class never navigates away from the
// grid. Saving/deleting the class itself are still real form submissions
// (this app has no client framework), so those do leave the popup - they
// land back on this same grid page. Adding a roster member is the one
// exception (see the submit handler below): that action gets repeated
// many times in a row while building out a class's roster, so it's worth
// the extra fetch()-based plumbing to keep the popup open across each
// add instead of bouncing back to the grid and making the admin reopen
// it every single time.
(function () {
  const dialog = document.getElementById('class-view-dialog');
  if (!dialog || !window.loadFragmentIntoDialog) return;

  let currentClassId = null;

  function loadClass(id) {
    currentClassId = id;
    window.loadFragmentIntoDialog(dialog, `/admin/class-schedule/classes/${id}/view-fragment`).catch(() => {
      window.location.href = `/admin/class-schedule/classes/${id}/manage`;
    });
  }

  document.addEventListener('click', (e) => {
    const viewBtn = e.target.closest('[data-view-class]');
    // A real request: "remove the edit button and attendance link
    // button from the schedule cards" - [data-view-class] now lives on
    // the whole card (views/partials/class-schedule-grid.ejs), not a
    // small dedicated button, so a click on the archive checkbox it
    // also contains bubbles up here too. Selecting a class for archiving
    // shouldn't also pop open its view/edit dialog.
    if (viewBtn && !e.target.closest('.class-card-checkbox')) {
      loadClass(viewBtn.getAttribute('data-view-class'));
      return;
    }

    if (!dialog.open) return;

    if (e.target.closest('[data-edit-class-btn]')) {
      const form = dialog.querySelector('[data-view-form]');
      if (!form) return;
      form.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = false; });
      dialog.querySelector('.class-view-footer-view').hidden = true;
      dialog.querySelector('.class-view-footer-edit').hidden = false;
      return;
    }

    if (e.target.closest('[data-cancel-edit-btn]')) {
      if (currentClassId) loadClass(currentClassId);
    }
  });

  // [data-view-class] used to only ever sit on a real <button>, keyboard-
  // operable for free - now that it's the whole card (a <div>, since a
  // <button> can't legally contain the archive checkbox it also holds),
  // Enter/Space need to be wired up by hand to keep it keyboard
  // accessible.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('[data-view-class]');
    if (!card || card.tagName === 'BUTTON' || card.tagName === 'A' || e.target.closest('.class-card-checkbox')) return;
    e.preventDefault();
    loadClass(card.getAttribute('data-view-class'));
  });

  // Add Member (views/class-schedule-view-fragment.ejs's own nested
  // dialog) - posts via fetch instead of a plain form submission, so a
  // success just closes that small picker and refreshes the roster list
  // underneath it, with the outer class-view-dialog never closing at
  // all. Falls back to a real form submission (the old behavior) on any
  // error, same safety net loadClass() itself already uses.
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-roster-add-form]');
    if (!form || !dialog.contains(form)) return;
    e.preventDefault();

    // URL-encoded, not FormData directly - this route has no multer
    // middleware (it's not a file upload), and Express's body parser
    // only parses application/x-www-form-urlencoded/json, not
    // multipart/form-data (see public/js/csrf.js's own comment on that
    // same distinction) - a raw FormData body would leave req.body
    // undefined server-side.
    fetch(form.action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': window.CSRF_TOKEN || '',
      },
      body: new URLSearchParams(new FormData(form)),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then(() => {
        const pickerDialog = form.closest('dialog');
        if (pickerDialog) pickerDialog.close();
        if (currentClassId) loadClass(currentClassId);
      })
      .catch(() => form.submit());
  });
})();
