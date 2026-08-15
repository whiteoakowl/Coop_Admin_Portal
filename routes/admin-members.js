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
const { createStorageClient } = require('../utils/storage');
const { saveUpload, removeUpload } = require('../utils/uploadBackend');
const { BADGE_WIDTH, BADGE_HEIGHT } = require('../utils/nameTagBadge');
const { getTemplate, badgeDataForMember } = require('../utils/nameTagData');
const { CARD_WIDTH, CARD_HEIGHT } = require('../utils/scheduleCardBadge');
const { scheduleCardDataForMember, getScheduleCardTemplate } = require('../utils/scheduleCardData');
const { getMemberSchedule } = require('../utils/schedule');
const NameTagRenderCore = require('../public/js/name-tag-render-core');
const {
  familyOf,
  allFamilies,
  setMemberFamily,
  setPrimaryParent,
  rostersForMember,
  membersWithDetails,
  generateMemberCode,
  lastNameOf,
  byLastName,
} = require('../utils/members');
const { GRADE_LEVELS } = require('../utils/classSchedule');
const { buildCardPairs } = require('../utils/cardPairs');
const { buildDuplexPages } = require('../utils/duplexPrint');
const { paginate, parsePage } = require('../utils/pagination');

router.use(requireFullAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });
const MEMBER_TYPES = ['student', 'parent'];

// Member profile photos - go to Supabase Storage when configured, local
// disk otherwise (see utils/uploadBackend.js and MIGRATION.md). multer
// uses memoryStorage now regardless of backend, since a Storage upload
// needs the raw buffer anyway and the local-disk path writes that same
// buffer itself (via saveUpload) rather than letting multer write it.
const PHOTO_DIR = path.join(__dirname, '..', 'public', 'uploads', 'members');
const MEMBER_PHOTOS_BUCKET = 'member-photos';
const storageClient = createStorageClient();
// Only needed as a local-disk fallback - a serverless deployment's
// filesystem is read-only outside /tmp, so this must not run when
// Storage is actually configured.
if (!storageClient && !fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });

const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

// Saves an uploaded photo (Storage or local disk, see above) and returns
// the key to store in photo_path.
function savePhotoFile(file) {
  return saveUpload({
    client: storageClient,
    bucket: MEMBER_PHOTOS_BUCKET,
    localDir: PHOTO_DIR,
    buffer: file.buffer,
    originalName: file.originalname,
    contentType: file.mimetype,
  });
}

// Removes a member's stored photo given the key/path in photo_path -
// called whenever a photo is replaced or the member itself is deleted, so
// an old photo of a real child or parent doesn't sit around forever with
// no way to remove it once it's no longer referenced anywhere. Silently
// no-ops for null/already-missing files (deleting a member who never had
// a photo is the common case, not an error).
function deletePhotoFile(photoPath) {
  return removeUpload({ client: storageClient, bucket: MEMBER_PHOTOS_BUCKET, localDir: PHOTO_DIR, key: photoPath });
}

// Every attendance record for this member across every roster they're on,
// newest first - the Members profile page's Attendance tab.
async function attendanceHistoryForMember(memberId) {
  return db
    .prepare(
      `SELECT r.name AS "rosterName", a.session_date AS date, a.status,
              a.check_in_time AS "checkInTime", c.check_out_time AS "checkOutTime", c.number AS number
       FROM attendance a
       JOIN rosters r ON r.id = a.roster_id
       LEFT JOIN checkouts c ON c.member_id = a.member_id AND c.roster_id = a.roster_id AND c.session_date = a.session_date
       WHERE a.member_id = ?
       ORDER BY a.session_date DESC`
    )
    .all(memberId);
}

// --- Members page (the full member list) ---

