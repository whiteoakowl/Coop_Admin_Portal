// A real request: "Do not refresh the page every time you assign or
// unassigned a setup/cleanup task. Should be able to keep assigning all
// at once." Each Assign/Unassign form on the Setup/Cleanup Assignments
// page (views/partials/setup-assignment-cards.ejs) now submits via fetch
// instead of a normal page POST - mirrors public/js/floater-assign.js's
// own fix for the exact same complaint on the Floater Chart, see
// routes/admin-setup.js's own isFetch() check for the JSON-vs-redirect
// branch this relies on. On success every card is re-fetched
// (routes/admin-setup.js's /assignments/fragment route) and swapped into
// #setup-assignment-cards-container rather than patched row-by-row, since
// one member's assignment can free up (or take) a task another member's
// own dropdown was suggesting - a single-row patch would leave those
// other dropdowns stale.
//
// Delegated on document (mirrors csrf.js's own pattern) rather than bound
// to each form directly, since the cards get replaced wholesale after
// every successful save.
(function () {
  const container = document.getElementById('setup-assignment-cards-container');
  if (!container) return;
  const status = document.getElementById('setup-assign-status');
  const main = document.getElementById('main-content');
  const day = main ? main.dataset.day : '';

  function showError(message) {
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
  }
  function clearError() {
    if (!status) return;
    status.hidden = true;
    status.textContent = '';
  }

  async function refreshCards() {
    const date = container.dataset.selectedDate;
    const res = await fetch(`/admin/setup/${day}/assignments/fragment?date=${encodeURIComponent(date)}`, {
      headers: { 'X-Requested-With': 'fetch' },
    });
    if (!res.ok) throw new Error('Saved, but could not refresh the cards - reload the page to see it.');
    container.innerHTML = await res.text();
  }

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('.floater-assign-form');
    if (!form || !container.contains(form)) return;
    e.preventDefault();

    const submitBtn = form.querySelector('button[type="submit"]');
    const originalLabel = submitBtn ? submitBtn.textContent : '';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
    }
    clearError();

    const body = new URLSearchParams(new FormData(form));
    fetch(form.action, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'X-Requested-With': 'fetch',
        'X-CSRF-Token': window.CSRF_TOKEN || '',
      },
      body: body.toString(),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not save that assignment.');
        return refreshCards();
      })
      .catch((err) => {
        showError(err.message || 'Could not save that assignment.');
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = originalLabel;
        }
      });
  });
})();
