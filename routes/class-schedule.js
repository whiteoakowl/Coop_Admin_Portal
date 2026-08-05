const express = require('express');
const router = express.Router();
const { isValidDay, defaultDay, DAY_LABELS, gridForDay, appSetting, addStaff, activeParentsForStaff } = require('../utils/classSchedule');

router.get('/class-schedule', (req, res) => res.redirect(`/class-schedule/${defaultDay()}`));

router.get('/class-schedule/:day', (req, res) => {
  const day = req.params.day;
  if (!isValidDay(day)) return res.status(404).render('404', { title: 'Not Found' });

  const editMode = appSetting('class_schedule_public_mode', 'view') === 'edit';

  res.render('class-schedule-public', {
    title: `${DAY_LABELS[day]} Class Schedule`,
    day,
    dayLabel: DAY_LABELS[day],
    grid: gridForDay(day),
    editMode,
    staffOptions: editMode ? activeParentsForStaff() : [],
    notice: req.query.notice || null,
  });
});

// Self-service signup, only available when the admin has switched the
// public page to edit mode. Adds the submitting member as a teacher or
// assistant on the class - nothing else about the class is editable here.
router.post('/class-schedule/:day/classes/:id/signup', (req, res) => {
  const day = req.params.day;
  if (!isValidDay(day)) return res.status(404).render('404', { title: 'Not Found' });
  if (appSetting('class_schedule_public_mode', 'view') !== 'edit') {
    return res.redirect(`/class-schedule/${day}`);
  }

  const classId = parseInt(req.params.id, 10);
  const memberId = parseInt(req.body.memberId, 10);
  const role = req.body.role === 'assistant' ? 'assistant' : 'teacher';
  const eligible = activeParentsForStaff().some((p) => p.id === memberId);
  if (classId && eligible) addStaff(classId, memberId, role);

  res.redirect(`/class-schedule/${day}?notice=` + encodeURIComponent(eligible ? 'Signed up!' : 'Please select your name.'));
});

module.exports = router;
