// Powers the "Select All" checkbox next to the Class Schedule grid's
// "Archive Selected" button: toggles every per-class checkbox associated
// (via the HTML form="..." attribute) with the same archive form, since
// those checkboxes live inside table cells rather than the form itself.
(function () {
  if (window.__classScheduleArchiveSelectInstalled) return;
  window.__classScheduleArchiveSelectInstalled = true;

  document.addEventListener('change', (e) => {
    const master = e.target.closest('[data-select-all-for]');
    if (!master) return;
    const formId = master.getAttribute('data-select-all-for');
    document.querySelectorAll(`input[name="classIds"][form="${formId}"]`).forEach((cb) => {
      cb.checked = master.checked;
    });
  });
})();
