// Grade Level/Full/Hour filtering for the Class Schedule page's "Filter"
// dropdown button (views/partials/class-schedule-grid.ejs) - a real
// request: "Class page filter drop down. Filter button, grade level,
// hour, day, full." All three combine (AND, not OR) - a class only stays
// visible when it matches every filter currently set. Grade Level and
// Full apply to BOTH Grid and List views (each class card/row carries its
// own data-class-grade-list/data-class-full); Hour only really does
// anything in List view, same as before this file existed - Grid view
// already lays every hour out as its own column, so there's nothing for
// a single-hour filter to meaningfully do there.
//
// Markup contract:
//   <details data-filter-details><summary>Filter</summary><div class="filter-panel">...</div></details>
//   <select data-class-schedule-hour-filter="monday">, data-class-schedule-grade-filter="monday">, data-class-schedule-full-filter="monday">
//   <div class="class-card" data-class-grade-list="1st,2nd" data-class-full="0"> (Grid view, inside a <td>)
//   <tr data-class-schedule-hour="1" data-class-grade-list="1st,2nd" data-class-full="0"> (List view)
(function () {
  function matchesGrade(el, gradeValue) {
    if (!gradeValue) return true;
    const list = (el.getAttribute('data-class-grade-list') || '').split(',').filter(Boolean);
    return list.includes(gradeValue);
  }

  function matchesFull(el, fullValue) {
    if (!fullValue) return true;
    const isFull = el.getAttribute('data-class-full') === '1';
    return fullValue === 'full' ? isFull : !isFull;
  }

  // A real request: "add semester choice dropdown settings to... all
  // classes." 'none' (the "No Semester" option) matches a class whose own
  // data-class-semester-id is also 'none' (see the EJS: semester_id == null
  // is rendered as the literal string "none", same sentinel the select's
  // own option value uses).
  function matchesSemester(el, semesterValue) {
    if (!semesterValue) return true;
    return el.getAttribute('data-class-semester-id') === semesterValue;
  }

  function selectValue(day, attr) {
    const select = document.querySelector('[' + attr + '="' + day + '"]');
    return select ? select.value : '';
  }

  function applyFilters(day) {
    const gradeValue = selectValue(day, 'data-class-schedule-grade-filter');
    const fullValue = selectValue(day, 'data-class-schedule-full-filter');
    const hourValue = selectValue(day, 'data-class-schedule-hour-filter');
    const semesterValue = selectValue(day, 'data-class-schedule-semester-filter');

    const gridPanel = document.querySelector('[data-class-schedule-view="grid"][data-class-schedule-day="' + day + '"]');
    if (gridPanel) {
      gridPanel.querySelectorAll('[data-class-grade-list]').forEach((card) => {
        card.style.display = matchesGrade(card, gradeValue) && matchesFull(card, fullValue) && matchesSemester(card, semesterValue) ? '' : 'none';
      });
    }

    const listPanel = document.querySelector('[data-class-schedule-view="list"][data-class-schedule-day="' + day + '"]');
    if (listPanel) {
      listPanel.querySelectorAll('tr[data-class-schedule-hour]').forEach((row) => {
        const hourOk = !hourValue || row.getAttribute('data-class-schedule-hour') === hourValue;
        row.hidden = !(hourOk && matchesGrade(row, gradeValue) && matchesFull(row, fullValue) && matchesSemester(row, semesterValue));
      });
    }
  }

  document.addEventListener('change', function (e) {
    const select = e.target.closest('[data-class-schedule-hour-filter], [data-class-schedule-grade-filter], [data-class-schedule-full-filter], [data-class-schedule-semester-filter]');
    if (!select) return;
    const day = select.getAttribute('data-class-schedule-hour-filter') || select.getAttribute('data-class-schedule-grade-filter') || select.getAttribute('data-class-schedule-full-filter') || select.getAttribute('data-class-schedule-semester-filter');
    applyFilters(day);
  });

  // A real request: "I need to be able to switch between semester views
  // on... classes." The new Semester/Day combo picker (routes/admin-
  // schedule.js, views/admin-schedule.ejs) navigates here with
  // ?semesterId= already set, which the Semester filter's own <select>
  // (views/partials/class-schedule-grid.ejs) pre-selects server-side -
  // this filter has only ever RUN on its own change event though, so
  // without this, the dropdown would show the right semester selected
  // but every class would still be visible until the admin touched some
  // other filter first. Runs once for whichever day's filter panel is
  // actually on the page.
  document.querySelectorAll('[data-class-schedule-semester-filter]').forEach((select) => {
    applyFilters(select.getAttribute('data-class-schedule-semester-filter'));
  });

  // Close the Filter dropdown on an outside click, same "click anywhere
  // else closes it" affordance every other popup in this app already has.
  document.addEventListener('click', function (e) {
    document.querySelectorAll('[data-filter-details][open]').forEach((details) => {
      if (details.contains(e.target)) return;
      details.removeAttribute('open');
    });
  });
})();
