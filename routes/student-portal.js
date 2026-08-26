// Student Portal - mostly a read-only view of the signed-in student's own
// class schedule/assignments/transcript. Registration was originally a
// Parent-Portal-only action (a parent registers their children); a real
// request extended this so a student can register themselves too, but
// ONLY for a class that has its own allow_student_register turned on
// (off by default - see the class_registration_rules migration's own
// comment: "teachers and class assistants will be able to register, but
// not the students until allowed"). Shares the exact same registration
// logic Parent Portal uses (utils/classRegistration.js), just gated by
// allow_student_register instead of allow_parent_register.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requirePortalAuth, requirePortal } = require('../middleware/portalAuth');
const { memberForAccount } = require('../utils/portalAuth');
const { allClassesList } = require('../utils/classSchedule');
const { formatFriendlyTimestamp, formatTimestamp } = require('../utils/dates');
const { assignmentsForStudent, diplomaForStudent, transcriptForStudent } = require('../utils/academics');
const { isRegistrationOpenForAccount, nextWindowForAccount } = require('../utils/registrationWindows');
const { sectionIdsForMember, classSectionIds, memberSatisfiesRestriction } = require('../utils/sections');
const { registerForClass, unregisterFromClass } = require('../utils/classRegistration');
const notifications = require('../utils/notifications');
const resourceLinks = require('../utils/resourceLinks');
const babysitters = require('../utils/babysitters');
const { imageFileFilter } = require('../utils/uploads');
const { createStorageClient, uploadFile, generateKey } = require('../utils/storage');
const { getTemplate, badgeDataForMembers } = require('../utils/nameTagData');
const { BADGE_WIDTH, BADGE_HEIGHT } = require('../utils/nameTagBadge');
const NameTagRenderCore = require('../public/js/name-tag-render-core');

router.use(requirePortalAuth, requirePortal('student'));

const BABYSITTER_PHOTOS_BUCKET = 'private-babysitter-photos';
const BABYSITTER_PHOTOS_DIR = path.join(__dirname, '..', 'private-uploads', 'babysitter-photos');
const babysitterStorageClient = createStorageClient();
if (!babysitterStorageClient && !fs.existsSync(BABYSITTER_PHOTOS_DIR)) fs.mkdirSync(BABYSITTER_PHOTOS_DIR, { recursive: true });
const MAX_BABYSITTER_PHOTO_BYTES = 4 * 1024 * 1024;
const uploadBabysitterPhoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BABYSITTER_PHOTO_BYTES }, fileFilter: imageFileFilter });

// Every class this student is enrolled in - re-derived from
// class_enrollments on every request, the same "never trust a class id
// belongs to this account" rule Parent/Teacher Portal both follow.
async function classesForStudent(member) {
  if (!member) return [];
  const enrolledRows = await db.prepare('SELECT class_id FROM class_enrollments WHERE student_id = ?').all(member.id);
  const classIds = new Set(enrolledRows.map((r) => r.class_id));
  if (classIds.size === 0) return [];
  const all = await allClassesList(null);
  return all.filter((c) => classIds.has(c.id));
}

// Announcements on the homepage - same site-wide + per-account
// 'announcement' notification pattern Parent/Teacher Portal's own home
// routes already established (routes/parent-portal.js, routes/teacher-
// portal.js) - a personal announcement is already filtered to the right
// audience at send time (Main/Co-op Admin's own role-targeted "Send to"
// dropdown - see routes/main-admin-announcements.js/routes/admin-
// announcements.js). Replaces this route's own earlier site-only,
// LIMIT-5 query with the same richer feed Parent/Teacher Portal show.
async function announcementsForAccount(accountId) {
  const siteRows = await db
    .prepare("SELECT * FROM announcements WHERE (expires_at IS NULL OR expires_at > now_text()) ORDER BY published_at DESC LIMIT 10")
    .all();
  const personalRows = await notifications.listForAccount(accountId, { typeKey: 'announcement' });
  return [
    ...siteRows.map((a) => ({ title: a.title, body: a.body, dateLabel: formatFriendlyTimestamp(a.published_at), sortKey: a.published_at, isNew: false })),
    ...personalRows.map((n) => ({ title: n.title, body: n.body, dateLabel: formatFriendlyTimestamp(n.created_at), sortKey: n.created_at, isNew: !n.read_at })),
  ]
    .sort((a, b) => (a.sortKey < b.sortKey ? 1 : -1))
    .slice(0, 15);
}

router.get('/', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForStudent(member);
  const announcements = await announcementsForAccount(req.portalAccount.id);
  res.render('student-home', { title: 'Student Portal', member, classes, announcements });
});

