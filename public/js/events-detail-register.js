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

  function rowInfo(row) {
    return row.querySelector('.event-register-member-info');
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

  // "The button will turn white and say registered" - roster-action-btn-
  // registered is the white/green-outline variant (public/css/styles.css).
  function markRegistered(row) {
    const actions = rowActions(row);
    actions.innerHTML = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'roster-action-btn roster-action-btn-small roster-action-btn-registered js-event-unregister-btn';
    btn.textContent = 'Registered';
    actions.appendChild(btn);
    const checkbox = rowInfo(row).querySelector('.event-register-member-checkbox');
    if (checkbox) checkbox.remove();
    updateSelectedButtonState();
  }

  function markUnregistered(row) {
    const actions = rowActions(row);
    actions.innerHTML = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'roster-action-btn roster-action-btn-small js-event-register-btn';
    btn.textContent = 'Register';
    actions.appendChild(btn);
    // A cancelled registration is eligible again (eligibility is a static
    // grade/age check, not affected by registering/cancelling) - restore
    // its checkbox in the plain (no-dialog) case so it can be picked back
    // up by "Register Selected" without a reload.
    if (!needsDialog) {
      const info = rowInfo(row);
      if (!info.querySelector('.event-register-member-checkbox')) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'event-register-member-checkbox';
        checkbox.value = row.dataset.memberId;
        info.insertBefore(checkbox, info.firstChild);
      }
    }
    updateSelectedButtonState();
  }

  function updateSelectedButtonState() {
    if (!selectedBtn) return;
    selectedBtn.disabled = list.querySelectorAll('.event-register-member-checkbox:checked').length === 0;
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
      selectedBtn.disabled = true;
      const originalLabel = selectedBtn.textContent;
      selectedBtn.textContent = 'Registering…';
      // Sequential, not Promise.all - each call goes through the same
      // capacity/waitlist checks a single Register click would, and
      // firing them one at a time keeps that server-side accounting
      // (registrationCount, family_capacity) correct in request order
      // instead of racing several at once against the same event.
      for (const checkbox of checkboxes) {
        const row = checkbox.closest('.event-register-member-row');
        const data = await registerMember(checkbox.value);
        if (data.ok) markRegistered(row);
      }
      selectedBtn.textContent = originalLabel;
      updateSelectedButtonState();
    });
  }

  if (dialog) {
    const dialogForm = document.getElementById('event-register-dialog-form');
    const cancelBtn = document.getElementById('event-register-dialog-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => dialog.close());

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
