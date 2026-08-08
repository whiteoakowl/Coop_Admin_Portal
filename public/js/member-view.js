// Powers clicking a member's name on the Members list: fetches their
// Membership Form as a view-only HTML fragment and shows it in a shared
// dialog (mirrors public/js/class-schedule-view.js). Edit unlocks the
// fields in place; Save is a real form POST (this app has no client
// framework), so that leaves the popup - it lands back on the list page,
// which is what makes "the box disappears" after Save.
(function () {
  const dialog = document.getElementById('member-view-dialog');
  if (!dialog) return;

  let currentId = null;

  // updateMemberFormForType/initMemberFormInteractions are defined in
  // member-form.js (loaded on this page too, ahead of this script) -
  // shared so the toggle/family-checklist/team-picker behave identically
  // whether they live on the full Add/Edit page or in this popup.
  function initTypeToggle(root) {
    const form = root.querySelector('[data-member-view-form]');
    if (!form) return;
    form.querySelectorAll('input[name="memberType"]').forEach((r) => r.addEventListener('change', () => updateMemberFormForType(form)));
    updateMemberFormForType(form);
    initMemberFormInteractions(form);
  }

  function loadMember(id) {
    currentId = id;
    fetch(`/admin/members/${id}/view-fragment`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.text() : Promise.reject(res.status)))
      .then((html) => {
        dialog.innerHTML = html;
        initTypeToggle(dialog);
        if (!dialog.open) dialog.showModal();
      })
      .catch(() => {
        window.location.href = `/admin/members/${id}`;
      });
  }

  document.addEventListener('click', (e) => {
    const viewBtn = e.target.closest('[data-view-member]');
    if (viewBtn) {
      loadMember(viewBtn.getAttribute('data-view-member'));
      return;
    }

    if (!dialog.open) return;

    if (e.target.closest('[data-edit-member-btn]')) {
      const form = dialog.querySelector('[data-member-view-form]');
      if (!form) return;
      form.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = false; });
      dialog.querySelector('.member-form-footer-view').hidden = true;
      dialog.querySelector('.member-form-footer-edit').hidden = false;
      return;
    }

    if (e.target.closest('[data-cancel-member-edit]')) {
      if (currentId) loadMember(currentId);
    }
  });
})();
