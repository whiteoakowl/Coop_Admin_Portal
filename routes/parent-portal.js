// Parent Portal - the first fully-built new member-facing portal. Reuses
// the EXISTING classes/class_enrollments domain model (utils/
// classSchedule.js) rather than a parallel "course" system; the only new
// tables are class_registrations (an audit trail of a parent's own
// registration actions) and the capacity/registration_open/description
// columns classes itself gained (see the portal-platform-foundation
// migration).
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requirePortalAuth, requirePortal } = require('../middleware/portalAuth');
const { memberForAccount, familyForAccount } = require('../utils/portalAuth');
const {
  roomGridForDay,
  hoursForDay,
  ageGroupList,
  getClass,
  formatGradeRange,
  classImageUrl,
  CLASS_DAY_LABELS_FULL,
  isValidClassDay,
  listActiveClassDays,
  allClassesList,
  attendanceHistoryForRoster,
  GRADE_LEVELS,
  classScheduleIdsForClass,
  parseClockMinutesLocal,
  classesWithOpenStaffSlotsForDay,
  listScheduleCombos,
} = require('../utils/classSchedule');
const { CLASS_DAY_ORDER } = require('../utils/classDays');
const { comboSemesterId, findComboId } = require('../utils/scheduleComboLinks');
const { getActiveKioskSemesterId } = require('../utils/kioskSettings');
const { getHandbookHtml } = require('../utils/membershipHandbook');
const { getTemplate, badgeDataForMembers } = require('../utils/nameTagData');
const { BADGE_WIDTH, BADGE_HEIGHT } = require('../utils/nameTagBadge');
const { CARD_WIDTH, CARD_HEIGHT } = require('../utils/scheduleCardBadge');
const { buildDuplexPages, SCHEDULE_CARD_SAFE_INSET } = require('../utils/duplexPrint');
const { buildCardPairs } = require('../utils/cardPairs');
const NameTagRenderCore = require('../public/js/name-tag-render-core');
const { formatFriendlyTimestamp, formatTimestamp, ageFromBirthday, todayISO } = require('../utils/dates');
const { isRegistrationOpenForAccount, nextWindowForAccount } = require('../utils/registrationWindows');
const { familyOf, byLastName } = require('../utils/members');
const { libraryActivityForMemberIds, allItems: allLibraryItems, allLibraryTypes } = require('../utils/library');
const resourceLinks = require('../utils/resourceLinks');
const trainingModule = require('../utils/training');
const {
  assignmentsForStudentInClass,
  diplomaForStudent,
  issueDiploma,
  transcriptForStudent,
  lessonsForStudentView,
  getContentItem,
  getQuizAttempt,
  submitQuizAttempt,
  contentItemsForAssignment,
  markLessonItemComplete,
} = require('../utils/academics');
const notifications = require('../utils/notifications');
const { sectionIdsForMember, classSectionIds, memberSatisfiesRestriction } = require('../utils/sections');
const { registerForClass, unregisterFromClass, joinClassAsStaff, leaveClassAsStaff } = require('../utils/classRegistration');
const events = require('../utils/events');
const babysitters = require('../utils/babysitters');
const { imageFileFilter } = require('../utils/uploads');
const { jsonScriptSafe } = require('../utils/json');
const { createStorageClient, uploadFile, generateKey } = require('../utils/storage');
const reading = require('../utils/reading');
const businessDirectory = require('../utils/directory');
const classifieds = require('../utils/classifieds');

router.use(requirePortalAuth, requirePortal('parent'));

const BABYSITTER_PHOTOS_BUCKET = 'private-babysitter-photos';
const BABYSITTER_PHOTOS_DIR = path.join(__dirname, '..', 'private-uploads', 'babysitter-photos');
const babysitterStorageClient = createStorageClient();
if (!babysitterStorageClient && !fs.existsSync(BABYSITTER_PHOTOS_DIR)) {
  try {
    fs.mkdirSync(BABYSITTER_PHOTOS_DIR, { recursive: true });
  } catch (err) {
    console.error(`Could not create local upload directory ${BABYSITTER_PHOTOS_DIR}:`, err.message);
  }
}
const MAX_BABYSITTER_PHOTO_BYTES = 4 * 1024 * 1024;
const uploadBabysitterPhoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BABYSITTER_PHOTO_BYTES }, fileFilter: imageFileFilter });

// Every student in the signed-in parent's own family - the only students
// this portal ever lets them register/view, enforced here (not just
// hidden in the UI) by every route below re-deriving this same list
// rather than trusting a student id from the request.
async function childrenForAccount(account) {
  const member = await memberForAccount(account.id);
  if (!member || !member.family_id) return [];
  return (
    await db
      .prepare("SELECT * FROM members WHERE family_id = ? AND member_type = 'student' AND active = 1")
      .all(member.family_id)
  ).sort(byLastName);
}

// Every adult in this account's own family - a real request: "Classroom
// dashboard on parent portal should have Parent names in drop down menu
// to show what classes the parent is teaching or assisting in," which
// the dashboard's own original request ("a dropdown menu... with each
// family member to choose view") already called for but only ever
// implemented for students (childrenForAccount above). Same re-derive-
// from-the-account rule as childrenForAccount - never trusts a member id
// from the request.
// A real request: "if a parent is an admin it should still show them as
// a possible parent to signup for teaching and assisting in a class" -
// member_type IN ('parent', 'admin') is the established convention
// everywhere else in this app that treats "parent" and "admin" as the
// same kind of adult (utils/members.js's own parentsAndAdmins, Setup/
// Cleanup absence lookups, orientation, schedule cards, event
// visibility...) - this was the one place still checking 'parent' alone.
async function parentsForAccount(account) {
  const member = await memberForAccount(account.id);
  if (!member || !member.family_id) return [];
  return (
    await db
      .prepare("SELECT * FROM members WHERE family_id = ? AND member_type IN ('parent', 'admin') AND active = 1")
      .all(member.family_id)
  ).sort(byLastName);
}

// A real request: "under the section for registering teacher or class
// assistant it should list all parent names in that family and any
// students 15 years old or older as eligible to register for teacher or
// class assistant positions" - self-signup used to implicitly mean only
// the logged-in account's own member.
// A real bug report: "it's not showing parent names to register as
// teacher or assistant" - this originally reused parentsForAccount/
// childrenForAccount, which BOTH return [] outright when the account's
// own member has no family_id, rather than falling back to at least the
// account itself. members.family_id is nullable with ON DELETE SET NULL
// (a deleted/merged family clears it on every member who was in it,
// without touching their own active account), so a parent who got
// orphaned that way - especially one with no children, since that's the
// only path that ever called either of those two functions before - saw
// literally nobody listed here, including themselves, even though the
// OLD single-person self-signup (before this feature existed) never
// needed a family_id at all, just memberForAccount. familyForAccount
// (utils/portalAuth.js) already gets this right - self always included,
// family_id or not - so this reuses that instead of re-deriving it.
async function staffEligibleFamilyMembers(account) {
  const family = await familyForAccount(account.id);
  return family
    .filter(
      (m) =>
        m.member_type === 'parent' ||
        m.member_type === 'admin' ||
        (m.member_type === 'student' && m.birthday && ageFromBirthday(m.birthday) >= 15)
    )
    .sort(byLastName);
}

