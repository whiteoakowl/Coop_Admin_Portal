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
const ADULT_AGE = 18;

// A real request: "No parent/student choice on membership forms or
// profiles. All children are automatically counted as student and adults
// counted as parents." Mirrors utils/dates.js's own isChildAge exactly
// (same < 18 cutoff, same "no birthday means not a known child") so the
// live preview here always agrees with what the server actually saves.
function isChildBirthday(iso) {
  if (!iso) return false;
  const birth = new Date(iso + 'T00:00:00');
  if (Number.isNaN(birth.getTime())) return false;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const hadBirthdayThisYear = today.getMonth() > birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() >= birth.getDate());
  if (!hadBirthdayThisYear) age--;
  return age >= 0 && age < ADULT_AGE;
}

// Toggles the Parent-only / Admin-only sections and re-themes the header +
// Family box (blue for Student, green for Parent, purple for Admin) as the
// Birthday field changes - type is no longer a user choice (see above), so
// this is a live preview of what the server will derive on save, not the
// thing that actually decides it.
function updateMemberFormForType(form) {
  const lockedAdmin = form.querySelector('input[name="memberType"][value="admin"]');
  const birthdayInput = form.querySelector('input[name="birthday"]');
  const type = lockedAdmin ? 'admin' : isChildBirthday(birthdayInput ? birthdayInput.value : '') ? 'student' : 'parent';
  const meta = MEMBER_TYPE_META[type] || MEMBER_TYPE_META.parent;

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

// "add parent/student ... it will ask student or parent, name, if
// student then it asks birthday and grade. save." Opens the quick-add
// dialog (main-admin-member-edit.ejs, outside #member-form for the same
// reason initAddFamilyDialog's own dialog is) - a real submit (no fetch)
// since there's nothing on this page to patch in place, just a plain page
// reload showing the result. A further real request ("No parent/student
// choice on membership forms or profiles") dropped the Student/Parent
// radio this used to toggle Birthday/Grade Level with - both fields are
// just always there now, and the server derives parent-vs-student from
// whatever Birthday comes back.
function initQuickAddMemberDialog(form) {
  const openBtn = form.querySelector('[data-quick-add-member-open]');
  const dialog = document.querySelector('[data-quick-add-member-dialog]');
  if (!openBtn || !dialog) return;
  const addForm = dialog.querySelector('[data-quick-add-member-form]');

  openBtn.addEventListener('click', () => {
    addForm.reset();
    dialog.showModal();
  });
}

// The Admin Positions "Add a Position" dropdown (the Setup/Cleanup Team
// box this was also originally built for is gone now - a real request:
// "Remove setup/cleanup team section [from the member form]. That is only
// done through the setup/cleanup admin pages") is a quick-pick convenience
// on top of the real multi-select checkbox list below it -
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
  initQuickAddMemberDialog(form);
  initPickerChecklist(form, '[data-position-picker]', '[data-position-checklist]');
}

(function () {
  const form = document.getElementById('member-form');
  if (!form) return;
  const birthdayInput = form.querySelector('input[name="birthday"]');
  if (birthdayInput) birthdayInput.addEventListener('input', () => updateMemberFormForType(form));
  updateMemberFormForType(form);
  initMemberFormInteractions(form);
})();
