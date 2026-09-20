// A real request: "add button that says copy link. When you click it
// will say copied and you will have copied the member link... to paste
// somewhere else to share" - one shared, event-delegated handler for any
// `[data-copy-link]` button anywhere in the app, rather than a one-off
// script per page.
(function () {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy-link]');
    if (!btn) return;
    const link = btn.dataset.copyLink;
    navigator.clipboard.writeText(link).then(() => {
      const original = btn.dataset.copyLinkLabel || btn.textContent;
      btn.dataset.copyLinkLabel = original;
      btn.textContent = 'Copied!';
      clearTimeout(btn.__copyLinkTimer);
      btn.__copyLinkTimer = setTimeout(() => {
        btn.textContent = original;
      }, 2000);
    });
  });
})();
