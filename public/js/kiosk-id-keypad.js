/* exported initIdKeypad */
// Shared numeric keypad for every kiosk scan screen (Check In, Check Out,
// Find a Parent, Class Check-In) - lets someone type their 6-digit Member
// ID by hand instead of scanning. A member's barcode already just *is*
// their member_code (utils/members.js's generateMemberCode, db/schema.sql's
// member_code column), so typing the ID and scanning the barcode land on
// the exact same lookup - no separate code path needed here at all.
//
// Builds its own digit-display + button grid into `container` (kept out of
// each page's own EJS markup so every scan page can share this one
// definition). Once exactly 6 digits have been entered, stuffs that value
// into the page's existing (otherwise-hidden) barcode input and submits its
// form - same as a hardware scanner typing a barcode into that input and
// firing Enter, so every page's own submit handler needs no changes at all.
function initIdKeypad(container, input, form) {
  if (!container || !input || !form) return;

  var ID_LENGTH = 6;
  var value = '';

  var display = document.createElement('div');
  display.className = 'id-keypad-display';
  container.appendChild(display);

  var grid = document.createElement('div');
  grid.className = 'id-keypad-grid';
  container.appendChild(grid);

  function render() {
    display.textContent = value || 'Enter your ID number';
    display.classList.toggle('id-keypad-display-empty', !value);
  }
  render();

  function addDigit(d) {
    if (value.length >= ID_LENGTH) return;
    value += d;
    input.value = value;
    render();
    if (value.length === ID_LENGTH) {
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

  ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'].forEach(function (key) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'numpad-btn id-keypad-btn';
    if (key === 'clear') {
      btn.textContent = 'Clear';
      btn.setAttribute('aria-label', 'Clear entry');
      btn.addEventListener('click', function () { value = ''; input.value = ''; render(); });
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
}
