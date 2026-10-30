// Public self-registration form (views/portal-register.ejs) - lets a
// family add any number of "Child" blocks the same way the admin-entered
// Membership Form does (see public/js/membership-form.js, the pattern
// this mirrors), plus a per-child "give this student their own portal
// login" checkbox that reveals/hides that child's own email+password
// fields. Unlike membership-form.js's children (always at least one
// block), a child block here is entirely optional, so there's no
// "hide the remove button on the last block" rule - any number,
// including zero, is a valid submission.
(function () {
  const form = document.getElementById('portal-register-form');
  if (!form) return;

  const childrenList = document.getElementById('register-children');
  const addChildBtn = document.getElementById('add-child-btn');
  const template = document.getElementById('register-child-template');
  let childIndex = childrenList ? childrenList.querySelectorAll('[data-child-block]').length : 0;

  // A real request: "Put double title back but it should say parent/
  // guardian #2, #3 etc. Same for children" - every child lives in this
  // one dynamic list with no separate "Child #1" elsewhere on the page
  // (unlike an additional parent, continuing on from the Parent/Guardian
  // section above - see renumberAdults below), so numbering here starts
  // at #1. Recomputed from each block's own DOM position (not the
  // array `index` baked into its field names, which never shifts once a
  // block is removed) so removing one from the middle of the list closes
  // the gap instead of leaving a missing number behind.
  function renumberChildren() {
    if (!childrenList) return;
    childrenList.querySelectorAll('[data-child-block]').forEach((block, i) => {
      const title = block.querySelector('[data-child-title]');
      if (title) title.textContent = 'Child #' + (i + 1);
    });
  }

  function bindLoginToggle(block) {
    const toggle = block.querySelector('[data-child-login-toggle]');
    const fields = block.querySelector('[data-child-login-fields]');
    if (!toggle || !fields) return;
    toggle.addEventListener('change', () => {
      fields.hidden = !toggle.checked;
    });
  }

  function bindRemove(block) {
    const btn = block.querySelector('.register-remove-child');
    if (btn) btn.addEventListener('click', () => { block.remove(); renumberChildren(); });
  }

  if (childrenList) {
    childrenList.querySelectorAll('[data-child-block]').forEach((block) => {
      bindLoginToggle(block);
      bindRemove(block);
    });
    renumberChildren();
  }

  if (addChildBtn && template && childrenList) {
    addChildBtn.addEventListener('click', () => {
      const html = template.innerHTML.split('__INDEX__').join(String(childIndex));
      childIndex++;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html.trim();
      const block = wrapper.firstElementChild;
      childrenList.appendChild(block);
      bindLoginToggle(block);
      bindRemove(block);
      renumberChildren();
    });
  }

  // A real request: "There is a +child button. There should also be an
  // add adult button." Same clone-a-<template> pattern as the children
  // block above, plus the "Address is the same" checkbox's own show/hide
  // (partials/register-adult-fields.ejs's own data-adult-same-address-
  // toggle/data-adult-address-fields) - no server round-trip needed to
  // hide those fields, same as a child's own login-fields toggle.
  const adultsList = document.getElementById('register-adults');
  const addAdultBtn = document.getElementById('add-adult-btn');
  const adultTemplate = document.getElementById('register-adult-template');
  let adultIndex = adultsList ? adultsList.querySelectorAll('[data-adult-block]').length : 0;

  // A real request: "Put double title back but it should say parent/
  // guardian #2, #3 etc." - numbering starts at #2 since the
  // Parent/Guardian section at the top of the form is implicitly #1.
  // Same DOM-position-based recompute as renumberChildren above, for the
  // same "stays correct after a block is removed from the middle of the
  // list" reason.
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

  // A real request: "For add an adult, also add check box for give this
  // parent their own portal log in" - same show/hide pattern as a
  // child's own bindLoginToggle above.
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
      adultIndex++;
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

  // A real request: "can't check the box until you have scrolled
  // through the entire handbook." The checkbox starts `disabled` (see
  // views/portal-register.ejs) so it can't be checked at all until this
  // fires - scrollHeight - clientHeight - scrollTop hitting ~0 is the
  // standard "scrolled to the bottom" check; the 4px slack absorbs sub-
  // pixel rounding some browsers introduce on fractional zoom levels. A
  // handbook short enough to never need scrolling (scrollHeight <=
  // clientHeight) enables the checkbox immediately instead of trapping
  // the visitor behind a scrollbar that isn't there.
  const scrollBox = document.getElementById('handbook-scroll-box');
  const handbookCheckbox = document.getElementById('handbook-read-checkbox');
  const scrollHint = document.getElementById('handbook-scroll-hint');
  if (scrollBox && handbookCheckbox) {
    function checkScrolled() {
      const atBottom = scrollBox.scrollHeight - scrollBox.clientHeight <= scrollBox.scrollTop + 4;
      if (atBottom) {
        handbookCheckbox.disabled = false;
        if (scrollHint) scrollHint.hidden = true;
      }
    }
    scrollBox.addEventListener('scroll', checkScrolled);
    checkScrolled();
  }
})();
