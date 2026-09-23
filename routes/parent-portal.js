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
  DAY_LABELS,
  isValidDay,
  defaultDay,
  allClassesList,
  attendanceHistoryForRoster,
  GRADE_LEVELS,
} = require('../utils/classSchedule');
const { sendCsv, toCsvRow } = require('../utils/spreadsheet');
const { getHandbookHtml } = require('../utils/membershipHandbook');
const { getTemplate, badgeDataForMembers } = require('../utils/nameTagData');
const { BADGE_WIDTH, BADGE_HEIGHT } = require('../utils/nameTagBadge');
const NameTagRenderCore = require('../public/js/name-tag-render-core');
const { formatFriendlyTimestamp, formatTimestamp, ageFromBirthday, todayISO } = require('../utils/dates');
const { isRegistrationOpenForAccount, nextWindowForAccount } = require('../utils/registrationWindows');
const { familyOf, byLastName } = require('../utils/members');
const { libraryActivityForMemberIds } = require('../utils/library');
const resourceLinks = require('../utils/resourceLinks');
const {
  assignmentsForStudent,
  assignmentsForStudentInClass,
  diplomaForStudent,
  transcriptForStudent,
  lessonsForStudentView,
  getContentItem,
  getQuizAttempt,
  submitQuizAttempt,
  contentItemsForAssignment,
} = require('../utils/academics');
const notifications = require('../utils/notifications');
const { sectionIdsForMember, classSectionIds, memberSatisfiesRestriction } = require('../utils/sections');
const { registerForClass, unregisterFromClass } = require('../utils/classRegistration');
const events = require('../utils/events');
const babysitters = require('../utils/babysitters');
const { imageFileFilter } = require('../utils/uploads');
const { createStorageClient, uploadFile, generateKey } = require('../utils/storage');
const reading = require('../utils/reading');

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
async function parentsForAccount(account) {
  const member = await memberForAccount(account.id);
  if (!member || !member.family_id) return [];
  return (
    await db
      .prepare("SELECT * FROM members WHERE family_id = ? AND member_type = 'parent' AND active = 1")
      .all(member.family_id)
  ).sort(byLastName);
}

router.get('/', async (req, res) => {
  const children = await childrenForAccount(req.portalAccount);

  // Two real sources merged into one feed, newest first - a real
  // request: "notifications should be announcements and show up on the
  // parent portal homepage, showing current announcements and past
  // ones. main admin can send these customized notifications." Site-wide
  // announcements (the same content Main Admin > Website manages, also
  // shown to signed-out visitors on the public homepage) are one source;
  // the other is Main Admin > Announcements' own per-account
  // notifications (utils/notifications.js's notify(), type_key
  // 'announcement') - unread ones get a "New" badge (isNew below), read
  // ones just sink down the list, which is what "current ones and past
  // ones" means here rather than a hard time-based cutoff.
  const siteRows = await db
    .prepare("SELECT * FROM announcements WHERE (expires_at IS NULL OR expires_at > now_text()) ORDER BY published_at DESC LIMIT 10")
    .all();
  const personalRows = await notifications.listForAccount(req.portalAccount.id, { typeKey: 'announcement' });
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
  // reads as "Jane: 2, Sam: 1" rather than an ambiguous "3".
  const countsByStudent = childIds.length
    ? await db
        .prepare(
          `SELECT student_id, COUNT(*) AS c FROM class_registrations WHERE status = 'confirmed' AND student_id IN (${childIds.map(() => '?').join(',')}) GROUP BY student_id`
        )
        .all(...childIds)
    : [];
  const countByStudentId = new Map(countsByStudent.map((r) => [r.student_id, Number(r.c)]));
  const registrationCountsByChild = children.map((c) => ({ name: c.name, count: countByStudentId.get(c.id) || 0 }));

  res.render('parent-home', {
    title: 'Parent Portal',
    member: await memberForAccount(req.portalAccount.id),
    children,
    announcements,
    registrationCountsByChild,
  });
});

