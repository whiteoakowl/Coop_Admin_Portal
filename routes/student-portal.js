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
const reading = require('../utils/reading');
const { GAMES, CATEGORY_LABELS, gameByKey } = require('../utils/gamesCatalog');
const gameStats = require('../utils/gameStats');
const natureNews = require('../utils/natureNews');
const wordOfWeek = require('../utils/wordOfWeek');
const spellingBee = require('../utils/spellingBee');
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

const NATURE_NEWS_BUCKET = 'private-nature-news';
const NATURE_NEWS_DIR = path.join(__dirname, '..', 'private-uploads', 'nature-news');
const natureNewsStorageClient = createStorageClient();
if (!natureNewsStorageClient && !fs.existsSync(NATURE_NEWS_DIR)) fs.mkdirSync(NATURE_NEWS_DIR, { recursive: true });
const MAX_NATURE_NEWS_PHOTO_BYTES = 6 * 1024 * 1024;
const uploadNatureNewsPhoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_NATURE_NEWS_PHOTO_BYTES }, fileFilter: imageFileFilter });

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
  const natureNewsLatest = await natureNews.listApproved(3);
  const words = wordOfWeek.wordsOfTheWeek();
  const wordOfWeekDateLabel = wordOfWeek.currentWeekDateLabel();
  res.render('student-home', { title: 'Student Portal', member, classes, announcements, natureNewsLatest, words, wordOfWeekDateLabel });
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

// Nature News - a real request: "students can submit descriptions and
// one image of something they discovered in nature... main admin must
// approve. then it will appear on student portal homepage." See
// utils/natureNews.js's own header comment for the pending/approved/
// rejected review shape; routes/nature-news-image.js proxies the actual
// photo file (mounted separately at /nature-news since it needs to be
// reachable from Main Admin's own portal too, not just this
// student-only router).
router.get('/nature-news', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const posts = member ? await natureNews.postsForMember(member.id) : [];
  res.render('student-nature-news', { title: 'Nature News', posts, error: req.query.error || null, notice: req.query.notice || null });
});

router.post('/nature-news', uploadNatureNewsPhoto.single('image'), async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/student/nature-news?error=' + encodeURIComponent('No student profile found for your account.'));
  if (!req.file) return res.redirect('/student/nature-news?error=' + encodeURIComponent('Please attach a photo.'));

  let imageKey;
  if (natureNewsStorageClient) {
    imageKey = await uploadFile(natureNewsStorageClient, NATURE_NEWS_BUCKET, req.file.buffer, req.file.originalname, req.file.mimetype);
  } else {
    imageKey = generateKey(req.file.originalname);
    fs.writeFileSync(path.join(NATURE_NEWS_DIR, imageKey), req.file.buffer);
  }

  const result = await natureNews.submitPost(member.id, req.body.description, imageKey);
  if (!result.ok) return res.redirect('/student/nature-news?error=' + encodeURIComponent(result.error));
  res.redirect('/student/nature-news?notice=' + encodeURIComponent('Submitted for approval!'));
});

// Pets - a real request: "create a personal pet activity for students.
// They can choose a pet, choose a few features and save. Then they can
// name their pet, feed it, play with it, bathe it." Own member record
// only, same scoping as every other Student Portal route (never a
// client-supplied member/pet id). No pet yet -> the chooser/customize
// screen; a saved pet -> the dashboard.
const PET_CARE_ACTIONS = new Set(['feed', 'play', 'bathe']);

router.get('/pets', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const pet = member ? await pets.getPetForMember(member.id) : null;
  if (!pet) return res.redirect('/student/pets/customize');
  res.render('student-pets', {
    title: 'My Pet',
    pet,
    look: pets.lookByKey(pet.look),
    stats: pets.careStats(pet),
    levelInfo: pets.levelInfo(pet.xp),
    notice: req.query.notice || null,
    error: req.query.error || null,
    // Which care button was just pressed (if any) - a real request: "the
    // image as a whole moves again how do we make this more animated."
    // Lets the view play a distinct reaction (nibble/bounce/wobble +
    // floating icon burst) per action instead of one generic bounce for
    // all three. Whitelisted since it flows straight into a CSS class.
    careAction: PET_CARE_ACTIONS.has(req.query.action) ? req.query.action : null,
  });
});

router.get('/pets/customize', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const existing = member ? await pets.getPetForMember(member.id) : null;
  res.render('student-pets-customize', {
    title: existing ? 'Edit Pet' : 'Choose Your Pet',
    isNew: !existing,
    currentLook: existing ? existing.look : pets.defaultLook(),
    petName: existing ? existing.name : '',
    looks: pets.PET_LOOKS,
  });
});

