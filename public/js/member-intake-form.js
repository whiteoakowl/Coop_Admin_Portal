// Powers views/member-intake-form.ejs - the shared family-intake form
// behind Add Member (Main Admin + Co-op Admin) and the Membership Form.
// Parents are capped at 4, all pre-rendered in the page and revealed one
// at a time (simpler than cloning since the cap is small and fixed);
// students are unlimited, so those use the same hidden-<template>-clone
// pattern public/js/membership-form.js already established.
(function () {
  const addParentBtn = document.getElementById('add-parent-btn');
  const parentBlocks = document.querySelectorAll('[data-parent-block]');
  let nextParentIndex = 1; // block 0 is already visible

  if (addParentBtn && parentBlocks.length) {
    addParentBtn.addEventListener('click', () => {
      if (nextParentIndex >= parentBlocks.length) return;
      parentBlocks[nextParentIndex].hidden = false;
      nextParentIndex++;
      if (nextParentIndex >= parentBlocks.length) addParentBtn.hidden = true;
    });
  }

  const childrenList = document.getElementById('children-list');
  const addChildBtn = document.getElementById('add-child-btn');
  const template = document.getElementById('child-block-template');
  let childIndex = 1; // block 0 is already on the page

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
