// Powers the click target on each Class Schedule card. A real request:
// "when you click a classes it should take you to the classes full
// settings page with tabs for all of that classes features" - this used
// to fetch a quick-view/edit fragment into a shared popup dialog instead;
// now it navigates straight to that full tabbed page (admin-class-
// schedule-manage.ejs) so the class's Assignments/Grades tabs are always
// one click away too, not just Details/Staff/Roster. The old fragment
// route/dialog (class-schedule-view-fragment.ejs, #class-view-dialog)
// still exists and is still tested - just no longer this card's own
// click target.
(function () {
  document.addEventListener('click', (e) => {
    const card = e.target.closest('[data-view-class]');
    // A click on the archive checkbox the card also contains shouldn't
    // also navigate away from the grid (see views/partials/class-
    // schedule-grid.ejs's own comment on why that checkbox lives inside
    // this same clickable card).
    if (!card || e.target.closest('.class-card-checkbox')) return;
    window.location.href = `/admin/class-schedule/classes/${card.getAttribute('data-view-class')}/manage`;
  });

  // Enter/Space need to be wired up by hand - the card is a <div>, not a
  // real <button>/<a> (a <button> can't legally contain the archive
  // checkbox it also holds), so it gets no keyboard activation for free.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('[data-view-class]');
    if (!card || card.tagName === 'BUTTON' || card.tagName === 'A' || e.target.closest('.class-card-checkbox')) return;
    e.preventDefault();
    window.location.href = `/admin/class-schedule/classes/${card.getAttribute('data-view-class')}/manage`;
  });
})();
