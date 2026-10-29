// A real request: "Add the same exact check box and button system on
// floater assignments, on each setup cleanup team and position." Mirrors
// public/js/floater-text-notify.js exactly - see that file's own header
// comment for the full history/reasoning (every checkbox always visible,
// no page-level toggle; a card's own Select All only checks that one
// card's own boxes; Send Text sends to whichever boxes - individual
// rows, Select All, or both - are currently checked in that one card).
// Only the ids/fields differ: a Setup/Cleanup team card's own members
// carry team/tasks instead of Floater's position/room/hour.
(function () {
  const container = document.getElementById('setup-assignment-cards-container');
  const status = document.getElementById('setup-assign-status');
  const main = document.getElementById('main-content');
  const day = main ? main.dataset.day : '';
  const dialog = document.getElementById('setup-text-notify-dialog');
  const form = document.getElementById('setup-text-notify-form');
  const messageLabel = document.getElementById('setup-text-notify-message-label');
  const messageField = document.getElementById('setup-text-notify-message');
  const multiHint = document.getElementById('setup-text-notify-multi-hint');
  const recipientsHint = document.getElementById('setup-text-notify-recipients-hint');
  const sendBtn = document.getElementById('setup-text-notify-send-btn');
  if (!container || !dialog || !form) return;

  // Admin-editable (Settings > Text/Email Notifications > Setup/Cleanup
  // Assignments) via utils/notificationTemplates.js's own
  // notification_message_templates row 'setup_cleanup_assignment_default' -
  // dialog.dataset.messageTemplate is that row's raw {{placeholder}}
  // text, server-rendered into this page. Falls back to the original
  // hardcoded line only if that row is somehow missing entirely (should
  // never happen - the migration always seeds it).
  function fillMessageTemplate(data) {
    const template = dialog.dataset.messageTemplate;
    if (!template) return `You're assigned to ${data.team}: ${data.tasks}.`;
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

  // A real request: "Should not be able to click on send text button on
  // the page if not check boxes are selected" - same per-card scoping
  // Floater Assignments' own Send Text button uses.
  function updateCardSendBtn(card) {
    const sendTextBtn = card.querySelector('.floater-card-send-text-btn');
    if (!sendTextBtn) return;
    sendTextBtn.disabled = !card.querySelector('.floater-notify-checkbox:checked');
  }

  container.querySelectorAll('.floater-card').forEach(updateCardSendBtn);

  // A team's own Select All checkbox checks/unchecks every member
  // checkbox inside that SAME card only, never another team's, and
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

  // Sends to whichever of this one card's own checkboxes are currently
  // checked. A single recipient still gets the editable textarea
  // (pre-filled, same as before); 2+ recipients hide it entirely in
  // favor of the read-only hint, and each one's own team/tasks rides
  // along on pendingNotify so the server can build each of their own
  // messages (routes/admin-setup.js) rather than sending one shared
  // string.
  container.addEventListener('click', (e) => {
    const sendTextBtn = e.target.closest('.floater-card-send-text-btn');
    if (!sendTextBtn || sendTextBtn.disabled) return;
    const card = sendTextBtn.closest('.floater-card');
    if (!card) return;
    const checked = Array.from(card.querySelectorAll('.floater-notify-checkbox:checked'));
    if (checked.length === 0) return;
    clearMessage();

    pendingNotify = checked.map((cb) => ({ memberId: cb.dataset.memberId, team: cb.dataset.team, tasks: cb.dataset.tasks }));
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
    recipientsHint.textContent = `Sending to ${checked.length} member${checked.length === 1 ? '' : 's'}.`;
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

    fetch(`/admin/setup/${day}/assignments/setup-text-notify`, {
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
          showMessage(`Texted ${data.sentCount} member${data.sentCount === 1 ? '' : 's'}.`, true);
        }
      })
      .catch((err) => {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Now';
        showMessage(err.message || 'Could not send text notifications.', false);
      });
  });
})();
