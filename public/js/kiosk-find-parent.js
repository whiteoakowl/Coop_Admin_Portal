/* global keepInputFocused */
(function () {
  const form = document.getElementById('scan-form');
  if (!form) return;

  const input = document.getElementById('barcode-input');
  const status = document.getElementById('kiosk-status');
  const instructions = document.getElementById('kiosk-instructions');
  const icon = status.querySelector('.kiosk-status-icon');
  const scanView = document.getElementById('scan-view');
  const resultsView = document.getElementById('results-view');
  const studentHeading = document.getElementById('result-student-heading');
  const parentsEl = document.getElementById('result-parents');
  const scanAgainBtn = document.getElementById('scan-again-btn');

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
      setState('idle', 'Scan student name tag', 'camera');
    }, 2500);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Renders each parent's actual Schedule Card - the same
  // NameTagRenderCore-generated markup used by the Members "View Cards"
  // dialog and the Design/Print Schedule Card run, sent over as
  // pre-rendered HTML (data.parents[].html/bgCss) so this is guaranteed
  // to look exactly like the printed card, not a hand-built lookalike.
  function renderResults(data) {
    studentHeading.textContent = 'Parents for ' + data.studentName;

    if (data.parents.length === 0) {
      parentsEl.innerHTML = '<p class="roster-empty">No parent information found for ' + escapeHtml(data.studentName) + '.</p>';
    } else {
      parentsEl.innerHTML = data.parents
        .map(
          (p) =>
            '<div class="find-parent-parent-card">' +
            '<h3>' + escapeHtml(p.name) + '</h3>' +
            '<div class="badge-canvas find-parent-badge-canvas" style="width:' + data.cardWidth + 'px; height:' + data.cardHeight + 'px; background:' + p.bgCss + ';">' +
            p.html +
            '</div>' +
            '</div>'
        )
        .join('');
    }

    scanView.hidden = true;
    resultsView.hidden = false;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const barcode = input.value.trim();
    input.value = '';
    if (!barcode) return;

    setState('loading', 'Looking up…', 'loader');

    try {
      const res = await fetch('/kiosk/find-parent/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'barcode=' + encodeURIComponent(barcode),
      });
      const data = await res.json();
      if (data.ok) {
        setState('idle', 'Scan student name tag', 'camera');
        renderResults(data);
        return;
      }
      setState('error', data.message, 'x-circle');
      resetSoon();
    } catch (err) {
      setState('error', 'Connection error. Please try again.', 'x-circle');
      resetSoon();
    }
  });

  scanAgainBtn.addEventListener('click', () => {
    resultsView.hidden = true;
    scanView.hidden = false;
    setState('idle', 'Scan student name tag', 'camera');
    input.focus();
  });
})();
