// Powers the click-an-event-card popup on the Events list (public/member
// page, shared as-is by Parent Portal's own Events nav and Student
// Portal's own Calendar nav - see routes/events.js's own comment): fetches
// that event's photo/title/short description/cost as an HTML fragment and
// shows it in a shared dialog, same public/js/fragment-dialog.js helper
// and click-delegate shape as public/js/parent-class-view.js's own class
// card popup.
(function () {
  const dialog = document.getElementById('event-card-dialog');
  if (!dialog || !window.loadFragmentIntoDialog) return;

  document.addEventListener('click', (e) => {
    const card = e.target.closest('[data-view-event]');
    if (!card) return;
    const id = card.getAttribute('data-view-event');
    window.loadFragmentIntoDialog(dialog, `/events/${id}/fragment`).catch(() => {
      window.location.href = `/events/${id}`;
    });
  });
})();
