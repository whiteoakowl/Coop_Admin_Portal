const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { buildTemplateWorkbook, readRowsFromFile, toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { formatDateLabel, formatDateNumeric, formatTime, ageFromBirthday, isValidISODate } = require('../utils/dates');
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
  byLastName,
} = require('../utils/members');
const { GRADE_LEVELS } = require('../utils/classSchedule');
const { buildCardPairs } = require('../utils/cardPairs');
const { buildDuplexPages, SCHEDULE_CARD_SAFE_INSET } = require('../utils/duplexPrint');
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE } = require('../utils/pagination');
const { listAdminPositions, adminPositionIdsForMember, syncMemberAdminPositions, adminPositionTitlesForMembers } = require('../utils/adminPositions');
const { portalStatusForMembers, sectionIdsForMembers } = require('../utils/portalPermissions');
const { resolveFamilyId, createParentMember, createChildMember, uploadIntakePhotos, parseArrayField } = require('../utils/memberIntake');

router.use(requireFullAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });
// 'admin' is co-op staff/leaders who mainly just need a printable badge
// (see members.member_type's own schema comment) - no family/grade/setup
// team fields, just an optional Admin Position (see memberFormFields below
// and views/partials/member-form-fields.ejs's 3-way toggle).
const MEMBER_TYPES = ['student', 'parent', 'admin'];

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

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES },
  fileFilter: imageFileFilter,
});