router.get('/members', async (req, res) => {
  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  const familyFilter = parseInt(req.query.family, 10) || null;
  // Cards/Schedule dialog content (badge HTML, schedule-card HTML,
  // getMemberSchedule()) used to be computed here for every member on
  // every page load - two renderBadgeElements() calls and a DB query
  // each, whether or not their row's dialog was ever opened. Now fetched
  // on demand instead - see /members/:id/cards-fragment and
  // /members/:id/schedule-fragment below, and public/js/members-dialogs.js.
  const withRosters = (await membersWithDetails(typeFilter, familyFilter)).map((m) => ({ ...m, age: ageFromBirthday(m.birthday) }));
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
    baseHref: '/admin/members?' + (typeFilter ? `type=${typeFilter}&` : '') + (familyFilter ? `family=${familyFilter}&` : ''),
    typeFilter,
    familyFilter,
    families: await allFamilies(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// Powers the Members page's per-row Cards button (fetch-on-open - see
// public/js/members-dialogs.js). The same badge/schedule-card rendering
// the /members list route used to do for every row up front, done here
// for exactly the one member whose dialog was actually opened.
router.get('/members/:id/cards-fragment', async (req, res) => {
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!member) return res.status(404).send('Not found');
  const templates = { student: await getTemplate('student'), parent: await getTemplate('parent') };
  const badgeLayout = templates[member.member_type] || templates.student;
  const scheduleCardTemplate = await getScheduleCardTemplate();
  res.render('member-cards-fragment', {
    member,
    badgeHtml: NameTagRenderCore.renderBadgeElements(badgeLayout.elements, await badgeDataForMember(member)),
    badgeBgCss: NameTagRenderCore.backgroundCss(badgeLayout.background, badgeLayout.backgroundOpacity),
    scheduleCardHtml: NameTagRenderCore.renderBadgeElements(scheduleCardTemplate.elements, await scheduleCardDataForMember(member)),
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
router.get('/members/:id/schedule-fragment', async (req, res) => {
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!member) return res.status(404).send('Not found');
  res.render('member-schedule-fragment', { member, schedule: await getMemberSchedule(member.id) });
});

// Exports every field a member's profile can hold - the same information
// originally collected about them (contact info, address, birthday/grade,
// medical notes, family, rosters) - not just the Name/Type/Family/Rosters
// subset shown in the on-screen table.
router.get('/members/export.csv', async (req, res) => {
  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  const familyFilter = parseInt(req.query.family, 10) || null;
  const members = await membersWithDetails(typeFilter, familyFilter);

  const typeLabel = (t) => (t === 'parent' ? 'Parent' : 'Student');
  const lines = [
    toCsvRow([
      'Name',
      'Member ID',
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
        m.member_code || '',
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
async function syncCleanupTeams(memberId, teamIds) {
  await db.prepare('DELETE FROM setup_team_members WHERE member_id = ?').run(memberId);
  if (!teamIds) return;
  const link = db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?) ON CONFLICT (team_id, member_id) DO NOTHING');
  for (const teamId of teamIds) await link.run(teamId, memberId);
}

// Floater Assignments (volunteer_members) only ever gets a parent added to
// it via the Volunteers admin page, never from a member's own profile - so
// there's nothing here to sync, only to clear if they're no longer a
// parent, for the same "converted away from parent" staleness as above.
async function clearVolunteerMembershipIfNotParent(memberId, memberType) {
  if (memberType === 'parent') return;
  await db.prepare('DELETE FROM volunteer_members WHERE member_id = ?').run(memberId);
}

// Full-profile import (below) links an imported student to its "Parent
// Name" column by family, same as before - but a family has to actually
// exist now, so if the matched parent doesn't have one yet, one is
// invented from their surname (mirrors the migration in db/index.js) so
// the import's existing "link student to parent" behavior keeps working.
async function ensureFamilyForParent(parentId) {
  const parent = await db.prepare('SELECT id, name, family_id FROM members WHERE id = ?').get(parentId);
  if (!parent) return null;
  if (parent.family_id != null) return parent.family_id;
  const lastName = parent.name.trim().split(/\s+/).pop() || parent.name;
  let name = lastName;
  let suffix = 1;
  while (await db.prepare('SELECT id FROM families WHERE LOWER(name) = LOWER(?)').get(name)) {
    suffix++;
    name = `${lastName} ${suffix}`;
  }
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(name)).lastInsertRowid;
  await db.prepare('UPDATE members SET family_id = ? WHERE id = ?').run(familyId, parentId);
  return familyId;
}

// memberCount included for the form's "Setup Team - 2 members" checklist
// display, same idea as allFamilies() in utils/members.js.
async function allSetupTeams() {
  return db
    .prepare(
      `SELECT t.id, t.day, t.title, COUNT(stm.member_id) AS "memberCount"
       FROM setup_teams t
       LEFT JOIN setup_team_members stm ON stm.team_id = t.id
       GROUP BY t.id
       ORDER BY t.day, LOWER(t.title)`
    )
    .all();
}

async function cleanupTeamIdsForMember(memberId) {
  return (await db.prepare('SELECT team_id FROM setup_team_members WHERE member_id = ?').all(memberId)).map((r) => r.team_id);
}

// A family only shows up on the "Choose a Family" dropdown once it's been
// added here - the Members page's "+ Add Family" button, and (via fetch,
// see the wantsJson branch below) the "+ Add New Family" dialog on the
// Add/Edit Member form itself, so a new family can be created without
// leaving that form and losing whatever else was already typed in.
router.post('/members/families/new', async (req, res) => {
  const name = (req.body.name || '').trim();
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');

  if (!name) {
    const message = 'Family name is required.';
    if (wantsJson) return res.status(400).json({ error: message });
    return res.redirect('/admin/members?error=' + encodeURIComponent(message));
  }
  const exists = await db.prepare('SELECT id FROM families WHERE LOWER(name) = LOWER(?)').get(name);
  if (exists) {
    const message = `"${name}" family already exists.`;
    if (wantsJson) return res.status(409).json({ error: message });
    return res.redirect('/admin/members?error=' + encodeURIComponent(message));
  }
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(name)).lastInsertRowid;
  if (wantsJson) return res.json({ id: familyId, name });
  res.redirect('/admin/members?notice=' + encodeURIComponent(`"${name}" family added.`));
});

router.get('/members/new', async (req, res) => {
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
    families: await allFamilies(),
    memberFamilyId: null,
    gradeLevels: GRADE_LEVELS,
    setupTeams: await allSetupTeams(),
    memberCleanupTeamIds: [],
    error: req.query.error || null,
  });
});

router.post('/members/new', uploadPhoto.single('photo'), async (req, res) => {
  const f = memberFormFields(req);

  if (!f.name) {
    return res.redirect('/admin/members/new?error=' + encodeURIComponent('Name is required.'));
  }
  // Duplicate-name check used to piggyback on barcode's old UNIQUE
  // constraint (barcode = name), which incidentally also blocked two
  // members from ever sharing a name - now that barcode is a generated
  // member_code instead (see utils/members.js's generateMemberCode),
  // that's no longer automatic, so it's checked directly here to keep
  // the same practical behavior.
  const exists = await db.prepare('SELECT id FROM members WHERE LOWER(name) = LOWER(?)').get(f.name);
  if (exists) {
    return res.redirect('/admin/members/new?error=' + encodeURIComponent(`"${f.name}" is already in the member list.`));
  }

  const memberCode = await generateMemberCode();
  const photoPath = req.file ? await savePhotoFile(req.file) : null;

  const info = await db
    .prepare(
      `INSERT INTO members
         (name, barcode, member_code, member_type, address, city, state, zip, phone, email, photo_path, birthday, grade_level, medical_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      f.name,
      memberCode,
      memberCode,
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
  await syncCleanupTeams(info.lastInsertRowid, f.cleanupTeamIds);
  await setMemberFamily(info.lastInsertRowid, f.familyId);
  await setPrimaryParent(info.lastInsertRowid, f.isPrimaryParent);

  res.redirect('/admin/members?notice=' + encodeURIComponent(`${f.name} added.`));
});

// Full-profile bulk import - the Members page is the only place a CSV/XLSX
// upload can create brand-new member records, so unlike every other import
// popup in the app, this one reads the full set of profile columns.
// Registered here (before the /members/:id routes below) so its literal
// path never gets shadowed by the :id param.
router.get('/members/import-template.xlsx', (req, res) => {
  const buffer = buildTemplateWorkbook(
    ['First Name', 'Last Name', 'Type', 'Address', 'City', 'State', 'Zip', 'Phone', 'Email', 'Birthday', 'Grade Level', 'Medical/Allergy Notes', 'Parent First Name', 'Parent Last Name'],
    [
      ['Jane', 'Smith', 'Parent', '123 Main St', 'Anytown', 'NC', '27330', '555-987-6543', 'jane@example.com', '', '', '', '', ''],
      ['Alice', 'Smith', 'Student', '123 Main St', 'Anytown', 'NC', '27330', '555-123-4567', '', '2015-04-12', '5th Grade', 'Peanut allergy', 'Jane', 'Smith'],
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
router.get('/members/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');
  const tab = PROFILE_TABS.includes(req.query.tab) ? req.query.tab : 'profile';

  const family = await db
    .prepare('SELECT f.name AS "familyName" FROM members m LEFT JOIN families f ON f.id = m.family_id WHERE m.id = ?')
    .get(id);
  const restOfFamily = await familyOf(id);

  res.render('admin-member-profile', {
    title: member.name,
    member,
    tab,
    familyName: family ? family.familyName : null,
    familyMembers: restOfFamily.map((m) => m.name),
    // Includes the member being viewed (not just the rest of the family)
    // - powers the Class Schedule/Attendance tabs' "jump to this family
    // member" dropdown, which needs the current member as one of its own
    // options so it can show who's selected.
    familyRoster: [member, ...restOfFamily].sort(byLastName),
    rosters: await rostersForMember(id),
    schedule: await getMemberSchedule(id),
    history: (await attendanceHistoryForMember(id)).map((r) => ({
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

router.get('/members/:id/edit', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');

  res.render('admin-member-edit', {
    title: `Edit ${member.name}`,
    mode: 'edit',
    member,
    families: await allFamilies(),
    memberFamilyId: member.family_id,
    gradeLevels: GRADE_LEVELS,
    setupTeams: await allSetupTeams(),
    memberCleanupTeamIds: await cleanupTeamIdsForMember(id),
    error: req.query.error || null,
  });
});

router.post('/members/:id/edit', uploadPhoto.single('photo'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const f = memberFormFields(req);

  if (!f.name) {
    return res.redirect(`/admin/members/${id}/edit?error=` + encodeURIComponent('Name is required.'));
  }
  // Same duplicate-name check as /members/new - see that route's own
  // comment. Note this no longer touches barcode/member_code at all:
  // those are the member's permanent ID, assigned once at creation
  // (generateMemberCode) and never reassigned just because their name
  // was edited (a typo fix or legal name change shouldn't invalidate an
  // already-printed barcode).
  const clash = await db.prepare('SELECT id FROM members WHERE LOWER(name) = LOWER(?) AND id != ?').get(f.name, id);
  if (clash) {
    return res.redirect(`/admin/members/${id}/edit?error=` + encodeURIComponent(`"${f.name}" is already in the member list.`));
  }
  const existing = await db.prepare('SELECT photo_path FROM members WHERE id = ?').get(id);
  const photoPath = req.file ? await savePhotoFile(req.file) : existing ? existing.photo_path : null;
  // A newly uploaded photo replaces the old one in photo_path below - the
  // old file itself isn't referenced anywhere else once that happens, so
  // clean it up now rather than leaving it orphaned indefinitely.
  if (req.file && existing && existing.photo_path) await deletePhotoFile(existing.photo_path);

  await db.prepare(
    `UPDATE members SET
       name = ?, member_type = ?, address = ?, city = ?, state = ?, zip = ?, phone = ?, email = ?,
       photo_path = ?, birthday = ?, grade_level = ?, medical_notes = ?
     WHERE id = ?`
  ).run(
    f.name,
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
  await syncCleanupTeams(id, f.cleanupTeamIds);
  await clearVolunteerMembershipIfNotParent(id, f.memberType);
  await setMemberFamily(id, f.familyId);
  await setPrimaryParent(id, f.isPrimaryParent);

  res.redirect('/admin/members?notice=' + encodeURIComponent(`${f.name} updated.`));
});

const MEMBER_IMPORT_HEADER_ALIASES = {
  firstName: ['first name', 'first'],
  lastName: ['last name', 'last'],
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
  parentFirstName: ['parent first name'],
  parentLastName: ['parent last name'],
};

// First/Last are separate columns in the spreadsheet, but every member is
// still stored as a single "First Last" string - see utils/members.js's
// lastNameOf - the same convention the membership form's one-box Name
// field already uses. Joined back together here at read time so nothing
// downstream (duplicate-name matching, family-name derivation, display)
// needs to know the template ever had separate columns.
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
  out.name = [out.firstName, out.lastName].filter(Boolean).join(' ');
  out.parentName = [out.parentFirstName, out.parentLastName].filter(Boolean).join(' ');
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
    const existing = await db.prepare('SELECT * FROM members WHERE active = 1 AND LOWER(name) = LOWER(?)').get(r.name);
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
    const memberCode = await generateMemberCode();
    const info = await db
      .prepare(
        `INSERT INTO members (name, barcode, member_code, member_type, address, city, state, zip, phone, email, birthday, grade_level, medical_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        r.name,
        memberCode,
        memberCode,
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
    const parentRow = await db
      .prepare("SELECT id FROM members WHERE active = 1 AND member_type = 'parent' AND LOWER(name) = LOWER(?)")
      .get(r.parentName);
    const parentId = nameToId[r.parentName.toLowerCase()] || (parentRow ? parentRow.id : null);
    if (studentId && parentId && studentId !== parentId) {
      const familyId = await ensureFamilyForParent(parentId);
      if (familyId != null) {
        await db.prepare('UPDATE members SET family_id = ? WHERE id = ?').run(familyId, studentId);
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

router.post('/members/import/confirm', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const payloads = [].concat(req.body.payloads || []);
  const ids = [].concat(req.body.allMemberIds || []).map((id) => parseInt(id, 10));

  let merged = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!memberIds.includes(id)) continue; // this row's checkbox wasn't checked
    let updates;
    try {
      updates = JSON.parse(payloads[i] || '{}');
    } catch (err) {
      continue;
    }
    const setClauses = [];
    const params = [];
    for (const [field, value] of Object.entries(updates)) {
      const column = IMPORT_FIELD_COLUMNS[field];
      if (!column) continue;
      setClauses.push(`${column} = ?`);
      params.push(value);
    }
    if (setClauses.length === 0) continue;
    params.push(id);
    await db.prepare(`UPDATE members SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
    merged++;
  }

  res.redirect('/admin/members?notice=' + encodeURIComponent(`Merged new profile details into ${merged} existing member(s).`));
});

// --- Mass Import: one row = one whole household (up to 2 parents + 8
// kids), unlike the full-profile import above (one row = one member,
// linked to a family by a separate "Parent Name" column). Built for
// standing up a co-op's roster from an existing family list in one pass -
// every child on a row lands in the same family as its row's parents,
// with no per-row linking step needed. ---

const MASS_IMPORT_CHILD_SLOTS = 8;

const MASS_IMPORT_HEADERS = [
  'Primary Parent First Name', 'Primary Parent Last Name', 'Primary Parent Email',
  '2nd Parent First Name', '2nd Parent Last Name', '2nd Parent Email',
  'Address', 'City', 'State', 'Zip Code', 'Phone Number',
];
for (let i = 1; i <= MASS_IMPORT_CHILD_SLOTS; i++) {
  MASS_IMPORT_HEADERS.push(`Child ${i} First Name`, `Child ${i} Last Name`, `Child ${i} Birthday`, `Child ${i} Grade`);
}

router.get('/members/mass-import/sample.xlsx', (req, res) => {
  const exampleRow = [
    'Jane', 'Smith', 'jane@example.com', 'John', 'Smith', 'john@example.com',
    '123 Main St', 'Anytown', 'NC', '27330', '555-987-6543',
    'Alice', 'Smith', '2015-04-12', '5th Grade',
    'Ben', 'Smith', '2017-08-03', '3rd Grade',
  ];
  // Pad out the remaining 6 empty child slots (24 columns) so the row
  // lines up with MASS_IMPORT_HEADERS exactly.
  while (exampleRow.length < MASS_IMPORT_HEADERS.length) exampleRow.push('');

  const buffer = buildTemplateWorkbook(MASS_IMPORT_HEADERS, [exampleRow]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="mass-import-template.xlsx"');
  res.send(buffer);
});

// First/Last are separate columns in the spreadsheet (easier to fill in
// and to sort/validate than one combined name column), but every member
// is still stored as a single "First Last" string - see utils/members.js's
// lastNameOf - the same convention the membership form's one-box Name
// field and every other import path already use. Joining them here at
// read time means nothing downstream (family-name derivation, dedup
// matching by name, display, search) needs to know this template ever
// had separate columns.
function joinName(first, last) {
  return [first, last].filter(Boolean).join(' ');
}

function normalizeMassImportRow(row) {
  const lowerMap = {};
  for (const key of Object.keys(row)) lowerMap[key.trim().toLowerCase()] = row[key];
  const get = (label) => {
    const v = lowerMap[label.toLowerCase()];
    return v === undefined || v === null ? '' : String(v).trim();
  };

  const children = [];
  for (let i = 1; i <= MASS_IMPORT_CHILD_SLOTS; i++) {
    const name = joinName(get(`Child ${i} First Name`), get(`Child ${i} Last Name`));
    if (!name) continue;
    children.push({ name, birthday: get(`Child ${i} Birthday`), grade: get(`Child ${i} Grade`) });
  }

  return {
    primaryParentName: joinName(get('Primary Parent First Name'), get('Primary Parent Last Name')),
    primaryParentEmail: get('Primary Parent Email'),
    secondParentName: joinName(get('2nd Parent First Name'), get('2nd Parent Last Name')),
    secondParentEmail: get('2nd Parent Email'),
    address: get('Address'),
    city: get('City'),
    state: get('State'),
    zip: get('Zip Code'),
    phone: get('Phone Number'),
    children,
  };
}

// Always a brand-new family row named after the primary parent's last
// name - never silently merges into an existing same-named family (a
// coincidental surname match doesn't mean the same household). Same
// "Smith", "Smith 2", ... disambiguation as ensureFamilyForParent above,
// for the same reason.
async function createFamilyFromLastName(fullName) {
  const last = lastNameOf(fullName) || fullName;
  let name = last;
  let suffix = 1;
  while (await db.prepare('SELECT id FROM families WHERE LOWER(name) = LOWER(?)').get(name)) {
    suffix++;
    name = `${last} ${suffix}`;
  }
  return (await db.prepare('INSERT INTO families (name) VALUES (?)').run(name)).lastInsertRowid;
}

// One person-slot (primary parent / 2nd parent / a child) from a mass
// import row. If an active member already has this exact name, nothing
// about their existing profile is touched (never overwrites data an
// admin may have already curated) - they're just linked into this row's
// family if they weren't already in one, so re-running the same file
// (or a file that overlaps an existing roster) is safe rather than
// creating duplicates.
async function createOrLinkFamilyMember(name, memberType, familyId, fields) {
  const existing = await db.prepare('SELECT id, family_id FROM members WHERE active = 1 AND LOWER(name) = LOWER(?)').get(name);
  if (existing) {
    if (existing.family_id == null) await db.prepare('UPDATE members SET family_id = ? WHERE id = ?').run(familyId, existing.id);
    return { id: existing.id, created: false };
  }
  const memberCode = await generateMemberCode();
  const info = await db
    .prepare(
      `INSERT INTO members (name, barcode, member_code, member_type, address, city, state, zip, phone, email, birthday, grade_level, family_id, is_primary_parent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      memberCode,
      memberCode,
      memberType,
      fields.address || null,
      fields.city || null,
      fields.state || null,
      fields.zip || null,
      fields.phone || null,
      fields.email || null,
      fields.birthday || null,
      fields.gradeLevel || null,
      familyId,
      fields.isPrimaryParent ? 1 : 0
    );
  return { id: info.lastInsertRowid, created: true };
}

router.post('/members/mass-import', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.redirect('/admin/members?error=' + encodeURIComponent('Please choose a file to import.'));
  }

  let rows;
  try {
    rows = (await readRowsFromFile(req.file.buffer)).map(normalizeMassImportRow).filter((r) => r.primaryParentName);
  } catch (err) {
    return res.redirect('/admin/members?error=' + encodeURIComponent('Could not read that file. Please use the sample spreadsheet format.'));
  }

  if (rows.length === 0) {
    return res.redirect('/admin/members?error=' + encodeURIComponent('No rows with a Primary Parent Name were found in that file.'));
  }

  let familiesCreated = 0;
  let membersCreated = 0;
  let membersLinked = 0;

  for (const r of rows) {
    const familyId = await createFamilyFromLastName(r.primaryParentName);
    familiesCreated++;

    // Address/city/state/zip/phone are the shared household contact
    // info - every member of the family gets them, parents and kids
    // alike. Email is the one exception: each parent's own email column
    // goes on just their own profile; a child has no email column on
    // this template, so the primary parent's email doubles as the
    // family's shared contact email on every kid's profile too.
    const shared = { address: r.address, city: r.city, state: r.state, zip: r.zip, phone: r.phone };

    const primary = await createOrLinkFamilyMember(r.primaryParentName, 'parent', familyId, {
      ...shared,
      email: r.primaryParentEmail,
      isPrimaryParent: true,
    });
    if (primary.created) membersCreated++;
    else membersLinked++;

    if (r.secondParentName) {
      const second = await createOrLinkFamilyMember(r.secondParentName, 'parent', familyId, { ...shared, email: r.secondParentEmail });
      if (second.created) membersCreated++;
      else membersLinked++;
    }

    for (const child of r.children) {
      const result = await createOrLinkFamilyMember(child.name, 'student', familyId, {
        ...shared,
        email: r.primaryParentEmail,
        birthday: child.birthday,
        gradeLevel: child.grade,
      });
      if (result.created) membersCreated++;
      else membersLinked++;
    }
  }

  const summary =
    `Mass import complete: ${familiesCreated} famil${familiesCreated === 1 ? 'y' : 'ies'} created, ${membersCreated} new member(s) created` +
    (membersLinked ? `, ${membersLinked} already-existing member(s) linked to their family.` : '.');

  res.redirect('/admin/members?notice=' + encodeURIComponent(summary));
});

router.post('/members/:id/notes', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const notes = (req.body.notes || '').trim();
  await db.prepare('UPDATE members SET notes = ? WHERE id = ?').run(notes || null, id);
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
router.get('/members/:id/cards/print', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');

  const layout = CARD_PRINT_LAYOUTS.includes(req.query.layout) ? req.query.layout : 'nameTag';

  if (layout === 'sideBySide') {
    return res.render('admin-name-tag-both-print', {
      title: `Cards - ${member.name}`,
      pairs: await buildCardPairs([member]),
      badgeWidth: BADGE_WIDTH,
      badgeHeight: BADGE_HEIGHT,
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_HEIGHT,
    });
  }

  if (layout === 'frontBack') {
    const { frontPages, backPages } = buildDuplexPages(await buildCardPairs([member]));
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
    const badgeLayout = await getTemplate(member.member_type);
    cards.push({
      heading: 'Name Tag',
      html: NameTagRenderCore.renderBadgeElements(badgeLayout.elements, await badgeDataForMember(member)),
      bgCss: NameTagRenderCore.backgroundCss(badgeLayout.background, badgeLayout.backgroundOpacity),
      width: BADGE_WIDTH,
      height: BADGE_HEIGHT,
    });
  } else {
    const template = await getScheduleCardTemplate();
    cards.push({
      heading: 'Schedule Card',
      html: NameTagRenderCore.renderBadgeElements(template.elements, await scheduleCardDataForMember(member)),
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

router.post('/members/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  await db.prepare('DELETE FROM members WHERE id = ?').run(id);
  // ON DELETE CASCADE handles every other table referencing this member,
  // but a stored photo isn't a foreign key the database can clean up on
  // its own - without this, "Delete" leaves an actual photo of a real
  // person behind indefinitely, with no way to remove it from the app.
  if (member) await deletePhotoFile(member.photo_path);
  res.redirect(
    '/admin/members?notice=' + encodeURIComponent(member ? `Deleted "${member.name}".` : 'Member deleted.')
  );
});

module.exports = router;
