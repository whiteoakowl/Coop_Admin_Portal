// A real request: "when adding dates to setup/cleanup it should stay on
// the pop up and simply immediately update the list with the new date
// and allow you to continue adding dates while window is still open.
// same if clicking remove a date, the date should disappear and pop up
// stay open for further editing and adding." Both the Add Dates and
// Remove forms inside #edit-dates-dialog (admin-setup-assignments.ejs)
// now submit via fetch instead of a normal page POST - see routes/
// admin-setup.js's own isFetch() check for the HTML-fragment-vs-redirect
// branch this relies on. On success #setup-dates-list is swapped for the
// server's fresh render of it (same setup-dates-fragment.ejs both the
// full page and this fetch render), and the Add Dates input is cleared
// so its own onchange->requestSubmit() keeps working for the next date -
// the dialog itself is never closed by either action.
//
// The Remove form also carries data-confirm (public/js/confirm-dialog.js
// intercepts its first submit to show the Yes/No popup) - this listener
// deliberately leaves that FIRST, unconfirmed submit alone (same check
// confirm-dialog.js itself uses) so that flow still runs, and only takes
// over the second submit confirm-dialog.js's own Yes button re-fires
// once dataset.confirmed is set.
(function () {
  const list = document.getElementById('setup-dates-list');
  const dialog = document.getElementById('edit-dates-dialog');
  if (!list || !dialog) return;

  function swapList(html) {
    list.innerHTML = html;
  }

  function submitViaFetch(form) {
    const body = new URLSearchParams(new FormData(form));
    return fetch(form.action, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'fetch',
        'X-CSRF-Token': window.CSRF_TOKEN || '',
      },
      body: body.toString(),
    }).then((res) => {
      if (!res.ok) throw new Error('Request failed');
      return res.text();
    });
  }

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !dialog.contains(form)) return;
    if (form.dataset.confirm && form.dataset.confirmed !== '1') return;
    e.preventDefault();

    const dateInput = form.querySelector('input[name="dates"]');
    submitViaFetch(form)
      .then(swapList)
      .then(() => {
        if (dateInput) dateInput.value = '';
      })
      .catch(() => {
        // Fall back to a real navigation so the admin isn't stuck with a
        // silently-failed click - same as this dialog's own pre-fetch
        // behavior.
        form.dataset.confirmed = '1';
        form.submit();
      });
  });
})();