router.get('/', async (req, res) => {
  // Everything in this first batch is independent of everything else in
  // it (none reads a value another produced) - run concurrently instead
  // of one at a time. Only childIds/countsByStudent (needs `children`)
  // and visibilityFlags (needs `upcoming` + `family`) have a real
  // dependency, so those stay in a second batch below.
  const [children, siteRows, personalRows, family, upcoming, businessDirectoryListingsRaw, classifiedsListingsRaw, readingLeaders, member] =
    await Promise.all([
      childrenForAccount(req.portalAccount),
      // Two real sources merged into one feed, newest first - a real
      // request: "notifications should be announcements and show up on
      // the parent portal homepage, showing current announcements and
      // past ones. main admin can send these customized notifications."
      // Site-wide announcements (the same content Main Admin > Website
      // manages, also shown to signed-out visitors on the public
      // homepage) are one source; the other is Main Admin >
      // Announcements' own per-account notifications
      // (utils/notifications.js's notify(), type_key 'announcement') -
      // unread ones get a "New" badge (isNew below), read ones just sink
      // down the list, which is what "current ones and past ones" means
      // here rather than a hard time-based cutoff.
      db.prepare("SELECT * FROM announcements WHERE (expires_at IS NULL OR expires_at > now_text()) ORDER BY published_at DESC LIMIT 10").all(),
      notifications.listForAccount(req.portalAccount.id, { typeKey: 'announcement' }),
      // A real request: "Take off the my family card and replace it with
      // upcoming events from the event calendar" - same visibility rules
      // as the shared /events calendar itself (routes/events.js), just
      // capped to a handful for the homepage card.
      familyForAccount(req.portalAccount.id),
      events.listEvents({ status: 'published', upcomingOnly: true, approvalStatus: 'approved' }),
      // A real request: "card showing business directory listing. And a
      // card showing classifieds listings" - a small preview of each,
      // same 'active' status the /directory and /classifieds pages
      // themselves use.
      businessDirectory.listListings({ status: 'active' }),
      classifieds.listListings({ status: 'active' }),
      // A real request: "card showing the rankings for Parent reading
      // challenge" - same leaderboard /parent/leaderboard already
      // renders, scoped to memberType 'parent' (utils/reading.js).
      reading.leaderboard(5, 'parent'),
      memberForAccount(req.portalAccount.id),
    ]);

  const announcements = [
    ...siteRows.map((a) => ({ title: a.title, body: a.body, dateLabel: formatFriendlyTimestamp(a.published_at), sortKey: a.published_at, isNew: false })),
    ...personalRows.map((n) => ({ title: n.title, body: n.body, dateLabel: formatFriendlyTimestamp(n.created_at), sortKey: n.created_at, isNew: !n.read_at })),
  ]
    .sort((a, b) => (a.sortKey < b.sortKey ? 1 : -1))
    .slice(0, 15);

  const childIds = children.map((c) => c.id);
  // A real request: "class registrations count should show how many
  // classes your family is registered for by person in your family" -
  // per-child counts instead of one family-wide total, so the homepage
  // reads as "Jane: 2, Sam: 1" rather than an ambiguous "3". A real bug
  // report: "not showing counts... when I know they are signed up for
  // classes" - this used to count class_registrations (only a log of the
  // parent's OWN self-service register/cancel actions - see
  // utils/classRegistration.js), which stays empty for any student whose
  // class assignment came from Co-op Admin's own roster tool instead
  // (utils/classSchedule.js's setEnrollment writes class_enrollments
  // directly, never touching class_registrations at all). class_enrollments
  // is the actual "is this student in this class" table used everywhere
  // else (attendance, rosters, ...), so it's the right source here too.
  const [countsByStudent, visibilityFlags] = await Promise.all([
    childIds.length
      ? db
          .prepare(
            `SELECT student_id, COUNT(*) AS c FROM class_enrollments WHERE student_id IN (${childIds.map(() => '?').join(',')}) GROUP BY student_id`
          )
          .all(...childIds)
      : Promise.resolve([]),
    Promise.all(upcoming.map((e) => events.eventVisibleToFamily(e.id, family))),
  ]);
  const countByStudentId = new Map(countsByStudent.map((r) => [Number(r.student_id), Number(r.c)]));
  const registrationCountsByChild = children.map((c) => ({ name: c.name, count: countByStudentId.get(Number(c.id)) || 0 }));

  const upcomingEvents = upcoming
    .filter((e, i) => visibilityFlags[i])
    .slice(0, 3)
    .map((e) => ({ title: e.title, startsLabel: formatFriendlyTimestamp(e.starts_at) }));

  const businessDirectoryListings = businessDirectoryListingsRaw.slice(0, 4);
  const classifiedsListings = classifiedsListingsRaw.slice(0, 4);

  res.render('parent-home', {
    title: 'Parent Portal',
    member,
    children,
    announcements,
    registrationCountsByChild,
    upcomingEvents,
    businessDirectoryListings,
    classifiedsListings,
    readingLeaders,
  });
});

// Redirect target for the register/unregister POSTs below - back to the
// day grid the dialog was opened from, so registering/cancelling from
// inside the popup lands the parent right back where they were instead
// of resetting to Monday. Returns a URL already ending in `?` or `&` so a
// caller can always just tack `error=`/`notice=` straight on, regardless
// of whether a `day` param made it in.
function classesBackUrl(day) {
  return isValidClassDay(day) ? `/parent/classes?day=${day}&` : '/parent/classes?';
}

