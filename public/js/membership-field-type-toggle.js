// views/partials/membership-fields-manager.ejs (Main Admin > Members >
// Settings) - the "Dropdown Choices" textarea only makes sense when the
// field's own Type select is set to Dropdown, so it stays hidden
// otherwise instead of showing an always-visible, usually-irrelevant box.
(function () {
  function toggle(select) {
    const row = select.closest('form').querySelector('.membership-field-options-row');
    if (row) row.hidden = select.value !== 'dropdown';
  }

  document.querySelectorAll('.membership-field-type-select').forEach((select) => {
    toggle(select);
    select.addEventListener('change', () => toggle(select));
  });
})();
