// Keeps each hidden startsAt/endsAt/registrationOpensAt/registrationClosesAt
// input (views/admin-events-builder.ejs) in sync with its own calendar date
// input + time-of-day <select> (partials/date-range-picker.ejs, partials/
// time-select.ejs) - a real request: "date picker should be a calendar.
// Start and end time should be separate drop down menus," later "start
// date and end date picker should be on the same row next to each other,
// stacked below start time and end time... in the same row" (a Dates row
// above a Times row, rather than each field's own date+time pair
// together, so the date input and its own time select are no longer
// necessarily siblings - matched up here purely by their shared
// data-date-time-group instead). The hidden input is what actually
// submits, in the same "YYYY-MM-DDTHH:MM" shape a datetime-local input
// always produced, so the server-side route needs no changes at all.
(function () {
  document.querySelectorAll('[data-date-time-date]').forEach(function (dateInput) {
    var group = dateInput.dataset.dateTimeGroup;
    var timeSelect = document.querySelector('[data-date-time-time][data-date-time-group="' + group + '"]');
    var hidden = document.querySelector('[data-date-time-hidden="' + group + '"]');
    if (!timeSelect || !hidden) return;

    function sync() {
      hidden.value = dateInput.value && timeSelect.value ? dateInput.value + 'T' + timeSelect.value : '';
    }
    dateInput.addEventListener('change', sync);
    timeSelect.addEventListener('change', sync);
  });
})();
