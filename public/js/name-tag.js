(function () {
  const form = document.getElementById('name-tag-form');
  if (!form) return;

  if (form.dataset.redirectHome === '1') {
    setTimeout(() => {
      window.location.href = '/';
    }, 2000);
  }

  const parentSelect = document.getElementById('parentId');
  const groups = document.querySelectorAll('#name-tag-member-groups .absence-children-group');
  const requiredMsg = document.getElementById('member-required-msg');
  const selectAllBtn = document.getElementById('select-all-btn');

  function showGroupForParent() {
    groups.forEach((g) => {
      g.hidden = g.dataset.parentId !== parentSelect.value;
    });
    if (requiredMsg) requiredMsg.hidden = true;
    if (selectAllBtn) {
      selectAllBtn.hidden = !parentSelect.value;
      selectAllBtn.textContent = 'Select All';
    }
  }

  if (parentSelect) {
    parentSelect.addEventListener('change', showGroupForParent);
  }

  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      const visibleGroup = document.querySelector('#name-tag-member-groups .absence-children-group:not([hidden])');
      if (!visibleGroup) return;
      const boxes = visibleGroup.querySelectorAll('input[type="checkbox"]');
      const allChecked = [...boxes].every((b) => b.checked);
      boxes.forEach((b) => { b.checked = !allChecked; });
      selectAllBtn.textContent = allChecked ? 'Select All' : 'Deselect All';
      if (requiredMsg) requiredMsg.hidden = true;
    });
  }

  form.addEventListener('submit', (e) => {
    const visibleGroup = document.querySelector('#name-tag-member-groups .absence-children-group:not([hidden])');
    const checked = visibleGroup ? visibleGroup.querySelectorAll('input[type="checkbox"]:checked') : [];
    if (!visibleGroup || checked.length === 0) {
      e.preventDefault();
      if (requiredMsg) requiredMsg.hidden = false;
    }
  });
})();
