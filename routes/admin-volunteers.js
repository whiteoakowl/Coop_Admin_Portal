const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { isValidISODate, formatDateLabel, todayISO, weekdayOf } = require('../utils/dates');
const { parseNamesFromUpload, findMemberByName, hasInfantChild, activeParentOptions } = require('../utils/members');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { defaultDay, requireDay } = require('../utils/days');
const { staffListForDay, HOUR_POSITIONS } = require('../utils/classSchedule');
const {
  DAY_LABELS,
  RANKS,
  RANK_LABELS,
  getListByDay,
  sectionsForList,
  datesForList,
  membersForList,
  setMemberRank,
  buildListGrid,
} = require('../utils/volunteers');
const {
  permanentJobsForDay,
  floaterIdsForJob,
  substituteBoard,
} = require('../utils/substitutes');

const SUB_DAY_WEEKDAY = { monday: 1, wednesday: 3 };
function defaultSubDateFor(day) {
  const today = todayISO();
  return weekdayOf(today) === SUB_DAY_WEEKDAY[day] ? today : '';
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

const EDIT_DIALOGS = ['hours', 'dates', 'members'];

// Every Edit Hours/Dates/Members action lives inside a <dialog>, and a
// plain form POST fully reloads the page - so each form's action carries
// ?dialog=<name>, and every redirect back to the manage page echoes it
// through, letting the view reopen the same dialog on load instead of
// dropping the admin back at a closed popup after every save.
function manageUrl(day, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== null && value !== undefined && value !== '') query.set(key, value);
  }
  const qs = query.toString();
  return `/admin/volunteers/${day}/manage` + (qs ? `?${qs}` : '');
}
function dialogParam(req) {
  return EDIT_DIALOGS.includes(req.query.dialog) ? req.query.dialog : null;
}

// The landing page now lives on the combined Volunteers page, tabbed
// between Floater Assignments and Setup/Cleanup Teams.
router.get('/volunteers', requireAdmin, (req, res) => res.redirect(`/admin/volunteers/${defaultDay()}/manage`));

// --- Manage page: sections, dates, members, position/room grid ---

