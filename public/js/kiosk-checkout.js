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
  const stepTask = document.getElementById('step-task');
  const memberNameEls = stepTask.querySelectorAll('.task-member-name');
  const cancelBtn = document.getElementById('cancel-btn');

  const taskForm = document.getElementById('task-scan-form');
  const taskInput = document.getElementById('task-barcode-input');
  const taskResult = document.getElementById('task-kiosk-result');
  const taskStatus = document.getElementById('task-kiosk-status');
  const taskInstructions = document.getElementById('task-kiosk-instructions');
  const taskIcon = taskStatus.querySelector('.kiosk-status-icon');
  const taskManualSubmitBtn = document.getElementById('task-manual-submit-btn');

  keepInputFocused(input);
  initIdKeypad(document.getElementById('id-keypad'), input, scanForm);
  // Each step scopes its own chooser to its own panel - step-scan and
  // step-task both have a `.kiosk-method-choice` and matching
  // `[data-method-panel="scanner"|"manual"]` pair, and initKioskMethodChooser
  // only looks within the root it's given, so the two steps' identical
  // panel names never cross-toggle each other.
  const chooser = initKioskMethodChooser(stepScan);

  keepInputFocused(taskInput);
  initIdKeypad(document.getElementById('task-id-keypad'), taskInput, taskForm);
  const taskChooser = initKioskMethodChooser(stepTask);

  manualSubmitBtn.addEventListener('click', () => scanForm.requestSubmit());
  taskManualSubmitBtn.addEventListener('click', () => taskForm.requestSubmit());

  let currentMemberId = null;

  function setState(state, message, iconId) {
    status.className = 'kiosk-status kiosk-status-' + state;
    icon.innerHTML = '<svg class="icon' + (iconId === 'loader' ? ' icon-spin' : '') + '"><use href="#icon-' + iconId + '"/></svg>';
    instructions.textContent = message;
  }

  function setTaskState(state, message, iconId) {
    taskStatus.className = 'kiosk-status kiosk-status-' + state;
    taskIcon.innerHTML = '<svg class="icon' + (iconId === 'loader' ? ' icon-spin' : '') + '"><use href="#icon-' + iconId + '"/></svg>';
    taskInstructions.textContent = message;
  }

  function resetToScan() {
    currentMemberId = null;
    stepTask.classList.add('kiosk-hidden');
    stepScan.classList.remove('kiosk-hidden');
    result.hidden = true;
    chooser.showChooser();
    taskResult.hidden = true;
    taskInput.value = '';
    taskChooser.showChooser();
  }

  // Step 1: scan the member's own name tag. Students are checked out
  // immediately (see setState('success', ...) below); parents move on to
  // step-task to scan the Setup/Cleanup badge for the task they completed.
  scanForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const barcode = input.value.trim();
    input.value = '';
    if (!barcode) return;

    // The method panel active when this submission started - if it
    // fails, that's the screen to return to, not the button-choice row.
    const activePanel = stepScan.querySelector('[data-method-panel]:not([hidden])');
    const activeMethod = activePanel ? activePanel.dataset.methodPanel : 'scanner';

    stepScan.querySelectorAll('[data-method-panel]').forEach((p) => { p.hidden = true; });
    result.hidden = false;
    setState('loading', 'Checking…', 'loader');

    try {
      const res = await fetch('/kiosk/checkout/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'barcode=' + encodeURIComponent(barcode),
      });
      const data = await res.json();
      if (!data.ok) {
        setState('error', data.message, 'x-circle');
        setTimeout(() => {
          result.hidden = true;
          chooser.showPanel(activeMethod);
        }, 2500);
        return;
      }

      // 'parent-already-logged' - a member whose team logs at check-in
      // instead (see public/js/kiosk-checkin.js) already scanned their
      // Setup/Cleanup badge there; checkout is then a single scan just
      // like a student's, not the two-step flow below.
      if (data.memberType === 'student' || data.memberType === 'parent-already-logged') {
        setState('success', data.message, 'check-circle');
        setTimeout(() => { window.location.href = '/kiosk'; }, 1800);
        return;
      }

      currentMemberId = data.memberId;
      memberNameEls.forEach((el) => { el.textContent = data.name; });
      result.hidden = true;
      stepScan.classList.add('kiosk-hidden');
      stepTask.classList.remove('kiosk-hidden');
      // A real request: jump straight into the same method (scanner or
      // manual) just used for the member's own ID, instead of making
      // them pick a method again for the Setup/Cleanup badge.
      taskChooser.showPanel(activeMethod);
    } catch (err) {
      setState('error', 'Connection error. Please try again.', 'x-circle');
      setTimeout(() => {
        result.hidden = true;
        chooser.showPanel(activeMethod);
      }, 2500);
    }
  });

  // Step 2 (parents only): scan the Setup/Cleanup badge for the task just
  // completed.
  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const barcode = taskInput.value.trim();
    taskInput.value = '';
    if (!barcode || !currentMemberId) return;

    const activePanel = stepTask.querySelector('[data-method-panel]:not([hidden])');
    const activeMethod = activePanel ? activePanel.dataset.methodPanel : 'scanner';

    stepTask.querySelectorAll('[data-method-panel]').forEach((p) => { p.hidden = true; });
    taskResult.hidden = false;
    setTaskState('loading', 'Checking…', 'loader');

    try {
      const res = await fetch('/kiosk/checkout/task-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'memberId=' + encodeURIComponent(currentMemberId) + '&barcode=' + encodeURIComponent(barcode),
      });
      const data = await res.json();
      if (data.ok) {
        setTaskState('success', data.message, 'check-circle');
        setTimeout(() => { window.location.href = '/kiosk'; }, 1800);
        return;
      }
      setTaskState('error', data.message, 'x-circle');
      setTimeout(() => {
        taskResult.hidden = true;
        taskChooser.showPanel(activeMethod);
      }, 2500);
    } catch (err) {
      setTaskState('error', 'Connection error. Please try again.', 'x-circle');
      setTimeout(() => {
        taskResult.hidden = true;
        taskChooser.showPanel(activeMethod);
      }, 2500);
    }
  });

  cancelBtn.addEventListener('click', resetToScan);
})();
