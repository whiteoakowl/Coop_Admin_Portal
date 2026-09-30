// A real bug report: "parent portal, backing out of an event takes you to
// student portal. It should stay in parent portal." Every action form on
// the event detail page (register, cancel, volunteer signup, claim a
// donation/food item, guest register, etc. - views/events-detail.ejs)
// posts back to this same /events/:id page, whose own portal nav shell
// depends on a ?portal=parent|student query param (routes/events.js's own
// portalPrefix reads it to build the redirect). Rather than hand-editing
// every one of those forms' action attributes server-side, this tags them
// all at once from the page's own current URL, which already carries that
// param whenever it matters (the calendar/back-link/fragment links that
// lead here all set it - see events-list.ejs/events-card-fragment.ejs).
(function () {
  const portal = new URLSearchParams(window.location.search).get('portal');
  if (portal !== 'parent' && portal !== 'student') return;
  document.querySelectorAll('form[action^="/events/"]').forEach((form) => {
    if (form.action.indexOf('portal=') !== -1) return;
    const sep = form.action.indexOf('?') === -1 ? '?' : '&';
    form.action += `${sep}portal=${portal}`;
  });
})();
