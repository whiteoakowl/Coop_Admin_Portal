(function () {
  const form = document.getElementById('membership-form');
  if (!form) return;

  const parent2Checkbox = document.getElementById('add-parent2-checkbox');
  const parent2Section = document.getElementById('parent2-section');
  if (parent2Checkbox && parent2Section) {
    parent2Checkbox.addEventListener('change', () => {
      parent2Section.hidden = !parent2Checkbox.checked;
    });
  }

  const childrenList = document.getElementById('membership-children');
  const addChildBtn = document.getElementById('add-child-btn');
  const template = document.getElementById('membership-child-template');
  let childIndex = 1; // index 0 is the block already on the page

  function updateRemoveButtons() {
    const blocks = childrenList.querySelectorAll('[data-child-block]');
    blocks.forEach((block) => {
      const btn = block.querySelector('.membership-remove-child');
      if (btn) btn.hidden = blocks.length <= 1;
    });
  }

  function bindRemove(block) {
    const btn = block.querySelector('.membership-remove-child');
    if (btn) {
      btn.addEventListener('click', () => {
        block.remove();
        updateRemoveButtons();
      });
    }
  }

  if (addChildBtn && template && childrenList) {
    childrenList.querySelectorAll('[data-child-block]').forEach(bindRemove);
    updateRemoveButtons();

    addChildBtn.addEventListener('click', () => {
      const html = template.innerHTML.split('__INDEX__').join(String(childIndex));
      childIndex++;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html.trim();
      const block = wrapper.firstElementChild;
      childrenList.appendChild(block);
      bindRemove(block);
      updateRemoveButtons();
    });
  }
})();
