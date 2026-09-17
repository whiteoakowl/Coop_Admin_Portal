// Powers the "Edit Permissions" toggle button on the Main Admin Members
// page (views/main-admin-members.ejs - Co-op Admin's own Members page has
// no such button, portal roles/sections being a Main-Admin-only concept)
// - a real request: "there should be a button on the member page that
// says edit permissions. this allows you to still see the member list
// but now check boxes appear next to each name asking to select sections
// to put members in and portal permissions." Unlike archive-select-
// toggle.js (which shows/hides individual checkboxes already sitting in
// an existing column), this reveals a whole extra table column of
// Sections/Portal Permissions checkboxes per row - one class toggle on
// the table itself is simpler than juggling `hidden` on every cell.
(function () {
  if (window.__permissionsEditToggleInstalled) return;
  window.__permissionsEditToggleInstalled = true;

  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-permissions-toggle]');
    if (!toggle) return;
    const tableId = toggle.getAttribute('data-permissions-toggle');
    const table = document.getElementById(tableId);
    if (!table) return;

    const activating = !table.classList.contains('permissions-mode-on');
    table.classList.toggle('permissions-mode-on', activating);
    const saveBtn = document.querySelector(`[data-permissions-save="${tableId}"]`);
    if (saveBtn) saveBtn.hidden = !activating;

    // A real request: "when you click edit permissions you should then
    // only see one button for save permissions. once you click save you
    // see all the original buttons again." Every other button/link/form
    // in this same toolbar row (Add Member, Edit, Import, Export, Create
    // Accounts, Add/Edit Sections) - and the "Edit Permissions" toggle
    // itself - hides while active, leaving Save Permissions standing
    // alone; Save always submits a real form (a page load), so the
    // toolbar is back to its untouched, freshly-rendered state the moment
    // that happens - nothing here needs to explicitly restore it.
    const row = toggle.closest('.roster-btn-row');
    if (row) {
      Array.from(row.children).forEach((child) => {
        if (child === saveBtn) return;
        child.hidden = activating;
      });
    }
  });
})();
