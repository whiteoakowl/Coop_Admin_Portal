// Members list: a family with more than one member starts collapsed to
// just its head card (the primary parent - or, lacking one, whichever
// member sorts first; see utils/members.js's sortMembersByFamily, which
// already puts that member first within the group server-side). Clicking
// the head card's chevron expands the rest of the family; clicking a
// DIFFERENT family's chevron closes whichever family was open before -
// a real request, with a reference screenshot: "when you click on
// another family name the other family closes" - only one family open
// at a time, unlike the old table's own members-family-collapse.js
// (now removed - both its callers moved to this card layout), which let
// any number stay expanded together.
//
// This also closes any open "more actions" popover (.member-row-menu, a
// plain <details>) on an outside click - <details> has no such behavior
// natively, and left open it would float over whatever's expanded next.
(function () {
  const rows = document.querySelectorAll('.member-row-card[data-family-key]');
  if (rows.length) {
    const groups = new Map();
    rows.forEach((row) => {
      const key = row.dataset.familyKey;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });

    const toggles = [];
    groups.forEach((groupRows) => {
      if (groupRows.length < 2) return;
      const [headRow, ...restRows] = groupRows;
      const toggle = headRow.querySelector('.family-accordion-toggle');
      if (!toggle) return;
      restRows.forEach((row) => row.classList.add('member-row-collapsed'));
      toggle.__restRows = restRows;
      toggles.push(toggle);
    });

    let openToggle = null;
    toggles.forEach((toggle) => {
      toggle.addEventListener('click', () => {
        const wasOpen = toggle.getAttribute('aria-expanded') === 'true';

        if (openToggle && openToggle !== toggle) {
          openToggle.__restRows.forEach((row) => row.classList.add('member-row-collapsed'));
          openToggle.setAttribute('aria-expanded', 'false');
          openToggle.setAttribute('aria-label', openToggle.getAttribute('aria-label').replace('Hide', 'Show'));
        }

        toggle.__restRows.forEach((row) => row.classList.toggle('member-row-collapsed', wasOpen));
        toggle.setAttribute('aria-expanded', String(!wasOpen));
        openToggle = wasOpen ? null : toggle;
      });
    });
  }

  document.addEventListener('click', (e) => {
    document.querySelectorAll('.member-row-menu[open]').forEach((menu) => {
      if (!menu.contains(e.target)) menu.removeAttribute('open');
    });
  });
})();