router.get('/volunteers/:day/manage', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const sections = sectionsForList(list.id);
  const members = membersForList(list.id);
  const memberIds = members.map((m) => m.id);
  // Floater Assignments are staffed by parent volunteers, not students.
  const availableMembers = db
    .prepare("SELECT * FROM members WHERE active = 1 AND member_type = 'parent' ORDER BY name COLLATE NOCASE")
    .all()
    .filter((m) => !memberIds.includes(m.id));
  const dates = datesForList(list.id);
  const infantByMemberId = {};
  members.forEach((m) => { infantByMemberId[m.id] = hasInfantChild(m.id); });

  // Substitutes board - folded into this same Floater Assignments tab
  // (no longer a separate tab) since it's just another view over the same
  // day's floater pool.
  const selectedDate = isValidISODate(req.query.date) ? req.query.date : defaultSubDateFor(day);
  const jobs = permanentJobsForDay(day).map((j) => ({ ...j, floaterIds: floaterIdsForJob(j.id) }));

  res.render('admin-volunteers', {
    title: `${DAY_LABELS[day]} Floater Assignments`,
    tab: 'floater',
    day,
    dayLabel: DAY_LABELS[day],
    sections,
    members,
    infantByMemberId,
    ranks: RANKS,
    rankLabels: RANK_LABELS,
    availableMembers,
    dates: dates.map((d) => ({ date: d, label: formatDateLabel(d) })),
    grid: buildListGrid(list.id, null),
    openDialog: dialogParam(req),
    selectedDate,
    board: substituteBoard(day, selectedDate),
    jobs,
    allParents: activeParentOptions(),
    hourPositions: HOUR_POSITIONS,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.get('/volunteers/:day/teachers', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  res.render('admin-volunteers', {
    title: `${DAY_LABELS[day]} Teachers`,
    tab: 'teachers',
    day,
    dayLabel: DAY_LABELS[day],
    staffList: staffListForDay(day, 'teacher'),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.get('/volunteers/:day/assistants', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  res.render('admin-volunteers', {
    title: `${DAY_LABELS[day]} Class Assistants`,
    tab: 'assistants',
    day,
    dayLabel: DAY_LABELS[day],
    staffList: staffListForDay(day, 'assistant'),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/volunteers/:day/sections', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const labels = [].concat(req.body.labels || []);
  const update = db.prepare('UPDATE volunteer_sections SET label = ? WHERE volunteer_list_id = ? AND position = ?');
  labels.forEach((label, i) => {
    const trimmed = (label || '').trim() || `Hour ${i + 1}`;
    update.run(trimmed, list.id, i + 1);
  });
  res.redirect(manageUrl(day, { notice: 'Section labels updated.', dialog: dialogParam(req) }));
});

router.post('/volunteers/:day/dates/add', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const dates = [...new Set([].concat(req.body.dates || []).map((d) => d.trim()).filter(isValidISODate))];
  const insertDate = db.prepare('INSERT OR IGNORE INTO volunteer_dates (volunteer_list_id, session_date) VALUES (?, ?)');
  for (const d of dates) insertDate.run(list.id, d);
  res.redirect(manageUrl(day, { notice: `Added ${dates.length} date(s).`, dialog: dialogParam(req) }));
});

router.post('/volunteers/:day/dates/:date/remove', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const date = req.params.date;
  db.prepare('DELETE FROM volunteer_dates WHERE volunteer_list_id = ? AND session_date = ?').run(list.id, date);
  db.prepare('DELETE FROM volunteer_assignments WHERE volunteer_list_id = ? AND session_date = ?').run(list.id, date);
  res.redirect(manageUrl(day, { notice: `Removed ${formatDateLabel(date)}.`, dialog: dialogParam(req) }));
});

// New additions default into the first hour section; admins reassign from
// the members table's own section picker, so the quick-add bars don't need
// their own section dropdown.
function firstSectionId(listId) {
  const first = sectionsForList(listId)[0];
  return first ? first.id : null;
}

router.post('/volunteers/:day/add-member', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const sectionId = firstSectionId(list.id);
  if (sectionId) {
    const link = db.prepare('INSERT OR IGNORE INTO volunteer_members (volunteer_list_id, member_id, section_id) VALUES (?, ?, ?)');
    for (const memberId of memberIds) link.run(list.id, memberId, sectionId);
  }
  res.redirect(manageUrl(day, { dialog: dialogParam(req) }));
});

router.post('/volunteers/:day/import', requireAdmin, requireDay, upload.single('file'), (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const sectionId = firstSectionId(list.id);
  if (!req.file) {
    return res.redirect(manageUrl(day, { error: 'Please choose a file to import.', dialog: dialogParam(req) }));
  }
  const names = parseNamesFromUpload(req.file.buffer, req.file.originalname);
  const linkMember = db.prepare('INSERT OR IGNORE INTO volunteer_members (volunteer_list_id, member_id, section_id) VALUES (?, ?, ?)');
  let added = 0;
  let notFound = 0;
  for (const name of names) {
    const member = findMemberByName(name, 'parent');
    if (!member) { notFound++; continue; }
    const result = linkMember.run(list.id, member.id, sectionId);
    if (result.changes > 0) added++;
  }
  res.redirect(
    manageUrl(day, {
      notice: `Imported ${added} member(s) added to the list` + (notFound ? `, ${notFound} name(s) not found in Members.` : '.'),
      dialog: dialogParam(req),
    })
  );
});

// A member can be assigned to more than one hour, so this replaces their
// full set of section memberships with whatever's checked. Ignored if
// nothing is checked - a member can't be on the list with zero hours,
// they'd just fall out of every query that joins through volunteer_members.
// Rank lives on these same rows, so it's read before the delete and
// carried over to every re-inserted row rather than resetting to default.
router.post('/volunteers/:day/members/:memberId/sections', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const memberId = parseInt(req.params.memberId, 10);
  const sectionIds = [].concat(req.body.sectionIds || []).map((id) => parseInt(id, 10)).filter(Boolean);

  if (sectionIds.length > 0) {
    const existingRank = db
      .prepare('SELECT rank FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ? LIMIT 1')
      .get(list.id, memberId);
    const rank = existingRank ? existingRank.rank : 'sometimes';
    const del = db.prepare('DELETE FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ?');
    const insert = db.prepare('INSERT INTO volunteer_members (volunteer_list_id, member_id, section_id, rank) VALUES (?, ?, ?, ?)');
    del.run(list.id, memberId);
    for (const sectionId of sectionIds) insert.run(list.id, memberId, sectionId, rank);
  }
  res.redirect(manageUrl(day, { dialog: dialogParam(req) }));
});

router.post('/volunteers/:day/members/:memberId/rank', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const memberId = parseInt(req.params.memberId, 10);
  setMemberRank(list.id, memberId, req.body.rank);
  res.redirect(manageUrl(day, { dialog: dialogParam(req) }));
});

router.post('/volunteers/:day/remove-member/:memberId', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  db.prepare('DELETE FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ?').run(list.id, req.params.memberId);
  res.redirect(manageUrl(day, { dialog: dialogParam(req) }));
});

// Saves position/room text fields. Used by the full manage-page grid
// (many dates submitted at once), the single-date box on a linked
// roster's view page, and per-cell autosave-on-blur (one field at a
// time). Fields arrive as flat "position:<memberId>:<date>" /
// "room:<memberId>:<date>" keys - nested bracket names like
// position[1][2026-08-03] get silently mangled by Express's body parser,
// which treats purely-numeric bracket segments as array indices.
//
// A cell's position/room default to null (not '') when their key is
// absent from the request, and the upsert COALESCEs each column against
// its existing value - otherwise a single-field autosave request (which
// only sends one of the two keys) would blank out whichever field wasn't
// included, since a plain "excluded.field" upsert has no way to tell
// "not submitted" apart from "submitted as empty".
router.post('/volunteers/:day/assignments', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const upsert = db.prepare(
    `INSERT INTO volunteer_assignments (volunteer_list_id, member_id, session_date, position, room)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(volunteer_list_id, member_id, session_date) DO UPDATE SET
       position = COALESCE(excluded.position, volunteer_assignments.position),
       room = COALESCE(excluded.room, volunteer_assignments.room)`
  );
  const cells = {};
  for (const key of Object.keys(req.body)) {
    const match = /^(position|room):(\d+):(\d{4}-\d{2}-\d{2})$/.exec(key);
    if (!match) continue;
    const [, field, memberId, date] = match;
    const cellKey = `${memberId}|${date}`;
    if (!cells[cellKey]) cells[cellKey] = { memberId: parseInt(memberId, 10), date, position: null, room: null };
    cells[cellKey][field] = (req.body[key] || '').trim();
  }
  for (const cell of Object.values(cells)) {
    upsert.run(list.id, cell.memberId, cell.date, cell.position, cell.room);
  }
  const requested = req.body.redirectTo || '';
  const redirectTo = requested.startsWith('/admin/') ? requested : `/admin/volunteers/${day}/manage`;
  const sep = redirectTo.includes('?') ? '&' : '?';
  res.redirect(redirectTo + sep + 'notice=' + encodeURIComponent('Volunteer assignments saved.'));
});

router.get('/volunteers/:day/export.csv', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const grid = buildListGrid(list.id, null);

  const header = ['Name', 'Section'];
  for (const label of grid.dateLabels) header.push(`${label} Position`, `${label} Room`);

  const lines = [toCsvRow(header)];
  for (const section of grid.sections) {
    for (const row of section.members) {
      const fields = [row.member.name, section.label];
      for (const cell of row.cells) fields.push(cell.position || '', cell.room || '');
      lines.push(toCsvRow(fields));
    }
  }

  sendCsv(res, `${day}-floater-assignments.csv`, lines);
});

module.exports = router;
