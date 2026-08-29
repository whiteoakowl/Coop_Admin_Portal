// Small reusable "type a tag, press Enter, get a removable chip" widget -
// [data-tag-input="fieldName"] marks the wrapper, a plain text input
// inside it is where the admin types. Each confirmed tag becomes a
// hidden input named `fieldName` (repeated, one per tag - the exact
// shape [].concat(body.fieldName || []) already expects everywhere else
// in this app that submits a multi-value field, e.g. the class/event
// grade-checkbox grids), so the server side needs no new parsing logic.
(function () {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function addChip(wrap, fieldName, input, value) {
    const text = value.trim();
    if (!text) return;
    const chip = document.createElement('span');
    chip.className = 'tag-input-chip';
    chip.innerHTML =
      `<span>${escapeHtml(text)}</span>` +
      '<button type="button" aria-label="Remove tag">&times;</button>' +
      `<input type="hidden" name="${escapeHtml(fieldName)}" value="${escapeHtml(text)}" />`;
    chip.querySelector('button').addEventListener('click', () => chip.remove());
    wrap.insertBefore(chip, input);
  }

  document.querySelectorAll('[data-tag-input]').forEach((wrap) => {
    const fieldName = wrap.getAttribute('data-tag-input');
    const input = wrap.querySelector('.tag-input-field');
    if (!input) return;

    // Editing an event that already has tags: the server renders each
    // existing tag as a placeholder <span data-initial-tag="..."> (plain
    // text, not yet a real chip - EJS has no access to this file's own
    // escapeHtml/DOM-building) - hydrate those into real chips once, in
    // order, then drop the placeholders.
    wrap.querySelectorAll('[data-initial-tag]').forEach((placeholder) => {
      addChip(wrap, fieldName, input, placeholder.getAttribute('data-initial-tag') || '');
      placeholder.remove();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addChip(wrap, fieldName, input, input.value);
        input.value = '';
      } else if (e.key === 'Backspace' && !input.value) {
        // Backspacing on an empty field deletes the most recently added
        // chip - the usual chip-input convention, and the only way to
        // remove one without reaching for the mouse.
        const chips = wrap.querySelectorAll('.tag-input-chip');
        if (chips.length) chips[chips.length - 1].remove();
      }
    });
    // Losing focus with unconfirmed text still in the field commits it as
    // a tag rather than silently discarding what was typed.
    input.addEventListener('blur', () => {
      if (input.value.trim()) {
        addChip(wrap, fieldName, input, input.value);
        input.value = '';
      }
    });
  });
})();
