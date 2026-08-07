// Sitewide alert popup - polled once per admin page load (this script is
// included from partials/admin-nav.ejs, which is on every admin page).
// Backed by the same list that renders as the Home dashboard's Alert Log
// (utils/alerts.js via GET /admin/alerts.json), so a popup here always has
// a matching row there. Only pops up when today's alert count is higher
// than what's already been dismissed this browser session, so it doesn't
// nag on every click through the portal.
(function () {
  const dialog = document.getElementById('admin-alerts-dialog');
  if (!dialog) return;

  const STORAGE_KEY = 'shAlertAckCount';

  fetch('/admin/alerts.json')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || !data.count) return;
      const ackCount = parseInt(sessionStorage.getItem(STORAGE_KEY) || '0', 10);
      if (data.count <= ackCount) return;

      const summary = document.getElementById('admin-alerts-summary');
      const list = document.getElementById('admin-alerts-list');
      summary.textContent = data.count + ' alert' + (data.count === 1 ? '' : 's') + ' need' + (data.count === 1 ? 's' : '') + ' your attention today.';
      list.innerHTML = '';
      data.items.forEach((item) => {
        const li = document.createElement('li');
        const link = document.createElement('a');
        link.href = item.link;
        link.textContent = item.dayLabel + ' · ' + item.message;
        li.appendChild(link);
        list.appendChild(li);
      });

      dialog.addEventListener(
        'close',
        () => {
          sessionStorage.setItem(STORAGE_KEY, String(data.count));
        },
        { once: true }
      );

      const dismissBtn = document.getElementById('admin-alerts-dismiss');
      if (dismissBtn) dismissBtn.addEventListener('click', () => dialog.close(), { once: true });

      dialog.showModal();
    })
    .catch(() => {});
})();
