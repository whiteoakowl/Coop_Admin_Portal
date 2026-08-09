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
    cardsBoth: document.getElementById('print-cardsBoth-section'),
    barcodes: document.getElementById('print-barcodes-section'),
    setupCleanupBadges: document.getElementById('print-setupCleanupBadges-section'),
    customBadges: document.getElementById('print-customBadges-section'),
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
        scheduleList.querySelectorAll('.print-picker-row').forEach((row) => {
          row.style.display = !q || row.dataset.name.includes(q) ? '' : 'none';
        });
      });
    }
    const scheduleSelectAll = document.getElementById('schedule-print-select-all-checkbox');
    if (scheduleSelectAll) {
      scheduleSelectAll.addEventListener('change', () => {
        scheduleList.querySelectorAll('.print-picker-row').forEach((row) => {
          if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = scheduleSelectAll.checked;
        });
      });
    }
  }

  // Member-type-filterable checkbox lists (Name Tags, Barcodes Only): type
  // filter + select-all/select-none, mirrors the bulk print list wiring in
  // name-tag-editor.js. Shared across both panels since they're the same
  // member-picker-list markup with different id prefixes.
  function wireBulkMemberList(listId, filterSelectId, selectAllId, selectNoneId) {
    const bulkList = document.getElementById(listId);
    if (!bulkList) return;
    const filterSelect = document.getElementById(filterSelectId);
    if (filterSelect) {
      filterSelect.addEventListener('change', () => {
        const filter = filterSelect.value;
        bulkList.querySelectorAll('.print-picker-row').forEach((row) => {
          row.style.display = filter === 'all' || row.dataset.type === filter ? '' : 'none';
        });
      });
    }
    const selectAllCheckbox = document.getElementById(selectAllId);
    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener('change', () => {
        bulkList.querySelectorAll('.print-picker-row').forEach((row) => {
          if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = selectAllCheckbox.checked;
        });
      });
    }
    const selectNoneCheckbox = document.getElementById(selectNoneId);
    if (selectNoneCheckbox) {
      selectNoneCheckbox.addEventListener('change', () => {
        if (selectNoneCheckbox.checked) {
          bulkList.querySelectorAll('.print-picker-row').forEach((row) => {
            if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = false;
          });
          if (selectAllCheckbox) selectAllCheckbox.checked = false;
          selectNoneCheckbox.checked = false;
        }
      });
    }
  }

  wireBulkMemberList('name-tag-bulk-list', 'name-tag-bulk-filter-select', 'name-tag-select-all-checkbox', 'name-tag-select-none-checkbox');
  wireBulkMemberList('cards-both-bulk-list', 'cards-both-bulk-filter-select', 'cards-both-select-all-checkbox', 'cards-both-select-none-checkbox');
  wireBulkMemberList('barcodes-bulk-list', 'barcodes-bulk-filter-select', 'barcodes-select-all-checkbox', 'barcodes-select-none-checkbox');

  // Setup/Cleanup + Custom badge lists (partials/misc-badge-print-panel):
  // one Select All checkbox per form, wired the same way as the schedule
  // cards list above.
  ['setupCleanup', 'custom'].forEach((type) => {
    const form = document.getElementById(type + '-badge-print-form');
    if (!form) return;
    const selectAll = form.querySelector('.' + type + '-badge-select-all-checkbox');
    if (!selectAll) return;
    selectAll.addEventListener('change', () => {
      form.querySelectorAll('input[name="badgeIds"]').forEach((cb) => {
        cb.checked = selectAll.checked;
      });
    });
  });

  // No preview iframe on this hub - every bulk print form here just
  // submits normally (target="_blank"), opening the print page in its
  // own tab. That page's own print-auto.js opens the OS print dialog as
  // soon as it loads, so clicking Print here is still the only click
  // needed.
})();
