/* global keepInputFocused, initIdKeypad, initKioskMethodChooser */
(function () {
  const scanForm = document.getElementById('scan-form');
  if (!scanForm) return; // no session today

  const input = document.getElementById('barcode-input');
  const result = document.getElementById('kiosk-result');
  const status = document.getElementById('kiosk-status');
  const instructions = document.getElementById('kiosk-instructions');
  const icon = status.querySelector('.kiosk-status-icon');
  const manualSubmitBtn = document.getElementById('manual-submit-btn');

  const stepScan = document.getElementById('step-scan');
  const stepNumber = document.getElementById('step-number');
  const memberNameEl = document.getElementById('member-name');
  const numberMessage = document.getElementById('number-message');
  const numpad = document.getElementById('numpad');
  const cancelBtn = document.getElementById('cancel-btn');

  keepInputFocused(input);
  initIdKeypad(document.getElementById('id-keypad'), input, scanForm);
  const chooser = initKioskMethodChooser(document.getElementById('main-content'));

  manualSubmitBtn.addEventListener('click', () => scanForm.requestSubmit());

  let currentMemberId = null;

  // Build the 1-80 number grid once.
  for (let n = 1; n <= 80; n++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'numpad-btn';
    btn.textContent = n;
    btn.dataset.number = n;
    btn.addEventListener('click', () => chooseNumber(n));
    numpad.appendChild(btn);
  }

  function setState(state, message, iconId) {
    status.className = 'kiosk-status kiosk-status-' + state;
    icon.innerHTML = '<svg class="icon' + (iconId === 'loader' ? ' icon-spin' : '') + '"><use href="#icon-' + iconId + '"/></svg>';
    instructions.textContent = message;
  }

  function resetToScan() {
    currentMemberId = null;
    stepNumber.classList.add('kiosk-hidden');
    stepScan.classList.remove('kiosk-hidden');
    result.hidden = true;
    chooser.showChooser();
    numberMessage.textContent = '';
    numpad.querySelectorAll('.numpad-btn').forEach((b) => b.classList.remove('numpad-btn-selected'));
  }

  scanForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const barcode = input.value.trim();
    input.value = '';
    if (!barcode) return;

    // The method panel active when this submission started - if it
    // fails, that's the screen to return to, not the button-choice row.
    const activePanel = document.querySelector('[data-method-panel]:not([hidden])');
    const activeMethod = activePanel ? activePanel.dataset.methodPanel : 'scanner';

    document.querySelectorAll('[data-method-panel]').forEach((p) => { p.hidden = true; });
    result.hidden = false;
    setState('loading', 'Checking…', 'loader');

    try {
      const res = await fetch('/kiosk/checkout/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'barcode=' + encodeURIComponent(barcode),
      });
      const data = await res.json();
      if (data.ok) {
        currentMemberId = data.memberId;
        memberNameEl.textContent = data.name;
        numpad.querySelectorAll('.numpad-btn').forEach((b) => {
          b.classList.toggle('numpad-btn-selected', data.existingNumber && Number(b.dataset.number) === data.existingNumber);
        });
        result.hidden = true;
        stepScan.classList.add('kiosk-hidden');
        stepNumber.classList.remove('kiosk-hidden');
      } else {
        setState('error', data.message, 'x-circle');
        setTimeout(() => {
          result.hidden = true;
          chooser.showPanel(activeMethod);
        }, 2500);
      }
    } catch (err) {
      setState('error', 'Connection error. Please try again.', 'x-circle');
      setTimeout(() => {
        result.hidden = true;
        chooser.showPanel(activeMethod);
      }, 2500);
    }
  });

  async function chooseNumber(n) {
    if (!currentMemberId) return;
    try {
      const res = await fetch('/kiosk/checkout/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:
          'memberId=' + encodeURIComponent(currentMemberId) +
          '&number=' + encodeURIComponent(n),
      });
      const data = await res.json();
      numberMessage.textContent = data.message;
      if (data.ok) {
        setTimeout(() => { window.location.href = '/kiosk'; }, 1800);
      }
    } catch (err) {
      numberMessage.textContent = 'Connection error. Please try again.';
    }
  }

  cancelBtn.addEventListener('click', resetToScan);
})();
