// Powers the full Add/Edit Membership Form page - shared by both portals'
// own edit forms (views/admin-member-edit.ejs, views/
// main-admin-member-edit.ejs), which both include the same partials/
// member-form-fields.ejs markup. The "+ Add New Family" dialog posts to
// whichever portal's own families/new endpoint the including page sets via
// the form's data-add-family-url attribute.
const MEMBER_TYPE_META = {
  student: { icon: 'graduation-cap', title: 'Student Membership Form', subtitle: 'Create or update a student membership profile.', headerClass: 'member-form-header-student', boxClass: 'member-form-section-blue' },
  parent: { icon: 'users', title: 'Parent Membership Form', subtitle: 'Create or update a parent/guardian membership profile.', headerClass: 'member-form-header-parent', boxClass: 'member-form-section-green' },
  admin: { icon: 'badge', title: 'Admin Membership Form', subtitle: 'Create or update a co-op admin/leader membership profile.', headerClass: 'member-form-header-admin', boxClass: 'member-form-section-purple' },
};
const ALL_HEADER_CLASSES = Object.values(MEMBER_TYPE_META).map((m) => m.headerClass);
const ALL_BOX_CLASSES = Object.values(MEMBER_TYPE_META).map((m) => m.boxClass);

// Toggles the Student-only / Parent-only / Admin-only sections and re-themes
// the header + Family box (blue for Student, green for Parent, purple for
// Admin) when the Parent/Student/Admin toggle changes.
function updateMemberFormForType(form) {
  const checked = form.querySelector('input[name="memberType"]:checked');
  const type = checked ? checked.value : 'student';
  const meta = MEMBER_TYPE_META[type] || MEMBER_TYPE_META.student;

  form.querySelectorAll('[data-student-only]').forEach((el) => { el.style.display = type === 'student' ? '' : 'none'; });
  form.querySelectorAll('[data-parent-only]').forEach((el) => { el.style.display = type === 'parent' ? '' : 'none'; });
  form.querySelectorAll('[data-admin-only]').forEach((el) => { el.style.display = type === 'admin' ? '' : 'none'; });

  const header = form.querySelector('[data-member-form-header]');
  if (header) {
    header.classList.remove(...ALL_HEADER_CLASSES);
    header.classList.add(meta.headerClass);
    const iconUse = header.querySelector('.member-form-header-icon use');
    if (iconUse) iconUse.setAttribute('href', '#icon-' + meta.icon);
    const title = header.querySelector('h3');
    if (title) title.textContent = meta.title;
    const subtitle = header.querySelector('p');
    if (subtitle) subtitle.textContent = meta.subtitle;
  }

  const familyBox = form.querySelector('[data-family-box]');
  if (familyBox) {
    familyBox.classList.remove(...ALL_BOX_CLASSES);
    familyBox.classList.add(meta.boxClass);
  }
}

// Family is a single choice (a member belongs to one family), so the
// <select> is the only control for it - no redundant checkbox/checklist
// duplicating the same choice underneath. "+ Add New Family" opens a small
// dialog (mirrors the one on the Members page) that posts via fetch instead
// of a plain form submission, so a brand-new family can be created and
// selected without losing whatever else has already been typed into this
// page's Add/Edit Member form.
//
// The dialog itself lives outside #member-form in the markup (views/
// admin-member-edit.ejs) - a <form> can't nest inside another <form> (the
// browser silently drops the inner tag) - so it's looked up from the
// document, not scoped to the passed-in form.
function initAddFamilyDialog(form) {
  const select = form.querySelector('[data-family-select]');
  const openBtn = form.querySelector('[data-add-family-open]');
  const dialog = document.querySelector('[data-add-family-dialog]');
  if (!select || !openBtn || !dialog) return;
  const addForm = dialog.querySelector('[data-add-family-form]');
  const errorEl = dialog.querySelector('[data-add-family-error]');

  openBtn.addEventListener('click', () => {
    if (errorEl) errorEl.hidden = true;
    addForm.reset();
    dialog.showModal();
  });

  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = (new FormData(addForm).get('name') || '').toString().trim();
    if (errorEl) errorEl.hidden = true;

    fetch(form.dataset.addFamilyUrl || '/admin/members/families/new', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': window.CSRF_TOKEN || '',
      },
      body: new URLSearchParams({ name }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data && data.error ? data.error : 'Could not add family.');
        const option = document.createElement('option');
        option.value = data.id;
        option.textContent = `The ${data.name} Family`;
        option.selected = true;
        select.appendChild(option);
        dialog.close();
      })
      .catch((err) => {
        if (errorEl) {
          errorEl.textContent = err.message || 'Could not add family.';
          errorEl.hidden = false;
        }
      });
  });
}

// The Setup/Cleanup Team "Add a Team" dropdown (and, the same shape, the
// Admin Positions "Add a Position" dropdown - a real request: "ability to
// add unlimited admin positions to a member profile") is a quick-pick
// convenience on top of the real multi-select checkbox list below it -
// picking an option just checks that box, then resets itself. Generic
// over which picker/checklist pair so both boxes share one implementation
// instead of two near-identical copies.
function initPickerChecklist(form, pickerSelector, checklistSelector) {
  const picker = form.querySelector(pickerSelector);
  const checklist = form.querySelector(checklistSelector);
  if (!picker || !checklist) return;

  picker.addEventListener('change', () => {
    const id = picker.value;
    if (!id) return;
    const checkbox = checklist.querySelector(`input[type="checkbox"][value="${id}"]`);
    if (checkbox && !checkbox.disabled) {
      checkbox.checked = true;
      checkbox.closest('.member-form-checklist-row').classList.add('is-checked');
    }
    picker.value = '';
  });

  checklist.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      cb.closest('.member-form-checklist-row').classList.toggle('is-checked', cb.checked);
    });
  });
}

function initMemberFormInteractions(form) {
  initAddFamilyDialog(form);
  initPickerChecklist(form, '[data-team-picker]', '[data-team-checklist]');
  initPickerChecklist(form, '[data-position-picker]', '[data-position-checklist]');
}

(function () {
  const form = document.getElementById('member-form');
  if (!form) return;
  form.querySelectorAll('input[name="memberType"]').forEach((r) => r.addEventListener('change', () => updateMemberFormForType(form)));
  updateMemberFormForType(form);
  initMemberFormInteractions(form);
})();