// A photo over the limit above makes multer.single() itself throw a
// MulterError (LIMIT_FILE_SIZE), which - unlike imageFileFilter rejecting
// a wrong file TYPE (that just leaves req.file undefined) - was never
// caught anywhere, so it fell through to server.js's generic catch-all
// error handler: a bare 500 page that threw away every other field the
// admin had just typed (name, address, medical notes, family). Same fix
// as routes/admin-documents.js's own uploadDocument wrapper, parametrized
// by redirect target since /members/new and /members/:id/edit each redirect
// back to their own page on error.
function uploadMemberPhoto(redirectTo) {
  return function (req, res, next) {
    uploadPhoto.single('photo')(req, res, (err) => {
      if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.redirect(`${redirectTo(req)}?error=` + encodeURIComponent(`That photo is too large - photos are limited to ${MAX_PHOTO_BYTES / (1024 * 1024)}MB.`));
      }
      next(err);
    });
  };
}

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
  const dayFilter = ['monday', 'wednesday'].includes(req.query.day) ? req.query.day : '';
  // "Archive" (see /members/bulk-archive below) sets active = 0 on a
  // member rather than deleting them - a soft, undoable removal from the
  // active list, unlike the "Delete Selected" button which is permanent.
  // membersWithDetails itself doesn't filter by active (it's used
  // elsewhere for full lookups that need every member regardless), so the
  // default/archived split happens here instead - same "one boolean flag,
  // two mutually exclusive views" shape as nameTagSubmissions'
  // showArchived above.
  const showArchived = req.query.archived === '1';
  // Cards/Schedule dialog content (badge HTML, schedule-card HTML,
  // getMemberSchedule()) used to be computed here for every member on
  // every page load - two renderBadgeElements() calls and a DB query
  // each, whether or not their row's dialog was ever opened. Now fetched
  // on demand instead - see /members/:id/cards-fragment and
  // /members/:id/schedule-fragment below, and public/js/members-dialogs.js.
  const filteredMembers = (await membersWithDetails(typeFilter, familyFilter)).filter((m) => (showArchived ? Number(m.active) === 0 : Number(m.active) === 1));
  // A real request: "this will then add their admin title label next to
  // their name... on member lists." Batched (not per-row) for the same
  // N+1 reason as nameTagData.js's own bulk-print title lookup.
  const adminTitlesByMember = await adminPositionTitlesForMembers(filteredMembers.map((m) => m.id));
  // Mobile shows which day(s) a member is actually on instead of the
  // Type column (a real request: "on mobile the column type shouldn't
  // be there. It should read whether they are on Wednesday or Monday
  // rosters") - derived from each roster's own schedule_day, not a
  // second lookup, and also doubles as the new day filter option below.
  let withRosters = filteredMembers.map((m) => ({
    ...m,
    age: ageFromBirthday(m.birthday),
    birthdayLabel: m.birthday ? formatDateNumeric(m.birthday) : null,
    adminTitle: (adminTitlesByMember[m.id] || []).join(', ') || null,
    rosterDays: [...new Set(m.rosters.map((r) => r.schedule_day).filter(Boolean))],
  }));
  if (dayFilter) withRosters = withRosters.filter((m) => m.rosterDays.includes(dayFilter));
  // The on-screen table only gets the current page's slice - the print
  // table (admin-members.ejs's separate .members-print-table) still gets
  // every filtered member, since a printed roster is meant to show the
  // whole list regardless of which page happened to be open on screen.
  // The Members page's own "Select All" (public/js/archive-select-toggle.js)
  // also reaches into this same full list for its off-page checkboxes -
  // see admin-members.ejs's own comment, mirroring admin-schedule.ejs's.
  const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  const pagination = paginate(withRosters, parsePage(req.query.page), pageSize);

  res.render('admin-members', {
    title: 'Members',
    members: pagination.items,
    allMembersForPrint: withRosters,
    pagination,
    viewingAll: pageSize === Infinity,
    baseHref:
      '/admin/members?' +
      (typeFilter ? `type=${typeFilter}&` : '') +
      (familyFilter ? `family=${familyFilter}&` : '') +
      (dayFilter ? `day=${dayFilter}&` : '') +
      (showArchived ? `archived=1&` : ''),
    typeFilter,
    familyFilter,
    dayFilter,
    showArchived,
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
  const templates = { student: await getTemplate('student'), parent: await getTemplate('parent'), admin: await getTemplate('admin') };
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
    // A real request: "ability to add unlimited admin positions to a
    // member profile" - superseded the old single adminPositionId (a
    // plain <select>) with a checkbox multi-select, same "array of ids,
    // gated to the one member type that actually shows the field" shape
    // as cleanupTeamIds just above.
    adminPositionIds:
      memberType === 'admin'
        ? [].concat(req.body.adminPositionIds || []).map((id) => parseInt(id, 10)).filter(Boolean)
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

// "Add Member" now shares the same family-intake form/logic as the
// Membership Form (routes/membership.js) and Main Admin's own Add Member
// (routes/main-admin-members.js) - a real request: "Add member and
// membership request form should be the same." A further request:
// "there shouldn't be any lone admins/leaders, or single members" -
// every member is created through this one family-intake form now, no
// standalone/single-member creation path at all (an earlier "or add a
// single member" fallback at /members/new-single was removed for this
// reason - Admin/leader member_type has no path to being newly created
// through the UI anymore as a result). Editing an EXISTING member
// (GET/POST /members/:id/edit below) is unaffected - it keeps its own
// single-person admin-member-edit.ejs form, including any already-
// existing admin-type members.
router.get('/members/new', async (req, res) => {
  res.render('member-intake-form', {
    title: 'Add Member',
    portal: 'coop_admin',
    formAction: '/admin/members/new',
    backHref: '/admin/members',
    submitLabel: 'Add Member',
    isAdmin: true,
    families: await allFamilies(),
    setupTeams: await allSetupTeams(),
    gradeLevels: GRADE_LEVELS,
    error: req.query.error || null,
    notice: null,
  });
});

router.post('/members/new', uploadIntakePhotos('/admin/members/new'), async (req, res) => {
  const body = req.body;
  const back = '/admin/members/new';

  const address = {
    address: (body.address || '').trim() || null,
    city: (body.city || '').trim() || null,
    state: (body.state || '').trim() || null,
    zip: (body.zip || '').trim() || null,
  };

  const parents = parseArrayField(body, 'parents')
    .map((p, index) => ({ ...p, index }))
    .filter((p) => p && (p.name || '').trim());
  if (parents.length === 0) {
    return res.redirect(back + '?error=' + encodeURIComponent('At least one parent/guardian name is required.'));
  }

  const children = parseArrayField(body, 'children')
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c && (c.name || '').trim());
  if (children.length === 0) {
    return res.redirect(back + '?error=' + encodeURIComponent('Please add at least one student.'));
  }

  const familyId = await resolveFamilyId({ familyId: body.familyId, newFamilyName: body.newFamilyName, homeschoolDuration: body.homeschoolDuration });

  for (const p of parents) {
    await createParentMember(familyId, address, {
      name: p.name.trim(),
      email: (p.email || '').trim() || null,
      phone: (p.phone || '').trim() || null,
      isPrimaryParent: p.isPrimaryParent === '1',
      cleanupTeamId: parseInt(p.cleanupTeamId, 10) || null,
    });
  }

  for (const c of children) {
    const photoFile = (req.files || []).find((f) => f.fieldname === `children[${c.index}][photo]`);
    await createChildMember(
      familyId,
      address,
      {
        name: c.name.trim(),
        birthday: isValidISODate((c.birthday || '').trim()) ? c.birthday.trim() : null,
        gradeLevel: GRADE_LEVELS.includes(c.gradeLevel) ? c.gradeLevel : null,
        medicalNotes: (c.medicalNotes || '').trim() || null,
      },
      photoFile
    );
  }

  res.redirect('/admin/members?notice=' + encodeURIComponent(`Added ${parents.length + children.length} member(s).`));
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

// utils/spreadsheetWorker.js reads every cell with raw:false, i.e. its
// FORMATTED display text - a genuine Excel/Sheets Date-typed cell (what
// actually typing a birthdate into a spreadsheet produces) comes back
// as something like "4/12/2015" in whatever locale format the sheet
// used, not the ISO "2015-04-12" the birthday column is stored as and
// isValidISODate expects. Accepts both: already-ISO text as-is, or a
// U.S.-style M/D/Y (the overwhelming common case for a Date cell)
// normalized into ISO.
//
// A real bug report - "importing birthdays comes in as NaN/NaN/NaN, only
// 1 row imported out of many" - traced to the year group here requiring
// exactly 4 digits (\d{4}). Confirmed live: a genuine Excel Date cell,
// typed and left at Excel's own default short-date format rather than
// explicitly reformatted to a 4-digit year, reads back through
// SheetJS's raw:false as "4/12/15" - a 2-digit year - not "4/12/2015".
// Every row shaped like that silently failed this regex and got counted
// as an unreadable date instead of imported, which is exactly a "only
// the one row I happened to type the full year out for by hand made it
// through" result. \d{2,4} now accepts either; a 2-digit year picks
// 2000s vs 1900s the same way spreadsheet apps themselves do (Excel's
// own cutoff is 30, not tied to the current year, so this stays stable
// as time passes rather than drifting) - correct either way for this
// column's whole realistic range (a co-op member's child's birth year).
function normalizeBirthdayToISO(value) {
  if (isValidISODate(value)) return value;
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(String(value).trim());
  if (!match) return null;
  const [, m, d, yRaw] = match;
  const y = yRaw.length === 2 ? (Number(yRaw) < 30 ? `20${yRaw}` : `19${yRaw}`) : yRaw;
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isValidISODate(iso) ? iso : null;
}

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
  member.birthdayLabel = member.birthday ? formatDateNumeric(member.birthday) : null;
  const tab = PROFILE_TABS.includes(req.query.tab) ? req.query.tab : 'profile';

  const family = await db
    .prepare('SELECT f.name AS "familyName" FROM members m LEFT JOIN families f ON f.id = m.family_id WHERE m.id = ?')
    .get(id);
  const restOfFamily = await familyOf(id);
  const familyRoster = [member, ...restOfFamily].sort(byLastName);
  // "View All" on the Class Schedule tab's Family Member dropdown - only
  // meaningful (and only offered by the view) when there's more than one
  // family member to show side by side.
  const scheduleFamilyAll = tab === 'schedule' && req.query.family === 'all' && familyRoster.length > 1;

  const allSections = await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all();
  const memberSectionIds = (await sectionIdsForMembers([id]))[id];
  const portalStatus = (await portalStatusForMembers([id]))[id];
  const allRoles = await db.prepare('SELECT * FROM roles ORDER BY label').all();

  res.render('admin-member-profile', {
    title: member.name,
    member,
    tab,
    familyName: family ? family.familyName : null,
    familyMembers: restOfFamily.map((m) => m.name),
    memberSections: allSections.filter((s) => memberSectionIds.has(s.id)),
    portalRoles: portalStatus.account ? allRoles.filter((r) => portalStatus.roleIds.has(r.id)) : null,
    // Includes the member being viewed (not just the rest of the family)
    // - powers the Class Schedule/Attendance tabs' "jump to this family
    // member" dropdown, which needs the current member as one of its own
    // options so it can show who's selected.
    familyRoster,
    rosters: await rostersForMember(id),
    schedule: await getMemberSchedule(id),
    scheduleFamilyAll,
    familySchedules: scheduleFamilyAll
      ? await Promise.all(familyRoster.map(async (m) => ({ member: m, schedule: await getMemberSchedule(m.id) })))
      : null,
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
    adminPositions: await listAdminPositions(),
    memberAdminPositionIds: await adminPositionIdsForMember(id),
    error: req.query.error || null,
  });
});

router.post('/members/:id/edit', uploadMemberPhoto((req) => `/admin/members/${req.params.id}/edit`), async (req, res) => {
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
  await syncMemberAdminPositions(id, f.adminPositionIds);
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
    let incoming = row[field];
    if (!incoming) continue;
    if (existingMember[column]) continue; // never overwrite a value that's already set
    // Same "NaN/NaN/NaN" bug as the CREATE branch just below and Mass
    // Import Families (see that route's own comment) - a raw spreadsheet
    // cell's formatted text ("4/12/2015") isn't the ISO shape the
    // birthday column is stored as, and this merge path writes whatever
    // it's handed straight through on confirm with no read-time chance
    // to fix it up first. An unreadable date is treated the same as one
    // that was never provided - offering it as a mergeable field just to
    // silently write garbage isn't better than leaving it blank.
    if (field === 'birthday') {
      incoming = normalizeBirthdayToISO(incoming);
      if (!incoming) continue;
    }
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
        // normalizeBirthdayToISO here for the same reason mergeableFieldsFor
        // and the Mass Import Families loop both need it (see their own
        // comments) - a raw spreadsheet cell's formatted text isn't
        // automatically the ISO shape this column is stored as, and
        // writing it unconverted is what produces a literal "NaN/NaN/NaN"
        // everywhere that birthday is later displayed.
        memberType === 'student' && r.birthday ? normalizeBirthdayToISO(r.birthday) : null,
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
      .prepare("SELECT id FROM members WHERE active = 1 AND member_type IN ('parent', 'admin') AND LOWER(name) = LOWER(?)")
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
      SCHEDULE_CARD_SAFE_INSET,
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
      SCHEDULE_CARD_SAFE_INSET,
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
    SCHEDULE_CARD_SAFE_INSET,
  });
});

