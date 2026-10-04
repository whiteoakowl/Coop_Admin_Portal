// Closes any open Filter dropdown (<details data-filter-details>) on an
// outside click - the same "click anywhere else closes it" affordance
// every other popup in this app already has. Shared by every page with a
// Filter button built from this pattern (the Classes grid's own Filter,
// Parent Portal's class filters, and the Attendance > Class Rosters/
// Playground Check in/out filters).
(function () {
  document.addEventListener('click', function (e) {
    document.querySelectorAll('[data-filter-details][open]').forEach((details) => {
      if (details.contains(e.target)) return;
      details.removeAttribute('open');
    });
  });
})();
