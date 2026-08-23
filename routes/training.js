// Training & Learning module - member-facing Training Player. No login
// exists for members anywhere in this app (Portal Access was removed
// sitewide - see git history), so this follows the exact same trust
// model every other member-facing feature here already uses (routes/
// absence.js, routes/kiosk.js's Class Check-In and Find a Parent): a
// public link, no password, pick your own name from a list.
//
// Identity, once picked, is held in req.session.trainingMemberId - the
// SAME express-session/PgSessionStore infrastructure server.js already
// sets up for the admin login, just a different key and no adminId, so
// none of requireAdmin/csrfProtection's admin-only checks ever fire for
// these routes (see csrfProtection.js's own comment on why the public
// routes it lists - now including these - are deliberately out of scope
// for that CSRF check: there's no admin session for a forged request to
// ride along on, and the "pick your name" trust model here is the same
// one those routes already accepted).
//
// Everything that actually changes lesson/quiz/attempt state is
// authorized off req.session.trainingMemberId ONLY - see
// getAssignmentForMember's own comment (utils/training.js) for exactly
// how that ownership check works. An assignment id in the URL alone is
// never trusted; the member id it belongs to always comes from the
// session, never from the request body/query.
const express = require('express');
const router = express.Router();
const T = require('../utils/training');
const db = require('../db');
const { byLastName } = require('../utils/members');

// Every route below this point needs a picked identity except the picker
// itself and the identify action - redirect to the picker instead of
// 403ing, since "you haven't picked your name yet" is an expected state
// for a brand new link visit, not an error.
async function requireTrainingIdentity(req, res, next) {
  if (!req.session || !req.session.trainingMemberId) {
    return res.redirect('/training');
  }
  const member = await db.prepare('SELECT id, name FROM members WHERE id = ? AND active = 1').get(req.session.trainingMemberId);
  if (!member) {
    req.session.trainingMemberId = null;
    return res.redirect('/training');
  }
  req.trainingMember = member;
  next();
}

router.get('/training', async (req, res) => {
  if (req.session && req.session.trainingMemberId) {
    const member = await db.prepare('SELECT id FROM members WHERE id = ? AND active = 1').get(req.session.trainingMemberId);
    if (member) return res.redirect('/training/mine');
  }
  // A real request: "when members go to the training link and choose
  // their name from the drop down menu it should be alphabetical
  // according to last name" - matches every other member picker
  // sitewide's own sort (utils/members.js's byLastName), not a plain
  // first-name string compare.
  const members = (await db.prepare('SELECT id, name FROM members WHERE active = 1').all()).sort(byLastName);
  res.render('training-identify', { title: 'My Training', members, error: req.query.error || null });
});

router.post('/training/identify', async (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  const member = memberId ? await db.prepare('SELECT id FROM members WHERE id = ? AND active = 1').get(memberId) : null;
  if (!member) return res.redirect('/training?error=' + encodeURIComponent('Please choose your name from the list.'));
  req.session.trainingMemberId = member.id;
  res.redirect('/training/mine');
});

// "Not you?" - lets a shared kiosk/family device hand off to the next
// person without leaving anything of the previous person's session
// reachable.
router.post('/training/switch', (req, res) => {
  if (req.session) req.session.trainingMemberId = null;
  res.redirect('/training');
});

router.get('/training/mine', requireTrainingIdentity, async (req, res) => {
  res.render('training-mine', {
    title: 'My Training',
    member: req.trainingMember,
    error: req.query.error || null,
    assignments: await T.myAssignments(req.trainingMember.id),
  });
});

// The Training Player - lesson outline plus whichever one lesson is
// currently selected (?lesson=<id>, defaulting to the assignment's own
// current_lesson_id). Starting the attempt here (ensureAttemptStarted)
// rather than requiring a separate "Start" click is a no-op the second
// time an assignment is opened - see that function's own comment.
router.get('/training/:assignmentId/play', requireTrainingIdentity, async (req, res) => {
  const assignment = await T.getAssignmentForMember(req.params.assignmentId, req.trainingMember.id);
  if (!assignment || assignment.trainingStatus !== 'published') return res.status(404).render('404', { title: 'Not Found' });

  await T.ensureAttemptStarted(assignment.id);
  const state = await T.getPlayerState(assignment.id);

  const requestedLessonId = parseInt(req.query.lesson, 10) || assignment.current_lesson_id;
  let selected = state.lessons.find((l) => l.lesson_id === requestedLessonId && l.status !== 'locked');
  if (!selected) selected = state.lessons.find((l) => l.status !== 'locked' && l.status !== 'completed') || state.lessons.find((l) => l.status !== 'locked');

  let questions = null;
  if (selected && selected.lesson_type_snapshot === 'quiz') {
    const lesson = await db.prepare('SELECT * FROM training_lessons WHERE id = ?').get(selected.lesson_id);
    if (lesson) {
      questions = await db.prepare('SELECT * FROM training_quiz_questions WHERE lesson_id = ? ORDER BY position, id').all(lesson.id);
      for (const q of questions) {
        q.options = await db.prepare('SELECT id, option_text FROM training_quiz_options WHERE question_id = ? ORDER BY position, id').all(q.id);
      }
    }
  }
  let lessonRow = null;
  let resources = [];
  if (selected && selected.lesson_id) {
    lessonRow = await db.prepare('SELECT * FROM training_lessons WHERE id = ?').get(selected.lesson_id);
    if (lessonRow) resources = await db.prepare('SELECT * FROM training_lesson_resources WHERE lesson_id = ? ORDER BY position, id').all(lessonRow.id);
  }
  // A real bug report: a video lesson whose Video URL was a pasted
  // youtube.com/youtu.be link rendered a black, non-playing box - a plain
  // <video src> can't play an HTML page. training-play.ejs uses this to
  // pick between that <video> element and a YouTube IFrame embed instead
  // (see utils/training.js's own header comment for the full story).
  const youtubeId = lessonRow && lessonRow.video_url ? T.youtubeVideoId(lessonRow.video_url) : null;

  res.render('training-play', {
    title: state.assignment.title,
    member: req.trainingMember,
    state,
    selected,
    lessonRow,
    youtubeId,
    resources,
    questions,
    error: req.query.error || null,
  });
});

