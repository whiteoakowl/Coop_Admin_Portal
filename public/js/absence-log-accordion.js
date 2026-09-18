// Absence/Late Log: a real request, with a reference design - "when you
// click on another family name the other family closes." Only one
// .absence-family-group's members panel open at a time, same idea as
// the Members list's own family accordion (public/js/members-family-
// accordion.js) but plain hidden/aria-expanded toggling instead of that
// one's collapse-by-class approach, since these aren't member card rows.
(function () {
  const toggles = document.querySelectorAll('.absence-family-toggle');
  if (!toggles.length) return;

  let openToggle = null;

  toggles.forEach((toggle) => {
    const panel = document.getElementById(toggle.getAttribute('aria-controls'));
    if (!panel) return;

    toggle.addEventListener('click', () => {
      const wasOpen = toggle.getAttribute('aria-expanded') === 'true';

      if (openToggle && openToggle !== toggle) {
        const openPanel = document.getElementById(openToggle.getAttribute('aria-controls'));
        if (openPanel) openPanel.hidden = true;
        openToggle.setAttribute('aria-expanded', 'false');
      }

      panel.hidden = wasOpen;
      toggle.setAttribute('aria-expanded', String(!wasOpen));
      openToggle = wasOpen ? null : toggle;
    });
  });
})();