// Redirect target for the register/unregister POSTs below - back to the
// day grid the dialog was opened from, so registering/cancelling from
// inside the popup lands the parent right back where they were instead
// of resetting to Monday. A real request: "manage class button on the
// parent portal homepage should go to the manage classes page" - Manage
// Classes' own Cancel forms send returnTo=manage so an unregister from
// THAT page comes back to it instead of the day grid. Returns a URL
// already ending in `?` or `&` so a caller can always just tack
// `error=`/`notice=` straight on, regardless of whether a `day` param
// made it in.
function classesBackUrl(day, returnTo) {
  if (returnTo === 'manage') return '/parent/classes/manage?';
  return isValidDay(day) ? `/parent/classes?day=${day}&` : '/parent/classes?';
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
router.get('/classes', async (req, res) => {
  const day = isValidDay(req.query.day) ? req.query.day : defaultDay();
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

  const windowOpen = await isRegistrationOpenForAccount(req.portalRoles);
  const nextWindow = windowOpen ? null : await nextWindowForAccount(req.portalRoles);

  res.render('parent-classes', {
    title: 'Class Registration',
    day,
    dayLabel: DAY_LABELS[day],
    hours: await hoursForDay(day),
    roomGrid: await roomGridForDay(day),
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
  const restriction = await classSectionIds(classId);
  const eligibleChildren = [];
  for (const child of children) {
    if (enrolledIds.has(child.id) || waitlistPositionByStudentId[child.id] != null) {
      eligibleChildren.push(child);
      continue;
    }
    if (cls.lock_by_grade && allowedGrades.length && !allowedGrades.includes(child.grade_level)) continue;
    if (cls.lock_by_age && allowedAges.length && !allowedAges.includes(String(ageFromBirthday(child.birthday)))) continue;
    if (restriction.length && !memberSatisfiesRestriction(await sectionIdsForMember(child.id), restriction)) continue;
    eligibleChildren.push(child);
  }

  const enrolledCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM class_enrollments WHERE class_id = ?').get(classId)).c);
  const staff = cls.staff || [];
  const assistantCount = staff.filter((s) => s.role === 'assistant').length;
  // A real request: the class card should show how many students/
  // assistants can sign up and how many of each already have, plus the
  // class's own waitlist total - not just "Full"/"X seats left" for
  // students alone, and not scoped to the signed-in family the way
  // waitlistPositionByStudentId below already is.
  const waitlistCount = Number((await db.prepare("SELECT COUNT(*) AS c FROM class_registrations WHERE class_id = ? AND status = 'waitlisted'").get(classId)).c);

  res.render('parent-class-fragment', {
    cls,
    classImageUrl: classImageUrl(cls.image_key),
    day: req.query.day || cls.day,
    gradeLabel: formatGradeRange(cls.age_group),
    teacherNames: staff.filter((s) => s.role === 'teacher').map((s) => s.name),
    assistantNames: staff.filter((s) => s.role === 'assistant').map((s) => s.name),
    enrolledCount,
    assistantCount,
    waitlistCount,
    seatsLeft: cls.capacity == null ? null : Math.max(0, cls.capacity - enrolledCount),
    isFull: cls.capacity != null && enrolledCount >= cls.capacity,
    children: eligibleChildren,
    hasChildren: children.length > 0,
    enrolledIds: [...enrolledIds],
    waitlistPositionByStudentId,
    windowOpen: await isRegistrationOpenForAccount(req.portalRoles, { day: cls.day, sectionIds: restriction }),
  });
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

// A fetch() caller (public/js/parent-manage-classes.js's instant-delete
// trash button) gets JSON back instead of a redirect, so cancelling a
// class from the list view never navigates the page - same isFetch
// convention routes/main-admin-members.js and routes/admin-members.js
// already use for their own no-reload row actions.
function isFetch(req) {
  return req.get('X-Requested-With') === 'fetch';
}

router.post('/classes/:id/unregister', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const studentId = parseInt(req.body.studentId, 10);
  const back = classesBackUrl(req.body.day, req.body.returnTo);

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

const DAY_SORT_ORDER = { monday: 0, wednesday: 1 };

// Every class a child in the family is enrolled in or waitlisted for -
// shared by the list-view page below and its Print/Export toolbar buttons
// so all three always agree on exactly the same rows.
async function manageClassesEntriesForAccount(account) {
  const children = await childrenForAccount(account);
  const allClasses = await allClassesList(null);
  const classById = new Map(allClasses.map((c) => [c.id, c]));

  const entries = [];
  for (const child of children) {
    const enrolledRows = await db.prepare('SELECT class_id FROM class_enrollments WHERE student_id = ?').all(child.id);
    for (const row of enrolledRows) {
      const cls = classById.get(row.class_id);
      if (cls) entries.push({ child, cls, waitlistPosition: null });
    }
    const waitlistRows = await db.prepare("SELECT class_id, waitlist_position FROM class_registrations WHERE student_id = ? AND status = 'waitlisted'").all(child.id);
    for (const row of waitlistRows) {
      const cls = classById.get(row.class_id);
      if (cls) entries.push({ child, cls, waitlistPosition: row.waitlist_position });
    }
  }
  // A real request: "viewing class schedule for family or person student,
  // classes should be categorized as Monday or Wednesday and in time
  // order" - grouped by family member first (unchanged), then by day
  // (Monday before Wednesday), then by the class's own hour_position
  // (its actual time slot) rather than alphabetically by class name.
  entries.sort(
    (a, b) =>
      a.child.name.localeCompare(b.child.name) ||
      DAY_SORT_ORDER[a.cls.day] - DAY_SORT_ORDER[b.cls.day] ||
      a.cls.hour_position - b.cls.hour_position
  );
  return { children, entries };
}

// A real request: "when parents click on class tab it should have the
// following subpages. Class registration, Manage Classes, name tag
// request, absence/late form, Policy Handbook. That manage class button
// on the parent portal homepage should go to the manage classes page."
// Distinct from /classes above (browsing/registering for NEW classes,
// "Class Registration") - this is a read-focused view of every class a
// child is already enrolled in or waitlisted for, across the WHOLE
// family (unlike Student Portal's own single-student "My Classes"), with
// a Cancel action per row. A later real request relabeled the subpage
// itself "View/Cancel Classes" and asked for a list view (grouped by
// family member) instead of the original card grid, plus a Print/Export/
// Print Name Tag toolbar and a click-through to each class's own read-
// only Class Dashboard (see /classes/dashboard below).
router.get('/classes/manage', async (req, res) => {
  const { children, entries } = await manageClassesEntriesForAccount(req.portalAccount);
  res.render('parent-manage-classes', {
    title: 'View/Cancel Classes',
    hasChildren: children.length > 0,
    entries,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.get('/classes/manage/print', async (req, res) => {
  const { children, entries } = await manageClassesEntriesForAccount(req.portalAccount);
  res.render('parent-manage-classes-print', { title: 'View/Cancel Classes', hasChildren: children.length > 0, entries });
});

// A real request: "Registration is added to event registration log on
// parent and student portals" - the family-wide equivalent of View/Cancel
// Classes above, but for event registrations (utils/events.js's own
// eventRegistrationsForMembers), reachable as a subpage of the existing
// Events nav link (views/partials/portal-nav.ejs's PARENT_NAV_LINKS).
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

router.get('/classes/manage/export.csv', async (req, res) => {
  const { entries } = await manageClassesEntriesForAccount(req.portalAccount);
  const lines = [toCsvRow(['Family Member', 'Class', 'Day', 'Time', 'Teacher', 'Status'])];
  entries.forEach((e) => {
    lines.push(
      toCsvRow([
        e.child.name,
        e.cls.class_name,
        e.cls.dayLabel,
        e.cls.timeLabel,
        e.cls.teacherNames.join(', '),
        e.waitlistPosition != null ? `Waitlisted (#${e.waitlistPosition})` : 'Registered',
      ])
    );
  });
  sendCsv(res, 'my-classes.csv', lines);
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
  // actual time slot) here instead.
  const byHourPosition = (a, b) => a.hour_position - b.hour_position;

  res.render('parent-class-dashboard', {
    title: 'Class Dashboard',
    children,
    parents,
    selectedChild,
    selectedParent,
    viewerKind,
    mondayClasses: classes.filter((c) => c.day === 'monday').sort(byHourPosition),
    wednesdayClasses: classes.filter((c) => c.day === 'wednesday').sort(byHourPosition),
  });
});

const CLASS_DASHBOARD_TABS = ['details', 'assignments', 'grades', 'lessons', 'attendance', 'chat'];

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
router.get('/classes/dashboard/:id', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const children = await childrenForAccount(req.portalAccount);
  const selectedId = parseInt(req.query.studentId, 10);
  const selectedChild = children.find((c) => c.id === selectedId) || children[0] || null;
  if (!selectedChild) return res.status(404).render('404', { title: 'Not Found' });

  const classes = await classesForChild(selectedChild.id);
  const cls = classes.find((c) => c.id === classId);
  if (!cls) return res.status(404).render('404', { title: 'Not Found' });

  let tab = CLASS_DASHBOARD_TABS.includes(req.query.tab) ? req.query.tab : 'details';
  if (tab === 'chat' && !cls.allow_parent_chat) tab = 'details';
  const assignments = ['assignments', 'grades'].includes(tab) ? await assignmentsForStudentInClass(selectedChild.id, classId) : [];
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
    children,
    selectedChild,
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
// the tab entirely when it's off.
router.post('/classes/dashboard/:id/chat', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const children = await childrenForAccount(req.portalAccount);
  const selectedId = parseInt(req.query.studentId, 10);
  const selectedChild = children.find((c) => c.id === selectedId) || children[0] || null;
  if (!selectedChild) return res.status(404).render('404', { title: 'Not Found' });

  const classes = await classesForChild(selectedChild.id);
  const cls = classes.find((c) => c.id === classId);
  if (!cls || !cls.allow_parent_chat) return res.status(404).render('404', { title: 'Not Found' });

  const back = `/parent/classes/dashboard/${classId}?tab=chat&studentId=${selectedChild.id}`;
  const body = (req.body.body || '').trim();
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
async function contentItemForParent(req, contentItemId) {
  const contentItem = await getContentItem(contentItemId);
  if (!contentItem || contentItem.type !== 'quiz') return null;
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

// A real request: "Policy Handbook" as one of the Classes tab's
// subpages - reuses the same admin-edited handbook content the pre-
// account membership application already shows (views/portal-
// register.ejs), just as a plain read-only page for an already-signed-in
// parent rather than the scroll-to-agree checkbox flow that page needs.
router.get('/handbook', async (req, res) => {
  res.render('parent-handbook', { title: 'Policy Handbook', handbookHtml: await getHandbookHtml() });
});

// Library - read-only. Reuses the EXISTING library_items/library_checkouts
// tables the Co-op Admin Portal's own scan-based Library tools already
// write to; a parent just gets a filtered view of their own family's
// activity, not a second checkout system.
router.get('/library', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const family = member ? [member, ...(await familyOf(member.id))] : [];
  const memberIds = family.map((m) => m.id);
  const { active, recentReturns } = await libraryActivityForMemberIds(memberIds);
  res.render('parent-library', { title: 'Library', active, recentReturns });
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

// Academics - assignments/grades, transcript, and diploma status for each
// of the parent's own children in one place (utils/academics.js). Purely
// read-only, same as everywhere else a parent views (rather than acts on)
// their children's records.
router.get('/academics', async (req, res) => {
  const children = await childrenForAccount(req.portalAccount);
  const academics = [];
  for (const child of children) {
    const enrolledRows = await db.prepare('SELECT class_id FROM class_enrollments WHERE student_id = ?').all(child.id);
    const classIds = enrolledRows.map((r) => r.class_id);
    const assignments = await assignmentsForStudent(child.id, classIds);
    const { current, history } = await transcriptForStudent(child.id);
    const diploma = await diplomaForStudent(child.id);
    academics.push({ child, assignments, current, history, diploma });
  }
  res.render('parent-academics', { title: 'Academics', academics });
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

// Babysitter Directory - a real request: "It should appear on parent
// portal to view directory. Parents can view or create a profile for
// their child as well to be a babysitter." One page: the approved
// directory, plus a create/edit form per one of the parent's own
// children (childrenForAccount - the same "never trust a member id from
// the request" rule this whole file already follows for class
// registration).
router.get('/babysitters', async (req, res) => {
  const children = await childrenForAccount(req.portalAccount);
  const profileByChildId = {};
  for (const child of children) profileByChildId[child.id] = await babysitters.profileForMember(child.id);
  const directory = await babysitters.listApprovedProfiles();
  res.render('parent-babysitters', {
    title: 'Babysitter Directory',
    children,
    profileByChildId,
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

router.post('/reading/log', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/parent/reading?error=' + encodeURIComponent('No parent profile found for your account.'));
  const result = await reading.addLog(member.id, {
    bookTitle: req.body.book_title,
    hours: req.body.hours,
    notes: req.body.notes,
    logDate: req.body.log_date,
  });
  if (!result.ok) return res.redirect('/parent/reading?error=' + encodeURIComponent(result.error));
  res.redirect('/parent/reading?notice=' + encodeURIComponent(`Logged! You earned ${result.points} points.`));
});

router.post('/reading/goal', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/parent/reading?error=' + encodeURIComponent('No parent profile found for your account.'));
  const result = await reading.setWeeklyGoal(member.id, req.body.weekly_goal_hours);
  if (!result.ok) return res.redirect('/parent/reading?error=' + encodeURIComponent(result.error));
  res.redirect('/parent/reading?notice=' + encodeURIComponent(`Weekly goal updated to ${result.hours} hours.`));
});

module.exports = router;
