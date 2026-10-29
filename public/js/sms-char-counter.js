// A real request: "Set 160 character length for all texting features
// across the app." Shared by every texting feature's own compose box
// (Communication > Text, the Members/Setup-Cleanup/Floater quick-text
// popups) - each textarea just needs maxlength="160" (the browser
// itself blocks typing/pasting past that, so this is purely the live
// "N / 160 characters" label, never a validation gate) and
// data-sms-char-counter="<id of its own counter element>". Delegated to
// `document` (same pattern public/js/csrf.js already uses) so a
// textarea rendered into a dialog after this script runs - the Members
// quick-text popup is rendered once per row - is still live without a
// separate re-scan step.
(function () {
  function updateCounter(textarea) {
    const counterId = textarea.dataset.smsCharCounter;
    const counter = counterId && document.getElementById(counterId);
    if (!counter) return;
    const max = Number(textarea.getAttribute('maxlength')) || 160;
    const length = textarea.value.length;
    counter.textContent = `${length} / ${max} characters`;
    counter.classList.toggle('alert-error', length >= max);
  }

  document.querySelectorAll('[data-sms-char-counter]').forEach(updateCounter);

  document.addEventListener('input', (e) => {
    if (e.target.matches('[data-sms-char-counter]')) updateCounter(e.target);
  });
})();
