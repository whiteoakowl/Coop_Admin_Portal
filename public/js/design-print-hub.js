// Design tab: one dropdown picks Student/Parent/Admin Name Tag or Schedule
// Card. Both canvas engines (name-tag-editor.js, schedule-card-editor.js)
// are already initialized on the page - this only shows/hides their
// sections and, for the three name-tag types, forwards the choice into the
// editor's own hidden #name-tag-type-select so its existing switchType
// logic runs unmodified.
(function () {
  const typeSelect = document.getElementById('design-type-select');
  if (!typeSelect) return;

  const nameTagSection = document.getElementById('design-name-tag-section');
  const scheduleCardSection = document.getElementById('design-schedule-card-section');
  const nameTagToolbar = document.getElementById('design-name-tag-toolbar-controls');
  const scheduleCardToolbar = document.getElementById('design-schedule-card-toolbar-controls');
  const hiddenNameTagSelect = document.getElementById('name-tag-type-select');

  function apply(value) {
    const isScheduleCard = value === 'scheduleCard';
    if (nameTagSection) nameTagSection.hidden = isScheduleCard;
    if (nameTagToolbar) nameTagToolbar.hidden = isScheduleCard;
    if (scheduleCardSection) scheduleCardSection.hidden = !isScheduleCard;
    if (scheduleCardToolbar) scheduleCardToolbar.hidden = !isScheduleCard;

    if (!isScheduleCard && hiddenNameTagSelect && hiddenNameTagSelect.value !== value) {
      hiddenNameTagSelect.value = value;
      hiddenNameTagSelect.dispatchEvent(new Event('change'));
    }
  }

  typeSelect.addEventListener('change', () => apply(typeSelect.value));
  apply(typeSelect.value);
})();

// Print tab: one dropdown picks which existing print flow to show
// (Schedule Cards / Name Tags / Schedules / Logs).
(function () {
  const typeSelect = document.getElementById('print-type-select');
  if (!typeSelect) return;

  const sections = {
    scheduleCards: document.getElementById('print-schedule-cards-section'),
    nameTags: document.getElementById('print-name-tags-section'),
    schedules: document.getElementById('print-schedules-section'),
    logs: document.getElementById('print-logs-section'),
  };

  function apply(value) {
    Object.keys(sections).forEach((key) => {
      if (sections[key]) sections[key].hidden = key !== value;
    });
  }

  typeSelect.addEventListener('change', () => apply(typeSelect.value));
  apply(typeSelect.value);

  // Schedule Cards list: name search + select-all (mirrors public/js/schedule.js).
  const scheduleList = document.getElementById('schedule-print-list');
  if (scheduleList) {
    const searchInput = document.getElementById('schedule-print-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        scheduleList.querySelectorAll('.member-picker-row').forEach((row) => {
          row.style.display = !q || row.dataset.name.includes(q) ? '' : 'none';
        });
      });
    }
    const scheduleSelectAll = document.getElementById('schedule-print-select-all-checkbox');
    if (scheduleSelectAll) {
      scheduleSelectAll.addEventListener('change', () => {
        scheduleList.querySelectorAll('.member-picker-row').forEach((row) => {
          if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = scheduleSelectAll.checked;
        });
      });
    }
  }

  // Name Tags list: type filter + select-all/select-none (mirrors the bulk
  // print list wiring in name-tag-editor.js).
  const bulkList = document.getElementById('name-tag-bulk-list');
  if (bulkList) {
    const filterSelect = document.getElementById('name-tag-bulk-filter-select');
    if (filterSelect) {
      filterSelect.addEventListener('change', () => {
        const filter = filterSelect.value;
        bulkList.querySelectorAll('.member-picker-row').forEach((row) => {
          row.style.display = filter === 'all' || row.dataset.type === filter ? '' : 'none';
        });
      });
    }
    const selectAllCheckbox = document.getElementById('name-tag-select-all-checkbox');
    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener('change', () => {
        bulkList.querySelectorAll('.member-picker-row').forEach((row) => {
          if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = selectAllCheckbox.checked;
        });
      });
    }
    const selectNoneCheckbox = document.getElementById('name-tag-select-none-checkbox');
    if (selectNoneCheckbox) {
      selectNoneCheckbox.addEventListener('change', () => {
        if (selectNoneCheckbox.checked) {
          bulkList.querySelectorAll('.member-picker-row').forEach((row) => {
            if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = false;
          });
          if (selectAllCheckbox) selectAllCheckbox.checked = false;
          selectNoneCheckbox.checked = false;
        }
      });
    }
  }
})();
