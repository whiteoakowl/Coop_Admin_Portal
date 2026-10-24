// Main Admin Annual Calendar: Add/Edit Key dialog - a real request:
// "Create key button should say add/edit key. Pop up to add/edit key
// add a trash button next to each key created. Also a save changes
// button at the bottom. Delete description. Be able to add a new key
// and stay in the popup and it will appear in the list below. Be able
// to edit existing keys and click save changes." Add Key posts via
// fetch and appends the returned row without closing the dialog; each
// row's trash icon deletes that one key via fetch (same confirmAction +
// remove-the-row shape public/js/annual-planner-curriculum.js's own
// delete already uses); Save Changes posts every row's current label/
// color in one request, replacing the old per-field auto-submit. Also
// keeps the key bar on the page itself (the clickable buttons used to
// color calendar dates, public/js/annual-calendar.js) in sync so a key
// added/edited/deleted here doesn't need a page reload to show up out
// there too.
(function () {
  const dialog = document.getElementById('annual-calendar-keys-dialog');
  const addForm = document.getElementById('annual-calendar-add-key-form');
  const tbody = document.getElementById('annual-calendar-keys-tbody');
  const tableWrap = document.getElementById('annual-calendar-keys-table-wrap');
  const emptyMessage = document.getElementById('annual-calendar-keys-empty');
  const saveBtn = document.getElementById('annual-calendar-save-keys-btn');
  const keyBar = document.querySelector('[data-annual-calendar-key-bar]');
  if (!dialog || !addForm || !tbody) return;

  function buildRow(key) {
    const tr = document.createElement('tr');
    tr.dataset.keyRow = '';
    tr.dataset.keyId = key.id;

    const labelTd = document.createElement('td');
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.name = 'label';
    labelInput.value = key.label;
    labelInput.setAttribute('aria-label', `Label for ${key.label}`);
    labelTd.appendChild(labelInput);

    const colorTd = document.createElement('td');
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.name = 'color';
    colorInput.value = key.color;
    colorInput.setAttribute('aria-label', `Color for ${key.label}`);
    colorTd.appendChild(colorInput);

    const deleteTd = document.createElement('td');
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'icon-btn icon-btn-danger';
    deleteBtn.setAttribute('data-delete-key', '');
    deleteBtn.setAttribute('aria-label', 'Delete key');
    deleteBtn.title = 'Delete key';
    deleteBtn.innerHTML = '<svg class="icon"><use href="#icon-trash"/></svg>';
    deleteTd.appendChild(deleteBtn);

    tr.appendChild(labelTd);
    tr.appendChild(colorTd);
    tr.appendChild(deleteTd);
    return tr;
  }

  function buildKeyBarButton(key) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'annual-calendar-key-btn';
    btn.setAttribute('data-annual-calendar-key-btn', '');
    btn.dataset.keyId = key.id;
    btn.dataset.keyLabel = key.label;
    btn.style.setProperty('--key-color', key.color);
    btn.title = `Click, then click calendar dates to apply “${key.label}”`;
    const swatch = document.createElement('span');
    swatch.className = 'annual-calendar-key-swatch';
    btn.appendChild(swatch);
    btn.appendChild(document.createTextNode(key.label));
    return btn;
  }

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = addForm.querySelector('[name="label"]').value.trim();
    const color = addForm.querySelector('[name="color"]').value;
    if (!label) return;
    const submitBtn = addForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const res = await fetch('/main-admin/annual-calendar/keys', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
        body: new URLSearchParams({ calendarId: addForm.dataset.calendarId, label, color }).toString(),
      });
      const data = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not add key.');

      tbody.appendChild(buildRow(data.key));
      if (tableWrap) tableWrap.hidden = false;
      if (emptyMessage) emptyMessage.hidden = true;
      if (keyBar) keyBar.insertBefore(buildKeyBarButton(data.key), keyBar.querySelector('[onclick*="showModal"]'));

      addForm.querySelector('[name="label"]').value = '';
      addForm.querySelector('[name="color"]').value = '#EE9A4D';
    } catch (err) {
      window.alert(err.message || 'Could not add key.');
    } finally {
      submitBtn.disabled = false;
    }
  });

  tbody.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('[data-delete-key]');
    if (!deleteBtn) return;
    const row = deleteBtn.closest('[data-key-row]');
    const keyId = row.dataset.keyId;
    const confirmed = await window.confirmAction({
      message: 'Delete this key? Dates colored with it will go back to unmarked.',
    });
    if (!confirmed) return;

    deleteBtn.disabled = true;
    try {
      const res = await fetch(`/main-admin/annual-calendar/keys/${keyId}/delete`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
      });
      const data = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !data.ok) throw new Error('Could not delete key.');

      row.remove();
      if (!tbody.querySelector('[data-key-row]')) {
        if (tableWrap) tableWrap.hidden = true;
        if (emptyMessage) emptyMessage.hidden = false;
      }
      const keyBarBtn = keyBar && keyBar.querySelector(`[data-annual-calendar-key-btn][data-key-id="${keyId}"]`);
      if (keyBarBtn) {
        window.dispatchEvent(new CustomEvent('annual-calendar-key-removed', { detail: { id: keyId } }));
        keyBarBtn.remove();
      }
    } catch (err) {
      deleteBtn.disabled = false;
      window.alert(err.message || 'Could not delete key.');
    }
  });

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const rows = Array.from(tbody.querySelectorAll('[data-key-row]'));
      const keys = rows.map((row) => ({
        id: row.dataset.keyId,
        label: row.querySelector('[name="label"]').value.trim(),
        color: row.querySelector('[name="color"]').value,
      }));
      if (keys.some((k) => !k.label)) {
        window.alert('Every key needs a label.');
        return;
      }

      saveBtn.disabled = true;
      try {
        const res = await fetch('/main-admin/annual-calendar/keys/bulk-update', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN || '' },
          body: JSON.stringify({ keys }),
        });
        const data = await res.json().catch(() => ({ ok: false }));
        if (!res.ok || !data.ok) throw new Error('Could not save changes.');

        keys.forEach((k) => {
          const keyBarBtn = keyBar && keyBar.querySelector(`[data-annual-calendar-key-btn][data-key-id="${k.id}"]`);
          if (!keyBarBtn) return;
          keyBarBtn.dataset.keyLabel = k.label;
          keyBarBtn.style.setProperty('--key-color', k.color);
          keyBarBtn.title = `Click, then click calendar dates to apply “${k.label}”`;
          keyBarBtn.lastChild.textContent = k.label;
        });
      } catch (err) {
        window.alert(err.message || 'Could not save changes.');
      } finally {
        saveBtn.disabled = false;
      }
    });
  }
})();
