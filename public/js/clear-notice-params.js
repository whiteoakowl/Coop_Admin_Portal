// A real request: "the notification should go away when the page is
// refreshed" - every page's notice/error banner (<%= notice %>/<%= error
// %> in views/partials's own alert markup) is rendered straight from
// this page's own ?notice=/?error= query string, set by whichever route
// just redirected here after an action. Without this, the banner kept
// reappearing on every reload since the query string itself never went
// away. history.replaceState swaps the address bar to this same URL
// minus just those two params (every other param - day, view, filters,
// ... - stays untouched) right after the page loads, so a REAL refresh
// afterward re-requests that now-clean URL and the banner doesn't come
// back; the one already on screen is untouched until then.
(function () {
  var url = new URL(window.location.href);
  if (!url.searchParams.has('notice') && !url.searchParams.has('error')) return;
  url.searchParams.delete('notice');
  url.searchParams.delete('error');
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
})();
