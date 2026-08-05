const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { parseNamesFromUpload, findMemberByName } = require('../utils/members');
const { buildTemplateWorkbook, readRowsFromFile } = require('../utils/spreadsheet');
const { formatDateLabel } = require('../utils/dates');
const { BADGE_WIDTH, BADGE_HEIGHT } = require('../utils/nameTagBadge');
const { getTemplate, badgeDataForMember } = require('../utils/nameTagData');
const { CARD_WIDTH, CARD_HEIGHT } = require('../utils/scheduleCardBadge');
const { scheduleCardDataForMember, getScheduleCardTemplate } = require('../utils/scheduleCardData');
const NameTagRenderCore = require('../public/js/name-tag-render-core');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });
const REASON_LABELS = { personal: 'Personal', medical: 'Medical' };

// Member profile photos - stored on disk (not memory) since they're kept
// long-term and served back out, unlike the CSV imports above.
const PHOTO_DIR = path.join(__dirname, '..', 'public', 'uploads', 'members');
if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });

const uploadPhoto = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PHOTO_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// Every Absence/Late form submission across all rosters, newest first.
function allAbsenceSubmissions(dateFilter) {
  let sql = `SELECT m.name AS memberName, r.name AS rosterName, a.session_date AS date, a.status,
             a.reason_category AS reasonCategory, a.reason_text AS reasonText
             FROM attendance a
             JOIN members m ON m.id = a.member_id
             JOIN rosters r ON r.id = a.roster_id
             WHERE a.source = 'absence_form'`;
  const params = [];
  if (dateFilter) {
    sql += ' AND a.session_date = ?';
    params.push(dateFilter);
  }
  sql += ' ORDER BY a.session_date DESC, m.name COLLATE NOCASE';

  return db
    .prepare(sql)
    .all(...params)
    .map((r) => ({
      memberName: r.memberName,
      rosterName: r.rosterName,
      dateLabel: formatDateLabel(r.date),
      statusLabel: r.status === 'late' ? 'Late' : 'Absent',
      reasonLabel: REASON_LABELS[r.reasonCategory] || '—',
      description: r.reasonText || '—',
    }));
}

