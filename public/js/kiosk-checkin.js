(function () {
  const form = document.getElementById('scan-form');
  if (!form) return; // no session today

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
      const res = await fetch('/kiosk/checkin/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'barcode=' + encodeURIComponent(barcode),
      });
      const data = await res.json();
      if (data.ok) {
        setState(data.alreadyChecked ? 'info' : 'success', data.message, data.alreadyChecked ? 'info-circle' : 'check-circle');
        setTimeout(() => { window.location.href = '/'; }, 1800);
        return;
      }
      setState('error', data.message, 'x-circle');
    } catch (err) {
      setState('error', 'Connection error. Please try again.', 'x-circle');
    }
    resetSoon();
  });
})();
