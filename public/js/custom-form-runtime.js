// Custom Forms - plain-JS conditional logic + multi-page navigation,
// shared by the public fill-out page (views/custom-forms-fill.ejs) and
// the Main Admin builder's own live preview panel (views/admin-custom-
// forms-builder.ejs). A real request: "Main admin portal, forms tab.
// Should have full editing features and view just like jotform.
// Exactly" - conditional "only show when" logic and a multi-page wizard
// with a progress indicator, both driven by plain DOM/events, no new
// library (same no-dependency rule public/js/homepage-block-reorder.js
// and public/js/lesson-drag-reorder.js already follow).
//
// evaluateCondition below is a deliberate line-for-line mirror of
// utils/customForms.js's own evaluateCondition - the one place a
// conditional rule's meaning is defined, kept in sync by hand since
// there's no shared build step between server and browser code in this
// app. Any change to one must be made to the other.
(function () {
  if (window.__customFormRuntimeInstalled) return;
  window.__customFormRuntimeInstalled = true;

  function evaluateCondition(rule, valuesByFieldId) {
    if (!rule) return true;
    var raw = valuesByFieldId[rule.fieldId];
    var values = (Array.isArray(raw) ? raw : [raw]).map(function (v) {
      return v === undefined || v === null ? '' : String(v);
    });
    var needle = (rule.value || '').toLowerCase();
    switch (rule.operator) {
      case 'equals':
        return values.some(function (v) { return v.toLowerCase() === needle; });
      case 'not_equals':
        return !values.some(function (v) { return v.toLowerCase() === needle; });
      case 'contains':
        return values.some(function (v) { return v.toLowerCase().indexOf(needle) !== -1; });
      case 'is_answered':
        return values.some(function (v) { return v.trim() !== ''; });
      case 'is_blank':
        return !values.some(function (v) { return v.trim() !== ''; });
      default:
        return true;
    }
  }

  // Reads every field currently in the DOM into {fieldId: value}, in
  // the exact same shape routes/custom-forms.js's own rawValueForField
  // builds server-side (a plain string for most types, an array of
  // selected option LABELS for a multiple_choice group - never ids,
  // since a conditional rule's own `value` is always a label).
  function collectValues(form) {
    var values = {};
    form.querySelectorAll('[data-cf-field-id]').forEach(function (wrapper) {
      var fieldId = wrapper.getAttribute('data-cf-field-id');
      var inputs = wrapper.querySelectorAll('input, select, textarea');
      if (inputs.length === 0) return;
      var first = inputs[0];
      if (first.type === 'checkbox' && first.hasAttribute('data-option-label')) {
        values[fieldId] = Array.prototype.slice.call(inputs).filter(function (i) { return i.checked; }).map(function (i) { return i.getAttribute('data-option-label'); });
      } else if (first.type === 'checkbox') {
        values[fieldId] = first.checked ? '1' : '0';
      } else if (first.type === 'radio') {
        var checked = Array.prototype.slice.call(inputs).find(function (i) { return i.checked; });
        values[fieldId] = checked ? checked.value : '';
      } else {
        values[fieldId] = first.value || '';
      }
    });
    return values;
  }

  function parseCondition(el) {
    var raw = el.getAttribute('data-cf-condition');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  // Applies every field's and every page's own conditional_logic rule
  // against the form's current values - called on load and on every
  // change/input event inside the form, so showing/hiding is genuinely
  // live as a respondent fills it in (and in the builder preview, as an
  // admin edits a field's values there).
  function applyConditions(form) {
    var values = collectValues(form);
    form.querySelectorAll('[data-cf-condition]').forEach(function (el) {
      var visible = evaluateCondition(parseCondition(el), values);
      el.classList.toggle('cf-hidden', !visible);
      el.querySelectorAll('input, select, textarea').forEach(function (input) {
        input.disabled = !visible && !input.hasAttribute('data-cf-keep-enabled');
      });
    });
    return values;
  }

  function pageIsVisible(page) {
    return !page.classList.contains('cf-hidden');
  }

  // Multi-page navigation - Next/Back move between .cf-page sections,
  // skipping over any page a section-level conditional rule just hid
  // (applyConditions already ran and toggled .cf-hidden before this is
  // called), and keep the progress indicator's active step in sync.
  function setupPaging(form) {
    var pages = Array.prototype.slice.call(form.querySelectorAll('.cf-page'));
    if (pages.length <= 1) return;
    var progressSteps = Array.prototype.slice.call(form.querySelectorAll('[data-cf-progress-step]'));

    function showPage(index) {
      pages.forEach(function (p, i) { p.classList.toggle('cf-page-active', i === index); });
      var activePage = pages[index];
      var pageId = activePage ? activePage.getAttribute('data-cf-page') : null;
      progressSteps.forEach(function (step) {
        step.classList.toggle('cf-progress-step-active', step.getAttribute('data-cf-progress-step') === pageId);
      });
      if (activePage) activePage.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function currentIndex() {
      return pages.findIndex(function (p) { return p.classList.contains('cf-page-active'); });
    }

    form.addEventListener('click', function (e) {
      var nextBtn = e.target.closest('[data-cf-next]');
      var prevBtn = e.target.closest('[data-cf-prev]');
      if (!nextBtn && !prevBtn) return;
      e.preventDefault();
      var idx = currentIndex();
      if (nextBtn) {
        // Required fields on the CURRENT, visible page must be filled
        // before moving on - a plain native checkValidity() pass over
        // just this page's own inputs (the browser already skips a
        // disabled/hidden input's own validity, so a conditionally-
        // hidden required field never blocks Next).
        var current = pages[idx];
        var invalid = Array.prototype.slice.call(current.querySelectorAll('input, select, textarea')).find(function (input) {
          return !input.disabled && !input.checkValidity();
        });
        if (invalid) {
          invalid.reportValidity();
          return;
        }
        for (var next = idx + 1; next < pages.length; next += 1) {
          if (pageIsVisible(pages[next])) return showPage(next);
        }
      } else if (prevBtn) {
        for (var prev = idx - 1; prev >= 0; prev -= 1) {
          if (pageIsVisible(pages[prev])) return showPage(prev);
        }
      }
    });

    // If page 1 itself starts out hidden by its own conditional rule
    // (an edge case, but possible), jump straight to the first visible
    // one on load.
    if (!pageIsVisible(pages[0])) {
      for (var i = 1; i < pages.length; i += 1) {
        if (pageIsVisible(pages[i])) {
          showPage(i);
          break;
        }
      }
    }
  }

  function init(form) {
    applyConditions(form);
    form.addEventListener('change', function () { applyConditions(form); });
    form.addEventListener('input', function () { applyConditions(form); });
    setupPaging(form);
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-cf-form]').forEach(init);
  });

  // Exposed for the builder's own live-preview panel, which re-renders
  // this same markup into a container that may be swapped out after a
  // save (a full page reload, same as every other builder action in
  // this app) - nothing else needs this, but it's cheap to expose.
  window.CustomFormRuntime = { evaluateCondition: evaluateCondition, collectValues: collectValues, init: init };
})();
