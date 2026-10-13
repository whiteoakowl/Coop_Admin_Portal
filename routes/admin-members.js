const express = require('express');
const router = express.Router();
const db = require('../db');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { sendCsv } = require('../utils/spreadsheet');
const { formatDateLabel, formatDateNumeric, formatTime, ageFromBirthday, isChildAge, isValidISODate } = require('../utils/dates');
const { uploadMemberPhoto, savePhotoFile, deletePhotoFile } = require('../utils/memberPhoto');
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
  byLastName,
  avatarColorFor,
  teacherMemberIds,
  assistantMemberIds,
} = require('../utils/members');
const { GRADE_LEVELS, CLASS_DAY_LABELS_FULL, listActiveClassDays } = require('../utils/classSchedule');
const { isValidClassDay } = require('../utils/classDays');
const { buildCardPairs } = require('../utils/cardPairs');
const { buildDuplexPages, SCHEDULE_CARD_SAFE_INSET } = require('../utils/duplexPrint');
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE, memberFamilyGroupKey } = require('../utils/pagination');
const { listAdminPositions, adminPositionIdsForMember, syncMemberAdminPositions, adminPositionTitlesForMembers } = require('../utils/adminPositions');
const { portalStatusForMembers, sectionIdsForMembers, setMemberSections, setMemberRoles } = require('../utils/portalPermissions');
const memberImport = require('../utils/memberImport');
const { clearVolunteerMembershipIfNotParent } = require('../utils/volunteers');

router.use(requireFullAdmin);

// 'admin' is co-op staff/leaders who mainly just need a printable badge
// (see members.member_type's own schema comment) - no family/grade/setup
// team fields, just an optional Admin Position (see memberFormFields below
// and views/partials/member-form-fields.ejs's 3-way toggle).
const MEMBER_TYPES = ['student', 'parent', 'admin'];

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

// Shared row shaping for the Members profile page's Attendance tab -
// pulled out so the family-wide "All" view (one call per family member)
// and the single-member view format their rows identically.
function formatAttendanceHistory(rows) {
  return rows.map((r) => ({
    rosterName: r.rosterName,
    dateLabel: formatDateLabel(r.date),
    statusLabel: r.status === 'present' ? 'Present' : r.status === 'late' ? 'Late' : 'Absent',
    status: r.status,
    checkInTime: r.checkInTime ? formatTime(r.checkInTime) : null,
    checkOutTime: r.checkOutTime ? formatTime(r.checkOutTime) : null,
    number: r.number,
  }));
}

// A real request: "under each person, each of the attendance rosters this
// member is on will show, then you can click on the class/roster name and
// it will expand and show attendance and dates for that class." Groups
// formatAttendanceHistory's already-date-desc-sorted flat rows by roster
// name, preserving each roster's own date order - groups come out in
// order of whichever roster's most recent attendance record is newest,
// since that's the order their rows first appear in the flat list.
function groupAttendanceByRoster(history) {
  const order = [];
  const byRoster = new Map();
  history.forEach((h) => {
    if (!byRoster.has(h.rosterName)) {
      byRoster.set(h.rosterName, []);
      order.push(h.rosterName);
    }
    byRoster.get(h.rosterName).push(h);
  });
  return order.map((rosterName) => ({ rosterName, rows: byRoster.get(rosterName) }));
}

// --- Members page (the full member list) ---

