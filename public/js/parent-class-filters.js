// Parent Portal's own Class Registration page (views/parent-classes.ejs) -
// a real request: "Parents can filter classes by grade level and by
// their own students, drop down menu. If filtering by their student it
// will only show classes that matching their grade level." Picking a
// student locks the Grade Level select to that student's own grade_level
// (data-grade on its own <option>, set by routes/parent-portal.js's own
// GRADE_LEVELS/childrenForAccount) and disables it, so there's no way to
// leave it showing a grade that doesn't match the selected student;
// "All Students" hands control back to Grade Level on its own.
(function () {
  const studentSelect = document.querySelector('[data-parent-class-student-filter]');
  const gradeSelect = document.querySelector('[data-parent-class-grade-filter]');
  if (!studentSelect || !gradeSelect) return;

  function applyGradeFilter() {
    const gradeValue = gradeSelect.value;
    document.querySelectorAll('[data-class-grade-list]').forEach((card) => {
      if (!gradeValue) {
        card.style.display = '';
        return;
      }
      const list = (card.getAttribute('data-class-grade-list') || '').split(',').filter(Boolean);
      card.style.display = list.includes(gradeValue) ? '' : 'none';
    });
  }

  studentSelect.addEventListener('change', () => {
    const option = studentSelect.selectedOptions[0];
    const grade = option ? option.getAttribute('data-grade') : '';
    if (studentSelect.value && grade) {
      gradeSelect.value = grade;
      gradeSelect.disabled = true;
    } else {
      gradeSelect.disabled = false;
    }
    applyGradeFilter();
  });

  gradeSelect.addEventListener('change', applyGradeFilter);

  document.addEventListener('click', function (e) {
    document.querySelectorAll('[data-filter-details][open]').forEach((details) => {
      if (details.contains(e.target)) return;
      details.removeAttribute('open');
    });
  });
})();