router.post('/pets/customize', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/student/pets/customize?error=' + encodeURIComponent('No student profile found for your account.'));
  await pets.savePet(member.id, {
    name: req.body.name,
    look: req.body.look,
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
  res.redirect('/student/pets?notice=' + encodeURIComponent(notice) + '&action=' + kind);
}

router.post('/pets/feed', (req, res) => careAction('feed', 'Yum! Your pet is happily fed.', req, res));
router.post('/pets/play', (req, res) => careAction('play', 'You played with your pet!', req, res));
router.post('/pets/bathe', (req, res) => careAction('bathe', 'Squeaky clean!', req, res));

// Reading Competition - a real request: "there will be a reading log on
// this page for students to fill out and earn points. students will be
// compete with other students." See utils/reading.js's own header
// comment for how points/streak/level/achievements/leaderboard are all
// derived from the raw reading_logs rows.
router.get('/reading', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const dashboard = member ? await reading.dashboardForMember(member.id) : null;
  res.render('student-reading', {
    title: 'Reading Challenge',
    dashboard,
    reading,
    today: new Date().toISOString().slice(0, 10),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

// Achievements and Leaderboard used to be sections embedded inside this
// same Reading Challenge page - a real request to list them as their
// own tabs in the Activities nav section (views/partials/portal-nav.ejs's
// own STUDENT_ACTIVITY_LINKS) split them into their own routes/views.
router.get('/achievements', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const dashboard = member ? await reading.dashboardForMember(member.id) : null;
  res.render('student-achievements', { title: 'Achievements', dashboard });
});

// A real request: "leaderboard should show top 5 ranking for reading
// hours amongst all student portals. top 5 ranking for reading points.
// top player for each game. top 5 highest spelling bee points winners."
// Reading hours and points share one query (reading.js's own
// leaderboard() already orders by hours, and points is a strict
// multiple of hours, so the two rankings are always identical order -
// just a different displayed unit per section).
router.get('/leaderboard', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const readingLeaders = await reading.leaderboard(5);
  const gameLeaders = await gameStats.topScorePerGame();
  const spellingLeaders = await spellingBee.topPlayers(5);
  res.render('student-leaderboard', {
    title: 'Leaderboard',
    readingLeaders,
    gameLeaders,
    spellingLeaders,
    memberId: member ? member.id : null,
  });
});

router.post('/reading/log', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/student/reading?error=' + encodeURIComponent('No student profile found for your account.'));
  const result = await reading.addLog(member.id, {
    bookTitle: req.body.book_title,
    hours: req.body.hours,
    notes: req.body.notes,
    logDate: req.body.log_date,
  });
  if (!result.ok) return res.redirect('/student/reading?error=' + encodeURIComponent(result.error));
  res.redirect('/student/reading?notice=' + encodeURIComponent(`Logged! You earned ${result.points} points.`));
});

router.post('/reading/goal', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.redirect('/student/reading?error=' + encodeURIComponent('No student profile found for your account.'));
  const result = await reading.setWeeklyGoal(member.id, req.body.weekly_goal_hours);
  if (!result.ok) return res.redirect('/student/reading?error=' + encodeURIComponent(result.error));
  res.redirect('/student/reading?notice=' + encodeURIComponent(`Weekly goal updated to ${result.hours} hours.`));
});

// Games - a real request: "create a game tab on student portal with tic
// tac toe, hangman, checkers, chess, connect 4. games will be card
// choices on the page when you click the games tab." Grew to 15 games
// (a real follow-up: "let's add more games"); the grid itself only shows
// a small preview tile per game (another real request: "game page should
// just show a small image of the game and play button. when you click
// play then it opens the full game to play on a new page") - the actual
// interactive markup lives in views/partials/games/<key>.ejs and is only
// ever rendered on the /play/:key route. All games are client-side,
// local pass-and-play or vs-a-simple-computer-AI (no server state to
// persist), so these routes just render the page; see
// public/js/games/*.js for the actual game logic and utils/gamesCatalog.js
// for the single source of truth on what games exist.
// A single deterministic "game of the day," the same for every student
// and stable all day (changes at UTC midnight) - what the Daily
// Challenge banner's "Start Challenge" button links to.
function gameOfTheDay() {
  const dayNumber = Math.floor(Date.now() / 86400000);
  return GAMES[dayNumber % GAMES.length];
}

router.get('/games', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const stats = member ? await gameStats.statsForMember(member.id) : { gamesPlayed: 0, streak: 0, highScore: null };
  res.render('student-games', { title: 'Games', games: GAMES, categoryLabels: CATEGORY_LABELS, stats, dailyGame: gameOfTheDay() });
});

router.get('/games/play/:key', async (req, res) => {
  const game = gameByKey(req.params.key);
  if (!game) return res.redirect('/student/games');
  const member = await memberForAccount(req.portalAccount.id);
  if (member) await gameStats.logPlay(member.id, game.key);
  res.render('student-game-play', { title: game.title, game, categoryLabels: CATEGORY_LABELS });
});

// Fire-and-forget call from snake.js/avoid-obstacles.js/trivia.js/
// typing-race.js/riddle-rush.js/word-scramble.js when a round ends - only
// the games with a genuinely comparable numeric result (see
// utils/gameStats.js's own SCORING_GAMES comment for why the rest never
// call this).
router.post('/games/score', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.status(401).json({ ok: false });
  const result = await gameStats.logScore(member.id, req.body.key, req.body.score);
  res.json(result);
});

// Spelling Bee - a real request: "this page will have a spelling game
// with vocabulary words for every grade level. grade level on students
// member profile determines their vocabulary level for the spelling
// game." See utils/spellingBee.js's own header comment for how
// members.grade_level (two different vocabularies depending on how the
// student was enrolled) maps to elementary/middle/high.
function shuffle(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

router.get('/spelling-bee', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const level = spellingBee.levelForMember(member);
  const round = shuffle(spellingBee.wordsForLevel(level)).slice(0, 8);
  const topPlayers = await spellingBee.topPlayers(5);
  res.render('student-spelling-bee', {
    title: 'Spelling Bee',
    level,
    levelLabel: spellingBee.LEVEL_LABELS[level],
    round,
    topPlayers,
  });
});

router.post('/spelling-bee/score', async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  if (!member) return res.status(401).json({ ok: false });
  const correctCount = Math.max(0, Math.min(50, parseInt(req.body.correctCount, 10) || 0));
  const roundTotal = Math.max(1, Math.min(50, parseInt(req.body.roundTotal, 10) || 1));
  const level = spellingBee.levelForMember(member);
  await spellingBee.logRound(member.id, correctCount, roundTotal, level);
  res.json({ ok: true });
});

module.exports = router;
