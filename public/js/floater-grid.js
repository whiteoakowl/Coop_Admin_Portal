// Floater Assignments planning grid: each date cell starts locked (plain
// name text + an Edit button). Clicking Edit swaps the name for a <select>
// of everyone available that hour (embedded once as JSON, keyed by hour
// position) and turns the button into Save. Clicking Save posts the pick
// to the same assign/unassign endpoints the Substitutes Needed cards use
// (there's only one "who's covering this slot" system - see
// jobAssignmentGrid/substituteBoard in utils/substitutes.js), then
// reloads so the cell locks back to plain text and every other view of
// this assignment (Substitutes Needed, exports) stays in sync.
(function () {
  const dataEl = document.getElementById('floaters-by-hour-data');
  const cells = document.querySelectorAll('.job-assign-cell');
  if (!dataEl || cells.length === 0) return;

  let floatersByHour = {};
  try {
    floatersByHour = JSON.parse(dataEl.textContent || '{}');
  } catch (err) {
    return;
  }

  const day = document.querySelector('main[data-day]')?.dataset.day;
  if (!day) return;

  cells.forEach((cell) => {
    const editBtn = cell.querySelector('.job-assign-edit-btn');
    if (!editBtn) return;

    editBtn.addEventListener('click', () => {
      if (editBtn.dataset.mode === 'edit') {
        const nameEl = cell.querySelector('.job-assign-name');
        const currentId = cell.dataset.memberId || '';
        const hourPosition = cell.dataset.hour;

        const select = document.createElement('select');
        select.className = 'job-assign-select';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'Unassigned';
        select.appendChild(blank);
        (floatersByHour[hourPosition] || []).forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          if (String(m.id) === String(currentId)) opt.selected = true;
          select.appendChild(opt);
        });

        nameEl.replaceWith(select);
        editBtn.textContent = 'Save';
        editBtn.dataset.mode = 'save';
      } else {
        const select = cell.querySelector('.job-assign-select');
        const memberId = select.value;
        const body = new URLSearchParams({
          date: cell.dataset.date,
          slotType: 'job',
          slotId: cell.dataset.jobId,
          isOverride: '1',
        });
        const url = memberId
          ? `/admin/volunteers/${day}/substitutes/assign`
          : `/admin/volunteers/${day}/substitutes/unassign`;
        if (memberId) body.set('memberId', memberId);

        editBtn.disabled = true;
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        })
          .then(() => window.location.reload())
          .catch(() => {
            editBtn.disabled = false;
          });
      }
    });
  });
})();
