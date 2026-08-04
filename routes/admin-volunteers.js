const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { isValidISODate, formatDateLabel } = require('../utils/dates');
const { parseNamesFile, findOrCreateMemberByName } = require('../utils/members');
const {
  DAYS,
  DAY_LABELS,
  isValidDay,
  getListByDay,
  sectionsForList,
  datesForList,
  membersForList,
  buildListGrid,
} = require('../utils/volunteers');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

function requireDay(req, res, next) {
  if (!isValidDay(req.params.day)) return res.status(404).send('Not found');
  next();
}

// --- Landing page: two square cards, one per volunteer day ---

router.get('/volunteers', requireAdmin, (req, res) => {
  const rosters = db.prepare('SELECT * FROM rosters WHERE active = 1 ORDER BY name COLLATE NOCASE').all();
  const cards = DAYS.map((day) => {
    const list = getListByDay(day);
    const roster = list.roster_id ? db.prepare('SELECT * FROM rosters WHERE id = ?').get(list.roster_id) : null;
    return { day, label: DAY_LABELS[day], rosterId: list.roster_id, rosterName: roster ? roster.name : null };
  });
  res.render('admin-volunteers', {
    title: 'Volunteers',
    cards,
    rosters,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/volunteers/:day/link', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const rosterId = parseInt(req.body.rosterId, 10) || null;
  db.prepare('UPDATE volunteer_lists SET roster_id = ? WHERE id = ?').run(rosterId, list.id);
  const roster = rosterId ? db.prepare('SELECT * FROM rosters WHERE id = ?').get(rosterId) : null;
  const notice = roster
    ? `${DAY_LABELS[day]} volunteers linked to "${roster.name}".`
    : `${DAY_LABELS[day]} volunteers unlinked from any roster.`;
  res.redirect('/admin/volunteers?notice=' + encodeURIComponent(notice));
});

// --- Manage page: sections, dates, members, position/room grid ---

router.get('/volunteers/:day/manage', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const sections = sectionsForList(list.id);
  const members = membersForList(list.id);
  const memberIds = members.map((m) => m.id);
  const availableMembers = db
    .prepare('SELECT * FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE')
    .all()
    .filter((m) => !memberIds.includes(m.id));
  const dates = datesForList(list.id);
  const roster = list.roster_id ? db.prepare('SELECT * FROM rosters WHERE id = ?').get(list.roster_id) : null;

  res.render('admin-volunteer-manage', {
    title: `${DAY_LABELS[day]} Volunteers`,
    day,
    dayLabel: DAY_LABELS[day],
    roster,
    sections,
    availableMembers,
    dates: dates.map((d) => ({ date: d, label: formatDateLabel(d) })),
    grid: buildListGrid(list.id, null),
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
  res.redirect(`/admin/volunteers/${day}/manage?notice=` + encodeURIComponent('Section labels updated.'));
});

router.post('/volunteers/:day/dates/add', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const dates = [...new Set([].concat(req.body.dates || []).map((d) => d.trim()).filter(isValidISODate))];
  const insertDate = db.prepare('INSERT OR IGNORE INTO volunteer_dates (volunteer_list_id, session_date) VALUES (?, ?)');
  for (const d of dates) insertDate.run(list.id, d);
  res.redirect(`/admin/volunteers/${day}/manage?notice=` + encodeURIComponent(`Added ${dates.length} date(s).`));
});

router.post('/volunteers/:day/dates/:date/remove', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const date = req.params.date;
  db.prepare('DELETE FROM volunteer_dates WHERE volunteer_list_id = ? AND session_date = ?').run(list.id, date);
  db.prepare('DELETE FROM volunteer_assignments WHERE volunteer_list_id = ? AND session_date = ?').run(list.id, date);
  res.redirect(`/admin/volunteers/${day}/manage?notice=` + encodeURIComponent(`Removed ${formatDateLabel(date)}.`));
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
  const memberId = parseInt(req.body.memberId, 10);
  const sectionId = firstSectionId(list.id);
  if (memberId && sectionId) {
    db.prepare('INSERT OR IGNORE INTO volunteer_members (volunteer_list_id, member_id, section_id) VALUES (?, ?, ?)').run(
      list.id,
      memberId,
      sectionId
    );
  }
  res.redirect(`/admin/volunteers/${day}/manage`);
});

router.post('/volunteers/:day/import', requireAdmin, requireDay, upload.single('file'), (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const sectionId = firstSectionId(list.id);
  if (!req.file) {
    return res.redirect(`/admin/volunteers/${day}/manage?error=` + encodeURIComponent('Please choose a file to import.'));
  }
  const names = parseNamesFile(req.file.buffer);
  const linkMember = db.prepare('INSERT OR IGNORE INTO volunteer_members (volunteer_list_id, member_id, section_id) VALUES (?, ?, ?)');
  let created = 0;
  let added = 0;
  for (const name of names) {
    const { member, created: wasCreated } = findOrCreateMemberByName(name);
    if (wasCreated) created++;
    const result = linkMember.run(list.id, member.id, sectionId);
    if (result.changes > 0) added++;
  }
  res.redirect(
    `/admin/volunteers/${day}/manage?notice=` +
      encodeURIComponent(`Imported ${names.length} name(s): ${created} new member(s), ${added} added to the list.`)
  );
});

router.post('/volunteers/:day/members/:memberId/section', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const memberId = parseInt(req.params.memberId, 10);
  const sectionId = parseInt(req.body.sectionId, 10);
  if (sectionId) {
    db.prepare('UPDATE volunteer_members SET section_id = ? WHERE volunteer_list_id = ? AND member_id = ?').run(
      sectionId,
      list.id,
      memberId
    );
  }
  res.redirect(`/admin/volunteers/${day}/manage`);
});

router.post('/volunteers/:day/remove-member/:memberId', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  db.prepare('DELETE FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ?').run(list.id, req.params.memberId);
  res.redirect(`/admin/volunteers/${day}/manage`);
});

// Bulk-saves position/room text fields. Used both by the full manage-page
// grid (many dates at once) and the single-date box on a linked roster's
// view page. Fields arrive as flat "position:<memberId>:<date>" /
// "room:<memberId>:<date>" keys - nested bracket names like
// position[1][2026-08-03] get silently mangled by Express's body parser,
// which treats purely-numeric bracket segments as array indices.
router.post('/volunteers/:day/assignments', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const upsert = db.prepare(
    `INSERT INTO volunteer_assignments (volunteer_list_id, member_id, session_date, position, room)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(volunteer_list_id, member_id, session_date) DO UPDATE SET position = excluded.position, room = excluded.room`
  );
  const cells = {};
  for (const key of Object.keys(req.body)) {
    const match = /^(position|room):(\d+):(\d{4}-\d{2}-\d{2})$/.exec(key);
    if (!match) continue;
    const [, field, memberId, date] = match;
    const cellKey = `${memberId}|${date}`;
    if (!cells[cellKey]) cells[cellKey] = { memberId: parseInt(memberId, 10), date, position: '', room: '' };
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

module.exports = router;
