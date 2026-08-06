// Sitewide "floater position needs approval" popup - polled once per
// admin page load (this script is included from partials/admin-nav.ejs,
// which is on every admin page). Only pops up when today's pending count
// is higher than what's already been dismissed this browser session, so
// it doesn't nag on every click through the portal.
(function () {
  const dialog = document.getElementById('pending-approvals-dialog');
  if (!dialog) return;

  const STORAGE_KEY = 'shPendingApprovalsAckCount';

  fetch('/admin/pending-approvals.json')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || !data.count) return;
      const ackCount = parseInt(sessionStorage.getItem(STORAGE_KEY) || '0', 10);
      if (data.count <= ackCount) return;

      const summary = document.getElementById('pending-approvals-summary');
      const list = document.getElementById('pending-approvals-list');
      summary.textContent =
        data.count + ' floater position' + (data.count === 1 ? '' : 's') + (data.count === 1 ? ' needs' : ' need') + ' approval today.';
      list.innerHTML = '';
      data.items.forEach((item) => {
        const li = document.createElement('li');
        const link = document.createElement('a');
        link.href = '/admin/volunteers/' + item.day + '/substitutes?date=' + item.date;
        link.textContent = item.dayLabel + ' · ' + item.hourLabel + ' · ' + item.slotLabel + ' → ' + item.memberName;
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

      const dismissBtn = document.getElementById('pending-approvals-dismiss');
      if (dismissBtn) dismissBtn.addEventListener('click', () => dialog.close(), { once: true });

      dialog.showModal();
    })
    .catch(() => {});
})();
