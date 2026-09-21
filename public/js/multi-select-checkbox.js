// Powers every views/partials/multi-select-checkbox.ejs instance - a real
// request, with a reference screenshot: "ages and grade choices on event
// and class forms should be dropdown menus with checkboxes and ability
// to choose multiple checkboxes... this will be more condensed." Each
// [data-multi-select] wraps a normal checkbox list, kept exactly as
// before (same name/value/checked attributes) so every existing route
// reading req.body.ageGroup etc. via [].concat(req.body.x || []) needs no
// changes at all - this only changes how the list is PRESENTED: closed
// behind a text-input-like trigger that shows a removable chip per
// currently-checked option, opening the real checkbox list on click.
//
// Every listener here is delegated on `document` rather than attached to
// specific elements, including chip removal (matched by each checkbox's
// position among its own panel's checkboxes, not its value - no
// CSS.escape-style quoting needed for a value containing a quote or
// backslash). That's deliberate, not just style: views/class-schedule-
// view-fragment.ejs's own [data-multi-select] is injected into a dialog
// by fetch() (public/js/class-schedule-view.js) long after this script's
// one-time page-load pass runs, so anything attached only at that pass
// would never reach it.
(function () {
  if (window.__multiSelectCheckboxInstalled) return;
  window.__multiSelectCheckboxInstalled = true;

  function panelFor(root) {
    return root.querySelector('[data-multi-select-panel]');
  }

  function closePanel(root) {
    var panel = panelFor(root);
    var trigger = root.querySelector('.multi-select-trigger');
    if (panel) panel.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }

  function rebuildChips(root) {
    var chips = root.querySelector('[data-multi-select-chips]');
    var panel = panelFor(root);
    if (!chips || !panel) return;
    var allCheckboxes = Array.prototype.slice.call(panel.querySelectorAll('input[type="checkbox"]'));
    var checked = allCheckboxes.filter(function (cb) { return cb.checked; });
    chips.innerHTML = '';
    if (checked.length === 0) {
      var placeholder = document.createElement('span');
      placeholder.className = 'multi-select-placeholder';
      placeholder.textContent = root.getAttribute('data-multi-select-placeholder') || 'Select…';
      chips.appendChild(placeholder);
      return;
    }
    checked.forEach(function (cb) {
      var label = cb.closest('label');
      var text = label ? label.textContent.trim() : cb.value;
      var chip = document.createElement('span');
      chip.className = 'multi-select-chip';
      chip.appendChild(document.createTextNode(text + ' '));
      // A <span role="button">, not a real <button> - see multi-select-
      // checkbox.ejs's own comment on why a real one can't nest inside
      // .multi-select-trigger (itself a <button>) without the browser's
      // parser silently kicking every chip after the first one out of
      // the trigger entirely.
      var remove = document.createElement('span');
      remove.className = 'multi-select-chip-remove';
      remove.setAttribute('role', 'button');
      remove.setAttribute('tabindex', '0');
      remove.setAttribute('aria-label', 'Remove ' + text);
      remove.setAttribute('data-multi-select-remove-index', String(allCheckboxes.indexOf(cb)));
      remove.textContent = '×';
      chip.appendChild(remove);
      chips.appendChild(chip);
    });
  }

  document.querySelectorAll('[data-multi-select]').forEach(rebuildChips);

  document.addEventListener('change', function (e) {
    if (e.target.type !== 'checkbox') return;
    var panel = e.target.closest('[data-multi-select-panel]');
    if (!panel) return;
    rebuildChips(panel.closest('[data-multi-select]'));
  });

  document.addEventListener('click', function (e) {
    var removeBtn = e.target.closest('[data-multi-select-remove-index]');
    if (removeBtn) {
      e.stopPropagation();
      var root = removeBtn.closest('[data-multi-select]');
      var panel = panelFor(root);
      var idx = parseInt(removeBtn.getAttribute('data-multi-select-remove-index'), 10);
      var cb = panel.querySelectorAll('input[type="checkbox"]')[idx];
      if (cb && !cb.disabled) {
        cb.checked = false;
        rebuildChips(root);
      }
      return;
    }

    var trigger = e.target.closest('.multi-select-trigger');
    if (trigger) {
      var triggerRoot = trigger.closest('[data-multi-select]');
      var triggerPanel = panelFor(triggerRoot);
      var willOpen = triggerPanel.hidden;
      document.querySelectorAll('[data-multi-select]').forEach(function (other) {
        if (other !== triggerRoot) closePanel(other);
      });
      triggerPanel.hidden = !willOpen;
      trigger.setAttribute('aria-expanded', String(willOpen));
      return;
    }

    if (!e.target.closest('[data-multi-select]')) {
      document.querySelectorAll('[data-multi-select]').forEach(closePanel);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var open = document.querySelector('[data-multi-select] [data-multi-select-panel]:not([hidden])');
      if (open) closePanel(open.closest('[data-multi-select]'));
      return;
    }
    // The chip remove control is role="button" on a <span>, not a real
    // <button> (see rebuildChips()'s own comment on why) - a real button
    // gets Enter/Space-activates-click for free from the browser, this
    // needs it wired up by hand.
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var removeBtn = e.target.closest('[data-multi-select-remove-index]');
    if (!removeBtn) return;
    e.preventDefault();
    removeBtn.click();
  });
})();
