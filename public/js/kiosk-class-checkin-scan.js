/* global keepInputFocused */
// Mirrors public/js/kiosk-checkin.js's fetch-and-show pattern exactly,
// just posting to this class's own scoped scan endpoint (routes/
// kiosk-class-checkin.js) instead of the main portal's - see that
// route's own comment on why the two are kept independent. The class id
// comes from the page body's data attribute rather than being hardcoded
// into a shared script, so this one file works for every class.
(function () {
  const form = document.getElementById('scan-form');
  if (!form) return;

  const classId = document.body.dataset.classId;
  const input = document.getElementById('barcode-input');
  const status = document.getElementById('kiosk-status');
  const instructions = document.getElementById('kiosk-instructions');
  const icon = status.querySelector('.kiosk-status-icon');

  keepInputFocused(input);

  let resetTimer = null;

  function setState(state, message, iconId) {
    status.className = 'kiosk-status kiosk-status-' + state;
    icon.innerHTML = '<svg class="icon' + (iconId === 'loader' ? ' icon-spin' : '') + '"><use href="#icon-' + iconId + '"/></svg>';
    instructions.textContent = message;
  }

  function resetSoon() {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      setState('idle', 'Scan your name tag barcode', 'camera');
    }, 2500);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const barcode = input.value.trim();
    input.value = '';
    if (!barcode) return;

    setState('loading', 'Checking…', 'loader');

    try {
      const res = await fetch(`/kiosk/class-checkin/classes/${classId}/scan`, {
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
