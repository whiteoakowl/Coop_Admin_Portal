// Every dedicated print-preview page (reached by clicking a "Print"
// button/link elsewhere in the app, or by loading into the Design/Print
// hub's preview iframe after "Print Selected") used to jump straight to
// the OS print dialog as soon as it loaded. That skipped the whole point
// of a preview page - the print dialog (and, once dismissed, the browser
// window behind it) covered the preview before there was any real chance
// to look it over. This file is intentionally a no-op now: the page just
// renders and waits for the visible Print button (already in every
// preview page's markup) to be clicked.
