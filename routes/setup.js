const express = require('express');
const router = express.Router();
const { isValidDay, DAY_LABELS } = require('../utils/days');
const { teamsForDay, membersForTeam } = require('../utils/setup');

// Public, no-login view-only page: shows every Setup/Cleanup team for a day.
router.get('/setup/:day', (req, res) => {
  const day = req.params.day;
  if (!isValidDay(day)) return res.status(404).render('404', { title: 'Not Found' });

  const teams = teamsForDay(day).map((t) => ({ ...t, members: membersForTeam(t.id) }));

  res.render('setup-public', {
    title: `${DAY_LABELS[day]} Setup/Cleanup Teams`,
    dayLabel: DAY_LABELS[day],
    teams,
  });
});

module.exports = router;
