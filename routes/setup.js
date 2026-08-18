const express = require('express');
const router = express.Router();
const { isValidDay, DAY_LABELS } = require('../utils/days');
const { closestUpcomingDate, formatDateLabel } = require('../utils/dates');
const { datesForDay, assignmentCardsForDate } = require('../utils/setup');

// A real request: the kiosk homepage's Setup/Cleanup button used to jump
// straight to a single auto-picked day - now it shows Monday/Wednesday
// choice buttons first, same "pick a day" step Class Check-In's own kiosk
// flow already uses, and lands on that day's assignment cards (below)
// after.
router.get('/setup', (req, res) => {
  res.render('kiosk-day-picker', { title: 'Setup/Cleanup Assignments', heading: 'Setup/Cleanup Assignments', basePath: '/setup', icon: 'icon-broom' });
});

// Public, no-login kiosk-style view: a real request - "the member view of
// the assignment cards for the current day or the closest date coming
// up" - the same per-team, per-member Task 1/Task 2 assignment cards the
// admin Setup/Cleanup Assignments tab shows (partials/setup-assignment-
// cards.ejs, editable: false here - read-only, same "reassigning happens
// on the live/admin tab, not here" rule as the Floater Assignments public
// page), not the standing Teams roster this route used to show instead.
router.get('/setup/:day', async (req, res) => {
  const day = req.params.day;
  if (!isValidDay(day)) return res.status(404).render('404', { title: 'Not Found' });

  const date = closestUpcomingDate(await datesForDay(day));
  const cards = date ? await assignmentCardsForDate(day, date) : [];

  res.render('setup-public', {
    title: `${DAY_LABELS[day]} Setup/Cleanup Assignments`,
    day,
    dayLabel: DAY_LABELS[day],
    date,
    dateLabel: date ? formatDateLabel(date) : null,
    cards,
  });
});

module.exports = router;
