const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { parseNamesFile, findOrCreateMemberByName } = require('../utils/members');
const { formatDateLabel } = require('../utils/dates');
const { DAYS, DAY_LABELS, isValidDay, getListByDay, sectionsForList } = require('../utils/volunteers');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });
const REASON_LABELS = { personal: 'Personal', medical: 'Medical' };

// Every Absence/Late form submission across all rosters, newest first.
function allAbsenceSubmissions() {
  return db
    .prepare(
      `SELECT m.name AS memberName, r.name AS rosterName, a.session_date AS date, a.status,
              a.reason_category AS reasonCategory, a.reason_text AS reasonText
       FROM attendance a
       JOIN members m ON m.id = a.member_id
       JOIN rosters r ON r.id = a.roster_id
       WHERE a.source = 'absence_form'
       ORDER BY a.session_date DESC, m.name COLLATE NOCASE`
    )
    .all()
    .map((r) => ({
      memberName: r.memberName,
      rosterName: r.rosterName,
      dateLabel: formatDateLabel(r.date),
      statusLabel: r.status === 'late' ? 'Late' : 'Absent',
      reasonLabel: REASON_LABELS[r.reasonCategory] || '—',
      description: r.reasonText || '—',
    }));
}

function rostersForMember(memberId) {
  return db
    .prepare(
      `SELECT r.* FROM rosters r
       JOIN roster_members rm ON rm.roster_id = r.id
       WHERE rm.member_id = ? ORDER BY r.name COLLATE NOCASE`
    )
    .all(memberId);
}

function absenceListMembers() {
  return db
    .prepare(
      `SELECT m.* FROM members m
       JOIN absence_list_members alm ON alm.member_id = m.id
       WHERE m.active = 1 ORDER BY m.name COLLATE NOCASE`
    )
    .all();
}

// --- Members page (the full member list) ---

router.get('/members', requireAdmin, (req, res) => {
  const members = db.prepare('SELECT * FROM members ORDER BY active DESC, name COLLATE NOCASE').all();
  const withRosters = members.map((m) => ({ ...m, rosters: rostersForMember(m.id) }));
  res.render('admin-members', {
    title: 'Members',
    members: withRosters,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/members', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  const customBarcode = (req.body.barcode || '').trim();

  if (!name) {
    return res.redirect('/admin/members?error=' + encodeURIComponent('Name is required.'));
  }

  // Barcodes read as names, so default the barcode to the member's name.
  const barcode = customBarcode || name;
  const exists = db.prepare('SELECT id FROM members WHERE barcode = ?').get(barcode);
  if (exists) {
    const msg = customBarcode ? 'That barcode is already in use.' : `"${barcode}" is already in the member list.`;
    return res.redirect('/admin/members?error=' + encodeURIComponent(msg));
  }

  db.prepare('INSERT INTO members (name, barcode) VALUES (?, ?)').run(name, barcode);
  res.redirect('/admin/members');
});

// Names-only bulk import, not tied to any roster or the absence list -
// just populates the shared member list.
router.post('/members/import', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.redirect('/admin/members?error=' + encodeURIComponent('Please choose a file to import.'));
  }
  const names = parseNamesFile(req.file.buffer);
  let created = 0;
  for (const name of names) {
    const { created: wasCreated } = findOrCreateMemberByName(name);
    if (wasCreated) created++;
  }
  res.redirect('/admin/members?notice=' + encodeURIComponent(`Imported ${names.length} name(s): ${created} new member(s) created.`));
});

router.post('/members/:id/edit', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/admin/members?error=' + encodeURIComponent('Name is required.'));
  db.prepare('UPDATE members SET name = ? WHERE id = ?').run(name, id);
  res.redirect('/admin/members');
});

router.post('/members/:id/notes', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const notes = (req.body.notes || '').trim();
  db.prepare('UPDATE members SET notes = ? WHERE id = ?').run(notes || null, id);
  res.redirect('/admin/members');
});

// --- Per-member Manage page: add/remove this one member from rosters,
// volunteer lists, and the absence list, all in one place. ---