// The room x hour grid, day-tabbed exactly like Co-op Admin's own Class
// Schedules page (utils/classSchedule.js's roomGridForDay - same data,
// same visual grid, just read-only and with each card opening a
// registration popup instead of an edit form). A real request: "the
// class grid on parent portal should look like [the Co-op Admin one] -
// when members click on the class it will show a popup with further
// information... and list the appropriate age/grade students from your
// family that you can sign up." Every class for the day shows here
// regardless of registration_open - closed classes are still worth
// seeing on the grid (and still show an already-enrolled child, added
// straight through Co-op Admin's own roster tools) - only the fragment
// dialog's own register controls actually gate on it.
// A real request: "add icons at the top for grid view vs list view of
// classes like co-op class portal" - the room/hour grid (default) is
// hard to scan on a narrow phone since every class card still has to
// fit inside one grid cell; List view flattens the same day's classes,
// sorted by actual start time, into one simple top-to-bottom stack
// instead - the Filter panel's own client-side grade filtering (public/
// js/parent-class-filters.js, matching on each card's own data-class-
// grade-list attribute) still works unchanged since it's the identical
// .class-card markup either way.
router.get('/classes', async (req, res) => {
  const activeDays = await listActiveClassDays();
  const day = activeDays.includes(req.query.day) ? req.query.day : (activeDays[0] || 'monday');
  const view = req.query.view === 'list' ? 'list' : 'grid';
  const children = await childrenForAccount(req.portalAccount);
  const childIds = children.map((c) => c.id);

  // Just enough to badge a card "Registered" at a glance - the fragment
  // dialog (fetched on click) does the real per-child eligibility and
  // register/cancel work below.
  const enrolledClassIds = childIds.length
    ? (
        await db
          .prepare(`SELECT DISTINCT class_id FROM class_enrollments WHERE student_id IN (${childIds.map(() => '?').join(',')})`)
          .all(...childIds)
      ).map((r) => r.class_id)
    : [];

  const windowOpen = await isRegistrationOpenForAccount(req.portalRoles, { actionType: 'parent_register_student' });
  const nextWindow = windowOpen ? null : await nextWindowForAccount(req.portalRoles, { actionType: 'parent_register_student' });

  const roomGrid = await roomGridForDay(day);
  const classList =
    view === 'list'
      ? roomGrid.rows
          .flatMap((row) => row.cells.flatMap((cell) => cell.classes))
          .sort((a, b) => (parseClockMinutesLocal(a.start_time) ?? 0) - (parseClockMinutesLocal(b.start_time) ?? 0) || a.class_name.localeCompare(b.class_name))
      : [];

  res.render('parent-classes', {
    title: 'Class Registration',
    day,
    view,
    activeDays,
    dayLabels: CLASS_DAY_LABELS_FULL,
    hours: await hoursForDay(day),
    roomGrid,
    classList,
    hasChildren: children.length > 0,
    children,
    gradeLevels: GRADE_LEVELS,
    enrolledClassIds,
    windowOpen,
    nextWindowLabel: nextWindow ? formatTimestamp(nextWindow.opens_at) : null,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// A real request: a button on the Class Registration page leading to a
// standing "classes needing a teacher or assistant" list - every class on
// a day/semester with an open teacher and/or assistant seat
// (classesWithOpenStaffSlotsForDay, utils/classSchedule.js), listed by hour, so
// a parent browsing for somewhere to volunteer doesn't have to open every
// single class's own popup to find one that still needs someone. A class
// drops off the instant both roles are filled, and reappears the moment
// a roster count dips back below its cap (e.g. a withdrawal) - always
// computed live, nothing here is stored.
// Same Semester/Day combo picker (partials/schedule-combo-picker.ejs) the
// Co-op Admin side of this app already uses everywhere this same
// "which semester/day" question comes up - resolveSemesterId below
// mirrors routes/admin-schedule.js's own helper of the same name (kept
// as a per-route-file copy by established convention here, not a shared
// export - see that file's own comment on why).
async function resolveSemesterId(semesterId) {
  return semesterId !== undefined ? semesterId : await getActiveKioskSemesterId();
}

router.get('/classes/needing-staff', async (req, res) => {
  const activeDays = await listActiveClassDays();
  const day = activeDays.includes(req.query.day) ? req.query.day : (activeDays[0] || 'monday');
  const combos = await listScheduleCombos();
  const resolvedSemesterId = await resolveSemesterId(comboSemesterId(req));

  res.render('parent-classes-needing-staff', {
    title: 'Classes Needing a Teacher or Assistant',
    day,
    dayLabels: CLASS_DAY_LABELS_FULL,
    combos,
    selectedComboId: findComboId(combos, day, resolvedSemesterId),
    hours: await classesWithOpenStaffSlotsForDay(day, resolvedSemesterId),
  });
});

// Powers the click-a-class-card popup: class info (day/time/room/
// teacher/price/seats/public description) plus, per child in the
// signed-in parent's own family, either their current registration
// status (Cancel, or their waitlist position) or a Register control -
// shown only for a child who is BOTH the right age/grade for this class
// (classes.age_group, same GRADE_LEVELS vocabulary as the create/edit
// class form) AND, if the class is section-restricted, in an allowed
// section. A child already enrolled/waitlisted always shows regardless
// of either check - added straight through Co-op Admin (or since aged
// out of the grade range) shouldn't make their existing spot vanish from
// view. Fetched as an HTML fragment (no <html>/<body>) into the shared
// dialog, same pattern as the Co-op Admin grid's own View popup - see
// public/js/fragment-dialog.js and public/js/class-schedule-view.js.
router.get('/classes/:id/fragment', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const cls = await getClass(classId);
  if (!cls) return res.status(404).send('Not found');

  const children = await childrenForAccount(req.portalAccount);
  const childIds = children.map((c) => c.id);

  const enrolledRows = childIds.length
    ? await db
        .prepare(`SELECT student_id FROM class_enrollments WHERE class_id = ? AND student_id IN (${childIds.map(() => '?').join(',')})`)
        .all(classId, ...childIds)
    : [];
  const enrolledIds = new Set(enrolledRows.map((r) => r.student_id));

  const waitlistRows = childIds.length
    ? await db
        .prepare(
          `SELECT student_id, waitlist_position FROM class_registrations
           WHERE class_id = ? AND status = 'waitlisted' AND student_id IN (${childIds.map(() => '?').join(',')})`
        )
        .all(classId, ...childIds)
    : [];
  const waitlistPositionByStudentId = {};
  waitlistRows.forEach((r) => {
    waitlistPositionByStudentId[r.student_id] = r.waitlist_position;
  });

  const allowedGrades = ageGroupList(cls.age_group);
  const allowedAges = ageGroupList(cls.numeric_ages);
  // restriction is the CLASS's own lock-by-section setting (eligibility -
  // can this child register for this class at all), separate from and
  // unaffected by the per-child registration-window check right below it.
  const restriction = await classSectionIds(classId);
  const classScheduleIds = await classScheduleIdsForClass(cls);
  const eligibleChildren = [];
  // A real request: "individual or multiple sections for members" - a
  // registration window's own Section scoping now asks which Section(s)
  // the CHILD actually being registered belongs to, so this has to be
  // computed per child (two siblings can be in different Sections) rather
  // than once for the whole class view the way it used to be. Computed
  // for every child that ends up in eligibleChildren, including an
  // already-registered one - registerControl() below renders a HIDDEN
  // fallback for them too (swapped visible by public/js/parent-class-
  // register-withdraw.js right after a successful Withdraw), which needs
  // this same answer ready at render time, not just a not-yet-registered
  // child's own real Register button.
  const windowOpenByChild = {};
  for (const child of children) {
    const isCurrentlyRegistered = enrolledIds.has(child.id) || waitlistPositionByStudentId[child.id] != null;
    if (!isCurrentlyRegistered) {
      if (cls.lock_by_grade && allowedGrades.length && !allowedGrades.includes(child.grade_level)) continue;
      if (cls.lock_by_age && allowedAges.length && !allowedAges.includes(String(ageFromBirthday(child.birthday)))) continue;
    }
    const childSectionIds = await sectionIdsForMember(child.id);
    if (!isCurrentlyRegistered && restriction.length && !memberSatisfiesRestriction(childSectionIds, restriction)) continue;
    eligibleChildren.push(child);
    windowOpenByChild[child.id] = await isRegistrationOpenForAccount(req.portalRoles, { classScheduleIds, sectionIds: [...childSectionIds], actionType: 'parent_register_student' });
  }

  const enrolledCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM class_enrollments WHERE class_id = ?').get(classId)).c);
  const staff = cls.staff || [];
  const teacherCount = staff.filter((s) => s.role === 'teacher').length;
  const assistantCount = staff.filter((s) => s.role === 'assistant').length;
  // A real request: the class card should show how many students/
  // assistants can sign up and how many of each already have, plus the
  // class's own waitlist total - not just "Full"/"X seats left" for
  // students alone, and not scoped to the signed-in family the way
  // waitlistPositionByStudentId below already is.
  const waitlistCount = Number((await db.prepare("SELECT COUNT(*) AS c FROM class_registrations WHERE class_id = ? AND status = 'waitlisted'").get(classId)).c);

  // A real request: a parent looking at a class that still needs a
  // teacher/assistant should be able to register a FAMILY MEMBER for it
  // right here, not need a separate 'teacher' portal role - see POST
  // /classes/:id/join below and utils/classRegistration.js's own
  // joinClassAsStaff. This is now the ONLY self-signup path - a follow-up
  // request ("they should be able to signup under parent portal not
  // teacher portal. Teacher portal should not have that feature at
  // all") removed Teacher Portal's own former "Sign Up to Teach" page
  // and its /browse-classes, /classes/:id/join, /classes/:id/leave
  // routes outright, rather than keeping both.
  // A later real request: "it should list all parent names in that
  // family and any students 15 years old or older as eligible to
  // register for teacher or class assistant positions" - this used to be
  // a single implicit member (the signed-in account's own row); now it's
  // every staffEligibleFamilyMembers() result, each with their own
  // current role (if already staffed) and their own per-person window
  // check, same per-person pattern windowOpenByChild above already uses
  // for the children section instead of one window shared by everyone.
  const staffEligibleMembers = await staffEligibleFamilyMembers(req.portalAccount);
  const staffRoleByMemberId = {};
  staff.forEach((s) => {
    staffRoleByMemberId[s.id] = s.role;
  });
  const staffMembers = [];
  for (const person of staffEligibleMembers) {
    const personSectionIds = [...(await sectionIdsForMember(person.id))];
    staffMembers.push({
      id: person.id,
      name: person.name,
      role: staffRoleByMemberId[person.id] || null,
      teacherWindowOpen: await isRegistrationOpenForAccount(req.portalRoles, { classScheduleIds, sectionIds: personSectionIds, actionType: 'parent_teacher' }),
      assistantWindowOpen: await isRegistrationOpenForAccount(req.portalRoles, { classScheduleIds, sectionIds: personSectionIds, actionType: 'parent_assistant' }),
    });
  }

  res.render('parent-class-fragment', {
    cls,
    classImageUrl: classImageUrl(cls.image_key),
    day: req.query.day || cls.day,
    dayLabels: CLASS_DAY_LABELS_FULL,
    gradeLabel: formatGradeRange(cls.age_group),
    teacherNames: staff.filter((s) => s.role === 'teacher').map((s) => s.name),
    assistantNames: staff.filter((s) => s.role === 'assistant').map((s) => s.name),
    enrolledCount,
    teacherCount,
    assistantCount,
    waitlistCount,
    seatsLeft: cls.capacity == null ? null : Math.max(0, cls.capacity - enrolledCount),
    isFull: cls.capacity != null && enrolledCount >= cls.capacity,
    children: eligibleChildren,
    hasChildren: children.length > 0,
    enrolledIds: [...enrolledIds],
    waitlistPositionByStudentId,
    windowOpenByChild,
    staffMembers,
  });
});

router.post('/classes/:id/join', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const role = req.body.role === 'assistant' ? 'assistant' : 'teacher';
  const back = classesBackUrl(req.body.day);
  // A real request opened this up from "always the signed-in account's
  // own member" to any eligible family member - memberId is request-
  // supplied now, so it MUST be checked against staffEligibleFamilyMembers
  // (never trusted outright) the same way /classes/:id/register already
  // re-derives childrenForAccount instead of trusting a studentId alone.
  const eligible = await staffEligibleFamilyMembers(req.portalAccount);
  const member = eligible.find((m) => m.id === parseInt(req.body.memberId, 10));
  if (!member) return res.redirect(back + 'error=' + encodeURIComponent('You can only register eligible members of your own family.'));
  const result = await joinClassAsStaff({ classId, member, accountId: req.portalAccount.id, portalRoles: req.portalRoles, role });
  if (!result.ok) return res.redirect(back + 'error=' + encodeURIComponent(result.error));
  res.redirect(back + 'notice=' + encodeURIComponent(result.notice));
});

router.post('/classes/:id/leave', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const back = classesBackUrl(req.body.day);
  const eligible = await staffEligibleFamilyMembers(req.portalAccount);
  const member = eligible.find((m) => m.id === parseInt(req.body.memberId, 10));
  if (!member) return res.redirect(back + 'error=' + encodeURIComponent('You can only manage eligible members of your own family.'));
  const result = await leaveClassAsStaff({ classId, member, accountId: req.portalAccount.id });
  if (!result.ok) return res.redirect(back + 'error=' + encodeURIComponent(result.error));
  res.redirect(back + 'notice=' + encodeURIComponent(result.notice));
});

router.post('/classes/:id/register', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const studentId = parseInt(req.body.studentId, 10);
  const back = classesBackUrl(req.body.day);

  const children = await childrenForAccount(req.portalAccount);
  if (!children.some((c) => c.id === studentId)) {
    return res.redirect(back + 'error=' + encodeURIComponent('You can only register your own children.'));
  }

  const result = await registerForClass({
    classId,
    studentId,
    accountId: req.portalAccount.id,
    portalRoles: req.portalRoles,
    registrantType: 'parent',
  });
  if (!result.ok) return res.redirect(back + 'error=' + encodeURIComponent(result.error));
  res.redirect(back + 'notice=' + encodeURIComponent(result.notice));
});

