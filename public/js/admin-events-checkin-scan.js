/* global keepInputFocused, initIdKeypad, initKioskMethodChooser, createKioskCameraScanner */
// A real request: "when you click each button it should show the same
// mobile barcode, barcode or ID check in buttons just like the class
// check in page." Mirrors public/js/kiosk-class-checkin-scan.js's own
// fetch-and-show pattern and reuses the same generic scan-method helpers
// (kiosk-camera-scanner.js, kiosk-id-keypad.js, kiosk-common.js - none of
// them are actually kiosk-route-specific), just posting to this event's
// own /scan endpoint (routes/admin-events.js) with a JSON body instead of
// a kiosk route's own form-urlencoded one, and with no "Complete" button
// to wire up - this page has a real "Back to <Event>" link instead of a
// kiosk-style exit-to-home button.
(function () {
  const form = document.getElementById('scan-form');
  if (!form) return;

  const eventId = document.body.dataset.eventId;
  const mode = document.body.dataset.mode === 'checkout' ? 'checkout' : 'checkin';
  const input = document.getElementById('barcode-input');
  const result = document.getElementById('kiosk-result');
  const status = document.getElementById('kiosk-status');
  const instructions = document.getElementById('kiosk-instructions');
  const icon = status.querySelector('.kiosk-status-icon');
  const manualSubmitBtn = document.getElementById('manual-submit-btn');
  const nameForm = document.getElementById('name-form');
  const nameInput = document.getElementById('name-input');
  const cameraVideo = document.getElementById('camera-video');
  const cameraError = document.getElementById('camera-error');

  keepInputFocused(input);
  initIdKeypad(document.getElementById('id-keypad'), input, form);

  const cameraScanner = createKioskCameraScanner(
    cameraVideo,
    (text) => submitValue(text),
    (message) => {
      cameraError.textContent = message;
      cameraError.hidden = false;
    }
  );

  initKioskMethodChooser(document.getElementById('main-content'), cameraScanner);

  manualSubmitBtn.addEventListener('click', () => form.requestSubmit());

  document.querySelectorAll('[data-method]').forEach((btn) => {
    btn.addEventListener('click', () => { cameraError.hidden = true; });
  });

  document.querySelectorAll('[data-back-to-chooser]').forEach((btn) => {
    btn.addEventListener('click', () => {
      result.hidden = true;
      cameraError.hidden = true;
    });
  });

  function setState(state, message, iconId) {
    status.className = 'kiosk-status kiosk-status-' + state;
    icon.innerHTML = '<svg class="icon' + (iconId === 'loader' ? ' icon-spin' : '') + '"><use href="#icon-' + iconId + '"/></svg>';
    instructions.textContent = message;
  }

  async function submitValue(rawValue) {
    const value = (rawValue || '').trim();
    if (!value) return;

    cameraScanner.busy(true);
    result.hidden = false;
    setState('loading', 'Checking…', 'loader');

    try {
      const csrf = document.querySelector('meta[name="csrf-token"]');
      const res = await fetch(`/main-admin/events/${eventId}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ? csrf.content : '' },
        body: JSON.stringify({ barcode: value, mode: mode }),
      });
      const data = await res.json();
      if (data.ok) {
        setState('success', data.message, 'check-circle');
        setTimeout(() => { result.hidden = true; }, 2000);
      } else {
        setState('error', data.message, 'x-circle');
        setTimeout(() => { result.hidden = true; }, 2500);
      }
    } catch (err) {
      setState('error', 'Connection error. Please try again.', 'x-circle');
      setTimeout(() => { result.hidden = true; }, 2500);
    }
    setTimeout(() => { cameraScanner.busy(false); }, 2000);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value;
    input.value = '';
    submitValue(value);
  });

  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = nameInput.value;
    nameInput.value = '';
    submitValue(value);
  });
})();
