// Live word count for the Assignment Upload content type's own rich-text
// editor (views/partials/lesson-content-manage.ejs) - a real request:
// "assignment upload, text box with word count and full editing
// features." Scoped to [data-word-count-source] so this never touches
// any other forum-editable field on the same page (Class Description,
// Lesson Details description, etc.).
(function () {
  document.querySelectorAll('[data-word-count-source]').forEach((editable) => {
    const wrapper = editable.closest('[data-toggle-field]') || editable.parentElement;
    const countEl = wrapper ? wrapper.querySelector('[data-word-count]') : null;
    if (!countEl) return;

    function update() {
      const text = editable.textContent || '';
      const words = text.trim().length ? text.trim().split(/\s+/) : [];
      countEl.textContent = words.length;
    }

    editable.addEventListener('input', update);
    update();
  });
})();
