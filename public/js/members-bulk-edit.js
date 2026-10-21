// Main Admin Members' own "Bulk Edit" button (views/main-admin-
// members.ejs's own #bulk-edit-dialog) - a real request: "Main admin
// portal members bulk edit button allows you to select 1 or multiple
// members and add them to a section, portal, family, delete. Archive,
// text or email." The per-row checkboxes/Select All checkbox are
// handled by public/js/archive-select-toggle.js's own generic
// data-select-all-for wiring, reused as-is; this file only covers the
// dialog itself: choosing an action reveals its own contextual sub-
// fields (checkboxes for sections/roles, a family <select>) for Add to
// Section(s)/Portal(s)/Family, or none at all for Archive/Delete/Email/
// Text - Apply then arms #members-select-form (same shared hidden form
// the checkboxes already post through) with the right action/data-
// confirm and submits it.
//
// Each field lives OUTSIDE #members-select-form in the DOM (it's inside
// the dialog, not nested in that bare <form>) but still carries
// form="members-select-form", the same technique this app's off-page
// checkboxes already use - any named control anywhere in the document
// can attach to a specific <form> that way, regardless of DOM nesting.
(function () {
  const btn = document.getElementById('bulk-edit-btn');
  const dialog = document.getElementById('bulk-edit-dialog');
  const actionSelect = document.getElementById('bulk-edit-action');
  const applyBtn = document.getElementById('bulk-edit-apply-btn');
  const form = document.getElementById('members-select-form');
  if (!btn || !dialog || !actionSelect || !applyBtn || !form) return;

  const ACTIONS = {
    sections: { fields: 'bulk-edit-sections-fields', url: '/main-admin/members/bulk-add-sections' },
    roles: { fields: 'bulk-edit-roles-fields', url: '/main-admin/members/bulk-add-roles' },
    family: { fields: 'bulk-edit-family-fields', url: '/main-admin/members/bulk-add-family' },
    archive: {
      url: '/main-admin/members/bulk-archive',
      confirm: "Archive the selected member(s)? They'll move to the Archive tab, but nothing is deleted.",
      yesLabel: 'Yes, Archive',
      safe: true,
    },
    delete: {
      url: '/main-admin/members/bulk-delete',
      confirm: 'Permanently delete the selected member(s)? This removes them from all rosters and attendance history. This cannot be undone.',
      yesLabel: 'Yes, Delete',
    },
    email: { url: '/main-admin/announcements/email/compose' },
    text: { url: '/main-admin/announcements/text/compose' },
  };

  function showFieldsFor(action) {
    document.querySelectorAll('.bulk-edit-subfields').forEach((el) => {
      el.hidden = true;
    });
    const cfg = ACTIONS[action];
    if (cfg && cfg.fields) document.getElementById(cfg.fields).hidden = false;
    applyBtn.disabled = !cfg;
  }

  btn.addEventListener('click', () => {
    actionSelect.value = '';
    showFieldsFor('');
    dialog.showModal();
  });

  actionSelect.addEventListener('change', () => showFieldsFor(actionSelect.value));

  // Runs before the native submit this button also triggers (it's a
  // plain type="submit" for form="members-select-form") - by the time
  // that submit actually fires, form.action/data-confirm already
  // reflect the chosen action, same "set it in a handler right before
  // the real submit" technique this app's other bulk-action pickers
  // already use (public/js/members-bulk-actions.js).
  applyBtn.addEventListener('click', () => {
    const cfg = ACTIONS[actionSelect.value];
    if (!cfg) return;
    form.action = cfg.url;
    if (cfg.confirm) form.dataset.confirm = cfg.confirm;
    else delete form.dataset.confirm;
    form.dataset.confirmYesLabel = cfg.yesLabel || 'Yes';
    if (cfg.safe) form.dataset.confirmSafe = '1';
    else delete form.dataset.confirmSafe;
    dialog.close();
  });
})();
