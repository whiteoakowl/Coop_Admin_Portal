const express = require('express');
const router = express.Router();
const requireAdmin = require('../middleware/requireAdmin');
const { requireDay } = require('../utils/days');
const { isValidISODate } = require('../utils/dates');
const { HOUR_POSITIONS } = require('../utils/classSchedule');
const {
  getPermanentJob,
  createPermanentJob,
  updatePermanentJob,
  deletePermanentJob,
  setJobFloaters,
  setAssignment,
  approveAssignment,
  clearAssignment,
  pendingApprovalsForToday,
} = require('../utils/substitutes');

// Substitutes is no longer its own tab - it's folded into the Floater
// Assignments manage page (routes/admin-volunteers.js). Keep this as a
// redirect so any old bookmarks/links still land somewhere useful.
router.get('/volunteers/:day/substitutes', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const qs = req.query.date ? `?date=${encodeURIComponent(req.query.date)}` : '';
  res.redirect(`/admin/volunteers/${day}/manage${qs}`);
});

function subUrl(day, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== null && value !== undefined && value !== '') query.set(key, value);
  }
  const qs = query.toString();
  return `/admin/volunteers/${day}/manage` + (qs ? `?${qs}` : '');
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

// Confirms the automated sub system's own pick as-is - a one-click
// approve, distinct from /assign (which is also used to override with a
// different person entirely).
router.post('/volunteers/:day/substitutes/approve', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const date = req.body.date;
  const slotType = req.body.slotType === 'job' ? 'job' : 'class';
  const slotId = parseInt(req.body.slotId, 10);
  if (isValidISODate(date) && slotId) approveAssignment(date, slotType, slotId);
  res.redirect(subUrl(day, { date }));
});

// Polled from every admin page (see public/js/pending-approvals.js) to
// power the sitewide "floater position needs approval" popup - also
// where the automated sub system's today's-board auto-fill actually
// happens for admins who never open the Substitutes tab themselves.
router.get('/pending-approvals.json', requireAdmin, (req, res) => {
  res.json(pendingApprovalsForToday());
});

module.exports = router;
