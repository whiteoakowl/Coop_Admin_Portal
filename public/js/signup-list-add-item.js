// Sign-Up List detail page's own "+ Add Item" dialog - a real request:
// "signup lists be able to add multiple items to a list in the popup
// before. Page only refreshes after adding however many needed." Submits
// via fetch() instead of a plain form POST, appends the new item to the
// table in place, and clears the fields for the next entry - the dialog
// stays open until the admin clicks Done, so adding 5 items is 5 quick
// entries in a row instead of 5 separate page loads.
(function () {
  const form = document.getElementById('add-item-form');
  if (!form) return;
  const section = document.getElementById('signup-items-section');
  const errorEl = document.getElementById('add-item-error');
  const nameInput = form.querySelector('input[name="itemName"]');

  function buildRow(item, deleteUrl) {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    nameTd.className = 'roster-name-col';
    nameTd.appendChild(document.createTextNode(item.item_name));
    if (item.notes) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = ' ' + item.notes;
      nameTd.appendChild(hint);
    }
    tr.appendChild(nameTd);

    const neededTd = document.createElement('td');
    neededTd.textContent = item.quantity_needed;
    tr.appendChild(neededTd);

    const claimedTd = document.createElement('td');
    claimedTd.textContent = item.quantityClaimed;
    tr.appendChild(claimedTd);

    const claimedByTd = document.createElement('td');
    claimedByTd.textContent = '—';
    tr.appendChild(claimedByTd);

    const actionsTd = document.createElement('td');
    const deleteForm = document.createElement('form');
    deleteForm.method = 'POST';
    deleteForm.action = deleteUrl;
    deleteForm.className = 'inline-block-form';
    deleteForm.setAttribute('data-confirm', `Remove "${item.item_name}"?`);
    deleteForm.innerHTML = '<button type="submit" class="roster-action-btn roster-action-btn-danger"><svg class="icon"><use href="#icon-trash"/></svg></button>';
    actionsTd.appendChild(deleteForm);
    tr.appendChild(actionsTd);

    return tr;
  }

  function appendItem(item, deleteUrl) {
    let tbody = document.getElementById('signup-items-tbody');
    if (!tbody) {
      // First item added while the page was still showing "No items yet"
      // - build the same table shape the server itself renders once
      // items.length > 0 (see main-admin-signup-list-detail.ejs).
      section.innerHTML =
        '<div class="roster-scroll"><table class="roster-table condensed-table">' +
        '<thead><tr><th>Item</th><th>Needed</th><th>Claimed</th><th>Claimed By</th><th></th></tr></thead>' +
        '<tbody id="signup-items-tbody"></tbody></table></div>';
      tbody = document.getElementById('signup-items-tbody');
      // confirm-dialog.js/unsaved-changes.js both delegate from
      // document-level listeners, so a form built after page load still
      // gets data-confirm/CSRF handling with nothing extra wired up here.
    }
    tbody.appendChild(buildRow(item, deleteUrl));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
        body: new URLSearchParams(new FormData(form)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not add item.');

      appendItem(data.item, data.deleteUrl);
      form.reset();
      nameInput.focus();
    } catch (err) {
      errorEl.textContent = err.message || 'Could not add item.';
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
