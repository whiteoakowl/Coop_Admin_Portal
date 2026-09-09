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
  // `readonly` doesn't have that problem: a readonly input still
  // dispatches real keydown events (it only blocks the DEFAULT character-
  // insertion action), and flipping the attribute off inside that same
  // keydown handler lets that very keystroke - and every one after it -
  // through normally, while a readonly input never triggers the on-
  // screen keyboard in the first place on any platform tested. Starts
  // (and returns to, after every submit) readonly so a stray tap from
  // staff standing at the kiosk never pops the on-screen keyboard either
  // - only a real keydown, impossible from a touch tap, ever turns it
  // off. See views/kiosk-*.ejs's own comment on why inputmode="none" was
  // dropped from these inputs' own markup instead of layering this on
  // top of it - staying on the belt-and-suspenders side risks the exact
  // failure mode this fixes still happening on some other Android build.
  inputEl.readOnly = true;
  inputEl.addEventListener('keydown', () => {
    inputEl.readOnly = false;
  });
  if (inputEl.form) {
    inputEl.form.addEventListener('submit', () => {
      inputEl.readOnly = true;
    });
  }
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
