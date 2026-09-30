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

  // A real bug report: "parent portal, backing out of an event takes you
  // to student portal" - this page's own URL already carries ?portal=
  // parent|student whenever a dual-role account got here from their own
  // nav (see events-list.ejs's own effectivePortal), so forwarding that
  // same param into the fragment fetch (and its own "Register Now" link -
  // views/events-card-fragment.ejs) keeps the whole click-through on the
  // right portal's nav shell.
  const portal = new URLSearchParams(window.location.search).get('portal');
  const portalQuery = portal === 'parent' || portal === 'student' ? `?portal=${portal}` : '';

  document.addEventListener('click', (e) => {
    const card = e.target.closest('[data-view-event]');
    if (!card) return;
    const id = card.getAttribute('data-view-event');
    window.loadFragmentIntoDialog(dialog, `/events/${id}/fragment${portalQuery}`).catch(() => {
      window.location.href = `/events/${id}${portalQuery}`;
    });
  });
})();
