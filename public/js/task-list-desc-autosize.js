// A real request: "the task bar line should be a description box where
// you can see the whole task" - the task description used to be a plain
// single-line text input, which clips/scrolls a long task horizontally
// instead of showing all of it. Swapping to a <textarea> (views/admin-
// setup-tasks.ejs) lets it wrap, but a textarea's own height still
// defaults to a fixed, short box unless something grows it to fit - this
// does that on load and on every keystroke while a list is in Edit mode,
// so the box is always exactly tall enough to show the whole task with
// no scrolling.
(function () {
  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  document.querySelectorAll('.task-list-desc-input').forEach(autosize);

  document.addEventListener('input', (e) => {
    if (e.target.classList && e.target.classList.contains('task-list-desc-input')) autosize(e.target);
  });
})();
