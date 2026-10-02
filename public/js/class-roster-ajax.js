// Co-op Admin > Class Schedule > a class's own Manage page, Student
// Roster section (views/admin-class-schedule-manage.ejs). Two real
// requests: "when deleting someone from the class roster the page should
// not refresh. It should stay on the roster and the name should
// disappear" and "if you add someone to a class roster the page should
// not refresh. The person should appear on the list." Both the Add
// Students dialog's form and each row's own Remove button now fetch()
// instead of submitting/navigating - window.confirmAction (public/js/
// confirm-dialog.js) is the same sitewide "are you sure?" popup every
// data-confirm form uses, just the Promise-returning flavor meant for a
// plain button like Remove instead of a real <form> submit.
//
// Delegated on `document` (addEventListener('submit'/'click', ...)
// rather than grabbing #add-students-form/#student-roster-list up front,
// same reasoning as confirm-dialog.js's own document-level listeners -
// this script (loaded from partials/admin-nav.ejs, included near the TOP
// of the page) runs before the Student Roster section further down the
// page has even been parsed yet, so an upfront getElementById would
// always find nothing.
(function () {
  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  function updateCount(countEl, delta) {
    if (!countEl) return;
    countEl.textContent = String(Math.max(0, parseInt(countEl.textContent, 10) + delta));
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || form.id !== 'add-students-form') return;
    const list = document.getElementById('student-roster-list');
    if (!list) return;
    e.preventDefault();

    const submitBtn = document.getElementById('add-students-submit');
    const checked = Array.from(form.querySelectorAll('input[name="studentIds"]:checked'));
    if (checked.length === 0) return;
    const body = new URLSearchParams();
    checked.forEach((input) => body.append('studentIds', input.value));
    body.append('_csrf', csrfToken());

    if (submitBtn) submitBtn.disabled = true;
    let res;
    try {
      res = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
        body: body.toString(),
      });
    } catch (err) {
      // Network error (or anything else fetch itself couldn't recover
      // from) - fall back to a real form submission rather than leaving
      // the admin stuck with a dead Add button.
      form.submit();
      return;
    }
    if (submitBtn) submitBtn.disabled = false;
    if (!res.ok) {
      form.submit();
      return;
    }
    const data = await res.json();
    const emptyEl = document.getElementById('student-roster-empty');
    if (emptyEl && data.addedIds.length > 0) emptyEl.hidden = true;
    list.insertAdjacentHTML('beforeend', data.rowsHtml);
    updateCount(document.getElementById('student-roster-count'), data.addedIds.length);

    // Remove the now-enrolled students from this same dialog's own
    // available-students list so they can't be picked again without a
    // reload, same as the full page would show on its own next load.
    data.addedIds.forEach((id) => {
      const row = form.querySelector(`[data-student-id="${id}"]`);
      if (row) row.remove();
    });
    if (form.querySelectorAll('[data-student-id]').length === 0) {
      const hint = document.getElementById('add-students-empty-hint');
      if (hint) hint.hidden = false;
      if (submitBtn) submitBtn.hidden = true;
    }
    const dialog = document.getElementById('add-students-dialog');
    if (dialog) dialog.close();
  });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.js-roster-student-remove');
    if (!btn) return;
    const confirmed = await window.confirmAction({
      message: 'Remove ' + btn.dataset.studentName + ' from this class?',
      yesLabel: 'Yes, Remove',
    });
    if (!confirmed) return;
    const body = new URLSearchParams();
    body.append('_csrf', csrfToken());
    let res;
    try {
      res = await fetch(btn.dataset.removeEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
        body: body.toString(),
      });
    } catch (err) {
      window.location.reload();
      return;
    }
    if (!res.ok) {
      window.location.reload();
      return;
    }
    const list = document.getElementById('student-roster-list');
    const card = btn.closest('[data-roster-student-card]');
    if (card) card.remove();
    updateCount(document.getElementById('student-roster-count'), -1);
    const emptyEl = document.getElementById('student-roster-empty');
    if (emptyEl && list && list.querySelectorAll('[data-roster-student-card]').length === 0) emptyEl.hidden = false;
  });
})();
