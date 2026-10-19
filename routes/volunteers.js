const express = require('express');
const router = express.Router();
const { closestUpcomingDate, formatDateLabel } = require('../utils/dates');
const { getListByDay, datesForList } = require('../utils/volunteers');
const { CLASS_DAY_LABELS_FULL: DAY_LABELS, isValidClassDay, listActiveClassDays } = require('../utils/classSchedule');
const { publicFloaterCardsForDate } = require('../utils/substitutes');

// A real request: the kiosk homepage's Floater Assignments button used to
// jump straight to a single auto-picked day - now it shows a choice of
// every day activated on Settings > Day Settings (not just a hardcoded
// Monday/Wednesday pair - a real request: "Full 7 day expansion..."),
// same "pick a day" step Class Check-In's own kiosk flow already uses
// (kiosk-class-checkin-days.ejs), and lands on that day's chart (below)
// after.
//
// A later real request: "Quicklinks have been created for member to
// quickly view ... floater assignments ... When they go to these quick
// links they should be stand alone pages not connected to the kiosk.
// Member should not be able to access the kiosk by going to these
// pages." /volunteers and /volunteers/:day are the exact same bare URL
// the Kiosk home screen's own Floater Assignments card links to (views/
// kiosk-home.ejs) AND the one a member reaches directly via a Quick
// Link/QR code/bookmark - with no way to tell those two visitors apart,
// this used to always show the kiosk "Return to Home Screen" link (and
// an idle timer that auto-navigates there too), which is exactly how a
// Quick Link visitor could wander into the real, interactive Kiosk. A
// fromKiosk flag - true only when kiosk-home.ejs's own links tag the
// request with ?kiosk=1 - now gates every path back to /kiosk; a bare
// visit (the Quick Link/QR code case) gets neither.
function isFromKiosk(req) {
  return req.query.kiosk === '1';
}

router.get('/volunteers', async (req, res) => {
  const days = (await listActiveClassDays()).map((d) => ({ value: d, label: DAY_LABELS[d] }));
  const fromKiosk = isFromKiosk(req);
  res.render('kiosk-day-picker', {
    title: 'Floater Assignments',
    heading: 'Floater Assignments',
    basePath: '/volunteers',
    icon: 'icon-users',
    days,
    fromKiosk,
  });
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
  if (!isValidClassDay(day)) return res.status(404).render('404', { title: 'Not Found' });
  const fromKiosk = isFromKiosk(req);

  // getListByDay now creates this day's list (for whatever semester is
  // currently active - utils/kioskSettings.js) on demand if it doesn't
  // exist yet, so this can no longer actually come back empty - kept as a
  // defensive guard rather than assuming that holds forever.
  const list = await getListByDay(day);
  if (!list) return res.status(404).render('404', { title: 'Not Found' });
  const date = closestUpcomingDate(await datesForList(list.id));
  // A real bug report: this used to be built from dailyAssignmentCards
  // (permanent jobs only, shared with the admin Chart tab/Archive) - a
  // class's own missing-teacher/assistant coverage, assigned from the
  // separate Substitutes Needed board, never showed up here at all even
  // once approved. publicFloaterCardsForDate (utils/substitutes.js) folds
  // both position types together, read-only, and only ever includes a
  // position once it has an 'approved' assignment - a real request: "do
  // not show positions that don't have someone assigned. if it is
  // unassigned it's invisible to members. only admins can see it." A
  // still-'pending' auto-suggestion (or a position with no suggestion at
  // all) is simply omitted here, not shown as "Unassigned" the way the
  // admin-only Archive/Chart views still do (dailyAssignmentCards, via
  // the same shared partials/floater-assignment-cards.ejs).
  const cards = date ? await publicFloaterCardsForDate(day, date) : [];

  res.render('volunteers-public', {
    title: `${DAY_LABELS[day]} Floater Assignments`,
    dayLabel: DAY_LABELS[day],
    date,
    dateLabel: date ? formatDateLabel(date) : null,
    cards,
    fromKiosk,
  });
});

module.exports = router;
