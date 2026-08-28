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
  DAY_LABELS,
  isValidDay,
  defaultDay,
} = require('../utils/classSchedule');
const { getTemplate, badgeDataForMembers } = require('../utils/nameTagData');
const { BADGE_WIDTH, BADGE_HEIGHT } = require('../utils/nameTagBadge');
const NameTagRenderCore = require('../public/js/name-tag-render-core');
const { formatFriendlyTimestamp, formatTimestamp } = require('../utils/dates');
const { isRegistrationOpenForAccount, nextWindowForAccount } = require('../utils/registrationWindows');
const { familyOf, byLastName } = require('../utils/members');
const { libraryActivityForMemberIds } = require('../utils/library');
const { assignmentsForStudent, diplomaForStudent, transcriptForStudent } = require('../utils/academics');
const notifications = require('../utils/notifications');
const { sectionIdsForMember, classSectionIds, memberSatisfiesRestriction } = require('../utils/sections');
const { registerForClass, unregisterFromClass } = require('../utils/classRegistration');
const babysitters = require('../utils/babysitters');
const { imageFileFilter } = require('../utils/uploads');
const { createStorageClient, uploadFile, generateKey } = require('../utils/storage');

router.use(requirePortalAuth, requirePortal('parent'));

const BABYSITTER_PHOTOS_BUCKET = 'private-babysitter-photos';
const BABYSITTER_PHOTOS_DIR = path.join(__dirname, '..', 'private-uploads', 'babysitter-photos');
const babysitterStorageClient = createStorageClient();
if (!babysitterStorageClient && !fs.existsSync(BABYSITTER_PHOTOS_DIR)) fs.mkdirSync(BABYSITTER_PHOTOS_DIR, { recursive: true });
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
  const registrationCount = childIds.length
    ? Number(
        (
          await db
            .prepare(`SELECT COUNT(*) AS c FROM class_registrations WHERE status = 'confirmed' AND student_id IN (${childIds.map(() => '?').join(',')})`)
            .get(...childIds)
        ).c
      )
    : 0;

  res.render('parent-home', {
    title: 'Parent Portal',
    member: await memberForAccount(req.portalAccount.id),
    children,
    announcements,
    registrationCount,
  });
});

// Redirect target for the register/unregister POSTs below - always back
// to the day grid the dialog was opened from, so cancelling/registering
// from inside the popup lands the parent right back where they were
// instead of resetting to Monday. Returns a URL already ending in `?` or
// `&` so a caller can always just tack `error=`/`notice=` straight on,
// regardless of whether a `day` param made it in.
function classesBackUrl(day) {
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
    title: 'Classes',
    day,
    dayLabel: DAY_LABELS[day],
    hours: await hoursForDay(day),
    roomGrid: await roomGridForDay(day),
    hasChildren: children.length > 0,
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
  const restriction = await classSectionIds(classId);
  const eligibleChildren = [];
  for (const child of children) {
    if (enrolledIds.has(child.id) || waitlistPositionByStudentId[child.id] != null) {
      eligibleChildren.push(child);
      continue;
    }
    if (allowedGrades.length && !allowedGrades.includes(child.grade_level)) continue;
    if (restriction.length && !memberSatisfiesRestriction(await sectionIdsForMember(child.id), restriction)) continue;
    eligibleChildren.push(child);
  }

  const enrolledCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM class_enrollments WHERE class_id = ?').get(classId)).c);
  const staff = cls.staff || [];

  res.render('parent-class-fragment', {
    cls,
    day: req.query.day || cls.day,
    gradeLabel: formatGradeRange(cls.age_group),
    teacherNames: staff.filter((s) => s.role === 'teacher').map((s) => s.name),
    assistantNames: staff.filter((s) => s.role === 'assistant').map((s) => s.name),
    seatsLeft: cls.capacity == null ? null : Math.max(0, cls.capacity - enrolledCount),
    isFull: cls.capacity != null && enrolledCount >= cls.capacity,
    children: eligibleChildren,
    hasChildren: children.length > 0,
    enrolledIds: [...enrolledIds],
    waitlistPositionByStudentId,
    windowOpen: await isRegistrationOpenForAccount(req.portalRoles),
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
    allowField: 'allow_parent_register',
  });
  if (!result.ok) return res.redirect(back + 'error=' + encodeURIComponent(result.error));
  res.redirect(back + 'notice=' + encodeURIComponent(result.notice));
});

router.post('/classes/:id/unregister', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const studentId = parseInt(req.body.studentId, 10);
  const back = classesBackUrl(req.body.day);

  const children = await childrenForAccount(req.portalAccount);
  if (!children.some((c) => c.id === studentId)) {
    return res.redirect(back + 'error=' + encodeURIComponent('You can only manage registrations for your own children.'));
  }

  const result = await unregisterFromClass({ classId, studentId, accountId: req.portalAccount.id });
  if (!result.ok) return res.redirect(back + 'error=' + encodeURIComponent(result.error));
  res.redirect(back + 'notice=' + encodeURIComponent('Registration cancelled.'));
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

module.exports = router;
