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
    if (btn) btn.addEventListener('click', () => block.remove());
  }

  if (childrenList) {
    childrenList.querySelectorAll('[data-child-block]').forEach((block) => {
      bindLoginToggle(block);
      bindRemove(block);
    });
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
    });
  }
})();
