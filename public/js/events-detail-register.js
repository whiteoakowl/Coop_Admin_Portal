// A real request: "when you click register next to a member the page
// will not refresh... add check boxes next to each member to be able to
// register multiple family members at once [and] select the button
// register selected." Followed up with: "when signing up multiple
// members, if it requires questions/food signups/volunteer signups or
// donation signups, when you click register it will ask those questions
// once per member - the first popup asks for the first individual
// member, then the next popup asks for the next individual member. After
// completing the information for each member, it will go to the ticket
// page and show each member you are registering and a dropdown ticket
// option next to each of them. Once a ticket has been selected for each
// member, a register now button will appear and go to a future payment
// screen."
//
// views/events-detail.ejs renders one shared row list either way -
// data-needs-dialog on #event-register-member-list says whether a
// member's own Register click (or Register Selected) should fire the
// AJAX call(s) straight away (the plain case) or open #event-register-
// dialog as a wizard first. The wizard is ONE dialog instance reused for
// however many members got queued: a Details step (extra fields/
// volunteer/donation/food) repeats once per queued member, reusing the
// same fields (reset between members - see resetDetailsFields); Tickets
// and Payment are each a single step listing every queued member at
// once, built by JS (buildTicketsStep/buildPaymentStep) since the queue
// itself is only known once a real Register click happens. Nothing is
// actually submitted to the server until Complete Registration on the
// Payment step (or, for a free event with no ticket/payment step at all,
// right after the last member's Details step) - finishRegistration()
// then posts each queued member's own collected answers/ticket choice to
// the existing single-member /register route, one at a time.
(function () {
  const list = document.getElementById('event-register-member-list');
  if (!list) return;

  const eventId = list.dataset.eventId;
  const needsDialog = list.dataset.needsDialog === '1';
  const dialog = document.getElementById('event-register-dialog');
  const selectedBtn = document.getElementById('event-register-selected-btn');
  const thankYouDialog = document.getElementById('event-register-thankyou-dialog');

  function rowActions(row) {
    return row.querySelector('.event-register-member-actions');
  }

  async function postPairs(path, pairs) {
    const body = new URLSearchParams();
    pairs.forEach(([key, value]) => body.append(key, value));
    let data;
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'X-CSRF-Token': window.CSRF_TOKEN || '',
        },
        body: body.toString(),
      });
      data = await res.json();
    } catch (err) {
      data = { ok: false, error: 'Connection error - please try again.' };
    }
    return data;
  }

  function unregisterMember(memberId) {
    return postPairs(`/events/${eventId}/unregister`, [['memberId', memberId]]);
  }

  // "The button will turn white and say [unregister]" - roster-action-btn-
  // registered is the white/green-outline variant (public/css/styles.css);
  // the button itself always did double as the unregister action (its own
  // js-event-unregister-btn class), this just makes the label say so. A
  // registered row keeps its own checkbox (see events-detail.ejs's own
  // comment) so it can still be picked up by the same bulk button, this
  // time for a bulk "Unregister Selected" - markRegistered/markUnregistered
  // only ever touch .event-register-member-actions, never the sibling
  // .event-register-member-info the checkbox lives in, so the checkbox is
  // never removed by either of these.
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

  list.addEventListener('change', (e) => {
    if (e.target.classList.contains('event-register-member-checkbox')) updateSelectedButtonState();
  });

  // ---------------------------------------------------------------------
  // Plain case - no dialog needed at all (no tickets/extra fields/
  // volunteer/donation/food on this event). Register/Unregister fire
  // immediately; Register Selected just loops the same calls.
  // ---------------------------------------------------------------------
  if (!needsDialog) {
    list.addEventListener('click', async (e) => {
      const registerBtn = e.target.closest('.js-event-register-btn');
      if (registerBtn) {
        const row = registerBtn.closest('.event-register-member-row');
        registerBtn.disabled = true;
        registerBtn.textContent = 'Registering…';
        const data = await postPairs(`/events/${eventId}/register`, [['memberId', row.dataset.memberId]]);
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
        unregisterBtn.disabled = true;
        const data = await unregisterMember(row.dataset.memberId);
        if (data.ok) {
          markUnregistered(row);
        } else {
          unregisterBtn.disabled = false;
          window.alert(data.error || 'Could not cancel - please try again.');
        }
      }
    });

    if (selectedBtn) {
      selectedBtn.addEventListener('click', async () => {
        const checkboxes = [...list.querySelectorAll('.event-register-member-checkbox:checked')];
        if (!checkboxes.length) return;
        const mode = selectedBtn.dataset.mode === 'unregister' ? 'unregister' : 'register';
        selectedBtn.disabled = true;
        selectedBtn.textContent = mode === 'unregister' ? 'Unregistering…' : 'Registering…';
        // Sequential, not Promise.all - each call goes through the same
        // capacity/waitlist checks a single Register/Unregister click
        // would, and firing them one at a time keeps that server-side
        // accounting (registrationCount, family_capacity) correct in
        // request order instead of racing several at once.
        for (const checkbox of checkboxes) {
          const row = checkbox.closest('.event-register-member-row');
          const rowIsRegistered = row.dataset.registered === '1';
          if (mode === 'unregister' && rowIsRegistered) {
            const data = await unregisterMember(checkbox.value);
            if (data.ok) markUnregistered(row);
          } else if (mode === 'register' && !rowIsRegistered) {
            const data = await postPairs(`/events/${eventId}/register`, [['memberId', checkbox.value]]);
            if (data.ok) markRegistered(row);
          }
        }
        updateSelectedButtonState();
      });
    }
    return;
  }

  // ---------------------------------------------------------------------
  // Wizard case - at least one of tickets/extra fields/volunteer/
  // donation/food exists.
  // ---------------------------------------------------------------------
  if (!dialog) return;

  const hasDetails = dialog.dataset.hasDetails === '1';
  const hasTickets = dialog.dataset.hasTickets === '1';
  const hasPayment = dialog.dataset.hasPayment === '1';
  const flatPriceCents = dialog.dataset.flatPriceCents ? parseInt(dialog.dataset.flatPriceCents, 10) : null;
  const flatPricePer = dialog.dataset.flatPricePer || '';
  const ticketTypesDataEl = document.getElementById('event-register-ticket-types-data');
  const ticketTypes = ticketTypesDataEl ? JSON.parse(ticketTypesDataEl.textContent || '[]') : [];

  const detailsStep = dialog.querySelector('[data-step="details"]');
  const errorEl = document.getElementById('event-register-dialog-error');
  const memberNameEl = document.getElementById('event-register-dialog-member-name');
  const detailsNextBtn = document.getElementById('event-register-details-next');
  const ticketRowsContainer = document.getElementById('event-register-ticket-rows');
  const ticketsSubmitBtn = document.getElementById('event-register-tickets-submit');
  const paymentSummaryEl = document.getElementById('event-register-payment-summary');
  const paymentCompleteBtn = document.getElementById('event-register-payment-complete');

  // queue: [{ id, name }], in the order Register Selected (or a single
  // Register click, as a queue of one) was invoked with. perMemberData:
  // memberId -> { answers, volunteerRoleIds, donationItemIds,
  // foodItemIds, ticketTypeId } - filled in as the wizard walks the queue.
  let queue = [];
  let queueIndex = 0;
  let perMemberData = {};

  function showStep(name) {
    dialog.querySelectorAll('.register-dialog-step').forEach((step) => {
      step.hidden = step.dataset.step !== name;
    });
  }

  function clearError() {
    if (errorEl) {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }
  }

  function showError(message) {
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = message;
    }
  }

  function resetDetailsFields() {
    if (!detailsStep) return;
    detailsStep.querySelectorAll('input[type="text"], textarea').forEach((el) => {
      el.value = '';
    });
    detailsStep.querySelectorAll('input[type="checkbox"]').forEach((el) => {
      el.checked = false;
    });
    detailsStep.querySelectorAll('select').forEach((el) => {
      el.selectedIndex = 0;
    });
  }

  function collectDetailsFields() {
    const data = { answers: {}, volunteerRoleIds: [], donationItemIds: [], foodItemIds: [] };
    if (!detailsStep) return data;
    detailsStep.querySelectorAll('[name^="answers["]').forEach((el) => {
      const match = /^answers\[f(\d+)\]$/.exec(el.name);
      if (!match) return;
      if (el.type === 'checkbox') {
        if (el.checked) data.answers[match[1]] = el.value;
      } else {
        data.answers[match[1]] = el.value;
      }
    });
    detailsStep.querySelectorAll('input[name="volunteerRoleIds"]:checked').forEach((el) => data.volunteerRoleIds.push(el.value));
    detailsStep.querySelectorAll('input[name="donationItemIds"]:checked').forEach((el) => data.donationItemIds.push(el.value));
    detailsStep.querySelectorAll('input[name="foodItemIds"]:checked').forEach((el) => data.foodItemIds.push(el.value));
    return data;
  }

  // A real request: "requires for each member or family. If required
  // for family is selected only the parent will be asked to choose or
  // fill out those extra fields." Each field's own wrapping <label>
  // carries data-field-scope="family" when it's family-scoped (see
  // views/events-detail.ejs); hiding it for anyone who isn't a parent/
  // admin also exempts it from constraint validation entirely (a hidden
  // element is "barred from constraint validation" per spec - the Next
  // button's own reportValidity() call below already relies on the same
  // rule for the rest of this step).
  function applyFieldScopeFor(memberType) {
    if (!detailsStep) return;
    const isParent = memberType === 'parent' || memberType === 'admin';
    detailsStep.querySelectorAll('[data-field-scope="family"]').forEach((el) => {
      el.hidden = !isParent;
    });
  }

  function showDetailsFor(index) {
    const member = queue[index];
    if (memberNameEl) memberNameEl.textContent = member.name;
    resetDetailsFields();
    applyFieldScopeFor(member.type);
    showStep('details');
  }

  function buildTicketsStep() {
    if (!ticketRowsContainer) return;
    ticketRowsContainer.innerHTML = '';
    queue.forEach((member) => {
      const row = document.createElement('div');
      row.className = 'event-register-ticket-row';
      const label = document.createElement('span');
      label.className = 'event-register-ticket-row-name';
      label.textContent = member.name;
      const select = document.createElement('select');
      select.className = 'event-register-ticket-select';
      select.dataset.memberId = member.id;
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = 'Choose a ticket…';
      select.appendChild(blank);
      ticketTypes.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.title} – $${(t.price_cents / 100).toFixed(2)} / ${t.price_per}`;
        select.appendChild(opt);
      });
      select.addEventListener('change', updateTicketsSubmitVisibility);
      row.appendChild(label);
      row.appendChild(select);
      ticketRowsContainer.appendChild(row);
    });
    updateTicketsSubmitVisibility();
  }

  // "Once a ticket has been selected for each member on that registration
  // list, then a register now button will appear" - hidden (not just
  // disabled) until every row actually has a choice.
  function updateTicketsSubmitVisibility() {
    if (!ticketsSubmitBtn) return;
    const selects = ticketRowsContainer ? [...ticketRowsContainer.querySelectorAll('.event-register-ticket-select')] : [];
    ticketsSubmitBtn.hidden = selects.length === 0 || selects.some((s) => !s.value);
  }

  function priceLineForMember(member) {
    const data = perMemberData[member.id] || {};
    if (ticketTypes.length) {
      const chosen = ticketTypes.find((t) => String(t.id) === String(data.ticketTypeId));
      return { label: chosen ? `${chosen.title} – $${(chosen.price_cents / 100).toFixed(2)}` : '—', cents: chosen ? chosen.price_cents : 0, pricePer: chosen ? chosen.price_per : null };
    }
    if (flatPriceCents != null) {
      return { label: `$${(flatPriceCents / 100).toFixed(2)} / ${flatPricePer}`, cents: flatPriceCents, pricePer: flatPricePer };
    }
    return { label: 'Free', cents: 0, pricePer: null };
  }

  function buildPaymentStep() {
    if (!paymentSummaryEl) return;
    let total = 0;
    let anyFamilyPriced = false;
    const lines = queue.map((member) => {
      const price = priceLineForMember(member);
      total += price.cents;
      if (price.pricePer === 'family') anyFamilyPriced = true;
      return `<div>${member.name}: ${price.label}</div>`;
    });
    lines.push(`<div><strong>Total: $${(total / 100).toFixed(2)}</strong></div>`);
    if (anyFamilyPriced) {
      lines.push('<p class="hint">A family-priced ticket is only actually billed once per family, no matter how many family members register with it - this total may be adjusted once your registration is complete.</p>');
    }
    paymentSummaryEl.innerHTML = lines.join('');
  }

  function buildParamsForMember(member) {
    const data = perMemberData[member.id] || {};
    const pairs = [['memberId', member.id]];
    Object.keys(data.answers || {}).forEach((fieldId) => pairs.push([`answers[f${fieldId}]`, data.answers[fieldId]]));
    (data.volunteerRoleIds || []).forEach((id) => pairs.push(['volunteerRoleIds', id]));
    (data.donationItemIds || []).forEach((id) => pairs.push(['donationItemIds', id]));
    (data.foodItemIds || []).forEach((id) => pairs.push(['foodItemIds', id]));
    if (data.ticketTypeId) pairs.push(['ticketTypeId', data.ticketTypeId]);
    return pairs;
  }

  function setWizardButtonsDisabled(disabled) {
    dialog.querySelectorAll('.notes-dialog-actions button').forEach((btn) => {
      btn.disabled = disabled;
    });
  }

  // The actual submission point - nothing posts to the server before this.
  // Loops the queue sequentially (same "don't race the same event's
  // capacity/waitlist accounting" reasoning as the plain bulk path above),
  // posting each queued member's own collected answers/ticket choice to
  // the existing single-member /register route - no server-side change
  // needed for the wizard redesign, since registerForEvent already only
  // ever takes one member at a time.
  async function finishRegistration() {
    clearError();
    setWizardButtonsDisabled(true);
    let successCount = 0;
    let lastError = null;
    for (const member of queue) {
      const data = await postPairs(`/events/${eventId}/register`, buildParamsForMember(member));
      if (data.ok) {
        successCount++;
        const row = list.querySelector(`.event-register-member-row[data-member-id="${member.id}"]`);
        if (row) markRegistered(row);
      } else {
        lastError = data.error || 'Could not register - please try again.';
      }
    }
    setWizardButtonsDisabled(false);
    if (successCount === 0 && lastError) {
      showError(lastError);
      return;
    }
    dialog.close();
    if (thankYouDialog) thankYouDialog.showModal();
    if (lastError) window.alert(`Some registrations could not be completed: ${lastError}`);
  }

  function startWizard(members) {
    queue = members;
    queueIndex = 0;
    perMemberData = {};
    clearError();
    if (hasDetails) {
      showDetailsFor(0);
    } else if (hasTickets) {
      buildTicketsStep();
      showStep('tickets');
    } else if (hasPayment) {
      buildPaymentStep();
      showStep('payment');
    }
    dialog.showModal();
  }

  list.addEventListener('click', (e) => {
    const registerBtn = e.target.closest('.js-event-register-btn');
    if (registerBtn) {
      const row = registerBtn.closest('.event-register-member-row');
      startWizard([{ id: row.dataset.memberId, name: row.dataset.memberName, type: row.dataset.memberType }]);
      return;
    }
    const unregisterBtn = e.target.closest('.js-event-unregister-btn');
    if (unregisterBtn) {
      const row = unregisterBtn.closest('.event-register-member-row');
      unregisterBtn.disabled = true;
      unregisterMember(row.dataset.memberId).then((data) => {
        if (data.ok) {
          markUnregistered(row);
        } else {
          unregisterBtn.disabled = false;
          window.alert(data.error || 'Could not cancel - please try again.');
        }
      });
    }
  });

  if (selectedBtn) {
    selectedBtn.addEventListener('click', async () => {
      const checkboxes = [...list.querySelectorAll('.event-register-member-checkbox:checked')];
      if (!checkboxes.length) return;
      const mode = selectedBtn.dataset.mode === 'unregister' ? 'unregister' : 'register';
      if (mode === 'unregister') {
        selectedBtn.disabled = true;
        selectedBtn.textContent = 'Unregistering…';
        for (const checkbox of checkboxes) {
          const row = checkbox.closest('.event-register-member-row');
          if (row.dataset.registered === '1') {
            const data = await unregisterMember(checkbox.value);
            if (data.ok) markUnregistered(row);
          }
        }
        updateSelectedButtonState();
        return;
      }
      const members = checkboxes
        .map((cb) => cb.closest('.event-register-member-row'))
        .filter((row) => row.dataset.registered !== '1')
        .map((row) => ({ id: row.dataset.memberId, name: row.dataset.memberName, type: row.dataset.memberType }));
      if (members.length) startWizard(members);
    });
  }

  // Next validates only the step being left (reportValidity() skips
  // hidden/display:none fields per spec, so it never blocks on a later
  // step's still-empty required inputs).
  if (detailsNextBtn) {
    const dialogForm = document.getElementById('event-register-dialog-form');
    detailsNextBtn.addEventListener('click', () => {
      if (dialogForm && !dialogForm.reportValidity()) return;
      const member = queue[queueIndex];
      perMemberData[member.id] = collectDetailsFields();
      queueIndex++;
      if (queueIndex < queue.length) {
        showDetailsFor(queueIndex);
      } else if (hasTickets) {
        buildTicketsStep();
        showStep('tickets');
      } else if (hasPayment) {
        buildPaymentStep();
        showStep('payment');
      } else {
        finishRegistration();
      }
    });
  }

  if (ticketsSubmitBtn) {
    ticketsSubmitBtn.addEventListener('click', () => {
      const selects = ticketRowsContainer ? [...ticketRowsContainer.querySelectorAll('.event-register-ticket-select')] : [];
      selects.forEach((select) => {
        const memberId = select.dataset.memberId;
        perMemberData[memberId] = perMemberData[memberId] || {};
        perMemberData[memberId].ticketTypeId = select.value;
      });
      buildPaymentStep();
      showStep('payment');
    });
  }

  if (paymentCompleteBtn) paymentCompleteBtn.addEventListener('click', finishRegistration);

  ['event-register-dialog-cancel', 'event-register-tickets-cancel', 'event-register-payment-cancel'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => dialog.close());
  });

  dialog.addEventListener('close', () => {
    queue = [];
    queueIndex = 0;
    perMemberData = {};
    clearError();
  });
})();
