// Members list: a family with more than one member starts collapsed to
// just its head row (the primary parent - or, lacking one, whichever
// member sorts first; see utils/members.js's sortMembersByFamily, which
// already puts that member first within the group server-side). Clicking
// the head row expands the rest of the family; clicking it again
// collapses them back. Solo members (no family, or the only active member
// in theirs) never get a toggle - there's nothing to expand.
//
// Purely a screen affordance - .members-print-table (admin-members.ejs's
// separate print-only table) always renders every member regardless of
// collapse state here.
(function () {
  const rows = document.querySelectorAll('.members-list-table tbody tr[data-family-key]');
  if (!rows.length) return;

  const groups = new Map();
  rows.forEach((row) => {
    const key = row.dataset.familyKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  groups.forEach((groupRows) => {
    if (groupRows.length < 2) return;
    const [headRow, ...restRows] = groupRows;

    const nameCell = headRow.querySelector('.members-col-name');
    if (!nameCell) return;

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'family-collapse-toggle';
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.setAttribute('aria-label', `Show ${restRows.length} more family member${restRows.length === 1 ? '' : 's'}`);
    toggleBtn.innerHTML = '<svg class="icon family-collapse-icon"><use href="#icon-chevron-down"/></svg>';
    nameCell.insertBefore(toggleBtn, nameCell.firstChild);

    restRows.forEach((row) => row.classList.add('family-row-collapsed'));

    toggleBtn.addEventListener('click', () => {
      const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
      restRows.forEach((row) => row.classList.toggle('family-row-collapsed', expanded));
      toggleBtn.setAttribute('aria-expanded', String(!expanded));
      toggleBtn.setAttribute('aria-label', expanded ? `Show ${restRows.length} more family member${restRows.length === 1 ? '' : 's'}` : 'Hide family members');
    });
  });
})();
