const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { buildTemplateWorkbook, readRowsFromFile, toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { formatDateLabel, formatTime, ageFromBirthday } = require('../utils/dates');
const { imageFileFilter, spreadsheetFileFilter } = require('../utils/uploads');
const { BADGE_WIDTH, BADGE_HEIGHT } = require('../utils/nameTagBadge');
const { getTemplate, badgeDataForMember } = require('../utils/nameTagData');
const { CARD_WIDTH, CARD_HEIGHT } = require('../utils/scheduleCardBadge');
const { scheduleCardDataForMember, getScheduleCardTemplate } = require('../utils/scheduleCardData');
const { getMemberSchedule } = require('../utils/schedule');
const NameTagRenderCore = require('../public/js/name-tag-render-core');
const { familyOf, allFamilies, setMemberFamily, setPrimaryParent, rostersForMember, membersWithDetails } = require('../utils/members');
const { GRADE_LEVELS } = require('../utils/classSchedule');
const { buildCardPairs } = require('../utils/cardPairs');
const { buildDuplexPages } = require('../utils/duplexPrint');
const { paginate, parsePage } = require('../utils/pagination');

router.use(requireFullAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });
const MEMBER_TYPES = ['student', 'parent'];

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

// Removes a member's photo file from disk given the web path stored in
// photo_path (e.g. "/uploads/members/172...-4821.jpg") - called whenever
// a photo is replaced or the member itself is deleted, so an old photo of
// a real child or parent doesn't sit on disk forever with no way to
// remove it once it's no longer referenced anywhere. Silently no-ops for
// null/already-missing files (deleting a member who never had a photo is
// the common case, not an error).
function deletePhotoFile(photoPath) {
  if (!photoPath) return;
  const filePath = path.join(PHOTO_DIR, path.basename(photoPath));
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// Every attendance record for this member across every roster they're on,
// newest first - the Members profile page's Attendance tab.
function attendanceHistoryForMember(memberId) {
  return db
    .prepare(
      `SELECT r.name AS rosterName, a.session_date AS date, a.status,
              a.check_in_time AS checkInTime, c.check_out_time AS checkOutTime, c.number AS number
       FROM attendance a
       JOIN rosters r ON r.id = a.roster_id
       LEFT JOIN checkouts c ON c.member_id = a.member_id AND c.roster_id = a.roster_id AND c.session_date = a.session_date
       WHERE a.member_id = ?
       ORDER BY a.session_date DESC`
    )
    .all(memberId);
}

// --- Members page (the full member list) ---

router.get('/members', (req, res) => {
  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  // Cards/Schedule dialog content (badge HTML, schedule-card HTML,
  // getMemberSchedule()) used to be computed here for every member on
  // every page load - two renderBadgeElements() calls and a DB query
  // each, whether or not their row's dialog was ever opened. Now fetched
  // on demand instead - see /members/:id/cards-fragment and
  // /members/:id/schedule-fragment below, and public/js/members-dialogs.js.
  const withRosters = membersWithDetails(typeFilter).map((m) => ({ ...m, age: ageFromBirthday(m.birthday) }));
  // The on-screen table only gets the current page's slice - the print
  // table (admin-members.ejs's separate .members-print-table) still gets
  // every filtered member, since a printed roster is meant to show the
  // whole list regardless of which page happened to be open on screen.
  const pagination = paginate(withRosters, parsePage(req.query.page));
  res.render('admin-members', {
    title: 'Members',
    members: pagination.items,
    allMembersForPrint: withRosters,
    pagination,
    baseHref: '/admin/members?' + (typeFilter ? `type=${typeFilter}&` : ''),
    typeFilter,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// Powers the Members page's per-row Cards button (fetch-on-open - see
// public/js/members-dialogs.js). The same badge/schedule-card rendering
// the /members list route used to do for every row up front, done here
// for exactly the one member whose dialog was actually opened.
router.get('/members/:id/cards-fragment', (req, res) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!member) return res.status(404).send('Not found');
  const templates = { student: getTemplate('student'), parent: getTemplate('parent') };
  const badgeLayout = templates[member.member_type] || templates.student;
  const scheduleCardTemplate = getScheduleCardTemplate();
  res.render('member-cards-fragment', {
    member,
    badgeHtml: NameTagRenderCore.renderBadgeElements(badgeLayout.elements, badgeDataForMember(member)),
    badgeBgCss: NameTagRenderCore.backgroundCss(badgeLayout.background, badgeLayout.backgroundOpacity),
    scheduleCardHtml: NameTagRenderCore.renderBadgeElements(scheduleCardTemplate.elements, scheduleCardDataForMember(member)),
    scheduleCardBgCss: NameTagRenderCore.backgroundCss(scheduleCardTemplate.background, scheduleCardTemplate.backgroundOpacity),
    badgeWidth: BADGE_WIDTH,
    badgeHeight: BADGE_HEIGHT,
    cardWidth: CARD_WIDTH,
    cardHeight: CARD_HEIGHT,
  });
});

// Powers the Members page's per-row Schedule button (fetch-on-open - see
// public/js/members-dialogs.js). This is the getMemberSchedule() query
// the /members list route used to run for every row up front, done here
// for exactly the one member whose dialog was actually opened.
router.get('/members/:id/schedule-fragment', (req, res) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!member) return res.status(404).send('Not found');
  res.render('member-schedule-fragment', { member, schedule: getMemberSchedule(member.id) });
});

// Exports every field a member's profile can hold - the same information
// originally collected about them (contact info, address, birthday/grade,
// medical notes, family, rosters) - not just the Name/Type/Family/Rosters
// subset shown in the on-screen table.
router.get('/members/export.csv', (req, res) => {
  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  const members = membersWithDetails(typeFilter);

  const typeLabel = (t) => (t === 'parent' ? 'Parent' : 'Student');
  const lines = [
    toCsvRow([
      'Name',
      'Type',
      'Active',
      'Address',
      'City',
      'State',
      'Zip',
      'Phone',
      'Email',
      'Birthday',
      'Grade Level',
      'Medical Notes',
      'Family',
      'Primary Parent',
      'Rosters',
      'Notes',
    ]),
    ...members.map((m) =>
      toCsvRow([
        m.name,
        typeLabel(m.member_type),
        m.active ? 'Yes' : 'No',
        m.address || '',
        m.city || '',
        m.state || '',
        m.zip || '',
        m.phone || '',
        m.email || '',
        m.birthday || '',
        m.grade_level || '',
        m.medical_notes || '',
        m.familyName || '',
        m.is_primary_parent ? 'Yes' : '',
        m.rosters.map((r) => r.name).join('; '),
        m.notes || '',
      ])
    ),
  ];

  sendCsv(res, `members${typeFilter ? '-' + typeFilter : ''}.csv`, lines);
});

function memberFormFields(req) {
  const memberType = MEMBER_TYPES.includes(req.body.memberType) ? req.body.memberType : 'student';
  const familyIdRaw = parseInt(req.body.familyId, 10);
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
    // Medical/Allergy Notes is on both the Parent and Student Membership
    // Forms (not student-only anymore - see the mockup), so it's captured
    // regardless of member type.
    medicalNotes: (req.body.medicalNotes || '').trim() || null,
    familyId: Number.isInteger(familyIdRaw) ? familyIdRaw : null,
    isPrimaryParent: req.body.isPrimaryParent === '1',
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

// Full-profile import (below) links an imported student to its "Parent
// Name" column by family, same as before - but a family has to actually
// exist now, so if the matched parent doesn't have one yet, one is
// invented from their surname (mirrors the migration in db/index.js) so
// the import's existing "link student to parent" behavior keeps working.
function ensureFamilyForParent(parentId) {
  const parent = db.prepare('SELECT id, name, family_id FROM members WHERE id = ?').get(parentId);
  if (!parent) return null;
  if (parent.family_id != null) return parent.family_id;
  const lastName = parent.name.trim().split(/\s+/).pop() || parent.name;
  let name = lastName;
  let suffix = 1;
  while (db.prepare('SELECT id FROM families WHERE name = ? COLLATE NOCASE').get(name)) {
    suffix++;
    name = `${lastName} ${suffix}`;
  }
  const familyId = db.prepare('INSERT INTO families (name) VALUES (?)').run(name).lastInsertRowid;
  db.prepare('UPDATE members SET family_id = ? WHERE id = ?').run(familyId, parentId);
  return familyId;
}

// memberCount included for the form's "Setup Team - 2 members" checklist
// display, same idea as allFamilies() in utils/members.js.
function allSetupTeams() {
  return db
    .prepare(
      `SELECT t.id, t.day, t.title, COUNT(stm.member_id) AS memberCount
       FROM setup_teams t
       LEFT JOIN setup_team_members stm ON stm.team_id = t.id
       GROUP BY t.id
       ORDER BY t.day, t.title COLLATE NOCASE`
    )
    .all();
}

function cleanupTeamIdsForMember(memberId) {
  return db.prepare('SELECT team_id FROM setup_team_members WHERE member_id = ?').all(memberId).map((r) => r.team_id);
}

// A family only shows up on the "Choose a Family" dropdown once it's been
// added here - the Members page's "+ Add Family" button, and (via fetch,
// see the wantsJson branch below) the "+ Add New Family" dialog on the
// Add/Edit Member form itself, so a new family can be created without
// leaving that form and losing whatever else was already typed in.
router.post('/members/families/new', (req, res) => {
  const name = (req.body.name || '').trim();
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');

  if (!name) {
    const message = 'Family name is required.';
    if (wantsJson) return res.status(400).json({ error: message });
    return res.redirect('/admin/members?error=' + encodeURIComponent(message));
  }
  const exists = db.prepare('SELECT id FROM families WHERE name = ? COLLATE NOCASE').get(name);
  if (exists) {
    const message = `"${name}" family already exists.`;
    if (wantsJson) return res.status(409).json({ error: message });
    return res.redirect('/admin/members?error=' + encodeURIComponent(message));
  }
  const familyId = db.prepare('INSERT INTO families (name) VALUES (?)').run(name).lastInsertRowid;
  if (wantsJson) return res.json({ id: familyId, name });
  res.redirect('/admin/members?notice=' + encodeURIComponent(`"${name}" family added.`));
});

router.get('/members/new', (req, res) => {
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
      is_primary_parent: 0,
    },
    families: allFamilies(),
    memberFamilyId: null,
    gradeLevels: GRADE_LEVELS,
    setupTeams: allSetupTeams(),
    memberCleanupTeamIds: [],
    error: req.query.error || null,
  });
});

