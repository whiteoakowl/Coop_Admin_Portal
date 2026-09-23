/* exported initPinKeypad */
// Shared numeric keypad for entering a 4-digit staff/admin PIN by hand - the
// exit-Kiosk-Mode code (views/partials/fullscreen-exit-pin-dialog.ejs) and
// the Class Check-In/Out PIN gate (views/kiosk-class-checkin-pin.ejs -
// shared by both Class Check-In and Playground Check-In, which unlock
// through this same page/route) both used a plain type="password" input
// with no on-screen way to enter it on a touch-only kiosk - a real
// request: "add a centered number keypad to type in the code." Masked
// (dots, not digits - see kiosk-id-keypad.js's sibling comment for why
// THAT keypad shows the real digits instead: a Member ID isn't a secret,
// but a PIN is) and centered via the same .kiosk-scan-col layout every
// other kiosk keypad already uses.
//
// Builds its own digit-display + button grid into `container`, same
// approach as kiosk-id-keypad.js's initIdKeypad. Auto-submits `form` once
// `length` digits (default 4, matching every PIN field's own maxlength/
// pattern="[0-9]{4}") have been entered - the physical/on-screen keyboard
// still works too, this is purely an additional touch-friendly input path
// feeding the exact same `input`.
function initPinKeypad(container, input, form, opts) {
  if (!container || !input || !form) return;

  var length = (opts && opts.length) || 4;
  var value = '';

  var display = document.createElement('div');
  display.className = 'id-keypad-display';
  container.appendChild(display);

  var grid = document.createElement('div');
  grid.className = 'id-keypad-grid';
  container.appendChild(grid);

  function render() {
    display.textContent = value ? '•'.repeat(value.length) : 'Enter PIN';
    display.classList.toggle('id-keypad-display-empty', !value);
  }
  render();

  function addDigit(d) {
    if (value.length >= length) return;
    value += d;
    input.value = value;
    render();
    if (value.length === length) {
      value = '';
      render();
      form.requestSubmit();
    }
  }

  function backspace() {
    value = value.slice(0, -1);
    input.value = value;
    render();
  }

  function clear() {
    value = '';
    input.value = '';
    render();
  }

  ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'].forEach(function (key) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'numpad-btn id-keypad-btn';
    if (key === 'clear') {
      btn.textContent = 'Clear';
      btn.setAttribute('aria-label', 'Clear entry');
      btn.addEventListener('click', clear);
    } else if (key === 'back') {
      btn.textContent = '⌫';
      btn.setAttribute('aria-label', 'Backspace');
      btn.addEventListener('click', backspace);
    } else {
      btn.textContent = key;
      btn.setAttribute('aria-label', 'Digit ' + key);
      btn.addEventListener('click', function () { addDigit(key); });
    }
    grid.appendChild(btn);
  });

  return { clear: clear };
}
