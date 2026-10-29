// A real request: "Add a button that says text notification. When you
// click this button a check box appears next to each floater
// assignment. click the check boxes on each assignment or the whole
// card then click send text notification button. A pop up appears
// showing an example of the text message that you can edit and add an
// optional image. Buttons send now or cancel."
//
// A later real request removed that page-level button entirely: "Not
// [the] orange send text button at the top of floater assignment page.
// Just the send text buttons on each hour title bar. Select all
// assigned floaters by clicking the check box on the title bars or
// select individual rows to send notifications to that hour then
// click send text." Every checkbox is now always visible (no more
// entering a "select mode" first); each hour card has its own Send
// Text button that sends to whichever boxes - the card's own Select
// All, individual rows, or both - are currently checked in that one
// card, and starts out disabled until at least one is checked. Mirrors
// floater-assign.js's own fetch + CSRF-header pattern rather than a
// plain form, since a checkbox here sits outside every row's own
// per-slot assign/unassign <form> (forms can't nest), and the image
// upload + async per-recipient status report both need a real response
// to react to.
(function () {
  const container = document.getElementById('floater-cards-container');
  const status = document.getElementById('floater-assign-status');
  const main = document.getElementById('main-content');
  const day = main ? main.dataset.day : '';
  const dialog = document.getElementById('floater-text-notify-dialog');
  const form = document.getElementById('floater-text-notify-form');
  const messageLabel = document.getElementById('floater-text-notify-message-label');
  const messageField = document.getElementById('floater-text-notify-message');
  const multiHint = document.getElementById('floater-text-notify-multi-hint');
  const recipientsHint = document.getElementById('floater-text-notify-recipients-hint');
  const sendBtn = document.getElementById('floater-text-notify-send-btn');
  if (!container || !dialog || !form) return;

  // Admin-editable (Settings > Text/Email Notifications > Floater
  // Assignments) via utils/notificationTemplates.js's own
  // notification_message_templates row 'floater_assignment_default' -
  // dialog.dataset.messageTemplate is that row's raw {{placeholder}}
  // text, server-rendered into this page. Falls back to the original
  // hardcoded line only if that row is somehow missing entirely (should
  // never happen - the migration always seeds it).
  function fillMessageTemplate(data) {
    const template = dialog.dataset.messageTemplate;
    if (!template) return `You're assigned: ${data.position}${data.hour ? ` at ${data.hour}` : ''}${data.room ? ` in Room ${data.room}` : ''}.`;
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (data[key] != null ? data[key] : ''));
  }

  let pendingNotify = [];

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

  // A real request: "Should not be able to click on send text button
  // on the page if not check boxes are selected" - now scoped to each
  // hour's own button, disabled until that same card has at least one
  // checked box.
  function updateCardSendBtn(card) {
    const sendTextBtn = card.querySelector('.floater-card-send-text-btn');
    if (!sendTextBtn) return;
    sendTextBtn.disabled = !card.querySelector('.floater-notify-checkbox:checked');
  }

  container.querySelectorAll('.floater-card').forEach(updateCardSendBtn);

  // "Click the check boxes on each assignment or the whole card" - a
  // card's own Select All checkbox checks/unchecks every assignment
  // checkbox inside that SAME card only, never another hour's, and
  // either one updates that card's own Send Text button.
  container.addEventListener('change', (e) => {
    const card = e.target.closest('.floater-card');
    if (!card) return;
    if (e.target.classList.contains('floater-card-select-all-checkbox')) {
      card.querySelectorAll('.floater-notify-checkbox').forEach((cb) => { cb.checked = e.target.checked; });
    }
    if (e.target.classList.contains('floater-card-select-all-checkbox') || e.target.classList.contains('floater-notify-checkbox')) {
      updateCardSendBtn(card);
    }
  });

  // "Send text button on hour title bar... when you click send text on
  // title bar it will create a pop up" - sends to whichever of this
  // one card's own checkboxes are currently checked. A later real
  // request: "if sending a text to everyone assigned that hour it
  // should not allow you to customize the message and it should send
  // each member their own unique assigned assignment" - only a single
  // recipient still gets the editable textarea (pre-filled, same as
  // before); 2+ recipients hide it entirely in favor of the read-only
  // hint, and each one's own position/room/hour rides along on
  // pendingNotify so the server can build each of their own messages
  // (routes/admin-volunteers.js) rather than sending one shared string.
  container.addEventListener('click', (e) => {
    const sendTextBtn = e.target.closest('.floater-card-send-text-btn');
    if (!sendTextBtn || sendTextBtn.disabled) return;
    const card = sendTextBtn.closest('.floater-card');
    if (!card) return;
    const checked = Array.from(card.querySelectorAll('.floater-notify-checkbox:checked'));
    if (checked.length === 0) return;
    clearMessage();

    pendingNotify = checked.map((cb) => ({ memberId: cb.dataset.memberId, position: cb.dataset.position, room: cb.dataset.room, hour: cb.dataset.hour }));
    const isSingle = checked.length === 1;
    messageLabel.hidden = !isSingle;
    multiHint.hidden = isSingle;
    if (isSingle) {
      messageField.value = fillMessageTemplate(checked[0].dataset);
    } else {
      messageField.value = '';
    }
    // Setting .value directly doesn't fire 'input' on its own -
    // public/js/sms-char-counter.js's own delegated listener needs this
    // so the "N / 160 characters" counter reflects a template-filled
    // message right away, not just once the admin starts typing.
    messageField.dispatchEvent(new Event('input', { bubbles: true }));
    recipientsHint.textContent = `Sending to ${checked.length} floater${checked.length === 1 ? '' : 's'}.`;
    const fileInput = form.querySelector('input[type="file"]');
    if (fileInput) fileInput.value = '';
    dialog.showModal();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (pendingNotify.length === 0) return;
    const isSingle = pendingNotify.length === 1;
    const message = messageField.value.trim();
    if (isSingle && !message) {
      messageField.focus();
      return;
    }

    const fileInput = form.querySelector('input[type="file"]');
    const formData = new FormData();
    formData.append('notify', JSON.stringify(pendingNotify));
    if (isSingle) formData.append('message', message);
    if (fileInput && fileInput.files[0]) formData.append('image', fileInput.files[0]);

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';

    fetch(`/admin/volunteers/${day}/floater-text-notify`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'X-CSRF-Token': window.CSRF_TOKEN || '',
      },
      body: formData,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not send text notifications.');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Now';
        dialog.close();
        pendingNotify = [];
        container.querySelectorAll('.floater-card-select-all-checkbox').forEach((cb) => { cb.checked = false; });
        container.querySelectorAll('.floater-notify-checkbox').forEach((cb) => { cb.checked = false; });
        container.querySelectorAll('.floater-card').forEach(updateCardSendBtn);
        const notSent = (data.results || []).filter((r) => r.status !== 'sent');
        if (notSent.length > 0) {
          showMessage(`Texted ${data.sentCount} of ${data.total}. Not sent: ${notSent.map((r) => `${r.name} (${r.detail || r.status})`).join(', ')}`, false);
        } else {
          showMessage(`Texted ${data.sentCount} floater${data.sentCount === 1 ? '' : 's'}.`, true);
        }
      })
      .catch((err) => {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Now';
        showMessage(err.message || 'Could not send text notifications.', false);
      });
  });
})();
