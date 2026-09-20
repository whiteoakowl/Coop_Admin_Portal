// Store product Edit page's own Options list (views/admin-store-edit.ejs)
// - a real request: "adding options to a product should be a row with a
// bar for the option title and the individual price next to it, and box
// for qty and enable/disable button. Button for add another option."
// data-next-index only ever counts UP (never re-derived from the current
// row count) so a still-present row's own index is never reused after an
// earlier row was removed - see routes/admin-store.js's own POST
// /:id/options, which reads whatever indices are actually present
// (Object.values, tolerant of gaps) rather than expecting them
// contiguous.
(function () {
  document.addEventListener('click', (e) => {
    const addBtn = e.target.closest('[data-add-option]');
    if (addBtn) {
      const list = addBtn.closest('form').querySelector('[data-options-list]');
      const index = Number(list.dataset.nextIndex || list.querySelectorAll('[data-option-row]').length);
      list.dataset.nextIndex = index + 1;
      const row = document.createElement('div');
      row.className = 'store-option-row';
      row.setAttribute('data-option-row', '');
      row.innerHTML = `
        <input type="text" class="store-option-name" name="options[${index}][name]" placeholder="Option title (e.g. Small)" required />
        <label class="store-option-price-label">$<input type="number" name="options[${index}][price]" min="0" step="0.01" required /></label>
        <input type="number" class="store-option-qty" name="options[${index}][qty]" min="0" placeholder="Qty" aria-label="Quantity (blank = unlimited)" />
        <input type="hidden" name="options[${index}][enabled]" value="0" />
        <label class="store-option-enabled-toggle">
          <input type="checkbox" name="options[${index}][enabled]" value="1" checked /> Enabled
        </label>
        <button type="button" class="icon-btn icon-btn-danger" data-remove-option aria-label="Remove option" title="Remove"><svg class="icon"><use href="#icon-trash"/></svg></button>
      `;
      list.appendChild(row);
      row.querySelector('.store-option-name').focus();
      return;
    }

    const removeBtn = e.target.closest('[data-remove-option]');
    if (removeBtn) {
      removeBtn.closest('[data-option-row]').remove();
    }
  });
})();
