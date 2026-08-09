(function () {
  const form = document.getElementById('absence-form');
  if (!form) return;

  const resultDialog = document.getElementById('result-dialog');
  if (resultDialog) {
    resultDialog.showModal();
    const goHome = resultDialog.dataset.redirectHome === '1';
    resultDialog.querySelector('.alert-popup-ok').addEventListener('click', () => {
      if (goHome) {
        window.location.href = '/kiosk';
      } else {
        resultDialog.close();
      }
    });
    if (goHome) {
      setTimeout(() => { window.location.href = '/kiosk'; }, 4000);
    }
  }

  const parentSelect = document.getElementById('parentId');
  const groups = document.querySelectorAll('.absence-children-group');
  const requiredMsg = document.getElementById('student-required-msg');
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
      const visibleGroup = document.querySelector('.absence-children-group:not([hidden])');
      if (!visibleGroup) return;
      const boxes = visibleGroup.querySelectorAll('input[type="checkbox"]');
      const allChecked = [...boxes].every((b) => b.checked);
      boxes.forEach((b) => { b.checked = !allChecked; });
      selectAllBtn.textContent = allChecked ? 'Select All' : 'Deselect All';
      if (requiredMsg) requiredMsg.hidden = true;
    });
  }

  form.addEventListener('submit', (e) => {
    const visibleGroup = document.querySelector('.absence-children-group:not([hidden])');
    const checked = visibleGroup ? visibleGroup.querySelectorAll('input[type="checkbox"]:checked') : [];
    if (!visibleGroup || checked.length === 0) {
      e.preventDefault();
      if (requiredMsg) requiredMsg.hidden = false;
    }
  });
})();
