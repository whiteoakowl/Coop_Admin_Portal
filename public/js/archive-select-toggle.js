// Powers every "Archive" toggle button (Class Schedule grid, Student/
// Parent Schedules grid): each starts with just a plain "Archive" button -
// clicking it (data-archive-toggle="<formId>") reveals the matching
// [data-archive-controls="<formId>"] block (Select All + Archive Selected,
// usually placed under the page's own filter row) and every VISIBLE
// per-card checkbox associated with that same form (form="<formId>",
// excluding .archive-offpage-checkbox - see below), and relabels itself
// "Cancel". Clicking it again hides all of that again and clears the
// selection, so leaving selection mode never leaves stray checked boxes
// behind for next time.
//   - "Select All" (data-select-all-for="<formId>") checks EVERY checkbox
//     associated with the same form, including .archive-offpage-checkbox
//     ones: the Student/Parent Schedules grid renders one of those -
//     permanently hidden, no card of its own - per active member NOT on
//     the current page (see views/admin-schedule.ejs's own comment -
//     "Select All" is a purely client-side DOM operation, so a paginated
//     list needs every other page's member already present in the DOM
//     somehow for it to reach them at all).
//   - The archive-toggle click handler below deliberately excludes
//     .archive-offpage-checkbox from its own show/hide - there's no card
//     for one of those to visually sit inside, so unhiding it would just
//     be a naked, unstyled checkbox floating on the page. Every other
//     per-card checkbox class this file has ever been used with (the
//     Student/Parent Schedules grid's own .archive-select-checkbox, the
//     Class Schedule grid's .class-card-checkbox) is unaffected - this
//     only excludes the one specific class that's never inside a card.
(function () {
  if (window.__archiveSelectToggleInstalled) return;
  window.__archiveSelectToggleInstalled = true;

  document.addEventListener('change', (e) => {
    const master = e.target.closest('[data-select-all-for]');
    if (!master) return;
    const formId = master.getAttribute('data-select-all-for');
    document.querySelectorAll(`input[type="checkbox"][form="${formId}"]`).forEach((cb) => {
      cb.checked = master.checked;
    });
  });

  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-archive-toggle]');
    if (!toggle) return;
    const formId = toggle.getAttribute('data-archive-toggle');
    const controls = document.querySelector(`[data-archive-controls="${formId}"]`);
    const checkboxes = document.querySelectorAll(`input[type="checkbox"][form="${formId}"]:not(.archive-offpage-checkbox)`);
    if (!controls) return;

    const activating = controls.hidden;
    controls.hidden = !activating;
    checkboxes.forEach((cb) => {
      cb.hidden = !activating;
      if (!activating) cb.checked = false;
    });
    if (!activating) {
      const selectAll = controls.querySelector('[data-select-all-for]');
      if (selectAll) selectAll.checked = false;
      // The off-page checkboxes aren't individually toggleable (no card
      // to click), so nothing else clears them on exit - do it here, same
      // "leaving selection mode never leaves a stray selection behind"
      // guarantee the visible, per-card ones already got above.
      document.querySelectorAll(`input[type="checkbox"].archive-offpage-checkbox[form="${formId}"]`).forEach((cb) => { cb.checked = false; });
    }
    toggle.textContent = activating ? 'Cancel' : 'Archive';
    toggle.setAttribute('aria-pressed', String(activating));
  });
})();
