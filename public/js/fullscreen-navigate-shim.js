// A real bug report: "dropdown search on member page... should
// automatically show that member. Currently nothing is happening." -
// and the same silent-no-op affected every other admin page's own
// Filter/date-picker <select onchange="window.fullscreenNavigate(...)">
// (admin-design, admin-library, admin-logs, admin-members, admin-name-
// tag, admin-rosters, admin-setup-assignments, admin-volunteers, main-
// admin-members, main-admin-name-tags - all copied from the same
// dropdown pattern, none of them kiosk pages). window.fullscreenNavigate
// is public/js/fullscreen-nav.js's own kiosk-only helper (it swaps page
// content in place so a kiosk terminal's fullscreen mode survives
// navigating) - that script is
// never loaded on these admin pages, which never need fullscreen
// preserved in the first place, so calling it just threw "not a
// function" and the dropdown did nothing.
//
// Loaded from partials/admin-nav.ejs and partials/portal-nav.ejs (every
// admin/portal page), guarded so it never overrides the real
// implementation on an actual kiosk page where fullscreen-nav.js is also
// loaded - this is only ever the fallback for a page that has none.
(function () {
  if (!window.fullscreenNavigate) {
    window.fullscreenNavigate = function (url) {
      window.location.href = url;
    };
  }
})();
