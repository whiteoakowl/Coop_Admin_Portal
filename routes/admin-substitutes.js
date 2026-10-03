const express = require('express');
const router = express.Router();
const requireAdmin = require('../middleware/requireAdmin');
const { requireClassDay } = require('../utils/classDays');
const { isValidISODate } = require('../utils/dates');
const { HOUR_POSITIONS } = require('../utils/classSchedule');
const {
  getPermanentJob,
  createPermanentJob,
  updatePermanentJob,
  deletePermanentJob,
  savePositionGroup,
  deletePositionGroup,
  saveTemporaryPositionGroup,
  deleteTemporaryPositionGroup,
  setJobFloaters,
  setAssignment,
  approveAssignment,
  clearAssignment,
} = require('../utils/substitutes');

// Substitutes is no longer its own tab - it's folded into the Floater
// Assignments manage page (routes/admin-volunteers.js). Keep this as a
// redirect so any old bookmarks/links still land somewhere useful.
router.get('/volunteers/:day/substitutes', requireAdmin, requireClassDay, (req, res) => {
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

router.post('/volunteers/:day/substitutes/permanent-jobs/new', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  // permanent_jobs itself has no semester concept (day-scoped only, same
  // for every semester) - this is purely so the redirect lands back on
  // whichever semester+day combo the admin was actually viewing (routes/
  // admin-volunteers.js's own combo picker) instead of resetting to the
  // default. The form's own action URL carries it as a query param (see
  // views/admin-volunteers.ejs), readable here regardless of this being a
  // POST since query-string parsing doesn't depend on method.
  const semesterId = req.query.semesterId;
  const title = (req.body.title || '').trim();
  const room = (req.body.room || '').trim();
  const hourPositions = [].concat(req.body.hourPositions || [])
    .map((v) => parseInt(v, 10))
    .filter((p) => HOUR_POSITIONS.includes(p));
  if (!title || hourPositions.length === 0) {
    return res.redirect(subUrl(day, { date: req.body.date, error: 'Job title and at least one hour are required.', semesterId }));
  }
  for (const hourPosition of hourPositions) await createPermanentJob({ day, hourPosition, title, room });
  const hourNote = hourPositions.length > 1 ? `Hours ${hourPositions.join(', ')}` : `Hour ${hourPositions[0]}`;
  res.redirect(subUrl(day, { date: req.body.date, notice: `"${title}" added (${hourNote}).`, semesterId }));
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
router.post('/volunteers/:day/substitutes/permanent-jobs/save-groups', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = req.query.semesterId;
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
  res.redirect(subUrl(day, { date: req.body.date, notice: 'Positions saved.', semesterId }));
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
router.post('/volunteers/:day/substitutes/permanent-jobs/group/:keyId/delete', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = req.query.semesterId;
  const keyId = parseInt(req.params.keyId, 10);
  const title = await deletePositionGroup(day, keyId);
  res.redirect(subUrl(day, { date: req.body.date, dialog: 'job', notice: title ? `Deleted "${title}".` : 'Position not found.', semesterId }));
});

// Add/Edit Temporary Position dialog's own Save button - same all-groups-
// at-once shape as /permanent-jobs/save-groups above, except every group
// here is scoped to one specific date (saveTemporaryPositionGroup's own
// day+date+title lookup), since a temporary position - unlike a permanent
// one - only ever exists for the single date it was created for. A
// missing/invalid date can't be saved against (there'd be nothing to
// scope the new rows to), so it's rejected up front instead of silently
// creating a recurring job by accident.
router.post('/volunteers/:day/substitutes/temporary-jobs/save-groups', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = req.query.semesterId;
  const date = req.body.date;
  if (!isValidISODate(date)) {
    return res.redirect(subUrl(day, { date, error: 'Choose a session date before adding a temporary position.', semesterId }));
  }
  const groups = req.body.groups && typeof req.body.groups === 'object' ? req.body.groups : {};
  for (const [key, group] of Object.entries(groups)) {
    const title = ((group && group.title) || '').trim();
    const room = ((group && group.room) || '').trim();
    const hours = [].concat((group && group.hours) || [])
      .map((v) => parseInt(v, 10))
      .filter((p) => HOUR_POSITIONS.includes(p));
    const keyId = key === 'new' ? null : parseInt(key, 10);
    if (keyId !== null && Number.isNaN(keyId)) continue;
    await saveTemporaryPositionGroup(day, date, keyId, title, room, hours);
  }
  res.redirect(subUrl(day, { date, notice: 'Temporary positions saved.', semesterId }));
});

router.post('/volunteers/:day/substitutes/temporary-jobs/group/:keyId/delete', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = req.query.semesterId;
  const date = req.body.date;
  const keyId = parseInt(req.params.keyId, 10);
  const title = isValidISODate(date) ? await deleteTemporaryPositionGroup(day, date, keyId) : null;
  res.redirect(subUrl(day, { date, dialog: 'temp-job', notice: title ? `Deleted "${title}".` : 'Position not found.', semesterId }));
});

router.post('/volunteers/:day/substitutes/permanent-jobs/:id/edit', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = req.query.semesterId;
  const id = parseInt(req.params.id, 10);
  const title = (req.body.title || '').trim();
  const room = (req.body.room || '').trim();
  const hourPosition = parseInt(req.body.hourPosition, 10);
  if (title && HOUR_POSITIONS.includes(hourPosition)) {
    await updatePermanentJob(id, { title, hourPosition, room });
  }
  res.redirect(subUrl(day, { date: req.body.date, semesterId }));
});