router.post('/training/:assignmentId/lessons/:lessonId/start', requireTrainingIdentity, async (req, res) => {
  const assignment = await T.getAssignmentForMember(req.params.assignmentId, req.trainingMember.id);
  if (!assignment) return res.status(404).json({ ok: false, error: 'Not found.' });
  const progress = await T.startLesson(assignment.id, req.params.lessonId);
  if (!progress) return res.status(403).json({ ok: false, error: 'That lesson is locked.' });
  res.json({ ok: true });
});

// Real playback progress only - see utils/training.js's recordVideoProgress
// for how this is turned into a trustworthy watch-percentage server-side
// (furthest point actually reached, not just the latest timestamp
// reported). currentSeconds/durationSeconds are raw numbers straight off
// the <video> element (public/js/training-player.js) - untrusted input in
// the sense that nothing stops a browser from lying about them, but
// there's nothing to gain by doing so beyond what actually watching
// would give, and the module design brief is explicit about not building
// an elaborate anti-cheat system for this.
router.post('/training/:assignmentId/lessons/:lessonId/video-progress', requireTrainingIdentity, async (req, res) => {
  const assignment = await T.getAssignmentForMember(req.params.assignmentId, req.trainingMember.id);
  if (!assignment) return res.status(404).json({ ok: false, error: 'Not found.' });
  const result = await T.recordVideoProgress(assignment.id, req.params.lessonId, req.body.currentSeconds, req.body.durationSeconds);
  if (!result) return res.status(403).json({ ok: false, error: 'That lesson is locked.' });
  res.json({ ok: true, ...result });
});

router.post('/training/:assignmentId/lessons/:lessonId/complete', requireTrainingIdentity, async (req, res) => {
  const assignment = await T.getAssignmentForMember(req.params.assignmentId, req.trainingMember.id);
  if (!assignment) return res.status(404).render('404', { title: 'Not Found' });
  try {
    await T.completeLesson(assignment.id, req.params.lessonId);
    res.redirect(`/training/${assignment.id}/play`);
  } catch (e) {
    res.redirect(`/training/${assignment.id}/play?lesson=${req.params.lessonId}&error=` + encodeURIComponent(e.message));
  }
});

router.post('/training/:assignmentId/lessons/:lessonId/quiz', requireTrainingIdentity, async (req, res) => {
  const assignment = await T.getAssignmentForMember(req.params.assignmentId, req.trainingMember.id);
  if (!assignment) return res.status(404).render('404', { title: 'Not Found' });
  // { questionId: optionId } - only the raw picks are trusted; grading
  // itself always re-derives correctness from the live options table
  // (see submitQuiz's own comment).
  const answers = {};
  Object.keys(req.body).forEach((key) => {
    const m = /^answer_(\d+)$/.exec(key);
    if (m) answers[m[1]] = req.body[key];
  });
  try {
    await T.submitQuiz(assignment.id, req.params.lessonId, answers);
    res.redirect(`/training/${assignment.id}/play`);
  } catch (e) {
    res.redirect(`/training/${assignment.id}/play?lesson=${req.params.lessonId}&error=` + encodeURIComponent(e.message));
  }
});

router.post('/training/:assignmentId/retake', requireTrainingIdentity, async (req, res) => {
  const assignment = await T.getAssignmentForMember(req.params.assignmentId, req.trainingMember.id);
  if (!assignment) return res.status(404).render('404', { title: 'Not Found' });
  try {
    await T.startRetake(assignment.id);
  } catch (e) {
    return res.redirect('/training/mine?error=' + encodeURIComponent(e.message));
  }
  res.redirect(`/training/${assignment.id}/play`);
});

module.exports = router;
