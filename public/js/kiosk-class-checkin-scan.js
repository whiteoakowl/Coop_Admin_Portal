/* global keepInputFocused, initIdKeypad */
// Mirrors public/js/kiosk-checkin.js's fetch-and-show pattern exactly,
// just posting to this class's own scoped, mode-specific scan endpoint
// (routes/kiosk-class-checkin.js) instead of the main portal's - see that
// route's own comment on why the two are kept independent. The class id
// and mode come from the page body's data attributes rather than being
// hardcoded into a shared script, so this one file works for both Check
// In and Check Out on every class. Unlike the main portal's kiosk scan
// pages, this input is visible and typeable (not just a hidden target for
// a hardware scanner) - one of the input methods here is typing a member's
// name by hand (utils/memberLookup.js), on top of the shared scanner +
// numeric ID keypad every other kiosk scan screen offers.
(function () {
  const form = document.getElementById('scan-form');
  if (!form) return;

  const classId = document.body.dataset.classId;
  const mode = document.body.dataset.mode === 'checkout' ? 'checkout' : 'checkin';
  const input = document.getElementById('barcode-input');
  const status = document.getElementById('kiosk-status');
  const instructions = document.getElementById('kiosk-instructions');
  const icon = status.querySelector('.kiosk-status-icon');
  const idleMessage = 'Scan a barcode or enter an ID number';

  keepInputFocused(input);
  initIdKeypad(document.getElementById('id-keypad'), input, form);

  let resetTimer = null;

  function setState(state, message, iconId) {
    status.className = 'kiosk-status kiosk-status-' + state;
    icon.innerHTML = '<svg class="icon' + (iconId === 'loader' ? ' icon-spin' : '') + '"><use href="#icon-' + iconId + '"/></svg>';
    instructions.textContent = message;
  }

  function resetSoon() {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      setState('idle', idleMessage, 'camera');
    }, 2500);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const barcode = input.value.trim();
    input.value = '';
    if (!barcode) return;

    setState('loading', 'Checking…', 'loader');

    try {
      const res = await fetch(`/kiosk/class-checkin/classes/${classId}/scan/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'barcode=' + encodeURIComponent(barcode),
      });
      const data = await res.json();
      if (data.ok) {
        setState(data.alreadyChecked ? 'info' : 'success', data.message, data.alreadyChecked ? 'info-circle' : 'check-circle');
        resetSoon();
        return;
      }
      setState('error', data.message, 'x-circle');
    } catch (err) {
      setState('error', 'Connection error. Please try again.', 'x-circle');
    }
    resetSoon();
  });
})();
