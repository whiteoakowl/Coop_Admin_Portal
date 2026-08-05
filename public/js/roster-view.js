(function () {
  const buttons = document.querySelectorAll('.grid-expand-btn');
  if (buttons.length === 0) return;

  const boxes = document.querySelectorAll('.grid-box');

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.expandTarget);
      const isExpanded = target.classList.contains('grid-box-expanded');

      boxes.forEach((box) => {
        box.classList.remove('grid-box-expanded');
        box.hidden = false;
        const boxBtn = box.querySelector('.grid-expand-btn');
        if (boxBtn) boxBtn.textContent = 'Expand';
      });

      if (!isExpanded) {
        target.classList.add('grid-box-expanded');
        boxes.forEach((box) => {
          if (box !== target) box.hidden = true;
        });
        btn.textContent = 'Collapse';
      }
    });
  });
})();
