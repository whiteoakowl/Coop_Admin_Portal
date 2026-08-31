// A real request: "make it to where the page doesn't refresh every time
// you click assign or unassigned - it should simply assign and allow you
// to continue clicking assignment until you're done." Each Assign/
// Unassign form on the Floater Assignments board (views/partials/
// floater-chart-cards.ejs) now submits via fetch instead of a normal page
// POST - see routes/admin-substitutes.js's own isFetch() check for the
// JSON-vs-redirect branch this relies on. On success the whole cards grid
// is re-fetched (routes/admin-volunteers.js's /fragment route) and swapped
// into #floater-cards-container rather than patched row-by-row, since one
// assignment can change other slots' own candidate lists this same hour
// (see buildHourSections' "used this hour" dedup logic) - a single-row
// patch would leave those other dropdowns stale.
//
// Delegated on document (mirrors csrf.js's own pattern) rather than bound
// to each form directly, since the grid's forms get replaced wholesale
// after every successful save.
(function () {
  const container = document.getElementById('floater-cards-container');
  if (!container) return;
  const status = document.getElementById('floater-assign-status');
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
    const res = await fetch(`/admin/volunteers/${day}/fragment?date=${encodeURIComponent(date)}`, {
      headers: { 'X-Requested-With': 'fetch' },
    });
    if (!res.ok) throw new Error('Saved, but could not refresh the board - reload the page to see it.');
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
