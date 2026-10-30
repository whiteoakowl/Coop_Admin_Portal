// "+ Add Adult"/"+ Add Child" dynamic block behavior, shared by every
// unified member edit page (Main Admin/Co-op Admin Edit Member, Parent
// Portal Edit Profile) - a real request: "This page should look exactly
// like the membership request form." Same clone-a-<template>/renumber/
// toggle pattern as public/js/portal-register-form.js's own Additional
// Parents/Children sections, reused verbatim here since both forms share
// the exact same field markup (partials/member-edit-adult-block.ejs/
// member-edit-child-block.ejs). Safe to load on every edit page
// regardless of whether that page's family has any existing blocks at
// all - everything below is a no-op until #member-family-adults/
// #member-family-children actually exist.
(function () {
  const childrenList = document.getElementById('member-family-children');
  const addChildBtn = document.getElementById('add-child-btn');
  const childTemplate = document.getElementById('child-block-template');
  let childIndex = childrenList ? childrenList.querySelectorAll('[data-child-block]').length : 0;

  // Recomputed from each block's own DOM position (not the array index
  // baked into its field names, which never shifts once a block is
  // removed) so removing one from the middle of the list closes the gap
  // instead of leaving a missing number behind - same reasoning as
  // portal-register-form.js's own renumberChildren.
  function renumberChildren() {
    if (!childrenList) return;
    childrenList.querySelectorAll('[data-child-block]').forEach((block, i) => {
      const title = block.querySelector('[data-child-title]');
      if (title) title.textContent = 'Child #' + (i + 1);
    });
  }

  function bindChildLoginToggle(block) {
    const toggle = block.querySelector('[data-child-login-toggle]');
    const fields = block.querySelector('[data-child-login-fields]');
    if (!toggle || !fields) return;
    toggle.addEventListener('change', () => {
      fields.hidden = !toggle.checked;
    });
  }

  function bindRemoveChild(block) {
    const btn = block.querySelector('.register-remove-child');
    if (btn) btn.addEventListener('click', () => { block.remove(); renumberChildren(); });
  }

  if (childrenList) {
    childrenList.querySelectorAll('[data-child-block]').forEach((block) => {
      bindChildLoginToggle(block);
      bindRemoveChild(block);
    });
    renumberChildren();
  }

  if (addChildBtn && childTemplate && childrenList) {
    addChildBtn.addEventListener('click', () => {
      const html = childTemplate.innerHTML.split('__INDEX__').join(String(childIndex));
      childIndex += 1;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html.trim();
      const block = wrapper.firstElementChild;
      childrenList.appendChild(block);
      bindChildLoginToggle(block);
      bindRemoveChild(block);
      renumberChildren();
    });
  }

  const adultsList = document.getElementById('member-family-adults');
  const addAdultBtn = document.getElementById('add-adult-btn');
  const adultTemplate = document.getElementById('adult-block-template');
  let adultIndex = adultsList ? adultsList.querySelectorAll('[data-adult-block]').length : 0;

  // Numbering starts at #2 since this page's own Parent/Guardian fields
  // (partials/member-edit-fields.ejs, above this section) are implicitly
  // #1 - same as portal-register-form.js's own renumberAdults.
  function renumberAdults() {
    if (!adultsList) return;
    adultsList.querySelectorAll('[data-adult-block]').forEach((block, i) => {
      const title = block.querySelector('[data-adult-title]');
      if (title) title.textContent = 'Parent/Guardian #' + (i + 2);
    });
  }

  function bindSameAddressToggle(block) {
    const toggle = block.querySelector('[data-adult-same-address-toggle]');
    const fields = block.querySelector('[data-adult-address-fields]');
    if (!toggle || !fields) return;
    toggle.addEventListener('change', () => {
      fields.hidden = toggle.checked;
    });
  }

  function bindAdultLoginToggle(block) {
    const toggle = block.querySelector('[data-adult-login-toggle]');
    const fields = block.querySelector('[data-adult-login-fields]');
    if (!toggle || !fields) return;
    toggle.addEventListener('change', () => {
      fields.hidden = !toggle.checked;
    });
  }

  function bindRemoveAdult(block) {
    const btn = block.querySelector('.register-remove-adult');
    if (btn) btn.addEventListener('click', () => { block.remove(); renumberAdults(); });
  }

  if (adultsList) {
    adultsList.querySelectorAll('[data-adult-block]').forEach((block) => {
      bindSameAddressToggle(block);
      bindAdultLoginToggle(block);
      bindRemoveAdult(block);
    });
    renumberAdults();
  }

  if (addAdultBtn && adultTemplate && adultsList) {
    addAdultBtn.addEventListener('click', () => {
      const html = adultTemplate.innerHTML.split('__INDEX__').join(String(adultIndex));
      adultIndex += 1;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html.trim();
      const block = wrapper.firstElementChild;
      adultsList.appendChild(block);
      bindSameAddressToggle(block);
      bindAdultLoginToggle(block);
      bindRemoveAdult(block);
      renumberAdults();
    });
  }
})();
