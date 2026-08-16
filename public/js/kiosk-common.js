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
