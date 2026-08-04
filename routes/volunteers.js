const express = require('express');
const router = express.Router();
const { todayISO } = require('../utils/dates');
const { isValidDay, getListByDay, DAY_LABELS, datesForList, buildListGrid } = require('../utils/volunteers');

// Public, no-login kiosk-style view: shows today's volunteer schedule only,
// for a screen members can walk up to and scroll through.
router.get('/volunteers/:day', (req, res) => {
  const day = req.params.day;
  if (!isValidDay(day)) return res.status(404).render('404', { title: 'Not Found' });

  const list = getListByDay(day);
  const today = todayISO();
  const scheduledToday = datesForList(list.id).includes(today);
  const grid = scheduledToday ? buildListGrid(list.id, today) : null;

  res.render('volunteers-public', {
    title: `${DAY_LABELS[day]} Floater Assignments`,
    dayLabel: DAY_LABELS[day],
    scheduledToday,
    grid,
  });
});

module.exports = router;
