// Generic List/Grid view toggle - a real request: "class schedules should
// be viewable in list and grid form like co-op admin portal" on the
// Parent Portal's own Classes page (views/parent-classes.ejs). Simpler
// than public/js/class-schedule-view-toggle.js's own day-scoped room x
// hour matrix (that one's markup contract is specific to the Co-op Admin
// Portal's own room-grid editor, not a fit for a flat list of classes to
// browse/register for) - this one is a single list/grid pair, no day
// scoping, reusable anywhere else a page just needs "show this same data
// two ways":
//   <button data-view-btn="list" aria-pressed="true">
//   <button data-view-btn="grid" aria-pressed="false">
//   <div data-view-panel="list">...</div>
//   <div data-view-panel="grid" hidden>...</div>
(function () {
  function showView(view) {
    document.querySelectorAll('[data-view-panel]').forEach((panel) => {
      panel.hidden = panel.getAttribute('data-view-panel') !== view;
    });
    document.querySelectorAll('[data-view-btn]').forEach((btn) => {
      const active = btn.getAttribute('data-view-btn') === view;
      btn.classList.toggle('icon-btn-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-view-btn]');
    if (!btn) return;
    showView(btn.getAttribute('data-view-btn'));
  });
})();