router.get('/members', async (req, res) => {
  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  const familyFilter = parseInt(req.query.family, 10) || null;
  const dayFilter = isValidClassDay(req.query.day) ? req.query.day : '';
  // A real request: "dropdown member search should include teachers and
  // class assistants" - teacher/assistant are class_staff roles, not a
  // member_type, so this is its own filter dimension alongside Type/Day/
  // Family rather than another MEMBER_TYPES value.
  const roleFilter = ['teacher', 'assistant'].includes(req.query.role) ? req.query.role : '';
  // A real request, with a reference screenshot, for a search bar on the
  // Members page - same "filter the already-fetched list by name" shape
  // Main Admin's own Members page (routes/main-admin-members.js) already
  // uses, just added here too for parity.
  const q = (req.query.q || '').trim().toLowerCase();
  // A real request: "remove member archive page, it is not needed on
  // co-op admin, only main admin" - Co-op Admin's Members page only ever
  // shows active members now; archiving/restoring a member is Main
  // Admin's own feature (routes/main-admin-members.js's Archive tab).
  // Cards/Schedule dialog content (badge HTML, schedule-card HTML,
  // getMemberSchedule()) used to be computed here for every member on
  // every page load - two renderBadgeElements() calls and a DB query
  // each, whether or not their row's dialog was ever opened. Now fetched
  // on demand instead - see /members/:id/cards-fragment and
  // /members/:id/schedule-fragment below, and public/js/members-dialogs.js.
  //
  // A real request: "membership to the app/website - all members are
  // listed in the member pages on main admin portal. Members only appear
  // on the member list for co-op admin portal if they are registered for
  // classes." Main Admin manages the full roster of everyone who's ever
  // joined; Co-op Admin only needs to see (and later staff for Floater/
  // Setup-Cleanup duty) families that have actually shown up for a class.
  // A family qualifies the moment ANY of its students has a
  // class_enrollments row - every other member in that same family
  // (parents, admin-type members included) comes along with it, same as
  // every other member list on this page already groups by family. An
  // enrolled student themselves always qualifies too, even on the rare
  // member row with no family_id at all.
  const enrolledStudentIds = new Set(
    (
      await db
        .prepare(`SELECT DISTINCT m.id AS "id" FROM members m JOIN class_enrollments ce ON ce.student_id = m.id WHERE m.member_type = 'student'`)
        .all()
    ).map((r) => r.id)
  );
  const qualifyingFamilyIds = new Set(
    (
      await db
        .prepare(
          `SELECT DISTINCT m.family_id AS "familyId" FROM members m
           JOIN class_enrollments ce ON ce.student_id = m.id
           WHERE m.member_type = 'student' AND m.family_id IS NOT NULL`
        )
        .all()
    ).map((r) => r.familyId)
  );
  const filteredMembers = (await membersWithDetails(typeFilter, familyFilter))
    .filter((m) => Number(m.active) === 1)
    .filter((m) => enrolledStudentIds.has(m.id) || (m.family_id != null && qualifyingFamilyIds.has(m.family_id)));
  // A real request: "this will then add their admin title label next to
  // their name... on member lists." Batched (not per-row) for the same
  // N+1 reason as nameTagData.js's own bulk-print title lookup.
  const adminTitlesByMember = await adminPositionTitlesForMembers(filteredMembers.map((m) => m.id));
  const teacherIds = roleFilter === 'teacher' ? await teacherMemberIds() : null;
  const assistantIds = roleFilter === 'assistant' ? await assistantMemberIds() : null;
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
  if (teacherIds) withRosters = withRosters.filter((m) => teacherIds.has(m.id));
  if (assistantIds) withRosters = withRosters.filter((m) => assistantIds.has(m.id));
  if (q) withRosters = withRosters.filter((m) => m.name.toLowerCase().includes(q));
  // The on-screen table only gets the current page's slice - the print
  // table (admin-members.ejs's separate .members-print-table) still gets
  // every filtered member, since a printed roster is meant to show the
  // whole list regardless of which page happened to be open on screen.
  // The Members page's own "Select All" (public/js/archive-select-toggle.js)
  // also reaches into this same full list for its off-page checkboxes -
  // see admin-members.ejs's own comment, mirroring admin-schedule.ejs's.
  const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  // A real bug report: "the dropdown for the last family on the page is
  // sometimes putting part of the family on the next page. Families
  // should stay together... each member list page doesn't have to be an
  // exact number of members" - see utils/pagination.js's own comment.
  const pagination = paginate(withRosters, parsePage(req.query.page), pageSize, memberFamilyGroupKey);

  // A real request: "if they are already on the log, it should say, this
  // member is already on the name tags request log. and the popup
  // closes." "On the log" means an active (unarchived) name_tag_requests
  // row already exists for that member - see the request-name-tag route
  // below, and routes/admin-design.js's own archived=0 "still needs
  // printing" queue query.
  const pendingNameTagMemberIds = new Set((await db.prepare('SELECT DISTINCT member_id FROM name_tag_requests WHERE archived = 0').all()).map((r) => r.member_id));

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
      (roleFilter ? `role=${roleFilter}&` : '') +
      (q ? `q=${encodeURIComponent(q)}&` : ''),
    typeFilter,
    familyFilter,
    dayFilter,
    roleFilter,
    activeDays: await listActiveClassDays(),
    dayLabels: CLASS_DAY_LABELS_FULL,
    q: req.query.q || '',
    families: await allFamilies(),
    error: req.query.error || null,
    notice: req.query.notice || null,
    pendingNameTagMemberIds,
    avatarColorFor,
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
  res.render('member-schedule-fragment', { member, schedule: await getMemberSchedule(member.id), dayLabels: CLASS_DAY_LABELS_FULL });
});

