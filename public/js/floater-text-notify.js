// A real request: "Add a button that says text notification. When you
// click this button a check box appears next to each floater
// assignment. click the check boxes on each assignment or the whole
// card then click send text notification button. A pop up appears
// showing an example of the text message that you can edit and add an
// optional image. Buttons send now or cancel." Click #1 reveals the
// checkboxes (nothing is sent yet); click #2 (the same button, now
// reading "Send Text Notification") opens an editable popup pre-filled
// from whichever boxes are checked instead of sending immediately -
// Send Now in that popup is what actually fires the request. Mirrors
// floater-assign.js's own fetch + CSRF-header pattern rather than a
// plain form, since a checkbox here sits outside every row's own
// per-slot assign/unassign <form> (forms can't nest), and the image
// upload + async per-recipient status report both need a real response
// to react to.
//
// Two later real requests: (1) "Should not be able to click on send
// text button on the page if no check boxes are selected" - click #2
// above is now disabled rather than clickable-with-a-warning whenever
// nothing is checked. (2) "Add a check box to the hour title bar of
// each hour card... Send text button on hour title bar, shrink to fit,
// when you click send text on title bar it will create a pop up" - a
// per-card shortcut button, always available, straight to the same
// popup for every assigned position in that one card.
(function () {
  const toggleBtn = document.getElementById('floater-text-notify-btn');
  const container = document.getElementById('floater-cards-container');
  const status = document.getElementById('floater-assign-status');
  const main = document.getElementById('main-content');
  const day = main ? main.dataset.day : '';
  const dialog = document.getElementById('floater-text-notify-dialog');
  const form = document.getElementById('floater-text-notify-form');
  const messageField = document.getElementById('floater-text-notify-message');
  const recipientsHint = document.getElementById('floater-text-notify-recipients-hint');
  const sendBtn = document.getElementById('floater-text-notify-send-btn');
  if (!toggleBtn || !container || !dialog || !form) return;

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

  let selectMode = false;
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
  // on the page if no check boxes are selected." Only applies once
  // select mode is on (the button's first click, entering select mode,
  // never needs anything checked yet) - disabled rather than a popup
  // telling the admin to go check something first.
  function updateToggleBtnDisabled() {
    if (!selectMode) {
      toggleBtn.disabled = false;
      return;
    }
    toggleBtn.disabled = !container.querySelector('.floater-notify-checkbox:checked');
  }

  function setSelectMode(on) {
    selectMode = on;
    container.classList.toggle('floater-notify-select-mode', on);
    toggleBtn.textContent = on ? 'Send Text Notification' : 'Text Notification';
    if (!on) {
      container.querySelectorAll('.floater-card-select-all-checkbox').forEach((cb) => { cb.checked = false; });
    }
    updateToggleBtnDisabled();
  }

  // "Click the check boxes on each assignment or the whole card" - a
  // card's own Select All checkbox checks/unchecks every assignment
  // checkbox inside that SAME card only, never another hour's.
  container.addEventListener('change', (e) => {
    if (e.target.classList.contains('floater-card-select-all-checkbox')) {
      const card = e.target.closest('.floater-card');
      if (card) card.querySelectorAll('.floater-notify-checkbox').forEach((cb) => { cb.checked = e.target.checked; });
    }
    if (e.target.classList.contains('floater-card-select-all-checkbox') || e.target.classList.contains('floater-notify-checkbox')) {
      updateToggleBtnDisabled();
    }
  });

  // Opens the same compose popup either path (the page-level toggle
  // button, or a card's own Send Text shortcut) ends up using, from
  // whichever list of checkboxes that path gathered.
  function openComposeDialog(checkboxes) {
    pendingNotify = checkboxes.map((cb) => ({ memberId: cb.dataset.memberId }));
    const first = checkboxes[0].dataset;
    messageField.value = fillMessageTemplate(first);
    recipientsHint.textContent = `Sending to ${checkboxes.length} floater${checkboxes.length === 1 ? '' : 's'}.`;
    const fileInput = form.querySelector('input[type="file"]');
    if (fileInput) fileInput.value = '';
    dialog.showModal();
  }

  toggleBtn.addEventListener('click', () => {
    if (!selectMode) {
      setSelectMode(true);
      clearMessage();
      return;
    }

    const checked = Array.from(container.querySelectorAll('.floater-notify-checkbox:checked'));
    if (checked.length === 0) return;
    clearMessage();
    openComposeDialog(checked);
  });

  // "Send text button on hour title bar... when you click send text on
  // title bar it will create a pop up" - a one-click shortcut straight
  // to the compose popup for every assigned position in that one card,
  // regardless of select mode or which boxes happen to be checked.
  container.addEventListener('click', (e) => {
    const sendBtn = e.target.closest('.floater-card-send-text-btn');
    if (!sendBtn) return;
    const card = sendBtn.closest('.floater-card');
    if (!card) return;
    const assigned = Array.from(card.querySelectorAll('.floater-notify-checkbox'));
    if (assigned.length === 0) return;
    clearMessage();
    openComposeDialog(assigned);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (pendingNotify.length === 0) return;
    const message = messageField.value.trim();
    if (!message) {
      messageField.focus();
      return;
    }

    const fileInput = form.querySelector('input[type="file"]');
    const formData = new FormData();
    formData.append('notify', JSON.stringify(pendingNotify));
    formData.append('message', message);
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
        setSelectMode(false);
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