router.get('/classes', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForStudent(member);
  const enrolledIds = new Set(classes.map((c) => c.id));

  // Every OTHER class with self-registration turned on - "Register for a
  // Class" only ever shows classes not already in "My Classes" above, and
  // only ones a Main/Co-op Admin has actually opened to students (most
  // classes stay parent-registers-on-your-behalf, unaffected by any of
  // this - allow_student_register defaults off).
  const openClasses = member
    ? (await allClassesList(null))
        .filter((c) => c.allow_student_register && !enrolledIds.has(c.id))
        .map((c) => ({ ...c, seatsLeft: c.capacity == null ? null : Math.max(0, c.capacity - Number(c.studentCount)), isFull: c.capacity != null && Number(c.studentCount) >= c.capacity }))
    : [];
  const eligibleClassIds = [];
  if (member) {
    const mySectionIds = await sectionIdsForMember(member.id);
    for (const c of openClasses) {
      const restriction = await classSectionIds(c.id);
      if (memberSatisfiesRestriction(mySectionIds, restriction)) eligibleClassIds.push(c.id);
    }
  }

  const waitlistRows = member
    ? await db.prepare("SELECT class_id, waitlist_position FROM class_registrations WHERE student_id = ? AND status = 'waitlisted'").all(member.id)
    : [];
  const waitlistPositionByClassId = {};
  waitlistRows.forEach((r) => {
    waitlistPositionByClassId[r.class_id] = r.waitlist_position;
  });

  const windowOpen = await isRegistrationOpenForAccount(req.portalRoles);
  const nextWindow = windowOpen ? null : await nextWindowForAccount(req.portalRoles);

  res.render('student-classes', {
    title: 'My Classes',
    classes,
    openClasses,
    eligibleClassIds,
    waitlistPositionByClassId,
    windowOpen,
    nextWindowLabel: nextWindow ? formatTimestamp(nextWindow.opens_at) : null,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/classes/:id/register', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const back = '/student/classes';
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect(back + '?error=' + encodeURIComponent('No student profile found for your account.'));

  const result = await registerForClass({
    classId,
    studentId: member.id,
    accountId: req.portalAccount.id,
    portalRoles: req.portalRoles,
    allowField: 'allow_student_register',
  });
  if (!result.ok) return res.redirect(back + '?error=' + encodeURIComponent(result.error));
  res.redirect(back + '?notice=' + encodeURIComponent(result.notice));
});

router.post('/classes/:id/unregister', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const back = '/student/classes';
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect(back + '?error=' + encodeURIComponent('No student profile found for your account.'));

  const result = await unregisterFromClass({ classId, studentId: member.id, accountId: req.portalAccount.id });
  if (!result.ok) return res.redirect(back + '?error=' + encodeURIComponent(result.error));
  res.redirect(back + '?notice=' + encodeURIComponent('Registration cancelled.'));
});

router.get('/assignments', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const classes = await classesForStudent(member);
  const assignments = member ? await assignmentsForStudent(member.id, classes.map((c) => c.id)) : [];
  res.render('student-assignments', { title: 'Assignments', assignments });
});

router.get('/transcript', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const { current, history } = member ? await transcriptForStudent(member.id) : { current: [], history: [] };
  res.render('student-transcript', { title: 'Transcript', member, current, history });
});

router.get('/diploma', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const diploma = member ? await diplomaForStudent(member.id) : null;
  res.render('student-diploma', { title: 'Diploma', member, diploma });
});

// Resource Links - a real request: Student Portal should have "resource
// links". Read-only: reuses utils/resourceLinks.js's role-scoped list
// exactly as Main/Co-op Admin curate it, no student-side editing.
router.get('/resources', async (req, res) => {
  const links = await resourceLinks.listResourceLinksForRole('student');
  res.render('student-resources', { title: 'Resource Links', links });
});

// Name Tag - a real request: Student Portal should have a "name Tag"
// tab. Scoped to the signed-in student's own member record only (not
// their whole family, unlike Parent Portal's own /parent/name-tags),
// using the exact same template/print pipeline (utils/nameTagData.js,
// views/main-admin-name-tag-bulk-print.ejs) so the printed tag matches
// whatever Main/Co-op Admin has designed.
router.get('/name-tag', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  res.render('student-name-tag', { title: 'Name Tag', member, error: req.query.error || null });
});

router.post('/name-tag/print', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/student/name-tag?error=' + encodeURIComponent('No student profile found for your account.'));

  const templates = { student: await getTemplate('student') };
  const dataByMember = await badgeDataForMembers([member]);
  const layout = templates.student;
  const badges = [
    {
      html: NameTagRenderCore.renderBadgeElements(layout.elements, dataByMember[member.id]),
      bgCss: NameTagRenderCore.backgroundCss(layout.background, layout.backgroundOpacity),
    },
  ];

  res.render('main-admin-name-tag-bulk-print', {
    title: 'Print Name Tag',
    badges,
    badgeWidth: BADGE_WIDTH,
    badgeHeight: BADGE_HEIGHT,
  });
});

// Babysitter Profile - a real request: "Students can also create their
// own baby sitter profile on the student portal, submit for approval for
// any changes or submissions." Own member record only - no picker, since
// a student portal account has exactly one member to submit for.
router.get('/babysitter', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const profile = member ? await babysitters.profileForMember(member.id) : null;
  res.render('student-babysitter', { title: 'Babysitter Profile', member, profile, error: req.query.error || null, notice: req.query.notice || null });
});

router.post('/babysitter', uploadBabysitterPhoto.single('photo'), async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/student/babysitter?error=' + encodeURIComponent('No student profile found for your account.'));

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
    member.id,
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
  res.redirect('/student/babysitter?notice=' + encodeURIComponent('Submitted for Main Admin review.'));
});

module.exports = router;
