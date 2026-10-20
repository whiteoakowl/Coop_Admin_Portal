// Powers the click-a-class-card popup on Teacher Portal's own Class
// Schedule grid (views/teacher-classes.ejs) - a real request: "Be able
// to click on classes and see the details and read the descriptions."
// Same fetch-a-fragment-into-a-shared-dialog pattern as Parent Portal's
// own public/js/parent-class-view.js (see that file's own comment); this
// is the Teacher Portal equivalent, read-only (no register controls) and
// not gated to classes this teacher is staffed on.
(function () {
  const dialog = document.getElementById('teacher-class-dialog');
  if (!dialog || !window.loadFragmentIntoDialog) return;

  document.addEventListener('click', (e) => {
    const card = e.target.closest('[data-view-class]');
    if (!card) return;
    const id = card.getAttribute('data-view-class');
    window.loadFragmentIntoDialog(dialog, `/teacher/classes/${id}/fragment`).catch(() => {});
  });
})();
