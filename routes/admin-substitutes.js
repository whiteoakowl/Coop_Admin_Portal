const express = require('express');
const router = express.Router();
const requireAdmin = require('../middleware/requireAdmin');
const { requireDay, DAY_LABELS } = require('../utils/days');
const { isValidISODate, todayISO, weekdayOf } = require('../utils/dates');
const { HOUR_POSITIONS } = require('../utils/classSchedule');
const { activeParentOptions } = require('../utils/members');
const {
  permanentJobsForDay,
  getPermanentJob,
  floaterIdsForJob,
  createPermanentJob,
  updatePermanentJob,
  deletePermanentJob,
  setJobFloaters,
  setAssignment,
  clearAssignment,
  substituteBoard,
} = require('../utils/substitutes');

const DAY_WEEKDAY = { monday: 1, wednesday: 3 };

function defaultDateFor(day) {
  const today = todayISO();
  return weekdayOf(today) === DAY_WEEKDAY[day] ? today : '';
}

router.get('/volunteers/:day/substitutes', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const selectedDate = isValidISODate(req.query.date) ? req.query.date : defaultDateFor(day);
  const jobs = permanentJobsForDay(day).map((j) => ({ ...j, floaterIds: floaterIdsForJob(j.id) }));

  res.render('admin-volunteers', {
    title: 'Volunteers',
    tab: 'substitutes',
    day,
    dayLabel: DAY_LABELS[day],
    selectedDate,
    board: substituteBoard(day, selectedDate),
    jobs,
    allParents: activeParentOptions(),
    hourPositions: HOUR_POSITIONS,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

function subUrl(day, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== null && value !== undefined && value !== '') query.set(key, value);
  }
  const qs = query.toString();
  return `/admin/volunteers/${day}/substitutes` + (qs ? `?${qs}` : '');
}

router.post('/volunteers/:day/substitutes/permanent-jobs/new', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const title = (req.body.title || '').trim();
  const hourPositions = [].concat(req.body.hourPositions || [])
    .map((v) => parseInt(v, 10))
    .filter((p) => HOUR_POSITIONS.includes(p));
  if (!title || hourPositions.length === 0) {
    return res.redirect(subUrl(day, { date: req.body.date, error: 'Job title and at least one hour are required.' }));
  }
  hourPositions.forEach((hourPosition) => createPermanentJob({ day, hourPosition, title }));
  const hourNote = hourPositions.length > 1 ? `Hours ${hourPositions.join(', ')}` : `Hour ${hourPositions[0]}`;
  res.redirect(subUrl(day, { date: req.body.date, notice: `"${title}" added (${hourNote}).` }));
});

router.post('/volunteers/:day/substitutes/permanent-jobs/:id/edit', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const id = parseInt(req.params.id, 10);
  const title = (req.body.title || '').trim();
  const hourPosition = parseInt(req.body.hourPosition, 10);
  if (title && HOUR_POSITIONS.includes(hourPosition)) {
    updatePermanentJob(id, { title, hourPosition });
  }
  res.redirect(subUrl(day, { date: req.body.date }));
});

router.post('/volunteers/:day/substitutes/permanent-jobs/:id/floaters', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const id = parseInt(req.params.id, 10);
  const memberIds = [].concat(req.body.memberIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  setJobFloaters(id, memberIds);
  res.redirect(subUrl(day, { date: req.body.date }));
});

router.post('/volunteers/:day/substitutes/permanent-jobs/:id/delete', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const id = parseInt(req.params.id, 10);
  const job = getPermanentJob(id);
  deletePermanentJob(id);
  res.redirect(subUrl(day, { date: req.body.date, notice: job ? `Deleted "${job.title}".` : 'Job deleted.' }));
});

router.post('/volunteers/:day/substitutes/assign', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const date = req.body.date;
  const slotType = req.body.slotType === 'job' ? 'job' : 'class';
  const slotId = parseInt(req.body.slotId, 10);
  const memberId = parseInt(req.body.memberId, 10);
  const isOverride = req.body.isOverride === '1';
  if (isValidISODate(date) && slotId && memberId) {
    setAssignment(date, slotType, slotId, memberId, isOverride);
  }
  res.redirect(subUrl(day, { date }));
});

router.post('/volunteers/:day/substitutes/unassign', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const date = req.body.date;
  const slotType = req.body.slotType === 'job' ? 'job' : 'class';
  const slotId = parseInt(req.body.slotId, 10);
  if (isValidISODate(date) && slotId) clearAssignment(date, slotType, slotId);
  res.redirect(subUrl(day, { date }));
});

module.exports = router;