// Shared by the single-row Delete button and the bulk "Delete Selected"
// action below - permanently removes one member (ON DELETE CASCADE
// handles every other table referencing them) and cleans up their stored
// photo, which isn't a foreign key the database can clean up on its own.
// Returns the deleted row (or null if id didn't match anything, e.g. a
// stale bulk selection for a member someone else already deleted).
async function deleteMemberById(id) {
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return null;
  await db.prepare('DELETE FROM members WHERE id = ?').run(id);
  await deletePhotoFile(member.photo_path);
  return member;
}

router.post('/members/:id/delete', async (req, res) => {
  const member = await deleteMemberById(parseInt(req.params.id, 10));
  res.redirect(
    '/admin/members?notice=' + encodeURIComponent(member ? `Deleted "${member.name}".` : 'Member deleted.')
  );
});

function memberIdsFromBody(body) {
  return [...new Set([].concat(body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean))];
}

// --- Members page bulk actions (Edit mode's Select All + Delete/Archive/
// Restore Selected - see admin-members.ejs's own comment and
// public/js/archive-select-toggle.js, reused as-is from the Class/
// Student/Parent Schedule archive grids' identical Select-All-across-
// every-page mechanics). ---

router.post('/members/bulk-delete', async (req, res) => {
  const memberIds = memberIdsFromBody(req.body);
  if (memberIds.length === 0) {
    return res.redirect('/admin/members?error=' + encodeURIComponent('Select at least one member to delete.'));
  }
  let count = 0;
  for (const id of memberIds) {
    if (await deleteMemberById(id)) count++;
  }
  res.redirect('/admin/members?notice=' + encodeURIComponent(`Deleted ${count} member(s).`));
});

