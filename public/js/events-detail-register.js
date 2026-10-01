// A real request: "when you click register next to a member the page
// will not refresh. The button will turn white and say registered,
// unless there is a popup for tickets [or extra fields]. Then that would
// happen first then it would say registered. Add check boxes next to
// each member to be able to register multiple family members at once
// [and] select the button register selected." Scoped, per a follow-up
// answer, to just what registering itself already needs (ticket choice,
// the event's own extra-field questions) - Volunteer/Food/Donation
// sign-ups on the same page stay their own separate sections, untouched.
//
// views/events-detail.ejs renders one shared row list either way -
// data-needs-dialog on #event-register-member-list says whether a
// member's own Register click should fire the AJAX call straight away
// (the plain case) or open #event-register-dialog first to collect the
// ticket/extra-field answers (event-wide, so one dialog instance is
// reused for every member - this file just swaps its hidden memberId and
// heading before opening it).
(function () {
  const list = document.getElementById('event-register-member-list');
  if (!list) return;

  const eventId = list.dataset.eventId;
  const needsDialog = list.dataset.needsDialog === '1';
  const dialog = document.getElementById('event-register-dialog');
  const selectedBtn = document.getElementById('event-register-selected-btn');
  const thankYouDialog = document.getElementById('event-register-thankyou-dialog');

  // A real request: "after asking about signups, food, etc. you are
  // taken to a ticket view and selection screen. After selecting the
  // ticket you want you click submit and you are taken to a payment
  // screen." The dialog's steps (views/events-detail.ejs's own
  // .register-dialog-step panels - details/ticket/payment, whichever of
  // those the event actually has) are shown one at a time in DOM order;
  // showStep/updatePaymentSummary live at this top level (not nested
  // inside the `if (dialog)` block below) since the Register-button
  // handler further down also needs to reset to step 0 before opening.
  const dialogSteps = dialog ? [...dialog.querySelectorAll('.register-dialog-step')] : [];
  function showStep(index) {
    dialogSteps.forEach((step, i) => {
      step.hidden = i !== index;
    });
    if (dialogSteps[index] && dialogSteps[index].dataset.step === 'payment') updatePaymentSummary();
  }
  // The ticket step's chosen price drives the Payment step's summary -
  // the flat (no-ticket-types) case already has its static amount
  // rendered server-side, so there's nothing to compute here then.
  function updatePaymentSummary() {
    const summary = document.getElementById('event-register-payment-summary');
    const checkedTicket = dialog && dialog.querySelector('input[name="ticketTypeId"]:checked');
    if (summary && checkedTicket) summary.textContent = checkedTicket.dataset.priceLabel || '';
  }

  function rowActions(row) {
    return row.querySelector('.event-register-member-actions');
  }

  async function postAction(path, params) {
    let data;
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'X-CSRF-Token': window.CSRF_TOKEN || '',
        },
        body: new URLSearchParams(params).toString(),
      });
      data = await res.json();
    } catch (err) {
      data = { ok: false, error: 'Connection error - please try again.' };
    }
    return data;
  }

  function registerMember(memberId, extraParams) {
    return postAction(`/events/${eventId}/register`, Object.assign({ memberId }, extraParams || {}));
  }
  function unregisterMember(memberId) {
    return postAction(`/events/${eventId}/unregister`, { memberId });
  }

  // "The button will turn white and say [unregister]" - roster-action-btn-
  // registered is the white/green-outline variant (public/css/styles.css);
  // the button itself always did double as the unregister action (its own
  // js-event-unregister-btn class), this just makes the label say so. A
  // registered row keeps its checkbox now (see events-detail.ejs's own
  // comment) so it can still be picked up by the bulk button, this time to
  // unregister rather than register.
  function markRegistered(row) {
    row.dataset.registered = '1';
    const actions = rowActions(row);
    actions.innerHTML = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'roster-action-btn roster-action-btn-small roster-action-btn-registered js-event-unregister-btn';
    btn.textContent = 'Unregister';
    actions.appendChild(btn);
    updateSelectedButtonState();
  }

  function markUnregistered(row) {
    row.dataset.registered = '0';
    const actions = rowActions(row);
    actions.innerHTML = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'roster-action-btn roster-action-btn-small js-event-register-btn';
    btn.textContent = 'Register';
    actions.appendChild(btn);
    updateSelectedButtonState();
  }

  // A real request: "register selected, [but] if all members from that
  // family are selected [and already registered], will say unregister
  // selected." The button now flips between the two actions based on what's
  // currently checked - if every checked row is already registered, it
  // switches to "Unregister Selected" (own click handler below unregisters
  // just those); otherwise it stays "Register Selected" and only acts on
  // whichever checked rows are NOT yet registered, so a stray registered
  // row checked alongside unregistered ones is silently skipped rather than
  // accidentally unregistered.
  function updateSelectedButtonState() {
    if (!selectedBtn) return;
    const checked = [...list.querySelectorAll('.event-register-member-checkbox:checked')];
    if (checked.length === 0) {
      selectedBtn.disabled = true;
      selectedBtn.textContent = 'Register Selected';
      selectedBtn.dataset.mode = 'register';
      return;
    }
    const allRegistered = checked.every((cb) => cb.closest('.event-register-member-row').dataset.registered === '1');
    selectedBtn.disabled = false;
    selectedBtn.dataset.mode = allRegistered ? 'unregister' : 'register';
    selectedBtn.textContent = allRegistered ? 'Unregister Selected' : 'Register Selected';
  }

  list.addEventListener('click', async (e) => {
    const registerBtn = e.target.closest('.js-event-register-btn');
    if (registerBtn) {
      const row = registerBtn.closest('.event-register-member-row');
      const memberId = row.dataset.memberId;
      if (needsDialog && dialog) {
        document.getElementById('event-register-dialog-member-id').value = memberId;
        document.getElementById('event-register-dialog-member-name').textContent = row.dataset.memberName;
        const err = document.getElementById('event-register-dialog-error');
        if (err) {
          err.hidden = true;
          err.textContent = '';
        }
        showStep(0);
        dialog.showModal();
        return;
      }
      registerBtn.disabled = true;
      registerBtn.textContent = 'Registering…';
      const data = await registerMember(memberId);
      if (data.ok) {
        markRegistered(row);
      } else {
        registerBtn.disabled = false;
        registerBtn.textContent = 'Register';
        window.alert(data.error || 'Could not register - please try again.');
      }
      return;
    }

    const unregisterBtn = e.target.closest('.js-event-unregister-btn');
    if (unregisterBtn) {
      const row = unregisterBtn.closest('.event-register-member-row');
      const memberId = row.dataset.memberId;
      unregisterBtn.disabled = true;
      const data = await unregisterMember(memberId);
      if (data.ok) {
        markUnregistered(row);
      } else {
        unregisterBtn.disabled = false;
        window.alert(data.error || 'Could not cancel - please try again.');
      }
    }
  });

  list.addEventListener('change', (e) => {
    if (e.target.classList.contains('event-register-member-checkbox')) updateSelectedButtonState();
  });

  if (selectedBtn) {
    selectedBtn.addEventListener('click', async () => {
      const checkboxes = [...list.querySelectorAll('.event-register-member-checkbox:checked')];
      if (!checkboxes.length) return;
      const mode = selectedBtn.dataset.mode === 'unregister' ? 'unregister' : 'register';
      selectedBtn.disabled = true;
      selectedBtn.textContent = mode === 'unregister' ? 'Unregistering…' : 'Registering…';
      // Sequential, not Promise.all - each call goes through the same
      // capacity/waitlist checks a single Register/Unregister click would,
      // and firing them one at a time keeps that server-side accounting
      // (registrationCount, family_capacity) correct in request order
      // instead of racing several at once against the same event.
      for (const checkbox of checkboxes) {
        const row = checkbox.closest('.event-register-member-row');
        const rowIsRegistered = row.dataset.registered === '1';
        if (mode === 'unregister' && rowIsRegistered) {
          const data = await unregisterMember(checkbox.value);
          if (data.ok) markUnregistered(row);
        } else if (mode === 'register' && !rowIsRegistered) {
          const data = await registerMember(checkbox.value);
          if (data.ok) markRegistered(row);
        }
      }
      updateSelectedButtonState();
    });
  }

  // Next validates only the step being left (reportValidity() skips
  // hidden/display:none fields per spec, so it never blocks on a later
  // step's still-empty required inputs) and Back/Next just toggle
  // `hidden` via the shared showStep() declared above.
  if (dialog) {
    const dialogForm = document.getElementById('event-register-dialog-form');
    const cancelBtn = document.getElementById('event-register-dialog-cancel');

    dialog.querySelectorAll('.js-dialog-next').forEach((btn) => {
      btn.addEventListener('click', () => {
        const current = dialogSteps.findIndex((step) => !step.hidden);
        if (current === -1) return;
        if (!dialogForm.reportValidity()) return;
        showStep(Math.min(current + 1, dialogSteps.length - 1));
      });
    });
    dialog.querySelectorAll('.js-dialog-back').forEach((btn) => {
      btn.addEventListener('click', () => {
        const current = dialogSteps.findIndex((step) => !step.hidden);
        if (current <= 0) return;
        showStep(current - 1);
      });
    });

    if (cancelBtn) cancelBtn.addEventListener('click', () => dialog.close());

    dialog.addEventListener('close', () => showStep(0));

    dialogForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const memberId = document.getElementById('event-register-dialog-member-id').value;
      const params = new URLSearchParams(new FormData(dialogForm));
      const submitBtn = dialogForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      const data = await postAction(`/events/${eventId}/register`, params);
      submitBtn.disabled = false;
      if (data.ok) {
        dialog.close();
        const row = list.querySelector(`.event-register-member-row[data-member-id="${memberId}"]`);
        if (row) markRegistered(row);
        if (thankYouDialog) thankYouDialog.showModal();
      } else {
        const err = document.getElementById('event-register-dialog-error');
        if (err) {
          err.hidden = false;
          err.textContent = data.error || 'Could not register - please try again.';
        }
      }
    });
  }
})();
