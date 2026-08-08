// Shared by both the full Add/Edit Membership Form page (this script) and
// the Members list's view/edit popup (public/js/member-view.js, which
// inlines the same logic since it has to re-run it every time the dialog's
// fragment is swapped in). Toggles the Student-only / Parent-only sections
// and re-themes the header + Family box (blue for Student, green for
// Parent) when the Student/Parent/Admin toggle changes.
const MEMBER_TYPE_META = {
  student: { icon: 'graduation-cap', title: 'Student Membership Form', subtitle: 'Enter student information', headerClass: 'member-form-header-student', boxClass: 'member-form-section-blue' },
  parent: { icon: 'users', title: 'Parent Membership Form', subtitle: 'Enter parent/guardian information', headerClass: 'member-form-header-parent', boxClass: 'member-form-section-green' },
  admin: { icon: 'users', title: 'Admin Membership Form', subtitle: 'Enter admin information', headerClass: 'member-form-header-student', boxClass: 'member-form-section-blue' },
};

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

(function () {
  const form = document.getElementById('member-form');
  if (!form) return;
  form.querySelectorAll('input[name="memberType"]').forEach((r) => r.addEventListener('change', () => updateMemberFormForType(form)));
  updateMemberFormForType(form);
})();
