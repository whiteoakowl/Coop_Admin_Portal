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
  const stepSecondBadge = document.getElementById('step-second-badge');
  const stepTask2 = document.getElementById('step-task-2');
  const secondBadgeYesBtn = document.getElementById('second-badge-yes-btn');
  const secondBadgeNoBtn = document.getElementById('second-badge-no-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const cancelBtn2 = document.getElementById('cancel-btn-2');
  const doneBtn = document.getElementById('done-btn');
  const methodChoice = stepScan.querySelector('.kiosk-method-choice');

  keepInputFocused(input);
  initIdKeypad(document.getElementById('id-keypad'), input, scanForm);
  // Each step scopes its own chooser to its own panel - mirrors
  // kiosk-checkout.js's own comment: step-scan and step-task both have a
  // `.kiosk-method-choice` and matching `[data-method-panel]` pair, and
  // initKioskMethodChooser only looks within the root it's given, so the
  // two steps' identical panel names never cross-toggle each other.
  const chooser = initKioskMethodChooser(stepScan);
  manualSubmitBtn.addEventListener('click', () => scanForm.requestSubmit());

  let currentMemberId = null;
  // Set on step-task's own success (see wireTaskStep's onSuccess below) -
  // held onto in case the "Do you have a 2nd badge?" answer is "No" (see
  // secondBadgeNoBtn below), so that path can show it without a second
  // round trip to the server.
  let pendingFinalMessage = '';
  let lastTaskMethod = 'scanner';

  function setState(state, message, iconId) {
    status.className = 'kiosk-status kiosk-status-' + state;
    icon.innerHTML = '<svg class="icon' + (iconId === 'loader' ? ' icon-spin' : '') + '"><use href="#icon-' + iconId + '"/></svg>';
    instructions.textContent = message;
  }

  // A real request: "after parent scans their setup/cleanup badge it
  // should ask if they have a 2nd setup/cleanup badge to scan, with yes
  // and no buttons... after the 2nd badge entry the screen says thank
  // you!" step-task (badge 1) and step-task-2 (badge 2) are identical
  // panels (same task-* classes - see kiosk-checkin.ejs's own comment on
  // step-task), so this wires up either one from the element it's given
  // instead of writing the same chooser/keypad/fetch logic out twice.
  function wireTaskStep(stepEl, endpoint, onSuccess) {
    const memberNameEls = stepEl.querySelectorAll('.task-member-name');
    const form = stepEl.querySelector('.task-scan-form');
    const taskInput = form.querySelector('.task-barcode-input');
    const taskResult = stepEl.querySelector('.task-kiosk-result');
    const taskStatus = stepEl.querySelector('.task-kiosk-status');
    const taskInstructions = stepEl.querySelector('.task-kiosk-instructions');
    const taskIcon = taskStatus.querySelector('.kiosk-status-icon');
    const taskManualSubmitBtn = stepEl.querySelector('.task-manual-submit-btn');

    keepInputFocused(taskInput);
    initIdKeypad(stepEl.querySelector('.task-id-keypad'), taskInput, form);
    const taskChooser = initKioskMethodChooser(stepEl);
    taskManualSubmitBtn.addEventListener('click', () => form.requestSubmit());

    function setTaskState(state, message, iconId) {
      taskStatus.className = 'kiosk-status kiosk-status-' + state;
      taskIcon.innerHTML = '<svg class="icon' + (iconId === 'loader' ? ' icon-spin' : '') + '"><use href="#icon-' + iconId + '"/></svg>';
      taskInstructions.textContent = message;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const barcode = taskInput.value.trim();
      taskInput.value = '';
      if (!barcode || !currentMemberId) return;

      const activePanel = stepEl.querySelector('[data-method-panel]:not([hidden])');
      const activeMethod = activePanel ? activePanel.dataset.methodPanel : 'scanner';

      stepEl.querySelectorAll('[data-method-panel]').forEach((p) => { p.hidden = true; });
      taskResult.hidden = false;
      setTaskState('loading', 'Checking…', 'loader');

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'memberId=' + encodeURIComponent(currentMemberId) + '&barcode=' + encodeURIComponent(barcode),
        });
        const data = await res.json();
        if (data.ok) {
          onSuccess(data, activeMethod);
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

    return {
      chooser: taskChooser,
      setName(name) { memberNameEls.forEach((el) => { el.textContent = name; }); },
      showFinal(message) {
        taskResult.hidden = false;
        setTaskState('success', message, 'check-circle');
        setTimeout(() => { window.location.href = '/kiosk'; }, 1800);
      },
      reset() {
        taskResult.hidden = true;
        taskInput.value = '';
        taskChooser.showChooser();
      },
    };
  }

  const task2 = wireTaskStep(stepTask2, '/kiosk/checkin/task-scan-2', (data) => {
    task2.showFinal(data.message);
  });

  // Step 2 ("log on check in" members only): scan the Setup/Cleanup
  // badge for the task about to be done. On success, ask whether there's
  // a 2nd badge (step-second-badge below) instead of finishing right away.
  const task1 = wireTaskStep(stepTask, '/kiosk/checkin/task-scan', (data, activeMethod) => {
    pendingFinalMessage = data.message;
    lastTaskMethod = activeMethod;
    stepTask.classList.add('kiosk-hidden');
    stepSecondBadge.classList.remove('kiosk-hidden');
  });

  function resetToScan() {
    currentMemberId = null;
    stepTask.classList.add('kiosk-hidden');
    stepSecondBadge.classList.add('kiosk-hidden');
    stepTask2.classList.add('kiosk-hidden');
    stepScan.classList.remove('kiosk-hidden');
    result.hidden = true;
    chooser.showChooser();
    task1.reset();
    task2.reset();
  }

  // Step 1: scan the member's own name tag. Most members are checked in
  // immediately (see setState('success', ...) below); a member on a
  // Setup/Cleanup team set to "log on check in" (see step-task below,
  // and routes/kiosk.js's own comment) moves on to step-task to scan
  // their badge for the task they're about to do instead.
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
      const res = await fetch('/kiosk/checkin/scan', {
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

      if (data.memberType === 'parent-taskscan') {
        currentMemberId = data.memberId;
        task1.setName(data.name);
        task2.setName(data.name);
        result.hidden = true;
        stepScan.classList.add('kiosk-hidden');
        stepTask.classList.remove('kiosk-hidden');
        // A real request: jump straight into the same method (scanner
        // or manual) just used for the member's own ID, instead of
        // making them pick a method again for the Setup/Cleanup badge.
        task1.chooser.showPanel(activeMethod);
        return;
      }

      // A real request: "when members are scanning that don't need to
      // scan a setup/cleanup badge, they should be able to continuously
      // scan" - a member who didn't need step-task above (the common
      // case: students always, most parents since #219's badge-scan
      // gate) returns straight to this same ready-to-scan panel instead
      // of leaving the page, so the next person can scan immediately.
      // doneBtn below is the deliberate way to end the session.
      setState(data.alreadyChecked ? 'info' : 'success', data.message, data.alreadyChecked ? 'info-circle' : 'check-circle');
      setTimeout(() => {
        result.hidden = true;
        chooser.showPanel(activeMethod);
      }, 1500);
    } catch (err) {
      setState('error', 'Connection error. Please try again.', 'x-circle');
      setTimeout(() => {
        result.hidden = true;
        chooser.showPanel(activeMethod);
      }, 2500);
    }
  });

  doneBtn.addEventListener('click', () => {
    input.disabled = true;
    methodChoice.hidden = true;
    stepScan.querySelectorAll('[data-method-panel]').forEach((p) => { p.hidden = true; });
    result.hidden = false;
    setState('success', 'Have a great day!', 'check-circle');
    setTimeout(() => { window.location.href = '/kiosk'; }, 1500);
  });

  // A real request: "after parent scans their setup/cleanup badge it
  // should ask if they have a 2nd setup/cleanup badge to scan, with yes
  // and no buttons. if they select yes, it allows them to scan their
  // barcode... after the 2nd badge entry the screen says thank you! ...
  // if they select no, it's says thank you!"
  secondBadgeNoBtn.addEventListener('click', () => {
    stepSecondBadge.classList.add('kiosk-hidden');
    stepTask.classList.remove('kiosk-hidden');
    task1.showFinal(pendingFinalMessage);
  });

  secondBadgeYesBtn.addEventListener('click', () => {
    stepSecondBadge.classList.add('kiosk-hidden');
    stepTask2.classList.remove('kiosk-hidden');
    // Same method-matching idea as the jump into badge 1 above - reuses
    // whichever method (scanner/manual) badge 1 was just scanned with.
    task2.chooser.showPanel(lastTaskMethod);
  });

  cancelBtn.addEventListener('click', resetToScan);
  cancelBtn2.addEventListener('click', resetToScan);
})();