router.post('/volunteers/:day/substitutes/permanent-jobs/:id/floaters', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = req.query.semesterId;
  const id = parseInt(req.params.id, 10);
  const memberIds = [].concat(req.body.memberIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  await setJobFloaters(id, memberIds);
  res.redirect(subUrl(day, { date: req.body.date, semesterId }));
});

router.post('/volunteers/:day/substitutes/permanent-jobs/:id/delete', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = req.query.semesterId;
  const id = parseInt(req.params.id, 10);
  const job = await getPermanentJob(id);
  await deletePermanentJob(id);
  res.redirect(subUrl(day, { date: req.body.date, notice: job ? `Deleted "${job.title}".` : 'Job deleted.', semesterId }));
});

// 'vacancy' (a class's own unfilled teacher/assistant slot count - see
// utils/substitutes.js's own classVacancySlots) is a real, valid slot
// type alongside 'class' and 'job', not a fallback case - this used to
// collapse any slotType other than 'job' down to 'class', which silently
// misfiled every vacancy-position Assign/Unassign/Approve click under
// slotType='class' with a vacancy-shaped slotId that never matches
// anything on read, so the click looked like it worked (a normal
// redirect) but never actually saved.
const SLOT_TYPES = ['class', 'job', 'vacancy'];
function slotTypeFromBody(body) {
  return SLOT_TYPES.includes(body.slotType) ? body.slotType : 'class';
}

// A real request: "make it to where the page doesn't refresh every time
// you click assign or unassigned - it should simply assign and allow you
// to continue clicking assignment until you're done." public/js/
// floater-assign.js now submits these three forms via fetch (marked with
// the same X-Requested-With: fetch header the codebase already uses for
// its other auto-save endpoints - see class-settings-autosave.js/
// attendance-grid.js), and re-fetches the cards grid on success instead of
// following a redirect. A plain, non-fetch form submit (JS disabled, or
// any other caller) still gets the original redirect - isFetch is checked
// per-request rather than assumed, so both keep working off the exact
// same route.
function isFetch(req) {
  return req.get('X-Requested-With') === 'fetch';
}

router.post('/volunteers/:day/substitutes/assign', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = req.query.semesterId;
  const date = req.body.date;
  const slotType = slotTypeFromBody(req.body);
  const slotId = parseInt(req.body.slotId, 10);
  const memberId = parseInt(req.body.memberId, 10);
  const isOverride = req.body.isOverride === '1';
  if (isValidISODate(date) && slotId && memberId) {
    try {
      await setAssignment(date, slotType, slotId, memberId, isOverride);
    } catch (e) {
      if (isFetch(req)) return res.status(400).json({ ok: false, error: e.message });
      return res.redirect(subUrl(day, { date, error: e.message, semesterId }));
    }
  }
  if (isFetch(req)) return res.json({ ok: true });
  res.redirect(subUrl(day, { date, semesterId }));
});

router.post('/volunteers/:day/substitutes/unassign', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = req.query.semesterId;
  const date = req.body.date;
  const slotType = slotTypeFromBody(req.body);
  const slotId = parseInt(req.body.slotId, 10);
  if (isValidISODate(date) && slotId) await clearAssignment(date, slotType, slotId);
  if (isFetch(req)) return res.json({ ok: true });
  res.redirect(subUrl(day, { date, semesterId }));
});

// Confirms the automated sub system's own pick as-is - a one-click
// approve, distinct from /assign (which is also used to override with a
// different person entirely).
router.post('/volunteers/:day/substitutes/approve', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = req.query.semesterId;
  const date = req.body.date;
  const slotType = slotTypeFromBody(req.body);
  const slotId = parseInt(req.body.slotId, 10);
  if (isValidISODate(date) && slotId) await approveAssignment(date, slotType, slotId);
  if (isFetch(req)) return res.json({ ok: true });
  res.redirect(subUrl(day, { date, semesterId }));
});

module.exports = router;
