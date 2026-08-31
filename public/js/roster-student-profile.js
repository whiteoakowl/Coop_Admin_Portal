// A real request: "on mobile view, class roster... have small organized
// cards for each student. listing name, grade, email button, trash can
// button. when you click on each student on the roster it will popup the
// parents information... their full information, birthday, grade level,
// signup date and time." Desktop already shows every one of those fields
// inline (views/partials/roster-student-row.ejs's own .roster-log-meta),
// so the click-to-open-profile affordance only makes sense - and only
// applies - once styles.css's own max-width:640px block has actually
// collapsed the row down to that compact card; the same matchMedia guard
// public/js/roster-btn-row-grid.js already uses for its own mobile-only
// behavior.
(function () {
  const FIELDS = ['name', 'family', 'grade', 'birthday', 'registered', 'parent-name', 'parent-phone', 'parent-email'];

  function isMobile() {
    return window.matchMedia('(max-width: 640px)').matches;
  }

  function openProfile(card) {
    const dialog = document.getElementById(card.dataset.profileDialog);
    if (!dialog) return;
    FIELDS.forEach((field) => {
      const value = card.dataset[field.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] || '';
      const target = dialog.querySelector(`[data-profile-field="${field}"]`);
      if (target) target.textContent = value;
      const row = dialog.querySelector(`[data-profile-row="${field}"]`);
      if (row) row.hidden = !value;
    });
    dialog.showModal();
  }

  document.addEventListener('click', (e) => {
    if (!isMobile()) return;
    const card = e.target.closest('[data-roster-student-card]');
    if (!card || e.target.closest('a, form, button')) return;
    openProfile(card);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!isMobile()) return;
    const card = e.target.closest('[data-roster-student-card]');
    if (!card || e.target.closest('a, form, button')) return;
    e.preventDefault();
    openProfile(card);
  });
})();
