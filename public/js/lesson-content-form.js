// Generic "show only the field(s) that match the selected dropdown value"
// toggle, used by the Add Content form (views/partials/lesson-content-
// manage.ejs - video/text/file/quiz) and the Add Question form (views/
// partials/quiz-questions-manage.ejs - multiple_choice/short_answer).
// Scoped per-form so more than one of these can exist on the same page
// (e.g. the Add Content form and, after adding a quiz, its own Add
// Question form) without interfering with each other.
(function () {
  if (window.__toggleFieldFormInstalled) return;
  window.__toggleFieldFormInstalled = true;

  function syncVisibility(form) {
    const select = form.querySelector('[data-toggle-select]');
    if (!select) return;
    form.querySelectorAll('[data-toggle-field]').forEach((el) => {
      el.style.display = el.getAttribute('data-toggle-field') === select.value ? '' : 'none';
    });
  }

  document.querySelectorAll('[data-toggle-form]').forEach((form) => {
    syncVisibility(form);
    const select = form.querySelector('[data-toggle-select]');
    if (select) select.addEventListener('change', () => syncVisibility(form));
  });
})();