// Exports every field a member's profile can hold - the same information
// originally collected about them (contact info, address, birthday/grade,
// medical notes, family, rosters) - not just the Name/Type/Family/Rosters
// subset shown in the on-screen table.
router.get('/members/export.csv', async (req, res) => {
  const typeFilter = MEMBER_TYPES.includes(req.query.type) ? req.query.type : '';
  const familyFilter = parseInt(req.query.family, 10) || null;
  const members = await membersWithDetails(typeFilter, familyFilter);
  const lines = memberImport.buildMembersExportCsvLines(members);
  sendCsv(res, `members${typeFilter ? '-' + typeFilter : ''}.csv`, lines);
});

// A real request: "No parent/student choice on membership forms or
// profiles. All children are automatically counted as student and adults
// counted as parents." memberType is no longer read from a submitted
// radio - it's derived from the submitted birthday (utils/dates.js's
// isChildAge), except for an existing Admin, who still submits a locked
// hidden memberType=admin field (see partials/member-form-fields.ejs) that
// this never overrides - the POST /:id/edit handler below also still
// refuses to let a raw request change TO or FROM admin either way.
function memberFormFields(req) {
  const birthday = (req.body.birthday || '').trim() || null;
  const memberType = req.body.memberType === 'admin' ? 'admin' : isChildAge(birthday) ? 'student' : 'parent';
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
    birthday,
    gradeLevel: memberType === 'student' ? (req.body.gradeLevel || '').trim() || null : null,
    // Medical/Allergy Notes is on both the Parent and Student Membership
    // Forms (not student-only anymore - see the mockup), so it's captured
    // regardless of member type.
    medicalNotes: (req.body.medicalNotes || '').trim() || null,
    familyId: Number.isInteger(familyIdRaw) ? familyIdRaw : null,
    isPrimaryParent: req.body.isPrimaryParent === '1',
    // A real request: "Remove setup/cleanup team section. That is only
    // done through the setup/cleanup admin pages" - this form no longer
    // touches setup_team_members at all; whatever team membership a
    // member already has stays untouched when their profile is saved here.
    // A real request: "ability to add unlimited admin positions to a
    // member profile" - superseded the old single adminPositionId (a
    // plain <select>) with a checkbox multi-select.
    // req.body.adminPositionsFormPresent (a hidden marker, always
    // submitted alongside these checkboxes - see partials/member-form-
    // fields.ejs's own comment) distinguishes a real form save (resync to
    // exactly what's checked, however many that is) from a raw/partial
    // request that skips the form entirely (undefined here means "leave
    // existing positions untouched," never "clear them").
    adminPositionIds:
      req.body.adminPositionsFormPresent === '1'
        ? [].concat(req.body.adminPositionIds || []).map((id) => parseInt(id, 10)).filter(Boolean)
        : undefined,
  };
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

