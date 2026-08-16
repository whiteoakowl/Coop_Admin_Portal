/* global keepInputFocused, initIdKeypad, initKioskMethodChooser, createKioskCameraScanner */
// Mirrors public/js/kiosk-checkin.js's fetch-and-show pattern, posting to
// this class's own scoped, mode-specific scan endpoint (routes/kiosk-
// class-checkin.js) - see that route's own comment on why the two are
// kept independent. The class id and mode come from the page body's data
// attributes rather than being hardcoded into a shared script, so this
// one file works for both Check In and Check Out on every class.
// Continuous: never leaves whichever entry method is active after a
// scan, so the very next scan (Mobile Barcode Scan, a hardware Barcode
// Scan, or typing another ID/name) just works - Complete is what exits
// back to the class's attendance page. #barcode-input stays the shared,
// permanently-hidden target every method funnels a value through except
// typing a name, which has its own separate, genuinely visible input
// (#name-input) since a hardware scanner's hidden target can't also be a
// typeable field a person taps into.
(function () {
  const form = document.getElementById('scan-form');
  if (!form) return;

  const classId = document.body.dataset.classId;
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

  document.querySelectorAll('[data-complete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      window.location.href = `/kiosk/class-checkin/classes/${classId}/attendance`;
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

    // Ignore further camera decodes while this one is being handled (and
    // for the "Checked In!" success pause after) so a badge still
    // sitting in front of the camera doesn't get re-submitted every
    // frame.
    cameraScanner.busy(true);
    result.hidden = false;
    setState('loading', 'Checking…', 'loader');

    try {
      const res = await fetch(`/kiosk/class-checkin/classes/${classId}/scan/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'barcode=' + encodeURIComponent(value),
      });
      const data = await res.json();
      if (data.ok) {
        const label = data.alreadyChecked
          ? data.message
          : (mode === 'checkout' ? 'Checked Out!' : 'Checked In!');
        setState(data.alreadyChecked ? 'info' : 'success', label, data.alreadyChecked ? 'info-circle' : 'check-circle');
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