// A fetch() caller (public/js/classroom-dashboard-withdraw.js's instant-
// delete Delete button) gets JSON back instead of a redirect, so
// withdrawing from a class on the Classroom Dashboard never navigates the
// page - same isFetch convention routes/main-admin-members.js and
// routes/admin-members.js already use for their own no-reload row
// actions.
function isFetch(req) {
  return req.get('X-Requested-With') === 'fetch';
}

router.post('/classes/:id/unregister', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const studentId = parseInt(req.body.studentId, 10);
  const back = classesBackUrl(req.body.day);

  const children = await childrenForAccount(req.portalAccount);
  if (!children.some((c) => c.id === studentId)) {
    const message = 'You can only manage registrations for your own children.';
    if (isFetch(req)) return res.status(403).json({ error: message });
    return res.redirect(back + 'error=' + encodeURIComponent(message));
  }

  const result = await unregisterFromClass({ classId, studentId, accountId: req.portalAccount.id });
  if (!result.ok) {
    if (isFetch(req)) return res.status(400).json({ error: result.error });
    return res.redirect(back + 'error=' + encodeURIComponent(result.error));
  }
  if (isFetch(req)) return res.json({ ok: true });
  res.redirect(back + 'notice=' + encodeURIComponent('Registration cancelled.'));
});

