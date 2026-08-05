const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { buildTemplateWorkbook, readRowsFromFile, toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { formatDateLabel } = require('../utils/dates');
const { imageFileFilter } = require('../utils/uploads');
const { BADGE_WIDTH, BADGE_HEIGHT } = require('../utils/nameTagBadge');
const { getTemplate, badgeDataForMember } = require('../utils/nameTagData');
const { CARD_WIDTH, CARD_HEIGHT } = require('../utils/scheduleCardBadge');
const { scheduleCardDataForMember, getScheduleCardTemplate } = require('../utils/scheduleCardData');
const { getMemberSchedule } = require('../utils/schedule');
const NameTagRenderCore = require('../public/js/name-tag-render-core');
const { familyOf, setFamilyMembers } = require('../utils/members');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });
const MEMBER_TYPES = ['student', 'parent', 'admin'];

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
  fileFilter: imageFileFilter,
});

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

// Every other active member, any type - the picker for "who's in this
// person's family" on the edit form (family connections aren't
// restricted to parent/student anymore).
function activeMembersExcluding(excludeId) {
  return db
    .prepare('SELECT id, name, member_type AS memberType FROM members WHERE active = 1 AND id != ? ORDER BY name COLLATE NOCASE')
    .all(excludeId || 0);
}

