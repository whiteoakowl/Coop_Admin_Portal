// Store product Edit page's own Options list (views/admin-store-edit.ejs)
// - a real request: "add option will be a drop down menu on parent/
// student portals. On main admin shop, product, when you add an option
// there will be sub categories to add variables, each with their own
// price. This setup is like shopify." A product has one or more option
// GROUPS (each its own dropdown at checkout), and each group has one or
// more VALUES (its own optional price/stock/enabled row) - this file
// appends/removes both, purely client-side. data-next-index (on both the
// top-level groups list and each group's own values list) only ever
// counts UP (never re-derived from the current row count) so a
// still-present row's own index is never reused after an earlier row was
// removed - see routes/admin-store.js's own POST /:id, which reads
// whatever indices are actually present (Object.values, tolerant of
// gaps) rather than expecting them contiguous. Every input carries
// form="details-form" (data-add-option-form) so a row added here submits
// along with the rest of the page's single Save button - see that same
// route's own comment ("only one save button at the bottom").
(function () {
  function addValueRow(groupRow, formAttr) {
    const list = groupRow.querySelector('[data-values-list]');
    const index = Number(list.dataset.nextIndex || list.querySelectorAll('[data-option-row]').length);
    list.dataset.nextIndex = index + 1;
    const groupIndex = groupRow.dataset.groupIndex;
    const row = document.createElement('div');
    row.className = 'store-option-row';
    row.setAttribute('data-option-row', '');
    row.innerHTML = `
      <input type="text" class="store-option-name"${formAttr} name="groups[${groupIndex}][values][${index}][name]" placeholder="Value (e.g. Small)" required />
      <label class="store-option-price-label">$<input type="number"${formAttr} name="groups[${groupIndex}][values][${index}][price]" min="0" step="0.01" placeholder="optional" /></label>
      <input type="number" class="store-option-qty"${formAttr} name="groups[${groupIndex}][values][${index}][qty]" min="0" placeholder="Qty" aria-label="Quantity (blank = unlimited)" />
      <input type="hidden"${formAttr} name="groups[${groupIndex}][values][${index}][enabled]" value="0" />
      <label class="store-option-enabled-toggle">
        <input type="checkbox"${formAttr} name="groups[${groupIndex}][values][${index}][enabled]" value="1" checked /> Enabled
      </label>
      <button type="button" class="icon-btn icon-btn-danger" data-remove-option aria-label="Remove value" title="Remove"><svg class="icon"><use href="#icon-trash"/></svg></button>
    `;
    list.appendChild(row);
    row.querySelector('.store-option-name').focus();
  }

  document.addEventListener('click', (e) => {
    const addGroupBtn = e.target.closest('[data-add-group]');
    if (addGroupBtn) {
      const list = addGroupBtn.closest('.manage-section').querySelector('[data-groups-list]');
      const formId = addGroupBtn.dataset.addOptionForm || '';
      const formAttr = formId ? ` form="${formId}"` : '';
      const groupIndex = Number(list.dataset.nextIndex || list.querySelectorAll('[data-group-row]').length);
      list.dataset.nextIndex = groupIndex + 1;
      const group = document.createElement('div');
      group.className = 'store-option-group';
      group.setAttribute('data-group-row', '');
      group.dataset.groupIndex = String(groupIndex);
      group.innerHTML = `
        <div class="store-option-group-header">
          <input type="text" class="store-group-name"${formAttr} name="groups[${groupIndex}][name]" placeholder="Group title (e.g. Size)" required />
          <button type="button" class="icon-btn icon-btn-danger" data-remove-group aria-label="Remove group" title="Remove"><svg class="icon"><use href="#icon-trash"/></svg></button>
        </div>
        <div class="store-options-list" data-values-list data-next-index="0"></div>
        <div class="roster-btn-row">
          <button type="button" class="btn-secondary" data-add-option data-add-option-form="${formId}">+ Add Value</button>
        </div>
      `;
      list.appendChild(group);
      addValueRow(group, formAttr);
      group.querySelector('.store-group-name').focus();
      return;
    }

    const removeGroupBtn = e.target.closest('[data-remove-group]');
    if (removeGroupBtn) {
      removeGroupBtn.closest('[data-group-row]').remove();
      return;
    }

    const addBtn = e.target.closest('[data-add-option]');
    if (addBtn) {
      const groupRow = addBtn.closest('[data-group-row]');
      const formId = addBtn.dataset.addOptionForm || '';
      const formAttr = formId ? ` form="${formId}"` : '';
      addValueRow(groupRow, formAttr);
      return;
    }

    const removeBtn = e.target.closest('[data-remove-option]');
    if (removeBtn) {
      removeBtn.closest('[data-option-row]').remove();
    }
  });
})();
