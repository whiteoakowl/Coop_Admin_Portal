/* global keepInputFocused, initIdKeypad, initKioskMethodChooser */
(function () {
  const form = document.getElementById('scan-form');
  if (!form) return; // no session today

  const input = document.getElementById('barcode-input');
  const result = document.getElementById('kiosk-result');
  const status = document.getElementById('kiosk-status');
  const instructions = document.getElementById('kiosk-instructions');
  const icon = status.querySelector('.kiosk-status-icon');
  const manualSubmitBtn = document.getElementById('manual-submit-btn');

  keepInputFocused(input);
  initIdKeypad(document.getElementById('id-keypad'), input, form);
  const chooser = initKioskMethodChooser(document.getElementById('main-content'));

  manualSubmitBtn.addEventListener('click', () => form.requestSubmit());

  function setState(state, message, iconId) {
    status.className = 'kiosk-status kiosk-status-' + state;
    icon.innerHTML = '<svg class="icon' + (iconId === 'loader' ? ' icon-spin' : '') + '"><use href="#icon-' + iconId + '"/></svg>';
    instructions.textContent = message;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const barcode = input.value.trim();
    input.value = '';
    if (!barcode) return;

    // The method panel that was active when this submission started - if
    // it fails, that's the screen to return the person to, not the
    // button-choice row (they already told us how they wanted to check
    // in; an unrecognized scan/ID shouldn't make them pick again).
    const activePanel = document.querySelector('[data-method-panel]:not([hidden])');
    const activeMethod = activePanel ? activePanel.dataset.methodPanel : 'scanner';

    document.querySelectorAll('[data-method-panel]').forEach((p) => { p.hidden = true; });
    result.hidden = false;
    setState('loading', 'Checking…', 'loader');

    try {
      const res = await fetch('/kiosk/checkin/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'barcode=' + encodeURIComponent(barcode),
      });
      const data = await res.json();
      if (data.ok) {
        setState(data.alreadyChecked ? 'info' : 'success', data.message, data.alreadyChecked ? 'info-circle' : 'check-circle');
        setTimeout(() => { window.location.href = '/kiosk'; }, 1800);
        return;
      }
      setState('error', data.message, 'x-circle');
      setTimeout(() => {
        result.hidden = true;
        chooser.showPanel(activeMethod);
      }, 2500);
    } catch (err) {
      setState('error', 'Connection error. Please try again.', 'x-circle');
      setTimeout(() => {
        result.hidden = true;
        chooser.showPanel(activeMethod);
      }, 2500);
    }
  });
})();
