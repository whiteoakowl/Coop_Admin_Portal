// Keeps each hidden startsAt/endsAt input (views/admin-events-builder.ejs)
// in sync with its own visible calendar date input + time-of-day <select>
// pair (partials/time-select.ejs) - a real request: "date picker should be
// a calendar. Start and end time should be separate drop down menus."
// The hidden input is what actually submits, in the same
// "YYYY-MM-DDTHH:MM" shape a datetime-local input always produced, so the
// server-side route needs no changes at all.
(function () {
  document.querySelectorAll('[data-date-time-picker]').forEach(function (wrap) {
    var group = wrap.querySelector('[data-date-time-date]').dataset.dateTimeGroup;
    var dateInput = wrap.querySelector('[data-date-time-date][data-date-time-group="' + group + '"]');
    var timeSelect = wrap.querySelector('[data-date-time-time][data-date-time-group="' + group + '"]');
    var hidden = wrap.parentElement.querySelector('[data-date-time-hidden="' + group + '"]');
    if (!dateInput || !timeSelect || !hidden) return;

    function sync() {
      hidden.value = dateInput.value && timeSelect.value ? dateInput.value + 'T' + timeSelect.value : '';
    }
    dateInput.addEventListener('change', sync);
    timeSelect.addEventListener('change', sync);
  });
})();
