(function () {
  const scanForm = document.getElementById('scan-form');
  if (!scanForm) return; // no session today

  const input = document.getElementById('barcode-input');
  const status = document.getElementById('kiosk-status');
  const instructions = document.getElementById('kiosk-instructions');
  const icon = status.querySelector('.kiosk-status-icon');

  const stepScan = document.getElementById('step-scan');
  const stepNumber = document.getElementById('step-number');
  const memberNameEl = document.getElementById('member-name');
  const numberMessage = document.getElementById('number-message');
  const numpad = document.getElementById('numpad');
  const cancelBtn = document.getElementById('cancel-btn');

  keepInputFocused(input);

  let currentMemberId = null;
  let currentRosterId = null;

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

  function setScanState(state, message, iconId) {
    status.className = 'kiosk-status kiosk-status-' + state;
    icon.innerHTML = '<svg class="icon' + (iconId === 'loader' ? ' icon-spin' : '') + '"><use href="#icon-' + iconId + '"/></svg>';
    instructions.textContent = message;
  }

  function resetToScan() {
    currentMemberId = null;
    currentRosterId = null;
    stepNumber.classList.add('kiosk-hidden');
    stepScan.classList.remove('kiosk-hidden');
    setScanState('idle', 'Scan your name tag barcode', 'camera');
    numberMessage.textContent = '';
    numpad.querySelectorAll('.numpad-btn').forEach((b) => b.classList.remove('numpad-btn-selected'));
    setTimeout(() => input.focus(), 50);
  }

  scanForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const barcode = input.value.trim();
    input.value = '';
    if (!barcode) return;

    setScanState('loading', 'Checking…', 'loader');

    try {
      const res = await fetch('/kiosk/checkout/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'barcode=' + encodeURIComponent(barcode),
      });
      const data = await res.json();
      if (data.ok) {
        currentMemberId = data.memberId;
        currentRosterId = data.rosterId;
        memberNameEl.textContent = data.name;
        numpad.querySelectorAll('.numpad-btn').forEach((b) => {
          b.classList.toggle('numpad-btn-selected', data.existingNumber && Number(b.dataset.number) === data.existingNumber);
        });
        stepScan.classList.add('kiosk-hidden');
        stepNumber.classList.remove('kiosk-hidden');
        setScanState('idle', 'Scan your name tag barcode', 'camera');
      } else {
        setScanState('error', data.message, 'x-circle');
        setTimeout(() => setScanState('idle', 'Scan your name tag barcode', 'camera'), 2500);
      }
    } catch (err) {
      setScanState('error', 'Connection error. Please try again.', 'x-circle');
      setTimeout(() => setScanState('idle', 'Scan your name tag barcode', 'camera'), 2500);
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
          '&rosterId=' + encodeURIComponent(currentRosterId) +
          '&number=' + encodeURIComponent(n),
      });
      const data = await res.json();
      numberMessage.textContent = data.message;
      if (data.ok) {
        setTimeout(() => { window.location.href = '/'; }, 1800);
      }
    } catch (err) {
      numberMessage.textContent = 'Connection error. Please try again.';
    }
  }

  cancelBtn.addEventListener('click', resetToScan);
})();
