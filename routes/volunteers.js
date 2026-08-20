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
  const rawCards = date ? await dailyAssignmentCardsWithLabels(day, date) : [];
  // A real request: "floater cards by hour should only show floaters who
  // have a confirmed assigned position" - substituteBoard auto-picks a
  // candidate for every open slot as soon as a date's board is first
  // viewed (see its own comment), persisted 'pending' until an admin
  // actually approves or overrides it - a suggestion, not a commitment.
  // The admin-facing Chart tab already only offers 'approved' picks via
  // its own separate candidates/dropdown machinery, but this public,
  // no-login kiosk view had no such gate: dailyAssignmentCardsWithLabels
  // (shared with the Archive tab's own read-only popup/print, where
  // showing a since-passed date's pending pick as a record of what was
  // suggested is fine) returns 'pending' assignments exactly the same
  // shape as 'approved' ones, so a floater walking up to this screen
  // could see themselves (or someone else) listed as confirmed for a
  // position nobody had actually signed off on yet. Blanking out
  // anything short of 'approved' - right here, not in the shared partial
  // itself - keeps that distinction admin-only everywhere else this data
  // is shown, while this one public-facing view only ever shows a name
  // once it's real.
  const cards = rawCards.map((hour) => ({
    ...hour,
    jobs: hour.jobs.map((job) => ({ ...job, assigned: job.assigned && job.assigned.status === 'approved' ? job.assigned : null })),
  }));

  res.render('volunteers-public', {
    title: `${DAY_LABELS[day]} Floater Assignments`,
    dayLabel: DAY_LABELS[day],
    date,
    dateLabel: date ? formatDateLabel(date) : null,
    cards,
  });
});

module.exports = router;
