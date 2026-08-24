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
  savePositionGroup,
  deletePositionGroup,
  setJobFloaters,
  setAssignment,
  approveAssignment,
  clearAssignment,
} = require('../utils/substitutes');
const { todaysAlerts } = require('../utils/alerts');

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

router.post('/volunteers/:day/substitutes/permanent-jobs/new', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const title = (req.body.title || '').trim();
  const room = (req.body.room || '').trim();
  const hourPositions = [].concat(req.body.hourPositions || [])
    .map((v) => parseInt(v, 10))
    .filter((p) => HOUR_POSITIONS.includes(p));
  if (!title || hourPositions.length === 0) {
    return res.redirect(subUrl(day, { date: req.body.date, error: 'Job title and at least one hour are required.' }));
  }
  for (const hourPosition of hourPositions) await createPermanentJob({ day, hourPosition, title, room });
  const hourNote = hourPositions.length > 1 ? `Hours ${hourPositions.join(', ')}` : `Hour ${hourPositions[0]}`;
  res.redirect(subUrl(day, { date: req.body.date, notice: `"${title}" added (${hourNote}).` }));
});

// The Add/Edit Position dialog's one Save button - unlike /new above (one
// title -> N brand-new rows), this applies every group in the dialog at
// once: existing positions' title/room/checked-hours plus whatever was
// filled into the blank "Add New Position" row at the bottom. Each
// group's own field names are `groups[<key>][title/room/hours]` - `<key>`
// is the group's own keyId (a permanent_jobs.id - see
// groupedPermanentJobsForDay) for an existing position, or the literal
// string 'new' for the blank row, matching savePositionGroup's own
// keyId-is-null-means-new contract.
router.post('/volunteers/:day/substitutes/permanent-jobs/save-groups', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const groups = req.body.groups && typeof req.body.groups === 'object' ? req.body.groups : {};
  for (const [key, group] of Object.entries(groups)) {
    const title = ((group && group.title) || '').trim();
    const room = ((group && group.room) || '').trim();
    const hours = [].concat((group && group.hours) || [])
      .map((v) => parseInt(v, 10))
      .filter((p) => HOUR_POSITIONS.includes(p));
    const keyId = key === 'new' ? null : parseInt(key, 10);
    if (keyId !== null && Number.isNaN(keyId)) continue;
    await savePositionGroup(day, keyId, title, room, hours);
  }
  res.redirect(subUrl(day, { date: req.body.date, notice: 'Positions saved.' }));
});

// A real bug report: "next to each position in that pop up there should
// be a trashcan symbol to remove that position. once you click the trash
// can the position is deleted but the add/edit window remains open for
// editing." keyId (a group's own anchor job id - see
// groupedPermanentJobsForDay) may stand for several permanent_jobs rows,
// one per hour the position runs - deletePositionGroup removes all of
// them. Echoes dialog=job back through the redirect (same reopen
// mechanism the Save button's own save-groups route above already uses)
// so the dialog pops right back open with the position gone instead of
// leaving the admin back at the closed manage page.
router.post('/volunteers/:day/substitutes/permanent-jobs/group/:keyId/delete', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const keyId = parseInt(req.params.keyId, 10);
  const title = await deletePositionGroup(day, keyId);
  res.redirect(subUrl(day, { date: req.body.date, dialog: 'job', notice: title ? `Deleted "${title}".` : 'Position not found.' }));
});

router.post('/volunteers/:day/substitutes/permanent-jobs/:id/edit', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const id = parseInt(req.params.id, 10);
  const title = (req.body.title || '').trim();
  const room = (req.body.room || '').trim();
  const hourPosition = parseInt(req.body.hourPosition, 10);
  if (title && HOUR_POSITIONS.includes(hourPosition)) {
    await updatePermanentJob(id, { title, hourPosition, room });
  }
  res.redirect(subUrl(day, { date: req.body.date }));
});

router.post('/volunteers/:day/substitutes/permanent-jobs/:id/floaters', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const id = parseInt(req.params.id, 10);
  const memberIds = [].concat(req.body.memberIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  await setJobFloaters(id, memberIds);
  res.redirect(subUrl(day, { date: req.body.date }));
});

router.post('/volunteers/:day/substitutes/permanent-jobs/:id/delete', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const id = parseInt(req.params.id, 10);
  const job = await getPermanentJob(id);
  await deletePermanentJob(id);
  res.redirect(subUrl(day, { date: req.body.date, notice: job ? `Deleted "${job.title}".` : 'Job deleted.' }));
});

router.post('/volunteers/:day/substitutes/assign', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const date = req.body.date;
  const slotType = req.body.slotType === 'job' ? 'job' : 'class';
  const slotId = parseInt(req.body.slotId, 10);
  const memberId = parseInt(req.body.memberId, 10);
  const isOverride = req.body.isOverride === '1';
  if (isValidISODate(date) && slotId && memberId) {
    await setAssignment(date, slotType, slotId, memberId, isOverride);
  }
  res.redirect(subUrl(day, { date }));
});

router.post('/volunteers/:day/substitutes/unassign', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const date = req.body.date;
  const slotType = req.body.slotType === 'job' ? 'job' : 'class';
  const slotId = parseInt(req.body.slotId, 10);
  if (isValidISODate(date) && slotId) await clearAssignment(date, slotType, slotId);
  res.redirect(subUrl(day, { date }));
});

// Confirms the automated sub system's own pick as-is - a one-click
// approve, distinct from /assign (which is also used to override with a
// different person entirely).
router.post('/volunteers/:day/substitutes/approve', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const date = req.body.date;
  const slotType = req.body.slotType === 'job' ? 'job' : 'class';
  const slotId = parseInt(req.body.slotId, 10);
  if (isValidISODate(date) && slotId) await approveAssignment(date, slotType, slotId);
  res.redirect(subUrl(day, { date }));
});

// Polled from every admin page (see public/js/alerts.js) to power the
// sitewide alert popup - the same list rendered as the Home dashboard's
// Alert Log (utils/alerts.js), so the popup only ever surfaces what an
// admin could also find there. Also where the automated sub system's
// today's-board auto-fill actually happens for admins who never open the
// Floater Assignments manage page themselves.
router.get('/alerts.json', requireAdmin, async (req, res) => {
  const items = await todaysAlerts();
  res.json({ count: items.length, items });
});

module.exports = router;
