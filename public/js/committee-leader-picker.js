// Committees' own "Add Committee"/"Edit Committee" dialogs - a real
// request: "adding a leader should be a drop down list of admin
// positions. Choose an admin and the leaders name and email address
// appears below." The <select> itself already lists one <option> per
// current position-holder (grouped by position via <optgroup> - see
// views/main-admin-volunteers.ejs and main-admin-committee-detail.ejs's
// own comment on why it's holders, not position titles, since exactly one
// person has to end up as "the leader"), each option's own data-email
// carrying that person's email; this just echoes the selected option's
// own text/data-email into the small readout beneath it.
(function () {
  document.querySelectorAll('.committee-leader-select').forEach((select) => {
    const readout = select.closest('.committee-leader-picker').querySelector('.committee-leader-email');
    if (!readout) return;
    function sync() {
      const option = select.selectedOptions[0];
      if (!option || !option.value) {
        readout.textContent = '';
        return;
      }
      readout.textContent = option.dataset.email ? `${option.textContent} — ${option.dataset.email}` : option.textContent;
    }
    select.addEventListener('change', sync);
    sync();
  });
})();