// A real request: "membership to the app/website. All members are
// listed in the member pages on main admin portal. Members only appear
// on the member list for co-op admin portal if they are registered for
// classes" - member creation (the Add Member form, plus the bulk CSV/
// XLSX import that used to live here too) is Main Admin-only now; Co-op
// Admin only ever surfaces members Main Admin has already created, once
// a student in their family registers for a class (see the GET /members
// route's own familyIdsWithEnrolledStudent filter). Editing an EXISTING
// member (GET/POST /members/:id/edit below) is unaffected.
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
  // "View All" on the Class Schedule/Attendance tabs' Family Member
  // dropdown - only meaningful (and only offered by the view) when
  // there's more than one family member to show side by side. A real
  // follow-up request: "if its a primary parent or parent, these tabs on
  // the member profiles will also show the whole families schedules and
  // Attendance" - a parent's own profile defaults straight to the family
  // view instead of requiring "All" to be picked explicitly every time
  // (a student's profile still defaults to just their own schedule/
  // history, same as before - "All" is still there for them to opt in).
  const familyAllDefault = familyRoster.length > 1 && member.member_type === 'parent';
  const scheduleFamilyAll = tab === 'schedule' && familyRoster.length > 1 && (req.query.family === 'all' || familyAllDefault);
  const attendanceFamilyAll = tab === 'attendance' && familyRoster.length > 1 && (req.query.family === 'all' || familyAllDefault);

  const allSections = await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all();
  const memberSectionIds = (await sectionIdsForMembers([id]))[id];
  const portalStatus = (await portalStatusForMembers([id]))[id];
  const allRoles = await db.prepare('SELECT * FROM roles ORDER BY label').all();

  res.render('admin-member-profile', {
    title: member.name,
    member,
    tab,
    familyName: family ? family.familyName : null,
    // A real request: "the family should be a list in a nice column with
    // parents listed under parent title, and children listed under
    // children title. Should show grade levels next to students in
    // parenthesis." Full member records now (not just names), so the view
    // can group by member_type and read each student's grade_level.
    // familyRoster (not restOfFamily) - a later real request: "add all
    // parents under list of family" - the member being viewed should
    // still show up under Parents if they themselves are one (partials/
    // member-profile-card.ejs keeps excluding them from Children only).
    familyMembers: familyRoster,
    memberSections: allSections.filter((s) => memberSectionIds.has(s.id)),
    portalRoles: portalStatus.account ? allRoles.filter((r) => portalStatus.roleIds.has(r.id)) : null,
    // Includes the member being viewed (not just the rest of the family)
    // - powers the Class Schedule/Attendance tabs' "jump to this family
    // member" dropdown, which needs the current member as one of its own
    // options so it can show who's selected.
    familyRoster,
    rosters: await rostersForMember(id),
    schedule: await getMemberSchedule(id),
    dayLabels: CLASS_DAY_LABELS_FULL,
    scheduleFamilyAll,
    familySchedules: scheduleFamilyAll
      ? await Promise.all(familyRoster.map(async (m) => ({ member: m, schedule: await getMemberSchedule(m.id) })))
      : null,
    attendanceFamilyAll,
    history: attendanceFamilyAll ? null : groupAttendanceByRoster(formatAttendanceHistory(await attendanceHistoryForMember(id))),
    familyAttendanceHistories: attendanceFamilyAll
      ? await Promise.all(
          familyRoster.map(async (m) => ({ member: m, history: groupAttendanceByRoster(formatAttendanceHistory(await attendanceHistoryForMember(m.id))) }))
        )
      : null,
  });
});

