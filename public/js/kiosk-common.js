/* exported keepInputFocused, initKioskMethodChooser */
// Keeps the hidden barcode-scanner input focused so a USB/Bluetooth scanner
// (which behaves like a keyboard) always has somewhere to type into.
// No bundler here - this file is loaded via a plain <script> tag before
// kiosk-checkin.js/kiosk-checkout.js/kiosk-find-parent.js on their
// respective pages, and this function is a real shared global they each
// call directly (see the /* global */ comment at the top of each).
function keepInputFocused(inputEl) {
  if (!inputEl) return;
  const focus = () => {
    if (document.activeElement !== inputEl && !inputEl.disabled) inputEl.focus();
  };
  focus();
  setInterval(focus, 400);
  document.addEventListener('click', focus);
  document.addEventListener('touchstart', focus);

  // A real bug report: a new Bluetooth barcode scanner typed the right
  // ID# into every other text field on the same Android tablet (Notes
  // app, address bar) but scanning did nothing at all on the kiosk's own
  // scan screens - Check In, Find a Parent, all of them. Root cause:
  // these inputs used to rely on inputmode="none" alone to keep the
  // on-screen keyboard from popping up over the scan screen, but that
  // attribute is documented to also silently swallow real hardware/
  // Bluetooth-keyboard keystrokes on some Android Chrome/WebView versions
  // - not just suppress the on-screen keyboard it's actually meant for.
  //
  // First attempt: keep the input `readonly` (which still dispatches real
  // keydown events - only the DEFAULT character-insertion action is
  // blocked) and flip `readOnly` off on the very first real keydown, so
  // that keystroke and every one after it gets inserted normally. That
  // got further (characters started reaching the field at all) but still
  // produced a wrong/garbled value on that same tablet: the instant the
  // field actually became editable mid-scan, Android judged it a normal
  // editable focused input and started bringing up the on-screen
  // keyboard, and that keyboard's own appearance mid-burst was racing the
  // Bluetooth scanner's remaining keystrokes and corrupting them - a
  // *different* on-screen-keyboard side effect of the exact same
  // "editable" state the toggle was designed to create.
  //
  // This version never makes the field editable at all, so neither
  // failure mode has anywhere to happen: it stays permanently readonly
  // (a readonly input never triggers the on-screen keyboard, on any
  // platform tested) and instead builds the scanned value itself, one
  // keydown at a time, in a plain JS string - the same technique
  // kiosk-id-keypad.js already uses to stuff a value into this same
  // input via script (always allowed, readonly or not) and submit the
  // form, just fed by real keystrokes instead of on-screen taps. A short
  // idle reset (below) keeps a stray leftover digit from ever prepending
  // itself onto a later, unrelated scan.
  inputEl.readOnly = true;
  let buffer = '';
  let resetTimer = null;
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(resetTimer);
      inputEl.value = buffer;
      buffer = '';
      if (inputEl.form) inputEl.form.requestSubmit();
      return;
    }
    if (e.key.length === 1) {
      buffer += e.key;
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => { buffer = ''; }, 500);
    }
  });
}

// Wires the "how would you like to scan/enter?" button row shared by
// every kiosk scan page with more than one entry method - Check In/Check
// Out offer 2 (Barcode Scanner, Manually Enter ID#), Find a Parent/Class
// Check In & Out add a 3rd (Mobile Barcode Scan). Scans `root` for
// [data-method] buttons (each showing the [data-method-panel] whose
// value matches) and [data-back-to-chooser] buttons (return to the
// button row). cameraScanner, if given (the object public/js/kiosk-
// camera-scanner.js's createKioskCameraScanner returns), is started only
// while the 'mobile-scan' panel is showing and stopped the moment it
// isn't - the camera should never keep running once its own panel isn't
// the one on screen.
function initKioskMethodChooser(root, cameraScanner) {
  const chooser = root.querySelector('.kiosk-method-choice');
  const panels = {};
  root.querySelectorAll('[data-method-panel]').forEach((panel) => {
    panels[panel.dataset.methodPanel] = panel;
  });

  function showPanel(method) {
    Object.keys(panels).forEach((key) => {
      panels[key].hidden = key !== method;
    });
    chooser.hidden = true;
    if (cameraScanner) {
      if (method === 'mobile-scan') cameraScanner.start();
      else cameraScanner.stop();
    }
  }

  function showChooser() {
    Object.keys(panels).forEach((key) => {
      panels[key].hidden = true;
    });
    chooser.hidden = false;
    if (cameraScanner) cameraScanner.stop();
  }

  root.querySelectorAll('[data-method]').forEach((btn) => {
    btn.addEventListener('click', () => showPanel(btn.dataset.method));
  });
  root.querySelectorAll('[data-back-to-chooser]').forEach((btn) => {
    btn.addEventListener('click', showChooser);
  });

  return { showPanel, showChooser };
}