router.post('/members/bulk-archive', async (req, res) => {
  const memberIds = memberIdsFromBody(req.body);
  if (memberIds.length === 0) {
    return res.redirect('/admin/members?error=' + encodeURIComponent('Select at least one member to archive.'));
  }
  const placeholders = memberIds.map(() => '?').join(',');
  await db.prepare(`UPDATE members SET active = 0 WHERE id IN (${placeholders})`).run(...memberIds);
  res.redirect('/admin/members?notice=' + encodeURIComponent(`Archived ${memberIds.length} member(s).`));
});

router.post('/members/bulk-unarchive', async (req, res) => {
  const memberIds = memberIdsFromBody(req.body);
  if (memberIds.length === 0) {
    return res.redirect('/admin/members?archived=1&error=' + encodeURIComponent('Select at least one member to restore.'));
  }
  const placeholders = memberIds.map(() => '?').join(',');
  await db.prepare(`UPDATE members SET active = 1 WHERE id IN (${placeholders})`).run(...memberIds);
  res.redirect('/admin/members?notice=' + encodeURIComponent(`Restored ${memberIds.length} member(s).`));
});

// --- Edit Families dialog (rename or delete a family "name" itself,
// distinct from adding/removing individual members from one - see
// families.name's own uniqueness constraint and members.family_id's ON
// DELETE SET NULL, so deleting a family here only ungroups its members,
// it never deletes the members themselves). ---

router.post('/members/families/:id/rename', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/admin/members?error=' + encodeURIComponent('Family name is required.'));
  const clash = await db.prepare('SELECT id FROM families WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, id);
  if (clash) return res.redirect('/admin/members?error=' + encodeURIComponent(`"${name}" family already exists.`));
  await db.prepare('UPDATE families SET name = ? WHERE id = ?').run(name, id);
  res.redirect('/admin/members?notice=' + encodeURIComponent('Family renamed.'));
});

// Same wantsJson branch as /members/families/new above - the Edit
// Families dialog's own Delete button (public/js/edit-families.js) fetches
// this so the family's row can just disappear from the still-open dialog,
// instead of a full page navigation closing the whole dialog out from
// under an admin who's part-way through deleting several in a row.
router.post('/members/families/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  const family = await db.prepare('SELECT * FROM families WHERE id = ?').get(id);
  await db.prepare('DELETE FROM families WHERE id = ?').run(id);
  if (wantsJson) return res.json({ ok: true, id, name: family ? family.name : null });
  res.redirect(
    '/admin/members?notice=' + encodeURIComponent(family ? `Deleted "${family.name}" family.` : 'Family deleted.')
  );
});

module.exports = router;
