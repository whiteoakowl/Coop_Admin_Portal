// Member Profile Attendance tab: a real request - "under each person, each
// of the attendance rosters this member is on will show, then you can
// click on the class/roster name and it will expand and show attendance
// and dates for that class. When you click on another class. The old
// class closes." Same single-open-at-a-time pattern as public/js/
// absence-log-accordion.js, just scoped to .member-attendance-roster-
// toggle instead - one open panel across the whole page at a time, even
// across different family members' own roster lists in the "All" view.
(function () {
  const toggles = document.querySelectorAll('.member-attendance-roster-toggle');
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
