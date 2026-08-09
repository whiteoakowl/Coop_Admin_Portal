// Generic "Edit" -> "Save Changes"/"Cancel" toggle for a form section that
// should stay read-only until explicitly opened for editing (prevents
// accidental changes just from a field catching focus/blur on a page
// someone's scrolling through). Markup contract: every field that should
// start locked carries `disabled`, and the form's action buttons carry
// data-edit-toggle-edit / -cancel / -save, all inside a .edit-section:
//   <div class="edit-section">
//     <form>
//       <input disabled />
//       <select disabled>...</select>
//       <button type="button" data-edit-toggle-edit>Edit</button>
//       <button type="button" data-edit-toggle-cancel hidden>Cancel</button>
//       <button type="submit" data-edit-toggle-save hidden>Save Changes</button>
//     </form>
//   </div>
(function () {
  function fields(section) {
    return section.querySelectorAll('input:not([type="hidden"]), select, textarea');
  }

  document.addEventListener('click', function (e) {
    const editBtn = e.target.closest('[data-edit-toggle-edit]');
    if (editBtn) {
      const section = editBtn.closest('.edit-section');
      fields(section).forEach((el) => { el.disabled = false; });
      editBtn.hidden = true;
      const cancelBtn = section.querySelector('[data-edit-toggle-cancel]');
      const saveBtn = section.querySelector('[data-edit-toggle-save]');
      if (cancelBtn) cancelBtn.hidden = false;
      if (saveBtn) saveBtn.hidden = false;
      return;
    }

    const cancelBtn = e.target.closest('[data-edit-toggle-cancel]');
    if (cancelBtn) {
      const section = cancelBtn.closest('.edit-section');
      const form = section.querySelector('form');
      if (form) form.reset();
      fields(section).forEach((el) => { el.disabled = true; });
      cancelBtn.hidden = true;
      const saveBtn = section.querySelector('[data-edit-toggle-save]');
      if (saveBtn) saveBtn.hidden = true;
      const editBtn = section.querySelector('[data-edit-toggle-edit]');
      if (editBtn) editBtn.hidden = false;
    }
  });
})();
