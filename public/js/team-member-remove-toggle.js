// Lets a per-member "Remove" trash icon inside an edit-toggle .edit-
// section card (Floater Teams, Setup/Cleanup Teams) mark a row for
// removal without submitting anything immediately - a real request: "when
// deleting floaters and cleanup/signup members from lists it should allow
// for multiple deletes and then click save before refreshing." Each trash
// icon just flips a same-named hidden checkbox (tied to the card's own
// Save button/form via the checkbox's own form="..." attribute, even
// though it lives outside that <form> tag in the markup) and toggles a
// struck-through visual state on the row; the card's single Save click
// submits every pending removal - along with whatever else that form
// already carries (the hour label, team title, ...) - in one request, so
// the page only refreshes once no matter how many members were removed.
(function () {
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-member-remove-btn]');
    if (!btn) return;
    const row = btn.closest('[data-member-remove-row]');
    const checkbox = row && row.querySelector('[data-member-remove-checkbox]');
    if (!checkbox) return;
    checkbox.checked = !checkbox.checked;
    row.classList.toggle('team-member-row-removed', checkbox.checked);
    btn.setAttribute('aria-pressed', String(checkbox.checked));
  });

  // edit-toggle.js's own Cancel handler already calls form.reset() on
  // every form in the section, which un-checks these checkboxes since
  // they're associated to a form via the form="..." attribute - this just
  // clears the matching visual state back off every row at the same time
  // (order versus that reset doesn't matter: this doesn't read
  // checkbox.checked, it just always clears the class).
  document.addEventListener('click', function (e) {
    const cancelBtn = e.target.closest('[data-edit-toggle-cancel]');
    if (!cancelBtn) return;
    const section = cancelBtn.closest('.edit-section');
    if (!section) return;
    section.querySelectorAll('[data-member-remove-row]').forEach((row) => row.classList.remove('team-member-row-removed'));
  });
})();
