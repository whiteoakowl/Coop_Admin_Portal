// Powers the Setup/Cleanup Assignments page's per-team "Edit"/"Save"/
// "Cancel" cards (views/partials/setup-assignment-cards.ejs) - a real
// request: each card should stay frozen (plain "Task 1"/"Task 2" text,
// no dropdowns) until its own Edit is clicked, then save every member's
// picks for THAT card together in one request instead of the old
// one-dropdown-auto-submits-on-its-own flow. Both the static text and
// the <select> for every slot are always present in the DOM (the EJS
// partial renders both) - this file only ever toggles a class on the
// card, it never builds or fetches any markup itself, so print and a
// no-JS view still show a real value.
//
// Guarded against double-install the same way public/js/archive-select-
// toggle.js is - this same partial (and so this same <script> tag) can
// legitimately render more than once on one page load in some contexts,
// and event delegation on `document` would otherwise double-fire every
// click/change once per extra copy.
(function () {
  if (window.__setupAssignmentCardsInstalled) return;
  window.__setupAssignmentCardsInstalled = true;

  function card(el) {
    return el.closest('.floater-card');
  }

  // A real request: once a task is picked for one member, it should stop
  // being offered to anyone else on the SAME card while the admin is
  // still mid-edit - not just after Save reloads the page with the
  // server's own already-filtered lists (routes/admin-setup.js's
  // taskOptionsExcludingAssignedElsewhere), which only reflects what was
  // true before this editing session started. Re-run on every change so
  // picking a task in one dropdown immediately grays it out (still
  // visible, just unselectable) in every other dropdown on this card -
  // except the one dropdown that already holds it, which always keeps
  // its own current value selectable.
  function refreshExclusions(cardEl) {
    var selects = cardEl.querySelectorAll('.setup-task-select');
    var holderBySelect = {};
    for (var i = 0; i < selects.length; i++) {
      if (selects[i].value) holderBySelect[selects[i].value] = selects[i];
    }
    for (var j = 0; j < selects.length; j++) {
      var select = selects[j];
      var options = select.querySelectorAll('option');
      for (var k = 0; k < options.length; k++) {
        var opt = options[k];
        if (!opt.value) continue; // "— No suggestion —" is always available
        var holder = holderBySelect[opt.value];
        opt.disabled = !!holder && holder !== select;
      }
    }
  }

  function enterEdit(cardEl) {
    cardEl.classList.add('setup-card-editing');
    refreshExclusions(cardEl);
  }

  function cancelEdit(cardEl) {
    var form = cardEl.querySelector('form');
    if (form) form.reset();
    cardEl.classList.remove('setup-card-editing');
    // A reset select can leave a stale disabled option from mid-edit
    // (e.g. one that was disabled because another dropdown had since-
    // reverted picks) - re-run once more so re-opening Edit later starts
    // from a clean slate rather than carrying over this session's state.
    if (form) refreshExclusions(cardEl);
  }

  document.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit-card]');
    if (editBtn) {
      enterEdit(card(editBtn));
      return;
    }
    const cancelBtn = e.target.closest('[data-cancel-card]');
    if (cancelBtn) {
      cancelEdit(card(cancelBtn));
    }
  });

  document.addEventListener('change', (e) => {
    const select = e.target.closest('.setup-task-select');
    if (!select) return;
    const cardEl = card(select);
    if (cardEl) refreshExclusions(cardEl);
  });
})();