function membersWithDetails(typeFilter) {
  const allMembers = db.prepare('SELECT * FROM members ORDER BY active DESC, name COLLATE NOCASE').all();
  const members = typeFilter ? allMembers.filter((m) => m.member_type === typeFilter) : allMembers;
  return members.map((m) => ({
    ...m,
    rosters: rostersForMember(m.id),
    familyNames: familyOf(m.id).map((p) => p.name),
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
      scheduleCardHtml: NameTagRenderCore.renderBadgeElements(scheduleCardTemplate.elements, scheduleCardDataForMember(m)),
      scheduleCardBgCss: scheduleCardBgCss,
      schedule: getMemberSchedule(m.id),
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
  const lines = [
    toCsvRow(['Name', 'Type', 'Family', 'Rosters']),
    ...members.map((m) =>
      toCsvRow([m.name, typeLabel(m.member_type), m.familyNames.join('; '), m.rosters.map((r) => r.name).join('; ')])
    ),
  ];

  sendCsv(res, `members${typeFilter ? '-' + typeFilter : ''}.csv`, lines);
});

function memberFormFields(req) {
  const memberType = MEMBER_TYPES.includes(req.body.memberType) ? req.body.memberType : 'student';
  return {
    name: (req.body.name || '').trim(),
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
    familyMemberIds: [].concat(req.body.familyMemberIds || []).map((id) => parseInt(id, 10)).filter(Boolean),
    cleanupTeamIds:
      memberType === 'parent'
        ? [].concat(req.body.cleanupTeamIds || []).map((id) => parseInt(id, 10)).filter(Boolean)
        : null,
  };
}

// Keeps setup_team_members in sync with the Cleanup Team checkboxes on a
// parent's profile, so editing it there is reflected on the actual
// Setup/Cleanup team charts (and vice versa - both read/write the same
// table). Always clears existing rows first (not just when teamIds is a
// real list) so converting an existing parent to student/admin drops their
// stale team membership instead of leaving them stuck on a chart they can
// no longer manage from their own profile.
function syncCleanupTeams(memberId, teamIds) {
  db.prepare('DELETE FROM setup_team_members WHERE member_id = ?').run(memberId);
  if (!teamIds) return;
  const link = db.prepare('INSERT OR IGNORE INTO setup_team_members (team_id, member_id) VALUES (?, ?)');
  for (const teamId of teamIds) link.run(teamId, memberId);
}

// Floater Assignments (volunteer_members) only ever gets a parent added to
// it via the Volunteers admin page, never from a member's own profile - so
// there's nothing here to sync, only to clear if they're no longer a
// parent, for the same "converted away from parent" staleness as above.
function clearVolunteerMembershipIfNotParent(memberId, memberType) {
  if (memberType === 'parent') return;
  db.prepare('DELETE FROM volunteer_members WHERE member_id = ?').run(memberId);
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
    },
    familyOptions: activeMembersExcluding(),
    familyMemberIds: [],
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
  const barcode = f.name;
  const exists = db.prepare('SELECT id FROM members WHERE barcode = ?').get(barcode);
  if (exists) {
    return res.redirect('/admin/members/new?error=' + encodeURIComponent(`"${barcode}" is already in the member list.`));
  }

  const photoPath = req.file ? `/uploads/members/${req.file.filename}` : null;

  const info = db
    .prepare(
      `INSERT INTO members
         (name, barcode, member_type, address, city, state, zip, phone, email, photo_path, birthday, grade_level, medical_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      f.medicalNotes
    );
  syncCleanupTeams(info.lastInsertRowid, f.cleanupTeamIds);
  setFamilyMembers(info.lastInsertRowid, f.familyMemberIds);

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
    familyOptions: activeMembersExcluding(id),
    familyMemberIds: familyOf(id).map((m) => m.id),
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
  const barcode = f.name;
  const clash = db.prepare('SELECT id FROM members WHERE barcode = ? AND id != ?').get(barcode, id);
  if (clash) {
    return res.redirect(`/admin/members/${id}/edit?error=` + encodeURIComponent(`"${barcode}" is already in the member list.`));
  }
  const existing = db.prepare('SELECT photo_path FROM members WHERE id = ?').get(id);
  const photoPath = req.file ? `/uploads/members/${req.file.filename}` : existing ? existing.photo_path : null;

  db.prepare(
    `UPDATE members SET
       name = ?, barcode = ?, member_type = ?, address = ?, city = ?, state = ?, zip = ?, phone = ?, email = ?,
       photo_path = ?, birthday = ?, grade_level = ?, medical_notes = ?
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
    id
  );
  syncCleanupTeams(id, f.cleanupTeamIds);
  clearVolunteerMembershipIfNotParent(id, f.memberType);
  setFamilyMembers(id, f.familyMemberIds);

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

// Fields a matched-by-name import row can contribute to an existing
// member's profile - never overwrites a value the member already has,
// only fills in what's currently blank (see mergeableFieldsFor below).
const IMPORT_MERGE_FIELDS = [
  ['address', 'Address'],
  ['city', 'City'],
  ['state', 'State'],
  ['zip', 'Zip'],
  ['phone', 'Phone'],
  ['email', 'Email'],
  ['birthday', 'Birthday'],
  ['gradeLevel', 'Grade Level'],
  ['medicalNotes', 'Medical/Allergy Notes'],
];

// The DB column for each importable field differs from its JS name in a
// couple of cases (gradeLevel -> grade_level, medicalNotes -> medical_notes).
const IMPORT_FIELD_COLUMNS = {
  address: 'address',
  city: 'city',
  state: 'state',
  zip: 'zip',
  phone: 'phone',
  email: 'email',
  birthday: 'birthday',
  gradeLevel: 'grade_level',
  medicalNotes: 'medical_notes',
};

function mergeableFieldsFor(existingMember, row) {
  const updates = {};
  for (const [field] of IMPORT_MERGE_FIELDS) {
    const column = IMPORT_FIELD_COLUMNS[field];
    const incoming = row[field];
    if (!incoming) continue;
    if (existingMember[column]) continue; // never overwrite a value that's already set
    updates[field] = incoming;
  }
  return updates;
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
  const mergeCandidates = [];

  for (const r of rows) {
    const existing = db.prepare('SELECT * FROM members WHERE active = 1 AND name = ? COLLATE NOCASE').get(r.name);
    if (existing) {
      nameToId[r.name.toLowerCase()] = existing.id;
      skipped++;
      const updates = mergeableFieldsFor(existing, r);
      if (Object.keys(updates).length > 0) {
        mergeCandidates.push({ memberId: existing.id, memberName: existing.name, updates });
      }
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
    if (studentId && parentId && studentId !== parentId) {
      setFamilyMembers(studentId, [parentId]);
      linkedParents++;
    }
  }

  const summary =
    `Imported ${rows.length} row(s): ${created} new member(s) created, ${skipped} already existed` +
    (linkedParents ? `, ${linkedParents} linked to a parent.` : '.');

  if (mergeCandidates.length === 0) {
    return res.redirect('/admin/members?notice=' + encodeURIComponent(summary));
  }

  res.render('admin-members-import-confirm', {
    title: 'Confirm Import Merge',
    summary,
    candidates: mergeCandidates.map((c) => ({
      memberId: c.memberId,
      memberName: c.memberName,
      fields: IMPORT_MERGE_FIELDS.filter(([field]) => c.updates[field] !== undefined).map(([field, label]) => ({
        label,
        value: c.updates[field],
      })),
      payload: JSON.stringify(c.updates),
    })),
  });
});

router.post('/members/import/confirm', requireAdmin, (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const payloads = [].concat(req.body.payloads || []);
  const ids = [].concat(req.body.allMemberIds || []).map((id) => parseInt(id, 10));

  let merged = 0;
  ids.forEach((id, i) => {
    if (!memberIds.includes(id)) return; // this row's checkbox wasn't checked
    let updates;
    try {
      updates = JSON.parse(payloads[i] || '{}');
    } catch (err) {
      return;
    }
    const setClauses = [];
    const params = [];
    for (const [field, value] of Object.entries(updates)) {
      const column = IMPORT_FIELD_COLUMNS[field];
      if (!column) continue;
      setClauses.push(`${column} = ?`);
      params.push(value);
    }
    if (setClauses.length === 0) return;
    params.push(id);
    db.prepare(`UPDATE members SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
    merged++;
  });

  res.redirect('/admin/members?notice=' + encodeURIComponent(`Merged new profile details into ${merged} existing member(s).`));
});

router.post('/members/:id/notes', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const notes = (req.body.notes || '').trim();
  db.prepare('UPDATE members SET notes = ? WHERE id = ?').run(notes || null, id);
  res.redirect('/admin/members');
});

// Member profile "Cards" dialog: prints whichever of Name Tag / Schedule
// Card the admin checked, on one preview page. Every member type can have
// a class schedule, so Schedule Card is available regardless of type.
router.get('/members/:id/cards/print', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');

  const wanted = [].concat(req.query.cards || []);
  const cards = [];

  if (wanted.includes('nameTag')) {
    const layout = getTemplate(member.member_type);
    cards.push({
      heading: 'Name Tag',
      html: NameTagRenderCore.renderBadgeElements(layout.elements, badgeDataForMember(member)),
      bgCss: NameTagRenderCore.backgroundCss(layout.background, layout.backgroundOpacity),
      width: BADGE_WIDTH,
      height: BADGE_HEIGHT,
    });
  }
  if (wanted.includes('scheduleCard')) {
    const template = getScheduleCardTemplate();
    cards.push({
      heading: 'Schedule Card',
      html: NameTagRenderCore.renderBadgeElements(template.elements, scheduleCardDataForMember(member)),
      bgCss: NameTagRenderCore.backgroundCss(template.background, template.backgroundOpacity),
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    });
  }

  if (cards.length === 0) {
    return res.redirect('/admin/members?error=' + encodeURIComponent('Select at least one card to print.'));
  }

  res.render('admin-member-cards-print', {
    title: `Cards - ${member.name}`,
    memberName: member.name,
    cards,
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

module.exports = router;
