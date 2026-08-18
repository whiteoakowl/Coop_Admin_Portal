// Grid/List view toggle for the Class Schedule page's room x hour matrix
// (views/partials/class-schedule-grid.ejs). Markup contract, all scoped
// by a shared data-class-schedule-day="<day>" so Monday/Wednesday never
// cross-wire even though only one tab's worth of markup is ever actually
// on the page at once:
//   <button data-class-schedule-view-btn="grid" data-class-schedule-day="monday" aria-pressed="true">
//   <button data-class-schedule-view-btn="list" data-class-schedule-day="monday" aria-pressed="false">
//   <div data-class-schedule-view="grid" data-class-schedule-day="monday">...room grid table...</div>
//   <div data-class-schedule-view="list" data-class-schedule-day="monday" hidden>...flat list table...</div>
//   <select data-class-schedule-hour-filter="monday"><option value="">All Hours</option>...
//   <tr data-class-schedule-hour="1"> (one per row in the list table)
//
// The hour filter only actually hides/shows anything in List view - Grid
// view already lays every hour out as its own column, so there's nothing
// for a single-hour filter to meaningfully do there (see the toolbar
// markup's own comment on why the control still stays visible regardless).
(function () {
  function panelsFor(day) {
    return document.querySelectorAll('[data-class-schedule-view][data-class-schedule-day="' + day + '"]');
  }
  function buttonsFor(day) {
    return document.querySelectorAll('[data-class-schedule-view-btn][data-class-schedule-day="' + day + '"]');
  }

  function showView(day, view) {
    panelsFor(day).forEach((panel) => {
      panel.hidden = panel.getAttribute('data-class-schedule-view') !== view;
    });
    buttonsFor(day).forEach((btn) => {
      const active = btn.getAttribute('data-class-schedule-view-btn') === view;
      btn.classList.toggle('icon-btn-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function applyHourFilter(day, hourValue) {
    const list = document.querySelector('[data-class-schedule-view="list"][data-class-schedule-day="' + day + '"]');
    if (!list) return;
    list.querySelectorAll('tr[data-class-schedule-hour]').forEach((row) => {
      row.hidden = !!hourValue && row.getAttribute('data-class-schedule-hour') !== hourValue;
    });
  }

  document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-class-schedule-view-btn]');
    if (!btn) return;
    showView(btn.getAttribute('data-class-schedule-day'), btn.getAttribute('data-class-schedule-view-btn'));
  });

  document.addEventListener('change', function (e) {
    const select = e.target.closest('[data-class-schedule-hour-filter]');
    if (!select) return;
    applyHourFilter(select.getAttribute('data-class-schedule-hour-filter'), select.value);
  });
})();
