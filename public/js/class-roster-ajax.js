// Co-op Admin > Class Schedule > a class's own Manage page, Student
// Roster AND Teachers & Assistants sections (views/admin-class-schedule-
// manage.ejs). Real requests: "when deleting someone from the class
// roster the page should not refresh. It should stay on the roster and
// the name should disappear" and "if you add someone to a class roster
// the page should not refresh. The person should appear on the list" -
// later confirmed to cover BOTH "members" this page manages, not just
// students: "when adding or deleting a member from a class roster the
// page refreshes and jumps back to the full class schedule grid" was
// still true for Teachers & Assistants specifically, since that section
// never got this same treatment the first time. Every add/remove control
// in both sections now fetch()es instead of submitting/navigating -
// window.confirmAction (public/js/confirm-dialog.js) is the same
// sitewide "are you sure?" popup every data-confirm form uses, just the
// Promise-returning flavor meant for a plain button like Remove instead
// of a real <form> submit.
//
// Delegated on `document` (addEventListener('submit'/'click', ...)
// rather than grabbing #add-students-form/#student-roster-list up front,
// same reasoning as confirm-dialog.js's own document-level listeners -
// this script (loaded from partials/admin-nav.ejs, included near the TOP
// of the page) runs before either section further down the page has even
// been parsed yet, so an upfront getElementById would always find
// nothing.
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

  // Teachers & Assistants section - exact same fetch()-instead-of-submit
  // shape as the Student Roster handlers above, just a single-select
  // member + role radio instead of a checkbox list (so there's only ever
  // one newly-added row per submit, not a batch).
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || form.id !== 'add-staff-form') return;
    const list = document.getElementById('staff-roster-list');
    if (!list) return;
    e.preventDefault();

    const select = form.querySelector('select[name="memberId"]');
    if (!select || !select.value) return;
    const submitBtn = document.getElementById('add-staff-submit');
    const body = new URLSearchParams(new FormData(form));
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
      form.submit();
      return;
    }
    if (submitBtn) submitBtn.disabled = false;
    if (!res.ok) {
      form.submit();
      return;
    }
    const data = await res.json();
    if (!data.rowHtml) return;
    const emptyEl = document.getElementById('staff-roster-empty');
    if (emptyEl) emptyEl.hidden = true;
    list.insertAdjacentHTML('beforeend', data.rowHtml);
    updateCount(document.getElementById('staff-roster-count'), 1);

    // Same "take the newly-added member off the still-open dialog's own
    // candidate list" idea as the Add Students dialog above, so they
    // can't be picked again without a reload.
    const option = select.querySelector(`option[value="${data.addedId}"]`);
    if (option) option.remove();
    if (select.querySelectorAll('option').length === 0) {
      const hint = document.getElementById('add-staff-empty-hint');
      if (hint) hint.hidden = false;
      if (submitBtn) submitBtn.hidden = true;
      select.closest('label').hidden = true;
      form.querySelector('.radio-group').hidden = true;
    }
    const dialog = document.getElementById('add-staff-dialog');
    if (dialog) dialog.close();
  });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.js-roster-staff-remove');
    if (!btn) return;
    const confirmed = await window.confirmAction({
      message: 'Remove ' + btn.dataset.staffName + ' from this class?',
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
    const list = document.getElementById('staff-roster-list');
    const row = btn.closest('[data-roster-staff-row]');
    if (row) row.remove();
    updateCount(document.getElementById('staff-roster-count'), -1);
    const emptyEl = document.getElementById('staff-roster-empty');
    if (emptyEl && list && list.querySelectorAll('[data-roster-staff-row]').length === 0) emptyEl.hidden = false;
  });
})();
