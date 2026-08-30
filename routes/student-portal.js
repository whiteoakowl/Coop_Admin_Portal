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
const pets = require('../utils/pets');
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
  res.render('student-resources', {
    title: 'Resource Links',
    links,
    categories: await resourceLinks.listCategories(),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

// A real request: "members can submit resource links for approval."
// Always lands as status 'pending' (resourceLinks.submitResourceLink) -
// it shows up nowhere on any member's own list until a Main Admin
// approves it from the Resource Links > Approvals tab.
router.post('/resources/submit', async (req, res) => {
  const title = (req.body.title || '').trim();
  const url = (req.body.url || '').trim();
  if (!title || !url) return res.redirect('/student/resources?error=' + encodeURIComponent('Title and website are required.'));

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
  res.redirect('/student/resources?notice=' + encodeURIComponent('Thanks! Your resource was submitted for admin approval.'));
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

// Pets - a real request: "create a personal pet activity for students.
// They can choose a pet, choose a few features and save. Then they can
// name their pet, feed it, play with it, bathe it." Own member record
// only, same scoping as every other Student Portal route (never a
// client-supplied member/pet id). No pet yet -> the chooser/customize
// screen; a saved pet -> the dashboard.
router.get('/pets', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const pet = member ? await pets.getPetForMember(member.id) : null;
  if (!pet) return res.redirect('/student/pets/customize');
  res.render('student-pets', {
    title: 'My Pet',
    pet,
    color: pets.colorForSpecies(pet.species, pet.color),
    stats: pets.careStats(pet),
    levelInfo: pets.levelInfo(pet.xp),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.get('/pets/customize', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const existing = member ? await pets.getPetForMember(member.id) : null;
  const appearance = existing || pets.defaultAppearance();
  res.render('student-pets-customize', {
    title: existing ? 'Edit Pet' : 'Choose Your Pet',
    isNew: !existing,
    appearance,
    petName: existing ? existing.name : '',
    speciesList: pets.SPECIES,
    eyesList: pets.EYES,
    mouthsList: pets.MOUTHS,
    accessoriesList: pets.ACCESSORIES,
  });
});

router.post('/pets/customize', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/student/pets/customize?error=' + encodeURIComponent('No student profile found for your account.'));
  await pets.savePet(member.id, {
    name: req.body.name,
    species: req.body.species,
    color: req.body.color,
    eyes: req.body.eyes,
    mouth: req.body.mouth,
    accessory: req.body.accessory,
  });
  res.redirect('/student/pets?notice=' + encodeURIComponent('Pet saved!'));
});

router.post('/pets/name', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/student/pets?error=' + encodeURIComponent('No student profile found for your account.'));
  await pets.renamePet(member.id, req.body.name);
  res.redirect('/student/pets?notice=' + encodeURIComponent('Name updated.'));
});

async function careAction(kind, notice, req, res) {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/student/pets?error=' + encodeURIComponent('No student profile found for your account.'));
  const result = await pets.performCareAction(member.id, kind);
  if (!result.ok) return res.redirect('/student/pets?error=' + encodeURIComponent(result.error));
  res.redirect('/student/pets?notice=' + encodeURIComponent(notice));
}

router.post('/pets/feed', (req, res) => careAction('feed', 'Yum! Your pet is happily fed.', req, res));
router.post('/pets/play', (req, res) => careAction('play', 'You played with your pet!', req, res));
router.post('/pets/bathe', (req, res) => careAction('bathe', 'Squeaky clean!', req, res));

module.exports = router;
