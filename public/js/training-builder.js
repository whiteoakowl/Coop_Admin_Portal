// Training Builder page (views/admin-training-builder.ejs): the Add/Edit
// Lesson dialogs' own type-dependent field toggle, and the Add/Edit
// Question dialogs' own "+ Add Option" row appender. Delegated on
// document so it works for every dialog on the page (the add dialog plus
// one edit dialog per existing lesson/question) without a separate
// listener per instance.
(function () {
  function applyLessonType(form) {
    const type = form.querySelector('[data-lesson-type-select]').value;
    form.querySelectorAll('[data-lesson-field]').forEach((field) => {
      const types = field.dataset.lessonField.split(',');
      field.hidden = !types.includes(type);
    });
  }

  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-lesson-type-select]')) {
      applyLessonType(e.target.closest('form'));
    }
  });

  // Every lesson-type form on the page starts in sync with its own
  // current selection (server-rendered), but a <dialog> hidden with
  // `hidden`/hasn't been shown yet still needs its fields toggled before
  // the admin ever sees it, not just on the first change event.
  document.querySelectorAll('[data-lesson-type-form]').forEach(applyLessonType);

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add-option]');
    if (!btn) return;
    const container = btn.closest('form').querySelector('[data-question-options]');
    const index = container.querySelectorAll('.training-question-option-row').length;
    const row = document.createElement('div');
    row.className = 'training-question-option-row';
    row.innerHTML = `<input type="radio" name="correctIndex" value="${index}" aria-label="Mark option ${index + 1} correct" /><input type="text" name="optionText" placeholder="Answer option" required />`;
    container.appendChild(row);
  });
})();
