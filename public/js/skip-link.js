// The "Skip to main content" link (partials/admin-nav.ejs) targets
// #main-content (tabindex="-1" on <main>, set on every page) so it's a
// valid focus target - but the browser's own fragment-navigation is
// unreliable about actually moving keyboard focus there (confirmed:
// Chromium scrolls to the target then resets focus to <body>, and the
// reset can land well after any reasonable setTimeout, so racing it is
// not an option). Prevent the native navigation outright and do the
// scroll+focus ourselves, so there's nothing left to race.
(function () {
  const skipLink = document.querySelector('.skip-link');
  if (!skipLink) return;
  skipLink.addEventListener('click', (e) => {
    const id = skipLink.getAttribute('href').slice(1);
    const target = document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    target.focus();
    target.scrollIntoView();
    history.replaceState(null, '', '#' + id);
  });
})();