router.get('/members/:id/edit', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');

  // A real request: "Only main admin and co-op admin can change sections,
  // portal roles, family, and birthday." Family and Birthday were already
  // admin-only (this is the only edit form that ever touches them), but
  // Sections/Portal Roles were only ever readable here (see /members/:id
  // above) - this is Co-op Admin gaining the same write access Main
  // Admin's own edit page already has (views/main-admin-member-edit.ejs),
  // minus Password/account-creation, which stays Main Admin-only (see
  // routes/main-admin-members.js's own "No creating users" comment).
  const portalStatus = (await portalStatusForMembers([id]))[id];
  res.render('admin-member-edit', {
    title: `Edit ${member.name}`,
    mode: 'edit',
    member,
    families: await allFamilies(),
    memberFamilyId: member.family_id,
    gradeLevels: GRADE_LEVELS,
    adminPositions: await listAdminPositions(),
    memberAdminPositionIds: await adminPositionIdsForMember(id),
    allSections: await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all(),
    memberSectionIds: (await sectionIdsForMembers([id]))[id],
    portalAccount: portalStatus.account,
    allRoles: await db.prepare('SELECT * FROM roles ORDER BY label').all(),
    portalRoleIds: portalStatus.roleIds,
    // A real request: "when you click edit profile for a member, it
    // should show the other parents and children's information as well
    // for easy editing." - each other family member gets its own compact
    // inline form (views/partials/family-members-editor.ejs), posting to
    // the quick-edit route below, so the whole family can be corrected
    // without leaving this page.
    familyMembers: await familyOf(id),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// The inline "Family Members" editor's own per-row Save (see GET
// /members/:id/edit above and views/partials/family-members-editor.ejs) -
// deliberately NOT the same route as the full Add/Edit Member form: only
// Name/Email/Phone (everyone) and Birthday/Grade Level (students only,
// same type-gating as the full form's own partials/member-form-fields.ejs)
// are editable here, so this never has to carry (and risk blanking out)
// every other field - photo, address, family, admin positions, sections,
// portal roles - that full form also saves. Member type itself is always
// left exactly as it already was, even if a new Birthday would otherwise
// imply a different one (isChildAge) - that's a bigger change than "easy
// editing" calls for, and still available from that family member's own
// full Edit page if it's ever actually needed.
router.post('/members/:viewerId/family/:memberId/quick-edit', async (req, res) => {
  const viewerId = parseInt(req.params.viewerId, 10);
  const memberId = parseInt(req.params.memberId, 10);
  const back = `/admin/members/${viewerId}/edit`;

  const viewer = await db.prepare('SELECT family_id FROM members WHERE id = ?').get(viewerId);
  const existing = await db.prepare('SELECT family_id, member_type FROM members WHERE id = ?').get(memberId);
  if (!viewer || !existing || viewer.family_id == null || existing.family_id !== viewer.family_id) {
    return res.redirect(back + '?error=' + encodeURIComponent('That family member could not be found.'));
  }

  const name = (req.body.name || '').trim();
  if (!name) return res.redirect(back + '?error=' + encodeURIComponent('Name is required.'));
  const clash = await db.prepare('SELECT id FROM members WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, memberId);
  if (clash) return res.redirect(back + '?error=' + encodeURIComponent(`"${name}" is already in the member list.`));

  const email = (req.body.email || '').trim() || null;
  const phone = (req.body.phone || '').trim() || null;
  const isStudent = existing.member_type === 'student';
  const birthdayRaw = (req.body.birthday || '').trim();
  const birthday = isStudent && isValidISODate(birthdayRaw) ? birthdayRaw : null;
  const gradeLevel = isStudent && GRADE_LEVELS.includes(req.body.gradeLevel) ? req.body.gradeLevel : null;

  if (isStudent) {
    await db.prepare('UPDATE members SET name = ?, email = ?, phone = ?, birthday = ?, grade_level = ? WHERE id = ?').run(name, email, phone, birthday, gradeLevel, memberId);
  } else {
    await db.prepare('UPDATE members SET name = ?, email = ?, phone = ? WHERE id = ?').run(name, email, phone, memberId);
  }

  res.redirect(back + '?notice=' + encodeURIComponent(`${name} updated.`));
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
  const existing = await db.prepare('SELECT photo_path, member_type FROM members WHERE id = ?').get(id);
  // A real request: "Choosing admins should not be on the membership
  // profile, co-op admin portal. It should be on main admin member
  // list edit only." partials/member-form-fields.ejs already never
  // renders a way to PICK Admin here - this is the server-side half of
  // that same boundary, for a raw request that skips the form entirely.
  // Admin status can only be carried through unchanged (an existing
  // Admin's other fields still save normally), never granted or revoked
  // from this route.
  if (existing && (f.memberType === 'admin') !== (existing.member_type === 'admin')) {
    f.memberType = existing.member_type;
    if (f.memberType !== 'admin') f.adminPositionIds = null;
  }
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
  await syncMemberAdminPositions(id, f.adminPositionIds);
  await clearVolunteerMembershipIfNotParent(id, f.memberType);
  await setMemberFamily(id, f.familyId);
  await setPrimaryParent(id, f.isPrimaryParent);

  // Sections/Portal Roles - see this file's own GET /members/:id/edit
  // comment on why Co-op Admin can now write these too, not just read
  // them. setMemberRoles is already a no-op for a member with no portal
  // account yet (utils/portalPermissions.js), same as Main Admin's own
  // identical handling when no password is set in the same submit.
  const sectionIds = [].concat(req.body.sectionIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  await setMemberSections(id, sectionIds);
  const portalStatus = (await portalStatusForMembers([id]))[id];
  if (portalStatus.account) {
    const roleIds = [].concat(req.body.roleIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
    await setMemberRoles(id, roleIds, null);
  }

  res.redirect('/admin/members?notice=' + encodeURIComponent(`${f.name} updated.`));
});

router.post('/members/:id/notes', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const notes = (req.body.notes || '').trim();
  await db.prepare('UPDATE members SET notes = ? WHERE id = ?').run(notes || null, id);
  res.redirect('/admin/members');
});

// A real request: "add an icon that shows sending something. when you
// click it a pop up will appear and ask, do you want to add this name
// tag to the request log? yes, no buttons, close windows." Queues a
// New Name Tag request for this member the same way the public
// routes/name-tag.js form does, so it shows up in Design > Print's
// Name Tag Requests queue and the Logs > Name Tag Request Log
// (routes/admin-logs.js) exactly like a parent-submitted request would.
// A real request: "when clicking the icon on member list to send to name
// tags request log the page should not refresh everytime." isFetch mirrors
// routes/admin-substitutes.js's own helper - a fetch() caller (public/js/
// member-name-tag-request.js) gets JSON back instead of the redirect, so
// the click never navigates the page; any other caller (no-JS, a future
// direct link) still gets the original redirect.
function isFetch(req) {
  return req.get('X-Requested-With') === 'fetch';
}

router.post('/members/:id/request-name-tag', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT id FROM members WHERE id = ?').get(id);
  if (member) {
    await db
      .prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'new_tag', 'both', 'Added from Member List by admin')")
      .run(id);
  }
  if (isFetch(req)) return res.json({ ok: true });
  res.redirect('/admin/members');
});

const CARD_PRINT_LAYOUTS = ['nameTag', 'scheduleCard', 'frontBack'];

// Member profile "Cards" dialog: prints exactly the layout the admin chose
// from the dropdown (member-cards-fragment.ejs) - a single card, or both
// cards together front-and-back for a double-sided cut-out card (see
// utils/duplexPrint.js). Every member type can have a class schedule, so
// Schedule Card is available regardless of type. "Front and back" reuses
// the exact same buildCardPairs/buildDuplexPages helpers and views the
// bulk Design/Print flows use (routes/admin-design.js), just with a
// single-member list, so a member's cards always print identically
// whether they were printed one at a time here or in a bulk batch there.
router.get('/members/:id/cards/print', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');

  const layout = CARD_PRINT_LAYOUTS.includes(req.query.layout) ? req.query.layout : 'nameTag';

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
  if (isFetch(req)) return res.json({ ok: true });
  res.redirect(
    '/admin/members?notice=' + encodeURIComponent(member ? `Deleted "${member.name}".` : 'Member deleted.')
  );
});

function memberIdsFromBody(body) {
  return [...new Set([].concat(body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean))];
}

// --- Members page bulk actions (Edit mode's Select All + Delete Selected -
// see admin-members.ejs's own comment and public/js/archive-select-toggle.js,
// reused as-is from the Class/Student/Parent Schedule archive grids'
// identical Select-All-across-every-page mechanics). Archive/Restore is
// Main Admin's own feature now (routes/main-admin-members.js) - a real
// request: "remove member archive page, it is not needed on co-op admin,
// only main admin." ---

// A real request: "any pages, do not refresh the page when clicking
// button or icons... stay on the screen so you don't have to search for
// families and members again." These 3 bulk actions are still real page
// submits (public/js/members-bulk-actions.js sets the form's own action
// and submits it directly), unlike the per-row actions below - so they
// still redirect, but back to whatever Filter/Family/search/page
// querystring the Members list actually had, not always the bare,
// unfiltered /admin/members - same req.get('Referer') || fallback shape
// routes/notifications.js already uses. Only trusts a same-page Referer
// (pathname must actually be /admin/members) so a spoofed header can't
// send an admin somewhere unexpected.
function membersRedirectUrl(req, fallbackQuery, extraParams) {
  let url;
  try {
    const referer = new URL(req.get('Referer') || '');
    url = referer.pathname === '/admin/members' ? referer : new URL(`http://x/admin/members?${fallbackQuery}`);
  } catch {
    url = new URL(`http://x/admin/members?${fallbackQuery}`);
  }
  url.searchParams.delete('notice');
  url.searchParams.delete('error');
  for (const [key, value] of Object.entries(extraParams)) url.searchParams.set(key, value);
  // encodeURIComponent, not URLSearchParams's own toString() (which
  // encodes a space as "+") - keeps the %20-style encoding every other
  // redirect in this file already uses, so an existing notice/error
  // banner elsewhere that pattern-matches the querystring keeps working.
  const query = [...url.searchParams].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return url.pathname + (query ? '?' + query : '');
}

router.post('/members/bulk-delete', async (req, res) => {
  const memberIds = memberIdsFromBody(req.body);
  if (memberIds.length === 0) {
    return res.redirect(membersRedirectUrl(req, '', { error: 'Select at least one member to delete.' }));
  }
  let count = 0;
  for (const id of memberIds) {
    if (await deleteMemberById(id)) count++;
  }
  res.redirect(membersRedirectUrl(req, '', { notice: `Deleted ${count} member(s).` }));
});

// A real request: "Co-op admin portal, members, remove manage families
// button and features. This is only done on main admin portal." Renaming
// and deleting a family's own "name" (distinct from adding/removing
// individual members from one) now lives exclusively on Main Admin's own
// Members page (routes/main-admin-members.js) - Co-op Admin's own
// /members/families/new above stays, since the Add/Edit Member form's
// own "+ Add New Family" inline dialog still needs it.

module.exports = router;
