/* exported keepInputFocused */
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
