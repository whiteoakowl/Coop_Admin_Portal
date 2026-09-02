const express = require('express');
const router = express.Router();
const { isValidDay, DAY_LABELS, defaultDateFor } = require('../utils/days');
const { absentMemberIdsForDate } = require('../utils/classSchedule');
const { teamsForDay, membersForTeam } = require('../utils/setup');

// A real request: the kiosk homepage's Setup/Cleanup button used to jump
// straight to a single auto-picked day - now it shows Monday/Wednesday
// choice buttons first, same "pick a day" step Class Check-In's own kiosk
// flow already uses, and lands on that day's team list (below) after.
router.get('/setup', (req, res) => {
  res.render('kiosk-day-picker', { title: 'Setup/Cleanup Teams', heading: 'Setup/Cleanup Teams', basePath: '/setup', icon: 'icon-broom' });
});

// Public, no-login kiosk-style view: a real request - "setup/cleanup team
// kiosk view. change it to where members only see their team list, leave
// off the assignments" - back to the standing Teams roster (who's on
// which team) this route showed before it was changed to the per-team,
// per-member Task 1/Task 2 assignment pick cards (partials/setup-
// assignment-cards.ejs, still used by the admin Setup/Cleanup
// Assignments tab - that per-date task detail is exactly the
// "assignments" this member-facing page should leave off now).
router.get('/setup/:day', async (req, res) => {
  const day = req.params.day;
  if (!isValidDay(day)) return res.status(404).render('404', { title: 'Not Found' });

  const teams = await Promise.all((await teamsForDay(day)).map(async (t) => ({ ...t, members: await membersForTeam(t.id) })));

  res.render('setup-public', {
    title: `${DAY_LABELS[day]} Setup/Cleanup Teams`,
    dayLabel: DAY_LABELS[day],
    teams,
    // Same "only means anything on today's own day" reasoning as the
    // admin manage page (routes/admin-setup.js) - kiosk-home always links
    // here with today's own day already (/setup/<%= defaultDay %>), so in
    // practice this is just "who's absent today".
    absentIds: await absentMemberIdsForDate(defaultDateFor(day)),
  });
});

module.exports = router;
