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

  // A real request: "the phone number field is far away from the
  // request, should there be another phone number bar close to the
  // permissions" - echoes the real phone field's live value next to the
  // SMS opt-in checkbox (see views/portal-register.ejs's own comment on
  // #sms-opt-in-phone-echo), so that section alone shows a reviewer both
  // the phone number and the opt-in language together.
  const phoneInput = document.getElementById('register-phone-input');
  const phoneEcho = document.getElementById('sms-opt-in-phone-echo');
  if (phoneInput && phoneEcho) {
    function updatePhoneEcho() {
      const value = phoneInput.value.trim();
      phoneEcho.textContent = value || '(enter your phone number above)';
    }
    phoneInput.addEventListener('input', updatePhoneEcho);
    updatePhoneEcho();
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
