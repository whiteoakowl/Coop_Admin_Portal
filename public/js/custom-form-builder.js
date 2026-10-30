// Main Admin Forms builder - small bits of dialog interactivity that
// don't need a full page reload: picking a field type from the palette
// (views/admin-custom-forms-builder.ejs's own .cf-type-palette) and
// showing/hiding the right detail rows for it (options list only for a
// choice field, no required/placeholder/default for a display-only
// heading/paragraph), and the conditional-logic rule builder's own
// "only show the operator/value once a controlling field is picked"
// behavior. Reordering itself is handled entirely by public/js/
// homepage-block-reorder.js (reused as-is, not duplicated here) and
// live preview by public/js/custom-form-runtime.js (also reused as-is
// in this same page) - this file is only the dialog-field plumbing
// those two don't cover.
(function () {
  if (window.__customFormBuilderInstalled) return;
  window.__customFormBuilderInstalled = true;

  var CHOICE_TYPES = ['single_choice', 'multiple_choice', 'dropdown'];
  var DISPLAY_ONLY_TYPES = ['heading', 'paragraph'];

  function fieldTypeOf(dialog) {
    var checked = dialog.querySelector('input[name="fieldType"]:checked');
    return checked ? checked.value : null;
  }

  // Shows/hides a dialog's own options-list, required toggle, and
  // placeholder/default-value rows to match the currently selected (or,
  // on the edit dialog, already-saved) field type - same shape the
  // original builder's inline onchange already used for the options
  // textarea, just generalized over every row a type can hide.
  function syncDialogForType(dialog, type) {
    var isChoice = CHOICE_TYPES.indexOf(type) !== -1;
    var isDisplayOnly = DISPLAY_ONLY_TYPES.indexOf(type) !== -1;
    dialog.querySelectorAll('[data-cf-row="options"]').forEach(function (el) { el.style.display = isChoice ? '' : 'none'; });
    dialog.querySelectorAll('[data-cf-row="required"], [data-cf-row="placeholder"], [data-cf-row="default"]').forEach(function (el) {
      el.style.display = isDisplayOnly ? 'none' : '';
    });
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.cf-type-btn');
    if (!btn) return;
    var dialog = btn.closest('dialog');
    var input = btn.querySelector('input[name="fieldType"]');
    if (!input || !dialog) return;
    dialog.querySelectorAll('.cf-type-btn').forEach(function (b) { b.classList.remove('cf-type-btn-selected'); });
    input.checked = true;
    btn.classList.add('cf-type-btn-selected');
    syncDialogForType(dialog, input.value);
  });

  // Conditional-logic rule builder: the operator/value rows only matter
  // once a "depends on this field" target is actually chosen - "no
  // target" is exactly how a field/page with no conditional_logic row
  // at all (always visible) gets represented in both dialogs.
  function syncConditionRows(dialog) {
    var select = dialog.querySelector('[data-cf-condition-field]');
    if (!select) return;
    var hasTarget = !!select.value;
    dialog.querySelectorAll('[data-cf-condition-row]').forEach(function (el) { el.style.display = hasTarget ? '' : 'none'; });
  }

  // Parsed once from the builder page's own #cf-field-meta JSON blob
  // (admin-custom-forms-builder.ejs) - {fieldId: {type, options:
  // [label,...]}} for every field in the form, so the rule-builder can
  // swap the free-text "value" input for a real <select> of that
  // field's own choices the moment a choice-type (or checkbox) field is
  // picked as the condition's target. Both inputs share the same
  // `name="conditionValue"`; only the visible one is ever enabled, so
  // only it is ever actually submitted.
  var fieldMeta = {};
  try {
    var metaEl = document.getElementById('cf-field-meta');
    if (metaEl) fieldMeta = JSON.parse(metaEl.textContent);
  } catch (err) {
    fieldMeta = {};
  }

  function syncConditionValueInput(dialog) {
    var select = dialog.querySelector('[data-cf-condition-field]');
    var textInput = dialog.querySelector('[data-cf-condition-value-text]');
    var optionSelect = dialog.querySelector('[data-cf-condition-value-select]');
    if (!select || !textInput || !optionSelect) return;
    var meta = fieldMeta[select.value];
    var currentValue = textInput.value || optionSelect.value;

    if (meta && meta.type === 'checkbox') {
      optionSelect.innerHTML = '<option value="1">Yes (checked)</option><option value="0">No (unchecked)</option>';
    } else if (meta && meta.options && meta.options.length) {
      optionSelect.innerHTML = meta.options.map(function (label) { return '<option value="' + label.replace(/"/g, '&quot;') + '">' + label + '</option>'; }).join('');
    }

    var useSelect = !!(meta && (meta.type === 'checkbox' || (meta.options && meta.options.length)));
    optionSelect.disabled = !useSelect;
    optionSelect.style.display = useSelect ? '' : 'none';
    textInput.disabled = useSelect;
    textInput.style.display = useSelect ? 'none' : '';
    if (useSelect && currentValue) optionSelect.value = currentValue;
    else if (!useSelect) textInput.value = currentValue;
  }

  document.addEventListener('change', function (e) {
    if (e.target.matches('[data-cf-condition-field]')) {
      syncConditionRows(e.target.closest('dialog'));
      syncConditionValueInput(e.target.closest('dialog'));
    }
  });

  // Run once for every already-open-in-the-DOM dialog on load (each
  // <dialog> exists in the page from the start, just not shown yet) so
  // an edit dialog for an existing heading/paragraph field, or one that
  // already has a condition set, opens already in the right state
  // rather than flashing the wrong rows for a moment.
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('dialog').forEach(function (dialog) {
      var checkedInput = dialog.querySelector('input[name="fieldType"]:checked');
      if (checkedInput) {
        var btn = checkedInput.closest('.cf-type-btn');
        if (btn) btn.classList.add('cf-type-btn-selected');
      }
      var type = fieldTypeOf(dialog) || dialog.getAttribute('data-cf-field-type');
      if (type) syncDialogForType(dialog, type);
      syncConditionRows(dialog);
      syncConditionValueInput(dialog);
    });
  });
})();
