// Keeps the hidden barcode-scanner input focused so a USB/Bluetooth scanner
// (which behaves like a keyboard) always has somewhere to type into.
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