router.get('/members/:id/manage', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');

  const currentRosters = rostersForMember(id);
  const currentRosterIds = currentRosters.map((r) => r.id);
  const availableRosters = db
    .prepare('SELECT * FROM rosters WHERE active = 1 ORDER BY name COLLATE NOCASE')
    .all()
    .filter((r) => !currentRosterIds.includes(r.id));

  const volunteerLists = DAYS.map((day) => {
    const list = getListByDay(day);
    const membership = db
      .prepare('SELECT section_id FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ?')
      .get(list.id, id);
    return {
      day,
      label: DAY_LABELS[day],
      sections: sectionsForList(list.id),
      onList: !!membership,
      sectionId: membership ? membership.section_id : null,
    };
  });

  const onAbsenceList = !!db.prepare('SELECT 1 FROM absence_list_members WHERE member_id = ?').get(id);

  res.render('admin-member-manage', {
    title: `Manage ${member.name}`,
    member,
    currentRosters,
    availableRosters,
    volunteerLists,
    onAbsenceList,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/members/:id/manage/add-roster', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rosterId = parseInt(req.body.rosterId, 10);
  if (rosterId) db.prepare('INSERT OR IGNORE INTO roster_members (roster_id, member_id) VALUES (?, ?)').run(rosterId, id);
  res.redirect(`/admin/members/${id}/manage`);
});

router.post('/members/:id/manage/remove-roster/:rosterId', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rosterId = parseInt(req.params.rosterId, 10);
  db.prepare('DELETE FROM roster_members WHERE roster_id = ? AND member_id = ?').run(rosterId, id);
  res.redirect(`/admin/members/${id}/manage`);
});

router.post('/members/:id/manage/set-volunteer', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const day = req.body.day;
  const sectionId = parseInt(req.body.sectionId, 10);
  if (isValidDay(day) && sectionId) {
    const list = getListByDay(day);
    db.prepare(
      `INSERT INTO volunteer_members (volunteer_list_id, member_id, section_id) VALUES (?, ?, ?)
       ON CONFLICT(volunteer_list_id, member_id) DO UPDATE SET section_id = excluded.section_id`
    ).run(list.id, id, sectionId);
  }
  res.redirect(`/admin/members/${id}/manage`);
});

router.post('/members/:id/manage/remove-volunteer/:day', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const day = req.params.day;
  if (isValidDay(day)) {
    const list = getListByDay(day);
    db.prepare('DELETE FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ?').run(list.id, id);
  }
  res.redirect(`/admin/members/${id}/manage`);
});

router.post('/members/:id/manage/add-absence', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('INSERT OR IGNORE INTO absence_list_members (member_id) VALUES (?)').run(id);
  res.redirect(`/admin/members/${id}/manage`);
});

router.post('/members/:id/manage/remove-absence', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM absence_list_members WHERE member_id = ?').run(id);
  res.redirect(`/admin/members/${id}/manage`);
});

router.post('/members/:id/delete', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  db.prepare('DELETE FROM members WHERE id = ?').run(id);
  res.redirect(
    '/admin/members?notice=' + encodeURIComponent(member ? `Deleted "${member.name}".` : 'Member deleted.')
  );
});

// --- Absence/Late list (who CAN be picked on the public absence form) ---
// Membership works the same way roster membership does: an explicit
// opt-in join table, managed via add-existing/import/remove here.

router.get('/absence-list', requireAdmin, (req, res) => {
  const members = absenceListMembers();
  const memberIds = members.map((m) => m.id);
  const availableMembers = db
    .prepare('SELECT * FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE')
    .all()
    .filter((m) => !memberIds.includes(m.id));

  res.render('admin-absence-list', {
    title: 'Absence/Late Form',
    members,
    availableMembers,
    submissions: allAbsenceSubmissions(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/absence-list/add-person', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    return res.redirect('/admin/absence-list?error=' + encodeURIComponent('Name is required.'));
  }
  const { member } = findOrCreateMemberByName(name);
  db.prepare('INSERT OR IGNORE INTO absence_list_members (member_id) VALUES (?)').run(member.id);
  res.redirect('/admin/absence-list');
});

router.post('/absence-list/add-member', requireAdmin, (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  if (memberId) {
    db.prepare('INSERT OR IGNORE INTO absence_list_members (member_id) VALUES (?)').run(memberId);
  }
  res.redirect('/admin/absence-list');
});

router.post('/absence-list/import', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.redirect('/admin/absence-list?error=' + encodeURIComponent('Please choose a file to import.'));
  }
  const names = parseNamesFile(req.file.buffer);
  const linkMember = db.prepare('INSERT OR IGNORE INTO absence_list_members (member_id) VALUES (?)');
  let created = 0;
  let added = 0;
  for (const name of names) {
    const { member, created: wasCreated } = findOrCreateMemberByName(name);
    if (wasCreated) created++;
    const result = linkMember.run(member.id);
    if (result.changes > 0) added++;
  }
  res.redirect(
    '/admin/absence-list?notice=' +
      encodeURIComponent(`Imported ${names.length} name(s): ${created} new member(s), ${added} added to the list.`)
  );
});

router.post('/absence-list/remove-member/:memberId', requireAdmin, (req, res) => {
  const memberId = parseInt(req.params.memberId, 10);
  db.prepare('DELETE FROM absence_list_members WHERE member_id = ?').run(memberId);
  res.redirect('/admin/absence-list');
});

module.exports = router;