// A real request: "Registration is added to event registration log on
// parent and student portals" - the family-wide equivalent of the
// Classroom Dashboard's own per-class enrollment view, but for event
// registrations (utils/events.js's own eventRegistrationsForMembers),
// reachable as a subpage of the existing Events nav link (views/
// partials/portal-nav.ejs's PARENT_NAV_LINKS).
router.get('/events', async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  const registrations = await events.eventRegistrationsForMembers(family.map((m) => m.id));
  const groups = family
    .map((m) => ({
      member: m,
      items: registrations.filter((r) => r.member_id === m.id).map((r) => ({ ...r, startsLabel: formatFriendlyTimestamp(r.starts_at) })),
    }))
    .filter((g) => g.items.length > 0);
  res.render('parent-event-registrations', {
    title: 'My Event Registrations',
    hasChildren: family.length > 0,
    groups,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// Every class one specific child is actually enrolled in (not waitlisted
// - there's nothing to show a "classroom" for until a seat is
// confirmed), re-derived from class_enrollments the same never-trust-a-
// passed-id way childrenForAccount already is. Mirrors routes/student-
// portal.js's own classesForStudent, just keyed off a family member the
// signed-in parent picked rather than the signed-in student themselves.
async function classesForChild(childId) {
  const enrolledRows = await db.prepare('SELECT class_id FROM class_enrollments WHERE student_id = ?').all(childId);
  const classIds = new Set(enrolledRows.map((r) => r.class_id));
  if (classIds.size === 0) return [];
  const all = await allClassesList(null);
  return all.filter((c) => classIds.has(c.id));
}

// Every class one specific parent is staffing (teacher or assistant role)
// - the parent-facing twin of classesForChild above, same class_staff
// table Teacher Portal's own classesForTeacher (routes/teacher-portal.js)
// already reads.
async function classesStaffedByMember(memberId) {
  const staffRows = await db.prepare('SELECT class_id FROM class_staff WHERE member_id = ?').all(memberId);
  const classIds = new Set(staffRows.map((r) => r.class_id));
  if (classIds.size === 0) return [];
  const all = await allClassesList(null);
  return all.filter((c) => classIds.has(c.id));
}

// A real request: "Add subpage class dashboard... Its already created on
// admin portal i think. Find all those features. They should look like
// real online classes. Parent portal there is a dropdown menu at the top
// of classroom dashboard with each family member to choose view.
// Classroom dashboard homepage for each member shows class cards. Monday
// 1st row, Wednesday 2nd row. Click ok the card and you go to all the
// class information." The "already created" feature is Student Portal's
// own /student/classes/:id (routes/student-portal.js) - this landing page
// is the new piece: a family-member picker over the same per-day class
// grouping, with each card linking into the shared read-only class detail
// route below.
router.get('/classes/dashboard', async (req, res) => {
  const children = await childrenForAccount(req.portalAccount);
  const parents = await parentsForAccount(req.portalAccount);

  // `viewer` is the new unified picker value ("student-<id>"/"parent-<id>")
  // a real request added: "Classroom dashboard on parent portal should
  // have Parent names in drop down menu to show what classes the parent
  // is teaching or assisting in" - the dashboard's original request ("a
  // dropdown menu... with each family member to choose view") already
  // called for every family member, but only students ever got wired up.
  // `studentId` alone still works unqualified - the one other page that
  // links here (views/parent-class-dashboard-detail.ejs's own back link)
  // still uses it, and that page only ever shows a child's own view.
  const viewerMatch = /^(student|parent)-(\d+)$/.exec(req.query.viewer || '');
  let viewerKind = viewerMatch ? viewerMatch[1] : 'student';
  const viewerId = viewerMatch ? parseInt(viewerMatch[2], 10) : parseInt(req.query.studentId, 10);

  let selectedChild = viewerKind === 'student' ? children.find((c) => c.id === viewerId) || null : null;
  let selectedParent = viewerKind === 'parent' ? parents.find((p) => p.id === viewerId) || null : null;
  if (!selectedChild && !selectedParent) {
    selectedChild = children[0] || null;
    selectedParent = selectedChild ? null : parents[0] || null;
    viewerKind = selectedChild ? 'student' : 'parent';
  }

  const classes = selectedChild
    ? await classesForChild(selectedChild.id)
    : selectedParent
      ? await classesStaffedByMember(selectedParent.id)
      : [];

  // A real request: "classes should be categorized as Monday or
  // Wednesday and in time order" - allClassesList's own default order is
  // alphabetical by class name (used elsewhere for a plain lookup list),
  // so each day's own cards are re-sorted by hour_position (the class's
  // actual time slot) here instead. Grouped by whichever days this
  // person's own classes actually fall on (not just the currently-active
  // Day Settings days), sorted calendar-order, so a class on a since-
  // deactivated day doesn't just vanish from someone already enrolled.
  const byHourPosition = (a, b) => a.hour_position - b.hour_position;
  const byDay = {};
  classes.forEach((c) => {
    (byDay[c.day] = byDay[c.day] || []).push(c);
  });
  const days = Object.keys(byDay).sort((a, b) => CLASS_DAY_ORDER[a] - CLASS_DAY_ORDER[b]);
  days.forEach((d) => byDay[d].sort(byHourPosition));

  res.render('parent-class-dashboard', {
    title: 'Class Dashboard',
    children,
    parents,
    selectedChild,
    selectedParent,
    viewerKind,
    days,
    dayLabels: CLASS_DAY_LABELS_FULL,
    byDay,
  });
});

// A real request: "Remove assignment tab from classroom dashboard" -
// Grades (its own tab, kept) already covers the one thing that mattered
// about a scored assignment; this was the un-scored duplicate list.
const CLASS_DASHBOARD_TABS = ['details', 'grades', 'lessons', 'attendance', 'chat'];
// A real bug report: "it won't let me click on class lessons under
// classroom dashboard" - traced to views/partials/class-dash-card.ejs:
// a parent's own TEACHING/ASSISTING card (picked via the "Parents"
// option in the dashboard's viewer dropdown, not a child) rendered with
// no link at all - its own comment said so outright ("has nowhere to
// click through to at all yet... that detail route is student-
// enrollment-only"). assignments/grades/attendance are per-STUDENT
// academic records that make no sense for a teacher looking at their own
// class, so the staff view only ever gets these three.
const STAFF_DASHBOARD_TABS = ['details', 'lessons', 'chat'];

// One class's own read-only info page for one child - details/
// assignments/grades/lessons/attendance, the same academics data (and,
// for Attendance, the same class roster; for Lessons, the same
// lessonsForStudentView content-item view) Student Portal's own class
// detail page already shows that student, just viewed by a parent on the
// child's behalf instead of the student themselves. Lessons started out
// READ-ONLY here (quiz-taking was student-only, full stop) - a follow-up
// request made that a per-class choice instead: "allow parents to
// complete lessons for student... turned on or off for different
// classes." views/partials/lessons-view.ejs now gets canTakeQuiz: !!cls.
// allow_parent_complete_lessons, so the "Take Quiz" link (and the actual
// GET/POST /content/:id/quiz routes below) only ever appear/work for a
// class that's deliberately opted in. Only ever shows a class + child
// pairing this account's own family actually has (never trusts either id
// from the request).
// A later real request added a second mode: ?viewer=parent-<id> shows
// the SAME page for a class this account's own family member TEACHES or
// ASSISTS (never a request-supplied member id - re-derived from
// parentsForAccount the same never-trust rule as the student mode
// above), read-only and with no child/grade context since there isn't
// one. viewerQuery is the one query-string fragment (studentId=X or
// viewer=parent-X) every link on the rendered page reuses, so the
// template never has to branch on which mode it's in just to build a URL.
router.get('/classes/dashboard/:id', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const staffViewerMatch = /^parent-(\d+)$/.exec(req.query.viewer || '');

  if (staffViewerMatch) {
    const parents = await parentsForAccount(req.portalAccount);
    const selectedParent = parents.find((p) => p.id === parseInt(staffViewerMatch[1], 10));
    if (!selectedParent) return res.status(404).render('404', { title: 'Not Found' });

    const staffedClasses = await classesStaffedByMember(selectedParent.id);
    const cls = staffedClasses.find((c) => c.id === classId);
    if (!cls) return res.status(404).render('404', { title: 'Not Found' });

    let tab = STAFF_DASHBOARD_TABS.includes(req.query.tab) ? req.query.tab : 'details';
    if (tab === 'chat' && !cls.allow_parent_chat) tab = 'details';
    const lessons = tab === 'lessons' ? await lessonsForStudentView(classId, null) : [];
    const chatMessages =
      tab === 'chat'
        ? (await db.prepare('SELECT * FROM class_chat_messages WHERE class_id = ? ORDER BY id ASC').all(classId)).map((m) => ({
            ...m,
            createdAtLabel: formatFriendlyTimestamp(m.created_at),
          }))
        : [];

    return res.render('parent-class-dashboard-detail', {
      title: cls.class_name,
      cls,
      selectedChild: null,
      selectedParent,
      viewerQuery: `viewer=parent-${selectedParent.id}`,
      tab,
      assignments: [],
      lessons,
      attendance: [],
      chatMessages,
    });
  }

  const children = await childrenForAccount(req.portalAccount);
  const selectedId = parseInt(req.query.studentId, 10);
  const selectedChild = children.find((c) => c.id === selectedId) || children[0] || null;
  if (!selectedChild) return res.status(404).render('404', { title: 'Not Found' });

  const classes = await classesForChild(selectedChild.id);
  const cls = classes.find((c) => c.id === classId);
  if (!cls) return res.status(404).render('404', { title: 'Not Found' });

  let tab = CLASS_DASHBOARD_TABS.includes(req.query.tab) ? req.query.tab : 'details';
  if (tab === 'chat' && !cls.allow_parent_chat) tab = 'details';
  const assignments = tab === 'grades' ? await assignmentsForStudentInClass(selectedChild.id, classId) : [];
  const lessons = tab === 'lessons' ? await lessonsForStudentView(classId, selectedChild.id) : [];
  const attendance = tab === 'attendance' ? await attendanceHistoryForRoster(selectedChild.id, cls.roster_id) : [];
  const chatMessages =
    tab === 'chat'
      ? (await db.prepare('SELECT * FROM class_chat_messages WHERE class_id = ? ORDER BY id ASC').all(classId)).map((m) => ({
          ...m,
          createdAtLabel: formatFriendlyTimestamp(m.created_at),
        }))
      : [];

  res.render('parent-class-dashboard-detail', {
    title: cls.class_name,
    cls,
    selectedChild,
    selectedParent: null,
    viewerQuery: `studentId=${selectedChild.id}`,
    tab,
    assignments,
    lessons,
    attendance,
    chatMessages,
  });
});

// A real request: "allow parent to interact in the class chat... turned
// on or off for different classes" - posts into the exact same
// class_chat_messages log Co-op Admin's own Chat tab already reads/writes
// (views/partials/class-chat.ejs, shared by both), gated by the class's
// own allow_parent_chat setting the same way the GET route above hides
// the tab entirely when it's off. Mirrors that same GET route's two
// modes (a child's enrollment, or this account's own family member's
// teaching/assisting role) for the same reason - a teacher posting in
// their own class's chat is just as real as a parent posting in their
// child's.
router.post('/classes/dashboard/:id/chat', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const staffViewerMatch = /^parent-(\d+)$/.exec(req.query.viewer || '');
  const body = (req.body.body || '').trim();

  let cls;
  let back;
  if (staffViewerMatch) {
    const parents = await parentsForAccount(req.portalAccount);
    const selectedParent = parents.find((p) => p.id === parseInt(staffViewerMatch[1], 10));
    if (!selectedParent) return res.status(404).render('404', { title: 'Not Found' });
    const staffedClasses = await classesStaffedByMember(selectedParent.id);
    cls = staffedClasses.find((c) => c.id === classId);
    back = `/parent/classes/dashboard/${classId}?tab=chat&viewer=parent-${selectedParent.id}`;
  } else {
    const children = await childrenForAccount(req.portalAccount);
    const selectedId = parseInt(req.query.studentId, 10);
    const selectedChild = children.find((c) => c.id === selectedId) || children[0] || null;
    if (!selectedChild) return res.status(404).render('404', { title: 'Not Found' });
    const classes = await classesForChild(selectedChild.id);
    cls = classes.find((c) => c.id === classId);
    back = `/parent/classes/dashboard/${classId}?tab=chat&studentId=${selectedChild.id}`;
  }
  if (!cls || !cls.allow_parent_chat) return res.status(404).render('404', { title: 'Not Found' });

  if (!body) return res.redirect(back + '&error=' + encodeURIComponent('A message is required.'));
  const member = await memberForAccount(req.portalAccount.id);
  await db.prepare('INSERT INTO class_chat_messages (class_id, author_name, body) VALUES (?, ?, ?)').run(classId, member.name, body);
  res.redirect(back);
});

// A real request: "allow parents to complete lessons for student...
// turned on or off for different classes" - the parent-side counterpart
// to routes/student-portal.js's own quiz-taking routes, submitting on
// behalf of whichever child ?studentId= names (defaulting to the first,
// same convention as the class dashboard route above). Re-derives
// everything from scratch rather than trusting the content item id alone:
// the quiz has to actually belong to a class one of this account's own
// children is enrolled in, AND that class has to have allow_parent_
// complete_lessons on - either failing gets the same 404 a nonexistent
// quiz would, so this route can't be used to probe which classes exist.
async function contentItemForParent(req, contentItemId, { requireQuiz = true } = {}) {
  const contentItem = await getContentItem(contentItemId);
  if (!contentItem) return null;
  if (requireQuiz && contentItem.type !== 'quiz') return null;
  if (!requireQuiz && contentItem.type === 'quiz') return null;
  const assignment = await db.prepare('SELECT * FROM class_assignments WHERE id = ?').get(contentItem.assignment_id);
  if (!assignment) return null;
  const children = await childrenForAccount(req.portalAccount);
  const selectedId = parseInt(req.query.studentId, 10);
  const selectedChild = children.find((c) => c.id === selectedId) || children[0] || null;
  if (!selectedChild) return null;
  const classes = await classesForChild(selectedChild.id);
  const cls = classes.find((c) => c.id === assignment.class_id);
  if (!cls || !cls.allow_parent_complete_lessons) return null;
  return { contentItem, assignment, cls, selectedChild };
}

router.get('/content/:id/quiz', async (req, res) => {
  const found = await contentItemForParent(req, parseInt(req.params.id, 10));
  if (!found) return res.status(404).render('404', { title: 'Not Found' });
  const { contentItem, assignment, cls, selectedChild } = found;
  if (assignment.open_date && assignment.open_date > todayISO()) return res.status(404).render('404', { title: 'Not Found' });
  const attempt = await getQuizAttempt(contentItem.id, selectedChild.id);
  const items = await contentItemsForAssignment(assignment.id, { includeAnswerKey: false });
  const questions = items.find((i) => i.id === contentItem.id).questions;
  res.render('parent-quiz-take', { title: contentItem.title || 'Quiz', cls, assignment, contentItem, questions, attempt: attempt || null, selectedChild });
});

router.post('/content/:id/quiz', async (req, res) => {
  const found = await contentItemForParent(req, parseInt(req.params.id, 10));
  if (!found) return res.status(404).render('404', { title: 'Not Found' });
  const { contentItem, assignment, selectedChild } = found;
  const items = await contentItemsForAssignment(assignment.id, { includeAnswerKey: false });
  const questions = items.find((i) => i.id === contentItem.id).questions;
  const answers = questions.map((q) => {
    if (q.type === 'multiple_choice') return { questionId: q.id, choiceId: req.body[`choice_${q.id}`] ? parseInt(req.body[`choice_${q.id}`], 10) : null };
    return { questionId: q.id, answerText: req.body[`answer_${q.id}`] || '' };
  });
  await submitQuizAttempt({ contentItemId: contentItem.id, studentId: selectedChild.id, answers });
  res.redirect(`/parent/classes/dashboard/${assignment.class_id}?tab=lessons&studentId=${selectedChild.id}&notice=` + encodeURIComponent('Quiz submitted.'));
});

// "Mark Complete" for a video/text/file/assignment_upload content item -
// the parent-side counterpart to routes/student-portal.js's own
// /content/:id/complete, same allow_parent_complete_lessons gate the
// quiz routes above already use.
router.post('/content/:id/complete', async (req, res) => {
  const found = await contentItemForParent(req, parseInt(req.params.id, 10), { requireQuiz: false });
  if (!found) return res.status(404).render('404', { title: 'Not Found' });
  const { contentItem, assignment, selectedChild } = found;
  if (assignment.open_date && assignment.open_date > todayISO()) return res.status(404).render('404', { title: 'Not Found' });
  await markLessonItemComplete(contentItem.id, selectedChild.id);
  res.redirect(`/parent/classes/dashboard/${assignment.class_id}?tab=lessons&studentId=${selectedChild.id}`);
});

// A real request: "Policy Handbook" as one of the Classes tab's
// subpages - reuses the same admin-edited handbook content the pre-
// account membership application already shows (views/portal-
// register.ejs), just as a plain read-only page for an already-signed-in
// parent rather than the scroll-to-agree checkbox flow that page needs.
router.get('/handbook', async (req, res) => {
  res.render('parent-handbook', { title: 'Policy Handbook', handbookHtml: await getHandbookHtml() });
});

// Library - a real request: "Page should show a list of all the library
// items broken down into categories. Filter button to filter the
// category. Button that says my library log... Library search bar."
// Reuses the EXISTING library_items/library_checkouts tables the Co-op
// Admin Portal's own scan-based Library tools already write to - this is
// a read-only catalog browse (checkout itself stays a barcode-scan-only
// action, same as everywhere else in the app), not a second checkout
// system.
router.get('/library', async (req, res) => {
  const typeFilter = (req.query.type || '').trim();
  const q = (req.query.q || '').trim().toLowerCase();
  const types = await allLibraryTypes();
  let items = await allLibraryItems(typeFilter || undefined);
  if (q) items = items.filter((i) => i.title.toLowerCase().includes(q));

  const itemsByType = {};
  for (const item of items) {
    const key = item.type || 'Uncategorized';
    if (!itemsByType[key]) itemsByType[key] = [];
    itemsByType[key].push(item);
  }
  const categories = Object.keys(itemsByType).sort((a, b) => a.localeCompare(b));

  res.render('parent-library', { title: 'Library', types, typeFilter, q, categories, itemsByType });
});

// My Library Log - what this family currently has checked out (and when
// it's due), plus their history of past checkouts/returns. This is the
// exact page the bare /library route used to render before it became the
// catalog browse above.
router.get('/library/log', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const family = member ? [member, ...(await familyOf(member.id))] : [];
  const memberIds = family.map((m) => m.id);
  const { active, recentReturns } = await libraryActivityForMemberIds(memberIds);
  res.render('parent-library-log', { title: 'My Library Log', active, recentReturns });
});

