// Powers the full Add/Edit Membership Form page (views/admin-member-edit.ejs).
const MEMBER_TYPE_META = {
  student: { icon: 'graduation-cap', title: 'Student Membership Form', subtitle: 'Create or update a student membership profile.', headerClass: 'member-form-header-student', boxClass: 'member-form-section-blue' },
  parent: { icon: 'users', title: 'Parent Membership Form', subtitle: 'Create or update a parent/guardian membership profile.', headerClass: 'member-form-header-parent', boxClass: 'member-form-section-green' },
};

// Toggles the Student-only / Parent-only sections and re-themes the header
// + Family box (blue for Student, green for Parent) when the
// Parent/Student/Admin toggle changes.
function updateMemberFormForType(form) {
  const checked = form.querySelector('input[name="memberType"]:checked');
  const type = checked ? checked.value : 'student';
  const meta = MEMBER_TYPE_META[type] || MEMBER_TYPE_META.student;

  form.querySelectorAll('[data-student-only]').forEach((el) => { el.style.display = type === 'student' ? '' : 'none'; });
  form.querySelectorAll('[data-parent-only]').forEach((el) => { el.style.display = type === 'parent' ? '' : 'none'; });

  const header = form.querySelector('[data-member-form-header]');
  if (header) {
    header.classList.remove('member-form-header-student', 'member-form-header-parent');
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
    familyBox.classList.remove('member-form-section-blue', 'member-form-section-green');
    familyBox.classList.add(meta.boxClass);
  }
}

// Family is a single choice (a member belongs to one family) but styled as
// a "dropdown + checklist" like the reference design - the <select> is the
// real form field; the checklist rows underneath are just a friendlier way
// to pick the same value, kept in sync with it in both directions.
function initFamilyChecklist(form) {
  const select = form.querySelector('[data-family-select]');
  const checklist = form.querySelector('[data-family-checklist]');
  if (!select || !checklist) return;

  function syncFromSelect() {
    const value = select.value;
    checklist.querySelectorAll('[data-family-option]').forEach((btn) => {
      btn.classList.toggle('is-checked', btn.getAttribute('data-family-option') === value);
    });
  }

  select.addEventListener('change', syncFromSelect);
  checklist.querySelectorAll('[data-family-option]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const value = btn.getAttribute('data-family-option');
      select.value = select.value === value ? '' : value; // click again to clear
      syncFromSelect();
    });
  });
}

// The Setup/Cleanup Team "Add a Team" dropdown is a quick-pick convenience
// on top of the real multi-select checkbox list below it - picking an
// option just checks that box, then resets itself.
function initTeamPicker(form) {
  const picker = form.querySelector('[data-team-picker]');
  const checklist = form.querySelector('[data-team-checklist]');
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
  initFamilyChecklist(form);
  initTeamPicker(form);
}

(function () {
  const form = document.getElementById('member-form');
  if (!form) return;
  form.querySelectorAll('input[name="memberType"]').forEach((r) => r.addEventListener('change', () => updateMemberFormForType(form)));
  updateMemberFormForType(form);
  initMemberFormInteractions(form);
})();