router.post('/members/new', uploadPhoto.single('photo'), (req, res) => {
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
  setMemberFamily(info.lastInsertRowid, f.familyId);
  setPrimaryParent(info.lastInsertRowid, f.isPrimaryParent);

  res.redirect('/admin/members?notice=' + encodeURIComponent(`${f.name} added.`));
});

// Full-profile bulk import - the Members page is the only place a CSV/XLSX
// upload can create brand-new member records, so unlike every other import
// popup in the app, this one reads the full set of profile columns.
// Registered here (before the /members/:id routes below) so its literal
// path never gets shadowed by the :id param.
router.get('/members/import-template.xlsx', (req, res) => {
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

const PROFILE_TABS = ['profile', 'schedule', 'attendance'];

// Clicking a member's name anywhere lands here - a read-only profile with
// Profile / Class Schedule / Attendance tabs. Class Schedule reflects
// class enrollment/staffing automatically (see syncMemberSchedulesForDay
// in utils/classSchedule.js); actually editing the profile itself is
// still the dedicated Edit page, linked from the Profile tab.
router.get('/members/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');
  const tab = PROFILE_TABS.includes(req.query.tab) ? req.query.tab : 'profile';

  const family = db
    .prepare('SELECT f.name AS familyName FROM members m LEFT JOIN families f ON f.id = m.family_id WHERE m.id = ?')
    .get(id);

  res.render('admin-member-profile', {
    title: member.name,
    member,
    tab,
    familyName: family ? family.familyName : null,
    familyMembers: familyOf(id).map((m) => m.name),
    rosters: rostersForMember(id),
    schedule: getMemberSchedule(id),
    history: attendanceHistoryForMember(id).map((r) => ({
      rosterName: r.rosterName,
      dateLabel: formatDateLabel(r.date),
      statusLabel: r.status === 'present' ? 'Present' : r.status === 'late' ? 'Late' : 'Absent',
      status: r.status,
      checkInTime: r.checkInTime ? formatTime(r.checkInTime) : null,
      checkOutTime: r.checkOutTime ? formatTime(r.checkOutTime) : null,
      number: r.number,
    })),
  });
});

