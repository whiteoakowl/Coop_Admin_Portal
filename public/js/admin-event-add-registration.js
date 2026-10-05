// Main Admin's own "Add a Member" popup on an event's Registrations page
// (views/admin-events-registrations.ejs) - a real request: "after
// selecting the family and then the members of that family signing up,
// the popup window will then go through all of the signup, extra
// question and tickets choices for that event as if the actual member is
// signing up." Step 1 is the existing family-filtered member checklist;
// Continue clones this event's own Ticket/Extra-Field <template>s once
// per CHECKED member into Step 2, so each member gets their own ticket
// choice and their own each_member-scoped answers instead of one shared
// set stamped onto everyone - a family-scoped field is only ever cloned
// for a member whose own data-member-type is parent/admin (same
// "admins count as parents" rule utils/events.js's own
// extraFieldsForMemberType enforces server-side for self-service
// registration). Submits as members[m<id>][ticketTypeId]/
// members[m<id>][answers][f<fieldId>] - routes/admin-events.js's own
// POST /:id/registrations/add parses that same "m"/"f"-prefixed shape.
(function () {
  const list = document.getElementById('add-registration-member-list');
  if (!list) return;

  const dialog = document.getElementById('add-registration-dialog');
  const familyFilter = document.getElementById('add-registration-family-filter');
  const stepPick = document.getElementById('add-registration-step-pick');
  const stepDetails = document.getElementById('add-registration-step-details');
  const detailsContainer = document.getElementById('add-registration-member-details');
  const ticketTemplate = document.getElementById('add-registration-ticket-template');
  const fieldsTemplate = document.getElementById('add-registration-fields-template');
  const continueBtn = document.getElementById('add-registration-continue-btn');
  const backBtn = document.getElementById('add-registration-back-btn');
  const saveBtn = document.getElementById('add-registration-save-btn');

  // "filter for family name in ABC order" - a plain show/hide over the
  // already-alphabetical checkbox list, not a server round trip.
  if (familyFilter) {
    familyFilter.addEventListener('change', () => {
      list.querySelectorAll('.member-picker-row').forEach((row) => {
        row.hidden = familyFilter.value !== '' && row.dataset.family !== familyFilter.value;
      });
    });
  }

  function resetToStepPick() {
    stepPick.hidden = false;
    stepDetails.hidden = true;
    backBtn.hidden = true;
    saveBtn.hidden = true;
    continueBtn.hidden = false;
    detailsContainer.innerHTML = '';
  }

  if (dialog) dialog.addEventListener('close', resetToStepPick);

  if (continueBtn) {
    continueBtn.addEventListener('click', () => {
      const checked = [...list.querySelectorAll('input[name="pickedMemberIds"]:checked')];
      if (checked.length === 0) {
        window.alert('Choose at least one member.');
        return;
      }
      detailsContainer.innerHTML = '';
      checked.forEach((checkbox) => {
        const memberId = checkbox.value;
        const memberName = checkbox.dataset.memberName || '';
        const memberType = checkbox.dataset.memberType || '';
        const isParent = memberType === 'parent' || memberType === 'admin';

        const wrap = document.createElement('div');
        wrap.className = 'add-registration-member-details member-form-full';
        const heading = document.createElement('h4');
        heading.textContent = 'For ' + memberName;
        wrap.appendChild(heading);

        // A member with no ticket types and no extra fields to show would
        // otherwise contribute literally nothing under members[m<id>] -
        // form-urlencoded serialization drops a key with no leaf value at
        // all, which would silently drop that member from the submission
        // entirely. This hidden input guarantees the key always exists.
        const pickedInput = document.createElement('input');
        pickedInput.type = 'hidden';
        pickedInput.name = 'members[m' + memberId + '][memberId]';
        pickedInput.value = memberId;
        wrap.appendChild(pickedInput);

        if (ticketTemplate) {
          const ticketFrag = ticketTemplate.content.cloneNode(true);
          ticketFrag.querySelectorAll('[data-ticket-input]').forEach((el) => {
            el.name = 'members[m' + memberId + '][ticketTypeId]';
          });
          wrap.appendChild(ticketFrag);
        }

        if (fieldsTemplate) {
          const fieldsFrag = fieldsTemplate.content.cloneNode(true);
          fieldsFrag.querySelectorAll('[data-field-id]').forEach((label) => {
            const fieldId = label.dataset.fieldId;
            const input = label.querySelector('[data-answer-input]');
            if (input) input.name = 'members[m' + memberId + '][answers][f' + fieldId + ']';
            // Hidden also exempts it from required-field constraint
            // validation (the element is "not rendered") - same rule
            // public/js/events-detail-register.js's own applyFieldScopeFor
            // relies on for the self-service wizard.
            if (label.dataset.fieldScope === 'family' && !isParent) label.hidden = true;
          });
          wrap.appendChild(fieldsFrag);
        }

        detailsContainer.appendChild(wrap);
      });

      stepPick.hidden = true;
      stepDetails.hidden = false;
      continueBtn.hidden = true;
      backBtn.hidden = false;
      saveBtn.hidden = false;
    });
  }

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      stepPick.hidden = false;
      stepDetails.hidden = true;
      backBtn.hidden = true;
      saveBtn.hidden = true;
      continueBtn.hidden = false;
    });
  }
})();
