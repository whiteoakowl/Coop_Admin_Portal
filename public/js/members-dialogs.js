// Members page: the Cards and Schedule dialogs on each row are fetched on
// open rather than server-rendered for all N members on every page load -
// see routes/admin-members.js's /members/:id/cards-fragment and
// /members/:id/schedule-fragment, and admin-members.ejs's own comment on
// why (this used to mean a getMemberSchedule() query and two
// renderBadgeElements() calls per member, whether or not anyone ever
// opened either dialog). Uses the same shared window.loadFragmentIntoDialog
// helper (public/js/fragment-dialog.js) as the Class Schedule/Floater
// Archive/Roster Archive view popups. The Notes dialog is unaffected -
// member.notes is already part of the base row query, nothing extra to
// defer there.
(function () {
  if (!window.loadFragmentIntoDialog) return;

  document.addEventListener('click', (e) => {
    const cardsBtn = e.target.closest('[data-view-cards]');
    if (cardsBtn) {
      const id = cardsBtn.getAttribute('data-view-cards');
      const dialog = document.getElementById(`cards-dialog-${id}`);
      if (!dialog) return;
      window
        .loadFragmentIntoDialog(dialog, `/admin/members/${id}/cards-fragment`)
        .then(() => {
          if (window.renderNameTagBarcodes) window.renderNameTagBarcodes(dialog);
        })
        .catch(() => {});
      return;
    }

    const scheduleBtn = e.target.closest('[data-view-schedule]');
    if (scheduleBtn) {
      const id = scheduleBtn.getAttribute('data-view-schedule');
      const dialog = document.getElementById(`schedule-dialog-${id}`);
      if (!dialog) return;
      window.loadFragmentIntoDialog(dialog, `/admin/members/${id}/schedule-fragment`).catch(() => {});
    }
  });
})();
