const express = require('express');
const router = express.Router();
const { isValidDay, DAY_LABELS, defaultDateFor } = require('../utils/days');
const { absentMemberIdsForDate } = require('../utils/classSchedule');
const { teamsForDay, membersForTeam } = require('../utils/setup');

// Public, no-login view-only page: shows every Setup/Cleanup team for a day.
router.get('/setup/:day', async (req, res) => {
  const day = req.params.day;
  if (!isValidDay(day)) return res.status(404).render('404', { title: 'Not Found' });

  const dayTeams = await teamsForDay(day);
  const teams = [];
  for (const t of dayTeams) teams.push({ ...t, members: await membersForTeam(t.id) });

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
