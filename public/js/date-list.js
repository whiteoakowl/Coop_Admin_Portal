// Powers the repeatable "pick as many dates as you like" input group used
// on the roster creation form and the "add more dates" form.
(function () {
  document.querySelectorAll('.date-list-wrap').forEach((wrap) => {
    const list = wrap.querySelector('.date-list');
    const addBtn = wrap.querySelector('.date-list-add');
    if (!list || !addBtn) return;

    function addRow() {
      const row = document.createElement('div');
      row.className = 'date-list-row';

      const input = document.createElement('input');
      input.type = 'date';
      input.name = 'dates';
      row.appendChild(input);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'date-list-remove';
      removeBtn.setAttribute('aria-label', 'Remove date');
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        if (list.children.length > 1) row.remove();
        else input.value = '';
      });
      row.appendChild(removeBtn);

      list.appendChild(row);
      input.focus();
    }

    list.querySelectorAll('.date-list-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (list.children.length > 1) btn.closest('.date-list-row').remove();
        else btn.previousElementSibling.value = '';
      });
    });

    addBtn.addEventListener('click', addRow);
  });
})();
