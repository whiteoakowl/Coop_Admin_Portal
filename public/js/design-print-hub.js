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
    cardsDuplex: document.getElementById('print-cardsDuplex-section'),
    barcodes: document.getElementById('print-barcodes-section'),
    barcodeLabels: document.getElementById('print-barcodeLabels-section'),
    setupCleanupBadges: document.getElementById('print-setupCleanupBadges-section'),
    customBadges: document.getElementById('print-customBadges-section'),
    schedules: document.getElementById('print-schedules-section'),
    classCheckinQr: document.getElementById('print-classCheckinQr-section'),
    libraryBarcodes: document.getElementById('print-libraryBarcodes-section'),
    logs: document.getElementById('print-logs-section'),
  };

  function apply(value) {
    Object.keys(sections).forEach((key) => {
      if (sections[key]) sections[key].hidden = key !== value;
    });
  }

  typeSelect.addEventListener('change', () => apply(typeSelect.value));
  apply(typeSelect.value);

  // The 6 print flows below all list the exact same active-member set
  // (only the checkbox selections differ per flow) - views/partials/
  // print-picker-table.ejs only renders real rows into the Schedule
  // Cards list (the one visible by default) and leaves the other 5
  // tables' <tbody> empty (skipRows) so the page doesn't ship that same
  // hundreds-of-rows table 6 times over in one response. Clone the real
  // rows into the empty ones here, once, before any of the wiring below
  // runs - each table's <tbody> ends up with its own independent copy of
  // the rows/checkboxes, so everything past this point behaves exactly
  // as if they'd all been server-rendered separately.
  const sourceList = document.getElementById('schedule-print-list');
  if (sourceList) {
    const sourceRows = sourceList.querySelectorAll('tbody tr');
    ['name-tag-bulk-list', 'cards-both-bulk-list', 'cards-duplex-bulk-list', 'barcodes-bulk-list', 'barcode-labels-bulk-list'].forEach((listId) => {
      const target = document.getElementById(listId);
      const tbody = target && target.querySelector('tbody');
      if (!tbody) return;
      sourceRows.forEach((row) => tbody.appendChild(row.cloneNode(true)));
    });
  }

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
      const applyFilter = () => {
        const filter = filterSelect.value;
        bulkList.querySelectorAll('.print-picker-row').forEach((row) => {
          // "Teachers" and "Primary Parents" are their own dataset
          // (data-teacher/data-primary) rather than their own member_type
          // value - a teacher/primary parent is still a parent-type member
          // underneath (utils/members.js's teacherMemberIds and members.
          // is_primary_parent), so each has to layer on top of, not
          // replace, the type filter.
          const matches =
            filter === 'all' ||
            (filter === 'teacher' ? row.dataset.teacher === '1' : filter === 'primaryParent' ? row.dataset.primary === '1' : row.dataset.type === filter);
          row.style.display = matches ? '' : 'none';
        });
      };
      filterSelect.addEventListener('change', applyFilter);
      // A real request: "we usually only need to print primary parent" -
      // the Name Tags filter now defaults to Primary Parents Only (see
      // admin-design.ejs), so the list has to start out already filtered
      // to match what the select visibly shows, not wait for a 'change'
      // event that a page load never fires on its own.
      applyFilter();
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
  wireBulkMemberList('cards-duplex-bulk-list', 'cards-duplex-bulk-filter-select', 'cards-duplex-select-all-checkbox', 'cards-duplex-select-none-checkbox');
  wireBulkMemberList('barcodes-bulk-list', 'barcodes-bulk-filter-select', 'barcodes-select-all-checkbox', 'barcodes-select-none-checkbox');
  wireBulkMemberList('barcode-labels-bulk-list', 'barcode-labels-bulk-filter-select', 'barcode-labels-select-all-checkbox', 'barcode-labels-select-none-checkbox');

  // Class Check-In QR Codes picker: select-all/select-none plus a Day/Hour
  // filter popup, all over .qr-picker-row (classes, not members - a
  // separate class from wireBulkMemberList's own .print-picker-row so it
  // never gets swept up by that function's clone-from-schedule-list step
  // above, which only ever targets the member lists by id).
  const qrList = document.getElementById('classcheckin-qr-list');
  if (qrList) {
    const qrSelectAll = document.getElementById('classcheckin-qr-select-all-checkbox');
    if (qrSelectAll) {
      qrSelectAll.addEventListener('change', () => {
        qrList.querySelectorAll('.qr-picker-row').forEach((row) => {
          if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = qrSelectAll.checked;
        });
      });
    }
    const qrSelectNone = document.getElementById('classcheckin-qr-select-none-checkbox');
    if (qrSelectNone) {
      qrSelectNone.addEventListener('change', () => {
        if (qrSelectNone.checked) {
          qrList.querySelectorAll('.qr-picker-row').forEach((row) => {
            if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = false;
          });
          if (qrSelectAll) qrSelectAll.checked = false;
          qrSelectNone.checked = false;
        }
      });
    }

    // Filter button -> Day/Room popup -> Save narrows the list to that one
    // day+room combination (both left on "All ..." shows every class again).
    const qrFilterBtn = document.getElementById('classcheckin-qr-filter-btn');
    const qrFilterDialog = document.getElementById('classcheckin-qr-filter-dialog');
    const qrFilterDaySelect = document.getElementById('classcheckin-qr-filter-day-select');
    const qrFilterRoomSelect = document.getElementById('classcheckin-qr-filter-room-select');
    const qrFilterSaveBtn = document.getElementById('classcheckin-qr-filter-save-btn');
    if (qrFilterBtn && qrFilterDialog) {
      qrFilterBtn.addEventListener('click', () => qrFilterDialog.showModal());
    }
    if (qrFilterSaveBtn && qrFilterDialog) {
      qrFilterSaveBtn.addEventListener('click', () => {
        const day = qrFilterDaySelect ? qrFilterDaySelect.value : '';
        const room = qrFilterRoomSelect ? qrFilterRoomSelect.value : '';
        qrList.querySelectorAll('.qr-picker-row').forEach((row) => {
          const matches = (!day || row.dataset.day === day) && (!room || row.dataset.room === room);
          row.style.display = matches ? '' : 'none';
        });
        qrFilterDialog.close();
      });
    }
  }

  // Library Barcodes picker: category filter + select-all/select-none over
  // .library-picker-row (library items, not members - its own class for
  // the same reason .qr-picker-row above is its own class, so it's never
  // swept up by wireBulkMemberList's member-list clone step).
  const libraryList = document.getElementById('library-barcodes-list');
  if (libraryList) {
    const libraryFilterSelect = document.getElementById('library-barcodes-filter-select');
    if (libraryFilterSelect) {
      libraryFilterSelect.addEventListener('change', () => {
        const filter = libraryFilterSelect.value;
        libraryList.querySelectorAll('.library-picker-row').forEach((row) => {
          row.style.display = filter === 'all' || row.dataset.type === filter ? '' : 'none';
        });
      });
    }
    const librarySelectAll = document.getElementById('library-barcodes-select-all-checkbox');
    if (librarySelectAll) {
      librarySelectAll.addEventListener('change', () => {
        libraryList.querySelectorAll('.library-picker-row').forEach((row) => {
          if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = librarySelectAll.checked;
        });
      });
    }
    const librarySelectNone = document.getElementById('library-barcodes-select-none-checkbox');
    if (librarySelectNone) {
      librarySelectNone.addEventListener('change', () => {
        if (librarySelectNone.checked) {
          libraryList.querySelectorAll('.library-picker-row').forEach((row) => {
            if (row.style.display !== 'none') row.querySelector('input[type="checkbox"]').checked = false;
          });
          if (librarySelectAll) librarySelectAll.checked = false;
          librarySelectNone.checked = false;
        }
      });
    }
  }

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

  // A big enough "Select All" (a co-op's full membership - potentially
  // several hundred to 1000+ people) can generate more badge HTML than
  // Netlify's serverless functions are allowed to return in one response
  // (~6MB - Function.ResponseSizeTooLarge), which crashes the whole print
  // request with no page at all. None of these forms need the entire
  // selection answered by one giant response just because they submit as
  // one click: past MAX_PRINT_CHUNK, fetch the print page in same-size
  // batches instead (so no single response can ever cross the cap
  // regardless of how large the co-op's membership grows) and merge every
  // batch's printable content into ONE already-open tab - a single
  // combined print job, not one tab per batch (which stops scaling well
  // once there are more than a couple of batches, and risks browsers'
  // own per-click popup ceilings). A selection at or under the limit
  // still submits the normal, single way with no client-side involvement
  // here at all.
  const MAX_PRINT_CHUNK = 100;

  function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  async function fetchChunkDocument(action, memberIds) {
    const body = new URLSearchParams();
    memberIds.forEach((id) => body.append('memberIds', id));
    const res = await fetch(action, {
      method: 'POST',
      body,
      headers: { 'X-CSRF-Token': window.CSRF_TOKEN || '' },
    });
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  // Every one of these print pages shares the same shape: a
  // #main-content with a .no-print header (title/Print button) followed
  // by one or more top-level "page" elements holding the actual printable
  // content (a repeating .badge-sheet-page per 8/12/30-per-sheet grid, or
  // a single flowing container for the Name Tags + Schedule Cards pair
  // layout). Always appending each batch's page elements as new top-level
  // siblings - rather than trying to detect and merge into an existing
  // matching container - keeps this one merge routine correct for both
  // shapes: a repeating sheet template ends up with more (still correctly
  // fixed-capacity) sheet pages, and the single-flowing-container
  // template ends up with more than one of that same container back to
  // back, which prints identically to one continuous one.
  async function printInChunks(form) {
    const checkedIds = Array.from(form.querySelectorAll('input[name="memberIds"]:checked')).map((cb) => cb.value);
    const win = window.open('', '_blank');
    if (!win) return; // Popup blocked - nothing more to do client-side; reducing the selection below MAX_PRINT_CHUNK still works the normal way.
    win.document.write('<!doctype html><title>Preparing print job&hellip;</title><body style="font: 16px sans-serif; padding: 2rem;">Preparing your print job&hellip; this tab will fill in automatically once ready.</body>');
    win.document.close();

    const batches = chunkArray(checkedIds, MAX_PRINT_CHUNK);
    let targetMain = null;
    for (let i = 0; i < batches.length; i++) {
      const doc = await fetchChunkDocument(form.action, batches[i]);
      if (i === 0) {
        // The first batch becomes the tab's real document as-is - full
        // head/nav/scripts intact - so every later batch just adds more
        // printable content into its already-correct #main-content.
        // document.write of a document this size (the full nav/head/
        // page shell) doesn't finish parsing synchronously - querying
        // the DOM immediately after write()/close() can run before the
        // parser has reached #main-content at all, so wait for the
        // popup's own 'load' to actually fire first.
        win.document.open();
        win.document.write('<!doctype html>' + doc.documentElement.outerHTML);
        win.document.close();
        if (win.document.readyState !== 'complete') {
          await new Promise((resolve) => win.addEventListener('load', resolve, { once: true }));
        }
        targetMain = win.document.getElementById('main-content');
        continue;
      }
      try {
        const sourceMain = doc.getElementById('main-content');
        if (!sourceMain || !targetMain) continue;
        Array.from(sourceMain.children).forEach((child) => {
          if (child.classList.contains('no-print')) return; // the header/Print button - only the first batch's copy is kept.
          targetMain.appendChild(win.document.importNode(child, true));
        });
        // Re-render whatever the newly-appended content needs (barcodes,
        // shrink-to-fit label names) - both are idempotent on content
        // that's already rendered, so re-running them over the whole tab
        // on every batch is simpler, and just as safe, as tracking exactly
        // what's new each time.
        if (typeof win.renderNameTagBarcodes === 'function') win.renderNameTagBarcodes(win.document);
        win.dispatchEvent(new win.Event('beforeprint'));
      } catch (err) {
        // One bad batch shouldn't take down the rest of an otherwise-fine
        // print job - the remaining batches still get appended.
        console.error('Bulk print: failed to merge one batch into the print tab', err);
      }
    }
  }

  function wireChunkedSubmit(formId) {
    const form = document.getElementById(formId);
    if (!form) return;
    form.addEventListener('submit', (e) => {
      const checkedCount = form.querySelectorAll('input[name="memberIds"]:checked').length;
      if (checkedCount <= MAX_PRINT_CHUNK) return;
      e.preventDefault();
      printInChunks(form);
    });
  }

  ['schedule-print-form', 'bulk-print-form', 'cards-both-print-form', 'cards-duplex-print-form', 'barcodes-print-form', 'barcode-labels-print-form'].forEach(wireChunkedSubmit);

  // No preview iframe on this hub - every bulk print form here just
  // submits normally (target="_blank"), opening the print page in its
  // own tab (or, past MAX_PRINT_CHUNK, a tab assembled from several
  // smaller requests - see printInChunks above). That page's own
  // print-auto.js opens the OS print dialog as soon as it loads, so
  // clicking Print here is still the
  // only click needed.
})();
