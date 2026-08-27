// Powers the "Edit Permissions" toggle button on the Main Admin and
// Co-op Admin Members pages (views/main-admin-members.ejs, views/
// admin-members.ejs) - a real request: "there should be a button on the
// member page that says edit permissions. this allows you to still see
// the member list but now check boxes appear next to each name asking to
// select sections to put members in and portal permissions." Unlike
// archive-select-toggle.js (which shows/hides individual checkboxes
// already sitting in an existing column), this reveals a whole extra
// table column of Sections/Portal Permissions checkboxes per row - one
// class toggle on the table itself is simpler than juggling `hidden` on
// every cell.
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
    toggle.textContent = activating ? 'Cancel' : 'Edit Permissions';
    toggle.setAttribute('aria-pressed', String(activating));
  });
})();
