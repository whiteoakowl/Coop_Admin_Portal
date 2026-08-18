const express = require('express');
const router = express.Router();
const { closestUpcomingDate, formatDateLabel } = require('../utils/dates');
const { isValidDay, getListByDay, DAY_LABELS, datesForList } = require('../utils/volunteers');
const { dailyAssignmentCardsWithLabels } = require('../utils/substitutes');

// A real request: the kiosk homepage's Floater Assignments button used to
// jump straight to a single auto-picked day - now it shows Monday/
// Wednesday choice buttons first, same "pick a day" step Class Check-In's
// own kiosk flow already uses (kiosk-class-checkin-days.ejs), and lands
// on that day's chart (below) after.
router.get('/volunteers', (req, res) => {
  res.render('kiosk-day-picker', { title: 'Floater Assignments', heading: 'Floater Assignments', basePath: '/volunteers', icon: 'icon-users' });
});

// Public, no-login kiosk-style view: shows the floater assignment chart
// for today, or - a real request - the closest date coming up if nothing
// is scheduled today, for a screen members can walk up to and glance at.
// Same 2x2 hour-card layout as the admin Chart tab and Archive print page
// (partials/floater-assignment-cards.ejs), so a floater sees the same
// shape wherever the chart is shown. Plain names only - no rank/child-
// under-2 annotations (those are admin-only assign-tool context).
router.get('/volunteers/:day', async (req, res) => {
  const day = req.params.day;
  if (!isValidDay(day)) return res.status(404).render('404', { title: 'Not Found' });

  const list = await getListByDay(day);
  // A volunteer_lists row for every valid day is always seeded at first
  // boot (see db/bootstrapPg.js) and should never actually be missing -
  // this is a defensive guard against a genuine startup race rather than
  // a scenario expected in normal operation: this is a public, no-login
  // route, so it's the most exposed to a request landing before that
  // seeding has finished (see netlify/functions/app.js's own comment on
  // why every invocation now awaits app.ready first to close that race).
  if (!list) return res.status(404).render('404', { title: 'Not Found' });
  const date = closestUpcomingDate(await datesForList(list.id));
  const cards = date ? await dailyAssignmentCardsWithLabels(day, date) : [];

  res.render('volunteers-public', {
    title: `${DAY_LABELS[day]} Floater Assignments`,
    dayLabel: DAY_LABELS[day],
    date,
    dateLabel: date ? formatDateLabel(date) : null,
    cards,
  });
});

module.exports = router;
