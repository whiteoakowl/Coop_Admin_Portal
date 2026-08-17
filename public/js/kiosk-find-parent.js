/* global keepInputFocused, initIdKeypad, initKioskMethodChooser, createKioskCameraScanner */
(function () {
  const form = document.getElementById('scan-form');
  if (!form) return;

  const input = document.getElementById('barcode-input');
  const result = document.getElementById('kiosk-result');
  const status = document.getElementById('kiosk-status');
  const instructions = document.getElementById('kiosk-instructions');
  const icon = status.querySelector('.kiosk-status-icon');
  const manualSubmitBtn = document.getElementById('manual-submit-btn');
  const findParentResults = document.getElementById('find-parent-results');
  const studentHeading = document.getElementById('result-student-heading');
  const parentsEl = document.getElementById('result-parents');
  const cameraVideo = document.getElementById('camera-video');
  const cameraError = document.getElementById('camera-error');

  keepInputFocused(input);
  initIdKeypad(document.getElementById('id-keypad'), input, form);

  const cameraScanner = createKioskCameraScanner(
    cameraVideo,
    (text) => submitBarcode(text),
    (message) => {
      cameraError.textContent = message;
      cameraError.hidden = false;
    }
  );

  initKioskMethodChooser(document.getElementById('main-content'), cameraScanner);

  manualSubmitBtn.addEventListener('click', () => form.requestSubmit());

  document.querySelectorAll('[data-complete]').forEach((btn) => {
    btn.addEventListener('click', () => { window.location.href = '/kiosk'; });
  });

  document.querySelectorAll('[data-method]').forEach((btn) => {
    btn.addEventListener('click', () => { cameraError.hidden = true; });
  });

  document.querySelectorAll('[data-back-to-chooser]').forEach((btn) => {
    btn.addEventListener('click', () => {
      result.hidden = true;
      findParentResults.hidden = true;
      cameraError.hidden = true;
    });
  });

  function setState(state, message, iconId) {
    status.className = 'kiosk-status kiosk-status-' + state;
    icon.innerHTML = '<svg class="icon' + (iconId === 'loader' ? ' icon-spin' : '') + '"><use href="#icon-' + iconId + '"/></svg>';
    instructions.textContent = message;
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
      // See public/js/badge-autofit.js's own comment - the allergy/
      // parent-phone fields on the injected Schedule Card markup are
      // autoFitText, and this page never goes through a full navigation
      // (the card arrives as pre-rendered HTML over fetch), so nothing
      // else here would ever trigger that correction pass.
      if (window.runBadgeAutoFit) window.runBadgeAutoFit(parentsEl);
    }

    result.hidden = true;
    findParentResults.hidden = false;
  }

  // Shared by every entry method - the hardware scanner/manual keypad
  // both funnel through the hidden #barcode-input's form submit, and the
  // camera scanner calls this directly with its decoded text. Continuous:
  // never leaves whichever method panel is active, so the very next scan
  // (from any method) just works - see initKioskMethodChooser for why the
  // camera keeps running behind these results instead of being torn down.
  async function submitBarcode(rawBarcode) {
    const barcode = (rawBarcode || '').trim();
    if (!barcode) return;

    // Ignore further camera decodes while this one is being handled (and
    // for a couple seconds after showing its result) so a badge still
    // sitting in front of the camera doesn't get looked up over and over.
    cameraScanner.busy(true);
    result.hidden = false;
    findParentResults.hidden = true;
    setState('loading', 'Looking up…', 'loader');

    try {
      const res = await fetch('/kiosk/find-parent/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'barcode=' + encodeURIComponent(barcode),
      });
      const data = await res.json();
      if (data.ok) {
        renderResults(data);
      } else {
        setState('error', data.message, 'x-circle');
        setTimeout(() => { result.hidden = true; }, 2500);
      }
    } catch (err) {
      setState('error', 'Connection error. Please try again.', 'x-circle');
      setTimeout(() => { result.hidden = true; }, 2500);
    }
    setTimeout(() => { cameraScanner.busy(false); }, 2000);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const barcode = input.value.trim();
    input.value = '';
    submitBarcode(barcode);
  });
})();
