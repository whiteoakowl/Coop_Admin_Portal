const express = require('express');
const router = express.Router();
const { todayISO, weekdayOf } = require('../utils/dates');
const {
  isValidDay,
  defaultDay,
  DAY_LABELS,
  gridForDay,
  absentMemberIdsForDate,
} = require('../utils/classSchedule');

const DAY_WEEKDAY = { monday: 1, wednesday: 3 };

router.get('/class-schedule', (req, res) => res.redirect(`/class-schedule/${defaultDay()}`));

router.get('/class-schedule/:day', (req, res) => {
  const day = req.params.day;
  if (!isValidDay(day)) return res.status(404).render('404', { title: 'Not Found' });

  const today = todayISO();
  const absentIds = weekdayOf(today) === DAY_WEEKDAY[day] ? absentMemberIdsForDate(today) : new Set();

  res.render('class-schedule-public', {
    title: `${DAY_LABELS[day]} Class Schedule`,
    day,
    dayLabel: DAY_LABELS[day],
    grid: gridForDay(day),
    absentIds,
  });
});

module.exports = router;
