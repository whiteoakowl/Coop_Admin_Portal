(function () {
  const form = document.getElementById('member-form');
  if (!form) return;

  const radios = form.querySelectorAll('input[name="memberType"]');
  const studentFields = document.getElementById('student-only-fields');
  if (!studentFields) return;

  function update() {
    const checked = form.querySelector('input[name="memberType"]:checked');
    const isStudent = !checked || checked.value === 'student';
    studentFields.style.display = isStudent ? '' : 'none';
  }

  radios.forEach((r) => r.addEventListener('change', update));
  update();
})();