// Training - a real request: "training should be a tab on their dashboard
// panel after chat tab." The existing Training module (routes/training.js)
// has its own, entirely separate "pick your name from a public link"
// trust model (req.session.trainingMemberId) for members with no portal
// account at all - not the portalAccount/portalRoles model this whole
// file uses. Rather than duplicate its lesson player/quiz-taking/video-
// progress code, this bridges the two: a signed-in parent's own member id
// (already re-derived server-side, never trusted from the request, same
// as everywhere else here) is written into that SAME session key, so the
// existing /training/:id/play etc. routes work for them exactly as they
// already do for anyone else - only this list page itself needed its own
// portal-nav-shelled view instead of training-mine.ejs's public/kiosk one.
router.get('/training', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.render('parent-training', { title: 'Training', assignments: [] });
  req.session.trainingMemberId = member.id;
  res.render('parent-training', { title: 'Training', assignments: await trainingModule.myAssignments(member.id) });
});

// Resources - a real request added this as a standing Parent Portal nav
// tab ("Parent portal is not divided into sections. Tabs are in this
// order... resources..."). Read-only, reuses the exact same role-scoped
// utils/resourceLinks.js list Student Portal already reads (routes/
// student-portal.js's own /resources) - just for the 'parent' role.
router.get('/resources', async (req, res) => {
  const links = await resourceLinks.listResourceLinksForRole('parent');
  res.render('parent-resources', {
    title: 'Resource Links',
    links,
    categories: await resourceLinks.listCategories(),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.post('/resources/submit', async (req, res) => {
  const title = (req.body.title || '').trim();
  const url = (req.body.url || '').trim();
  if (!title || !url) return res.redirect('/parent/resources?error=' + encodeURIComponent('Title and website are required.'));

  const member = await memberForAccount(req.portalAccount.id);
  await resourceLinks.submitResourceLink({
    title,
    url,
    description: (req.body.description || '').trim(),
    city: (req.body.city || '').trim(),
    state: (req.body.state || '').trim(),
    categoryId: parseInt(req.body.categoryId, 10) || null,
    submittedByMemberId: member ? member.id : null,
  });
  res.redirect('/parent/resources?notice=' + encodeURIComponent('Thanks! Your resource was submitted for admin approval.'));
});

// Documents - another new standing nav tab from that same request. Every
// document Co-op Admin manages (routes/admin-documents.js) is already
// meant to be shareable (each one has its own genuinely-public Copy Link
// - see routes/documents.js), so this is just a read-only card grid of
// the same `documents` table, no separate parent-facing storage/serving
// code - each card link goes straight to the existing public
// /documents/<token> page rather than duplicating its file-streaming.
router.get('/documents', async (req, res) => {
  const documents = await db.prepare('SELECT id, title, image_path, public_token FROM documents ORDER BY LOWER(title)').all();
  res.render('parent-documents', { title: 'Documents', documents });
});

// Academics - a real request: "sub pages should be transcripts, diplomas,
// name tags." Transcripts (this bare route - see the Classes/Class
// Registration precedent above of the bare route being the first
// subpage) is purely read-only, same as everywhere else a parent views
// (rather than acts on) their children's records; grades/assignments
// aren't part of this request and are already viewable per-class in
// Classroom Dashboard's own Lessons tab, so they're left out here.
router.get('/academics', async (req, res) => {
  const children = await childrenForAccount(req.portalAccount);
  const transcripts = [];
  for (const child of children) {
    const { current, history } = await transcriptForStudent(child.id);
    transcripts.push({ child, current, history });
  }
  res.render('parent-academics', { title: 'Academics', transcripts });
});

// Diplomas - a real request: "Diplomas allows parents to design and print
// a diploma for their students." Reuses the exact same diplomas table/
// issueDiploma upsert Main Admin's own /main-admin/academics uses (see
// utils/academics.js), just scoped to the parent's own children instead
// of gated behind manage_academics - a parent can create/edit (never
// issue on someone else's behalf) their own child's diploma wording and
// print it, the same one-diploma-per-student row either side writes to.
router.get('/academics/diplomas', async (req, res) => {
  const children = await childrenForAccount(req.portalAccount);
  const diplomas = [];
  for (const child of children) {
    const diploma = await diplomaForStudent(child.id);
    diplomas.push({ child, diploma });
  }
  res.render('parent-academics-diplomas', { title: 'Diplomas', diplomas, todayISO: todayISO() });
});

router.post('/academics/diplomas', async (req, res) => {
  const children = await childrenForAccount(req.portalAccount);
  const studentId = parseInt(req.body.studentId, 10);
  if (!children.some((c) => c.id === studentId)) {
    return res.redirect('/parent/academics/diplomas?error=' + encodeURIComponent('Select one of your own children.'));
  }
  const title = (req.body.title || '').trim() || 'Diploma of Completion';
  const issuedDate = req.body.issuedDate || todayISO();
  await issueDiploma({ studentId, title, issuedDate, bodyText: req.body.bodyText, issuedByAccountId: req.portalAccount.id });
  res.redirect('/parent/academics/diplomas?notice=' + encodeURIComponent('Diploma saved.'));
});

router.get('/academics/diplomas/:studentId/print', async (req, res) => {
  const children = await childrenForAccount(req.portalAccount);
  const child = children.find((c) => c.id === parseInt(req.params.studentId, 10));
  if (!child) return res.status(404).render('404', { title: 'Not Found' });
  const diploma = await diplomaForStudent(child.id);
  if (!diploma) return res.redirect('/parent/academics/diplomas?error=' + encodeURIComponent('Design a diploma for this child first.'));
  res.render('parent-academics-diploma-print', { title: 'Diploma', member: child, diploma });
});

// Name Tags - a real request: parents should be able to print name tags
// for themselves/their own family, without the design or bulk-print-
// everyone capability (those stay Main Admin/Co-op Admin only - see
// routes/main-admin-name-tags.js's own comment on why the underlying
// template data is shared across all three). Scoped to familyForAccount
// (self + every other active member sharing this account's family_id),
// enforced server-side the same way every other parent-portal route
// re-derives its own family list rather than trusting a posted id.
router.get('/name-tags', async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  res.render('parent-name-tags', { title: 'Name Tags', family, error: req.query.error || null });
});

router.post('/name-tags/print', async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  const familyIds = new Set(family.map((m) => m.id));
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter((id) => familyIds.has(id));
  if (memberIds.length === 0) {
    return res.redirect('/parent/name-tags?error=' + encodeURIComponent('Select at least one family member to print.'));
  }

  const members = family.filter((m) => memberIds.includes(m.id));

  // A real request: "Name tags allows them to print their name tag with
  // or without their schedule on the back." Reuses Main Admin's own
  // exact front/back duplex sheet (buildCardPairs/buildDuplexPages, same
  // as its own /print-duplex route) rather than inventing a second,
  // simpler schedule-back layout - it's already portal-agnostic (no nav)
  // and this is the same badge+schedule-card data every print flow here
  // already shares.
  if (req.body.includeSchedule) {
    const { frontPages, backPages } = buildDuplexPages(await buildCardPairs(members));
    return res.render('main-admin-cards-duplex-print', {
      title: 'Print Name Tags + Schedule Cards (Front & Back)',
      frontPages,
      backPages,
      badgeWidth: BADGE_WIDTH,
      badgeHeight: BADGE_HEIGHT,
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_HEIGHT,
      SCHEDULE_CARD_SAFE_INSET,
    });
  }

  const templates = { student: await getTemplate('student'), parent: await getTemplate('parent'), admin: await getTemplate('admin') };
  const dataByMember = await badgeDataForMembers(members);
  const badges = members.map((m) => {
    const layout = templates[m.member_type] || templates.student;
    return {
      html: NameTagRenderCore.renderBadgeElements(layout.elements, dataByMember[m.id]),
      bgCss: NameTagRenderCore.backgroundCss(layout.background, layout.backgroundOpacity),
    };
  });

  // Reuses the exact same print template Main Admin's own bulk print
  // renders (views/main-admin-name-tag-bulk-print.ejs) - it's already
  // portal-agnostic (no nav, just the badge sheet + Print button), so a
  // third near-identical copy here would only add drift risk for zero
  // real difference.
  res.render('main-admin-name-tag-bulk-print', {
    title: 'Print Name Tags',
    badges,
    badgeWidth: BADGE_WIDTH,
    badgeHeight: BADGE_HEIGHT,
  });
});

// Babysitter Directory - a real request: "should not show list of
// members students, just a directory of babysitters, button at the top
// of the page that says add/edit babysitters. Button is clicked and form
// pops up. Name selection is a drop down menu showing the parents
// students names only." One combined dialog (not one accordion form per
// child) whose Student dropdown is scoped to childrenForAccount - the
// same "never trust a member id from the request" rule this whole file
// already follows for class registration - with each child's own
// existing profile fields embedded as JSON (profileDataJson) so
// public/js/parent-babysitter-form.js can repopulate the form's fields
// on selection change without a page reload.
router.get('/babysitters', async (req, res) => {
  const children = await childrenForAccount(req.portalAccount);
  const profileByChildId = {};
  for (const child of children) profileByChildId[child.id] = await babysitters.profileForMember(child.id);
  const directory = await babysitters.listApprovedProfiles();
  res.render('parent-babysitters', {
    title: 'Babysitter Directory',
    children,
    profileByChildId,
    profileDataJson: jsonScriptSafe(profileByChildId),
    directory,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/babysitters/:memberId', uploadBabysitterPhoto.single('photo'), async (req, res) => {
  const memberId = parseInt(req.params.memberId, 10);
  const children = await childrenForAccount(req.portalAccount);
  if (!children.some((c) => c.id === memberId)) {
    return res.redirect('/parent/babysitters?error=' + encodeURIComponent('You can only manage a babysitter profile for your own children.'));
  }

  let photoKey = null;
  if (req.file) {
    if (babysitterStorageClient) {
      photoKey = await uploadFile(babysitterStorageClient, BABYSITTER_PHOTOS_BUCKET, req.file.buffer, req.file.originalname, req.file.mimetype);
    } else {
      photoKey = generateKey(req.file.originalname);
      fs.writeFileSync(path.join(BABYSITTER_PHOTOS_DIR, photoKey), req.file.buffer);
    }
  }

  await babysitters.submitProfile(
    memberId,
    {
      ageGrade: (req.body.ageGrade || '').trim(),
      availability: (req.body.availability || '').trim(),
      experience: (req.body.experience || '').trim(),
      certifications: (req.body.certifications || '').trim(),
      hourlyRate: (req.body.hourlyRate || '').trim(),
      contactMethod: (req.body.contactMethod || '').trim(),
      photoKey,
    },
    req.portalAccount.id
  );
  res.redirect('/parent/babysitters?notice=' + encodeURIComponent('Submitted for Main Admin review.'));
});

// Reading Challenge - a real request: "mimic the same reading challenge
// tabs and pages for parent portal. their reading challenge will work
// across all a parents" - a SEPARATE reading challenge among parents
// themselves (not a view into their children's reading), reusing
// utils/reading.js exactly the way Student Portal's own /student/reading
// does, just keyed off the signed-in parent's own member row instead of
// a student's. leaderboard()'s memberType param scopes ranking to
// 'parent' members only, so parents compete with parents.
router.get('/reading', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const dashboard = member ? await reading.dashboardForMember(member.id) : null;
  res.render('parent-reading', {
    title: 'Reading Challenge',
    dashboard,
    reading,
    today: new Date().toISOString().slice(0, 10),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.get('/achievements', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const dashboard = member ? await reading.dashboardForMember(member.id) : null;
  res.render('parent-achievements', { title: 'Achievements', dashboard });
});

router.get('/leaderboard', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const readingLeaders = await reading.leaderboard(5, 'parent');
  res.render('parent-leaderboard', {
    title: 'Leaderboard',
    readingLeaders,
    memberId: member ? member.id : null,
  });
});

// A real request: "log reading time should include minutes, not just
// hours" (and the same for the goal below) - reading.addLog/setWeeklyGoal
// both still just take one decimal hours number (shared with Student
// Portal's identical reading challenge, unaffected by this Parent-Portal-
// only request), so the two fields are combined into that one decimal
// right here rather than changing either function's own signature.
router.post('/reading/log', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/parent/reading?error=' + encodeURIComponent('No parent profile found for your account.'));
  const hours = (Number(req.body.hours) || 0) + (Number(req.body.minutes) || 0) / 60;
  const result = await reading.addLog(member.id, {
    bookTitle: req.body.book_title,
    hours,
    notes: req.body.notes,
    logDate: req.body.log_date,
  });
  if (!result.ok) return res.redirect('/parent/reading?error=' + encodeURIComponent(result.error));
  res.redirect('/parent/reading?notice=' + encodeURIComponent(`Logged! You earned ${result.points} points.`));
});

router.post('/reading/goal', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/parent/reading?error=' + encodeURIComponent('No parent profile found for your account.'));
  const hours = (Number(req.body.weekly_goal_hours) || 0) + (Number(req.body.weekly_goal_minutes) || 0) / 60;
  const result = await reading.setWeeklyGoal(member.id, hours);
  if (!result.ok) return res.redirect('/parent/reading?error=' + encodeURIComponent(result.error));
  res.redirect('/parent/reading?notice=' + encodeURIComponent(`Weekly goal updated to ${result.hours} hours.`));
});

module.exports = router;
