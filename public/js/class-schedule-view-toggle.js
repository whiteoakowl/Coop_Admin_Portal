// Grid/List view toggle for the Class Schedule page's room x hour matrix
// (views/partials/class-schedule-grid.ejs). Markup contract, scoped by a
// shared data-class-schedule-day="<day>" so Monday/Wednesday never
// cross-wire even though only one tab's worth of markup is ever actually
// on the page at once:
//   <button data-class-schedule-view-btn="grid" data-class-schedule-day="monday" aria-pressed="true">
//   <button data-class-schedule-view-btn="list" data-class-schedule-day="monday" aria-pressed="false">
//   <div data-class-schedule-view="grid" data-class-schedule-day="monday">...room grid table...</div>
//   <div data-class-schedule-view="list" data-class-schedule-day="monday" hidden>...flat list table...</div>
//
// The Hour/Grade Level/Full filters themselves live in public/js/
// class-schedule-filters.js, not here - this file only owns which of the
// two views is currently showing.
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

  document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-class-schedule-view-btn]');
    if (!btn) return;
    showView(btn.getAttribute('data-class-schedule-day'), btn.getAttribute('data-class-schedule-view-btn'));
  });
})();