router.get('/members/:id/edit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');

  res.render('admin-member-edit', {
    title: `Edit ${member.name}`,
    mode: 'edit',
    member,
    families: allFamilies(),
    memberFamilyId: member.family_id,
    gradeLevels: GRADE_LEVELS,
    setupTeams: allSetupTeams(),
    memberCleanupTeamIds: cleanupTeamIdsForMember(id),
    error: req.query.error || null,
  });
});

router.post('/members/:id/edit', uploadPhoto.single('photo'), (req, res) => {
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
  // A newly uploaded photo replaces the old one in photo_path below - the
  // old file itself isn't referenced anywhere else once that happens, so
  // clean it up now rather than leaving it orphaned on disk indefinitely.
  if (req.file && existing && existing.photo_path) deletePhotoFile(existing.photo_path);

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
  setMemberFamily(id, f.familyId);
  setPrimaryParent(id, f.isPrimaryParent);

  res.redirect('/admin/members?notice=' + encodeURIComponent(`${f.name} updated.`));
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

router.post('/members/import', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.redirect('/admin/members?error=' + encodeURIComponent('Please choose a file to import.'));
  }

  let rows;
  try {
    rows = (await readRowsFromFile(req.file.buffer)).map(normalizeImportRow).filter((r) => r.name);
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
        r.medicalNotes || null
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
      const familyId = ensureFamilyForParent(parentId);
      if (familyId != null) {
        db.prepare('UPDATE members SET family_id = ? WHERE id = ?').run(familyId, studentId);
        linkedParents++;
      }
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

router.post('/members/import/confirm', (req, res) => {
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

router.post('/members/:id/notes', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const notes = (req.body.notes || '').trim();
  db.prepare('UPDATE members SET notes = ? WHERE id = ?').run(notes || null, id);
  res.redirect('/admin/members');
});

const CARD_PRINT_LAYOUTS = ['nameTag', 'scheduleCard', 'sideBySide', 'frontBack'];

// Member profile "Cards" dialog: prints exactly the layout the admin chose
// from the dropdown (member-cards-fragment.ejs) - a single card, or both
// cards together (side by side for a quick look, or front-and-back for a
// double-sided cut-out card - see utils/duplexPrint.js). Every member type
// can have a class schedule, so Schedule Card is available regardless of
// type. "Side by side" and "front and back" reuse the exact same
// buildCardPairs/buildDuplexPages helpers and views the bulk Design/Print
// flows use (routes/admin-design.js), just with a single-member list, so a
// member's cards always print identically whether they were printed one
// at a time here or in a bulk batch there.
router.get('/members/:id/cards/print', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');

  const layout = CARD_PRINT_LAYOUTS.includes(req.query.layout) ? req.query.layout : 'nameTag';

  if (layout === 'sideBySide') {
    return res.render('admin-name-tag-both-print', {
      title: `Cards - ${member.name}`,
      pairs: buildCardPairs([member]),
      badgeWidth: BADGE_WIDTH,
      badgeHeight: BADGE_HEIGHT,
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_HEIGHT,
    });
  }

  if (layout === 'frontBack') {
    const { frontPages, backPages } = buildDuplexPages(buildCardPairs([member]));
    return res.render('admin-cards-duplex-print', {
      title: `Cards - ${member.name}`,
      frontPages,
      backPages,
      badgeWidth: BADGE_WIDTH,
      badgeHeight: BADGE_HEIGHT,
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_HEIGHT,
    });
  }

  const cards = [];
  if (layout === 'nameTag') {
    const badgeLayout = getTemplate(member.member_type);
    cards.push({
      heading: 'Name Tag',
      html: NameTagRenderCore.renderBadgeElements(badgeLayout.elements, badgeDataForMember(member)),
      bgCss: NameTagRenderCore.backgroundCss(badgeLayout.background, badgeLayout.backgroundOpacity),
      width: BADGE_WIDTH,
      height: BADGE_HEIGHT,
    });
  } else {
    const template = getScheduleCardTemplate();
    cards.push({
      heading: 'Schedule Card',
      html: NameTagRenderCore.renderBadgeElements(template.elements, scheduleCardDataForMember(member)),
      bgCss: NameTagRenderCore.backgroundCss(template.background, template.backgroundOpacity),
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    });
  }

  res.render('admin-member-cards-print', {
    title: `Cards - ${member.name}`,
    memberName: member.name,
    cards,
  });
});

router.post('/members/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  db.prepare('DELETE FROM members WHERE id = ?').run(id);
  // ON DELETE CASCADE handles every other table referencing this member,
  // but a photo file on disk isn't a foreign key SQLite can clean up on
  // its own - without this, "Delete" leaves an actual photo of a real
  // person behind indefinitely, with no way to remove it from the app.
  if (member) deletePhotoFile(member.photo_path);
  res.redirect(
    '/admin/members?notice=' + encodeURIComponent(member ? `Deleted "${member.name}".` : 'Member deleted.')
  );
});

module.exports = router;
