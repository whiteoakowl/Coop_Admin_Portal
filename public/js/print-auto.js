// Every dedicated print-preview page (reached by clicking a "Print"
// button/link elsewhere in the app, or by loading into the Design/Print
// hub's preview iframe after "Print Selected") should go straight to the
// OS print dialog once it's ready - not force a second click on this
// page's own Print button before anything happens. That button stays in
// the markup for a manual re-print (e.g. after cancelling the dialog)
// without navigating back and re-triggering everything.
(function () {
  window.addEventListener('load', function () {
    window.print();
  });
})();
