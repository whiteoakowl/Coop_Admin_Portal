// A real request: "Main admin portal and co-op admin portal. Members.
// Add a text icon to click and a pop up appears allowing you type a
// text message, add an image and send text button and close button."
// Each member row has its own dialog (text-dialog-<id>, same pattern
// Co-op's own notes-dialog-<id> already uses) with its own form, so
// there's no checkbox-selection step to build client-side the way
// Floater/Setup's own Send Text popup has - the recipient is always
// just whichever row's icon was clicked. One delegated listener handles
// every row's own form.
(function () {
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('.member-text-notify-form');
    if (!form) return;
    e.preventDefault();

    const dialog = form.closest('dialog');
    const status = form.querySelector('.member-text-notify-status');
    const sendBtn = form.querySelector('button[type="submit"]');
    const url = form.dataset.textNotifyUrl;
    if (status) {
      status.hidden = true;
      status.textContent = '';
      status.classList.remove('alert-error');
    }

    const formData = new FormData(form);
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';

    fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'X-CSRF-Token': window.CSRF_TOKEN || '',
      },
      body: formData,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not send this text.');
        if (data.status !== 'sent') throw new Error(data.detail || 'That text was not sent.');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Text';
        form.reset();
        if (dialog) dialog.close();
      })
      .catch((err) => {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Text';
        if (status) {
          status.textContent = err.message || 'Could not send this text.';
          status.hidden = false;
          status.classList.add('alert-error');
        }
      });
  });
})();
