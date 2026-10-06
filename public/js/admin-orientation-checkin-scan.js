/* global keepInputFocused, initIdKeypad, initKioskMethodChooser, createKioskCameraScanner */
// Mirrors public/js/admin-events-checkin-scan.js's own fetch-and-show
// pattern (JSON body + X-CSRF-Token header, since this lives inside the
// authenticated admin shell rather than the public kiosk), plus public/js/
// kiosk-class-checkin-scan.js's own Complete button handling - continuous
// scanning never leaves whichever entry method is active after a scan, so
// the next scan/entry just works; Complete is what exits back to the
// Tour/Open House Check-In list page.
(function () {
  const form = document.getElementById('scan-form');
  if (!form) return;

  const semesterId = document.body.dataset.semesterId;
  const scanPostUrl = document.body.dataset.scanPostUrl;
  const completeUrl = document.body.dataset.completeUrl;
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

  document.querySelectorAll('[data-complete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      window.location.href = completeUrl;
    });
  });

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
      const res = await fetch(scanPostUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ? csrf.content : '' },
        body: JSON.stringify({ barcode: value, semesterId: semesterId }),
      });
      const data = await res.json();
      if (data.ok) {
        setState(data.alreadyChecked ? 'info' : 'success', data.message, data.alreadyChecked ? 'info-circle' : 'check-circle');
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
