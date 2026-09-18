// A real request: "mobile view instead of tabs on all the pages. when
// you click the tab below a menu will pop up showing the different page
// choices." Each converted page keeps its own existing .view-tab links
// (the exact same ones admin-nav-accordion.js's sidebar subpages read
// their labels/hrefs from) unchanged, just moved inside a <dialog
// class="page-tabs-dialog"> instead of an inline strip - this only wires
// up the visible trigger button that opens it and copies the currently-
// active tab's own label onto that button, so there's nothing per-page
// to keep in sync by hand.
(function () {
  // This script loads from views/partials/portal-nav.ejs, which is
  // included near the TOP of <body> - well before the <main> content
  // (and this dialog/trigger pair inside it) further down the same
  // document has even been parsed yet. A plain immediate run would find
  // zero .page-tabs-dialog elements and silently wire up nothing (same
  // reasoning as public/js/roster-btn-row-grid.js's own 'load' listener,
  // whose target markup has this same problem).
  function wire() {
    document.querySelectorAll('.page-tabs-dialog').forEach((dialog) => {
      const trigger = dialog.previousElementSibling;
      if (!trigger || !trigger.classList.contains('page-tabs-trigger')) return;
      const activeTab = dialog.querySelector('.view-tab.active');
      const label = trigger.querySelector('.page-tabs-trigger-label');
      if (activeTab && label) label.textContent = activeTab.textContent.trim();
      trigger.addEventListener('click', () => dialog.showModal());
    });
  }
  window.addEventListener('load', wire);
})();
