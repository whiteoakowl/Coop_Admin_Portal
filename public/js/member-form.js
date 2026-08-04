(function () {
  const form = document.getElementById('member-form');
  if (!form) return;

  const radios = form.querySelectorAll('input[name="memberType"]');
  const studentFields = document.getElementById('student-only-fields');
  const parentFields = document.getElementById('parent-only-fields');
  if (!studentFields && !parentFields) return;

  function update() {
    const checked = form.querySelector('input[name="memberType"]:checked');
    const type = checked ? checked.value : 'student';
    if (studentFields) studentFields.style.display = type === 'student' ? '' : 'none';
    if (parentFields) parentFields.style.display = type === 'parent' ? '' : 'none';
  }

  radios.forEach((r) => r.addEventListener('change', update));
  update();
})();