function absenceSubmissionDates() {
  return db
    .prepare(`SELECT DISTINCT session_date FROM attendance WHERE source = 'absence_form' ORDER BY session_date DESC`)
    .all()
    .map((r) => ({ date: r.session_date, label: formatDateLabel(r.session_date) }));
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

// --- Members page (the full member list) ---

function activeParents(excludeId) {
  return db
    .prepare("SELECT id, name FROM members WHERE active = 1 AND member_type = 'parent' AND id != ? ORDER BY name COLLATE NOCASE")
    .all(excludeId || 0);
}

function membersWithDetails(typeFilter) {
  const allMembers = db.prepare('SELECT * FROM members ORDER BY active DESC, name COLLATE NOCASE').all();
  const parentNames = {};
  for (const m of allMembers) parentNames[m.id] = m.name;
  const members = typeFilter ? allMembers.filter((m) => m.member_type === typeFilter) : allMembers;
  return members.map((m) => ({
    ...m,
    rosters: rostersForMember(m.id),
    parentName: m.parent_id ? parentNames[m.parent_id] || null : null,
  }));
}

router.get('/members', requireAdmin, (req, res) => {
  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  const templates = { student: getTemplate('student'), parent: getTemplate('parent'), admin: getTemplate('admin') };
  const scheduleCardTemplate = getScheduleCardTemplate();
  const scheduleCardBgCss = NameTagRenderCore.backgroundCss(scheduleCardTemplate.background, scheduleCardTemplate.backgroundOpacity);
  const withRosters = membersWithDetails(typeFilter).map((m) => {
    const badgeLayout = templates[m.member_type] || templates.student;
    const badgeData = badgeDataForMember(m);
    return {
      ...m,
      badgeHtml: NameTagRenderCore.renderBadgeElements(badgeLayout.elements, badgeData),
      badgeBgCss: NameTagRenderCore.backgroundCss(badgeLayout.background, badgeLayout.backgroundOpacity),
      scheduleCardHtml: m.member_type === 'student' ? NameTagRenderCore.renderBadgeElements(scheduleCardTemplate.elements, scheduleCardDataForMember(m)) : null,
      scheduleCardBgCss: scheduleCardBgCss,
    };
  });
  res.render('admin-members', {
    title: 'Members',
    members: withRosters,
    typeFilter,
    badgeWidth: BADGE_WIDTH,
    badgeHeight: BADGE_HEIGHT,
    cardWidth: CARD_WIDTH,
    cardHeight: CARD_HEIGHT,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.get('/members/export.csv', requireAdmin, (req, res) => {
  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  const members = membersWithDetails(typeFilter);

  const typeLabel = (t) => (t === 'parent' ? 'Parent' : t === 'admin' ? 'Admin' : 'Student');
  const header = ['Name', 'Type', 'Parent', 'Rosters'];
  const lines = members.map((m) =>
    [
      `"${m.name.replace(/"/g, '""')}"`,
      typeLabel(m.member_type),
      m.parentName ? `"${m.parentName.replace(/"/g, '""')}"` : '',
      `"${m.rosters.map((r) => r.name).join('; ').replace(/"/g, '""')}"`,
    ].join(',')
  );

  const csv = [header.join(','), ...lines].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="members${typeFilter ? '-' + typeFilter : ''}.csv"`);
  res.send(csv);
});

const MEMBER_TYPES = ['student', 'parent', 'admin'];

function memberFormFields(req) {
  const memberType = MEMBER_TYPES.includes(req.body.memberType) ? req.body.memberType : 'student';
  return {
    name: (req.body.name || '').trim(),
    barcode: (req.body.barcode || '').trim(),
    memberType,
    address: (req.body.address || '').trim() || null,
    city: (req.body.city || '').trim() || null,
    state: (req.body.state || '').trim() || null,
    zip: (req.body.zip || '').trim() || null,
    phone: (req.body.phone || '').trim() || null,
    email: (req.body.email || '').trim() || null,
    birthday: memberType === 'student' ? (req.body.birthday || '').trim() || null : null,
    gradeLevel: memberType === 'student' ? (req.body.gradeLevel || '').trim() || null : null,
    medicalNotes: memberType === 'student' ? (req.body.medicalNotes || '').trim() || null : null,
    parentId: memberType === 'student' && req.body.parentId ? parseInt(req.body.parentId, 10) || null : null,
    cleanupTeamIds:
      memberType === 'parent'
        ? [].concat(req.body.cleanupTeamIds || []).map((id) => parseInt(id, 10)).filter(Boolean)
        : null,
  };
}

// Keeps setup_team_members in sync with the Cleanup Team checkboxes on a
// parent's profile, so editing it there is reflected on the actual
// Setup/Cleanup team charts (and vice versa - both read/write the same table).
function syncCleanupTeams(memberId, teamIds) {
  if (teamIds === null) return;
  db.prepare('DELETE FROM setup_team_members WHERE member_id = ?').run(memberId);
  const link = db.prepare('INSERT OR IGNORE INTO setup_team_members (team_id, member_id) VALUES (?, ?)');
  for (const teamId of teamIds) link.run(teamId, memberId);
}

function allSetupTeams() {
  return db.prepare('SELECT id, day, title FROM setup_teams ORDER BY day, title COLLATE NOCASE').all();
}

function cleanupTeamIdsForMember(memberId) {
  return db.prepare('SELECT team_id FROM setup_team_members WHERE member_id = ?').all(memberId).map((r) => r.team_id);
}

router.get('/members/new', requireAdmin, (req, res) => {
  res.render('admin-member-edit', {
    title: 'Add Member',
    mode: 'create',
    member: {
      member_type: 'student',
      name: '',
      barcode: '',
      address: '',
      city: '',
      state: '',
      zip: '',
      phone: '',
      email: '',
      photo_path: null,
      birthday: '',
      grade_level: '',
      medical_notes: '',
      parent_id: null,
    },
    parents: activeParents(),
    setupTeams: allSetupTeams(),
    memberCleanupTeamIds: [],
    error: req.query.error || null,
  });
});

router.post('/members/new', requireAdmin, uploadPhoto.single('photo'), (req, res) => {
  const f = memberFormFields(req);

  if (!f.name) {
    return res.redirect('/admin/members/new?error=' + encodeURIComponent('Name is required.'));
  }
  const barcode = f.barcode || f.name;
  const exists = db.prepare('SELECT id FROM members WHERE barcode = ?').get(barcode);
  if (exists) {
    const msg = f.barcode ? 'That barcode is already in use.' : `"${barcode}" is already in the member list.`;
    return res.redirect('/admin/members/new?error=' + encodeURIComponent(msg));
  }

  const photoPath = req.file ? `/uploads/members/${req.file.filename}` : null;

  const info = db
    .prepare(
      `INSERT INTO members
         (name, barcode, member_type, address, city, state, zip, phone, email, photo_path, birthday, grade_level, medical_notes, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      f.name,
      barcode,
      f.memberType,
      f.address,
      f.city,
      f.state,
      f.zip,
      f.phone,
      f.email,
      photoPath,
      f.birthday,
      f.gradeLevel,
      f.medicalNotes,
      f.parentId
    );
  syncCleanupTeams(info.lastInsertRowid, f.cleanupTeamIds);

  res.redirect('/admin/members?notice=' + encodeURIComponent(`${f.name} added.`));
});

router.get('/members/:id/edit', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');

  res.render('admin-member-edit', {
    title: `Edit ${member.name}`,
    mode: 'edit',
    member,
    parents: activeParents(id),
    setupTeams: allSetupTeams(),
    memberCleanupTeamIds: cleanupTeamIdsForMember(id),
    error: req.query.error || null,
  });
});

router.post('/members/:id/edit', requireAdmin, uploadPhoto.single('photo'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const f = memberFormFields(req);

  if (!f.name) {
    return res.redirect(`/admin/members/${id}/edit?error=` + encodeURIComponent('Name is required.'));
  }
  const barcode = f.barcode || f.name;
  const clash = db.prepare('SELECT id FROM members WHERE barcode = ? AND id != ?').get(barcode, id);
  if (clash) {
    const msg = f.barcode ? 'That barcode is already in use.' : `"${barcode}" is already in the member list.`;
    return res.redirect(`/admin/members/${id}/edit?error=` + encodeURIComponent(msg));
  }
  // A student can't be their own parent.
  const parentId = f.parentId === id ? null : f.parentId;

  const existing = db.prepare('SELECT photo_path FROM members WHERE id = ?').get(id);
  const photoPath = req.file ? `/uploads/members/${req.file.filename}` : existing ? existing.photo_path : null;

  db.prepare(
    `UPDATE members SET
       name = ?, barcode = ?, member_type = ?, address = ?, city = ?, state = ?, zip = ?, phone = ?, email = ?,
       photo_path = ?, birthday = ?, grade_level = ?, medical_notes = ?, parent_id = ?
     WHERE id = ?`
  ).run(
    f.name,
    barcode,
    f.memberType,
    f.address,
    f.city,
    f.state,
    f.zip,
    f.phone,
    f.email,
    photoPath,
    f.birthday,
    f.gradeLevel,
    f.medicalNotes,
    parentId,
    id
  );
  syncCleanupTeams(id, f.cleanupTeamIds);

  res.redirect('/admin/members?notice=' + encodeURIComponent(`${f.name} updated.`));
});

// Full-profile bulk import - the Members page is the only place a CSV/XLSX
// upload can create brand-new member records, so unlike every other import
// popup in the app, this one reads the full set of profile columns.
router.get('/members/import-template.xlsx', requireAdmin, (req, res) => {
  const buffer = buildTemplateWorkbook(
    ['Name', 'Type', 'Address', 'City', 'State', 'Zip', 'Phone', 'Email', 'Birthday', 'Grade Level', 'Medical/Allergy Notes', 'Parent Name'],
    [
      ['Jane Smith', 'Parent', '123 Main St', 'Anytown', 'NC', '27330', '555-987-6543', 'jane@example.com', '', '', '', ''],
      ['Alice Smith', 'Student', '123 Main St', 'Anytown', 'NC', '27330', '555-123-4567', '', '2015-04-12', '5th Grade', 'Peanut allergy', 'Jane Smith'],
    ]
  );
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="members-import-template.xlsx"');
  res.send(buffer);
});

const MEMBER_IMPORT_HEADER_ALIASES = {
  name: ['name'],
  type: ['type', 'member type'],
  address: ['address'],
  city: ['city'],
  state: ['state'],
  zip: ['zip', 'zip code', 'zipcode'],
  phone: ['phone', 'phone number'],
  email: ['email', 'email address'],
  birthday: ['birthday', 'birth date', 'dob'],
  gradeLevel: ['grade level', 'grade'],
  medicalNotes: ['medical/allergy notes', 'medical notes', 'allergy notes', 'medical'],
  parentName: ['parent name', 'parent'],
};

function normalizeImportRow(row) {
  const lowerMap = {};
  for (const key of Object.keys(row)) lowerMap[key.trim().toLowerCase()] = row[key];
  const out = {};
  for (const [field, aliases] of Object.entries(MEMBER_IMPORT_HEADER_ALIASES)) {
    for (const alias of aliases) {
      if (lowerMap[alias] !== undefined && String(lowerMap[alias]).trim() !== '') {
        out[field] = String(lowerMap[alias]).trim();
        break;
      }
    }
  }
  return out;
}

router.post('/members/import', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.redirect('/admin/members?error=' + encodeURIComponent('Please choose a file to import.'));
  }

  let rows;
  try {
    rows = readRowsFromFile(req.file.buffer).map(normalizeImportRow).filter((r) => r.name);
  } catch (err) {
    return res.redirect('/admin/members?error=' + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'));
  }

  let created = 0;
  let skipped = 0;
  const nameToId = {};

  for (const r of rows) {
    const existing = db.prepare('SELECT id FROM members WHERE active = 1 AND name = ? COLLATE NOCASE').get(r.name);
    if (existing) {
      nameToId[r.name.toLowerCase()] = existing.id;
      skipped++;
      continue;
    }
    const typeLower = (r.type || '').toLowerCase();
    const memberType = MEMBER_TYPES.includes(typeLower) ? typeLower : 'student';
    let barcode = r.name;
    if (db.prepare('SELECT id FROM members WHERE barcode = ?').get(barcode)) {
      barcode = `${r.name} (${Date.now().toString(36)})`;
    }
    const info = db
      .prepare(
        `INSERT INTO members (name, barcode, member_type, address, city, state, zip, phone, email, birthday, grade_level, medical_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        r.name,
        barcode,
        memberType,
        r.address || null,
        r.city || null,
        r.state || null,
        r.zip || null,
        r.phone || null,
        r.email || null,
        memberType === 'student' ? r.birthday || null : null,
        memberType === 'student' ? r.gradeLevel || null : null,
        memberType === 'student' ? r.medicalNotes || null : null
      );
    nameToId[r.name.toLowerCase()] = info.lastInsertRowid;
    created++;
  }

  let linkedParents = 0;
  for (const r of rows) {
    if (!r.parentName) continue;
    const studentId = nameToId[r.name.toLowerCase()];
    const parentRow = db
      .prepare("SELECT id FROM members WHERE active = 1 AND member_type = 'parent' AND name = ? COLLATE NOCASE")
      .get(r.parentName);
    const parentId = nameToId[r.parentName.toLowerCase()] || (parentRow ? parentRow.id : null);
    if (studentId && parentId) {
      db.prepare('UPDATE members SET parent_id = ? WHERE id = ?').run(parentId, studentId);
      linkedParents++;
    }
  }

  res.redirect(
    '/admin/members?notice=' +
      encodeURIComponent(
        `Imported ${rows.length} row(s): ${created} new member(s) created, ${skipped} already existed` +
          (linkedParents ? `, ${linkedParents} linked to a parent.` : '.')
      )
  );
});

router.post('/members/:id/notes', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const notes = (req.body.notes || '').trim();
  db.prepare('UPDATE members SET notes = ? WHERE id = ?').run(notes || null, id);
  res.redirect('/admin/members');
});

router.get('/members/:id/name-tag/print', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');

  const layout = getTemplate(member.member_type);
  const data = badgeDataForMember(member);
  res.render('admin-name-tag-print', {
    title: `Name Tag - ${member.name}`,
    html: NameTagRenderCore.renderBadgeElements(layout.elements, data),
    bgCss: NameTagRenderCore.backgroundCss(layout.background, layout.backgroundOpacity),
    badgeWidth: BADGE_WIDTH,
    badgeHeight: BADGE_HEIGHT,
  });
});

router.get('/members/:id/schedule-card/print', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare("SELECT * FROM members WHERE id = ? AND member_type = 'student'").get(id);
  if (!member) return res.status(404).send('Not found');

  const template = getScheduleCardTemplate();
  res.render('admin-name-tag-print', {
    title: `Schedule Card - ${member.name}`,
    heading: 'Schedule Card',
    html: NameTagRenderCore.renderBadgeElements(template.elements, scheduleCardDataForMember(member)),
    bgCss: NameTagRenderCore.backgroundCss(template.background, template.backgroundOpacity),
    badgeWidth: CARD_WIDTH,
    badgeHeight: CARD_HEIGHT,
  });
});

router.post('/members/:id/delete', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  db.prepare('DELETE FROM members WHERE id = ?').run(id);
  res.redirect(
    '/admin/members?notice=' + encodeURIComponent(member ? `Deleted "${member.name}".` : 'Member deleted.')
  );
});

// --- Absence/Late submissions log (every member is always eligible to be
// picked on the public absence form - no separate opt-in list to manage) ---

router.get('/absence-list', requireAdmin, (req, res) => {
  const dateFilter = req.query.date || '';

  res.render('admin-rosters', {
    title: 'Absence/Late Log',
    tab: 'absence',
    submissions: allAbsenceSubmissions(dateFilter),
    submissionDates: absenceSubmissionDates(),
    dateFilter,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.get('/absence-list/export.csv', requireAdmin, (req, res) => {
  const dateFilter = req.query.date || '';
  const submissions = allAbsenceSubmissions(dateFilter);

  const header = ['Name', 'Roster', 'Date', 'Status', 'Reason', 'Description'];
  const lines = submissions.map((s) =>
    [
      `"${s.memberName.replace(/"/g, '""')}"`,
      `"${s.rosterName.replace(/"/g, '""')}"`,
      s.dateLabel,
      s.statusLabel,
      s.reasonLabel,
      `"${(s.description || '').replace(/"/g, '""')}"`,
    ].join(',')
  );

  const csv = [header.join(','), ...lines].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="absence-late-log.csv"');
  res.send(csv);
});

module.exports = router;
