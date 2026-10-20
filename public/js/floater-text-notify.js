// A real request: "Add a button that says text notification. When you
// click this button a check box appears next to each floater
// assignment. When you click the check boxes then click text
// notifications. It send a notification showing the floater position,
// hour and room number." Click #1 reveals the checkboxes (nothing is
// sent yet); click #2 (the same button, now reading "Send Text
// Notification") collects every checked box and POSTs them in one
// request. Mirrors floater-assign.js's own fetch + CSRF-header pattern
// rather than a plain form, since a checkbox here sits outside every
// row's own per-slot assign/unassign <form> (forms can't nest).
(function () {
  const toggleBtn = document.getElementById('floater-text-notify-btn');
  const container = document.getElementById('floater-cards-container');
  const status = document.getElementById('floater-assign-status');
  const main = document.getElementById('main-content');
  const day = main ? main.dataset.day : '';
  if (!toggleBtn || !container) return;

  let selectMode = false;

  function showMessage(message, isSuccess) {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('alert-error', !isSuccess);
    status.classList.toggle('alert-success', !!isSuccess);
    status.hidden = false;
  }
  function clearMessage() {
    if (!status) return;
    status.hidden = true;
    status.textContent = '';
  }

  function setSelectMode(on) {
    selectMode = on;
    container.classList.toggle('floater-notify-select-mode', on);
    toggleBtn.textContent = on ? 'Send Text Notification' : 'Text Notification';
  }

  toggleBtn.addEventListener('click', () => {
    if (!selectMode) {
      setSelectMode(true);
      clearMessage();
      return;
    }

    const checked = Array.from(container.querySelectorAll('.floater-notify-checkbox:checked'));
    if (checked.length === 0) {
      showMessage('Check at least one floater to text first.');
      return;
    }
    clearMessage();

    const notify = checked.map((cb) => ({
      memberId: cb.dataset.memberId,
      position: cb.dataset.position,
      room: cb.dataset.room,
      hour: cb.dataset.hour,
    }));

    toggleBtn.disabled = true;
    toggleBtn.textContent = 'Sending…';

    fetch(`/admin/volunteers/${day}/floater-text-notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': window.CSRF_TOKEN || '',
      },
      body: JSON.stringify({ notify }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not send text notifications.');
        toggleBtn.disabled = false;
        setSelectMode(false);
        const notSent = (data.results || []).filter((r) => r.status !== 'sent');
        if (notSent.length > 0) {
          showMessage(`Texted ${data.sentCount} of ${data.total}. Not sent: ${notSent.map((r) => `${r.name} (${r.detail || r.status})`).join(', ')}`, false);
        } else {
          showMessage(`Texted ${data.sentCount} floater${data.sentCount === 1 ? '' : 's'}.`, true);
        }
      })
      .catch((err) => {
        toggleBtn.disabled = false;
        toggleBtn.textContent = 'Send Text Notification';
        showMessage(err.message || 'Could not send text notifications.', false);
      });
  });
})();
