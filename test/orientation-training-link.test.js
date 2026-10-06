// A real request: "Orientation settings should be linking a training
// already created under training to each selection. This [way] when a
// member completes a training it will automatically register as
// complete in the correct column next to the member." Covers the whole
// chain: linking a Training to an orientation column from Settings,
// passing that training, and the matching column auto-marking complete
// (utils/orientation.js's own applyTrainingCompletion, called from
// utils/training.js's maybeFinalizeAttempt) - plus the inverse, a FAILED
// attempt must not auto-complete anything.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `orientation-training-link-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `orientation-training-link-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const T = require('../utils/training');
const { setOrientationLink, orientationTrainingLinks, defaultSemesterId, orientationRows } = require('../utils/orientation');
const { createClass, createSemester, setEnrollment } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/orientation/settings').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function makeMember(name, barcode) {
  return (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'parent')").run(name, barcode)).lastInsertRowid;
}

async function buildOneQuestionTraining(title) {
  const id = await T.createTraining({ title, passingScore: 80 });
  const quizLessonId = await T.createLesson(id, { title: 'Quiz', type: 'quiz', required: true });
  await T.createQuizQuestion(quizLessonId, { question: 'Q1', points: 1, options: [{ text: 'Right', correct: true }, { text: 'Wrong', correct: false }] });
  await T.setTrainingStatus(id, 'published');
  return { trainingId: id, quizLessonId };
}

async function passTraining(trainingId, quizLessonId, memberId) {
  await T.assignTrainingToMembers(trainingId, [memberId], null);
  const assignment = (await T.myAssignments(memberId)).find((a) => a.training_id === trainingId || a.trainingId === trainingId) || (await T.myAssignments(memberId))[0];
  await T.ensureAttemptStarted(assignment.id);
  const questions = (await T.getTrainingWithContent(trainingId)).lessons[0].questions;
  const right = questions[0].options.find((o) => o.is_correct === 1).id;
  return T.submitQuiz(assignment.id, quizLessonId, { [questions[0].id]: right });
}

async function failTraining(trainingId, quizLessonId, memberId) {
  await T.assignTrainingToMembers(trainingId, [memberId], null);
  const assignment = (await T.myAssignments(memberId))[0];
  await T.ensureAttemptStarted(assignment.id);
  const questions = (await T.getTrainingWithContent(trainingId)).lessons[0].questions;
  const wrong = questions[0].options.find((o) => o.is_correct === 0).id;
  return T.submitQuiz(assignment.id, quizLessonId, { [questions[0].id]: wrong });
}

test('Orientation Settings: a Training can be linked to a column via its dropdown', async () => {
  const admin = await loginAsAdmin();
  const { trainingId } = await buildOneQuestionTraining('Teacher Orientation Video');

  const settingsPage = await request(app).get('/admin/orientation/settings').set('Cookie', admin.cookie);
  assert.match(settingsPage.text, /Teacher Orientation Video/, 'the training should be offered in the dropdown');
  const csrf = extractCsrf(settingsPage.text);

  await request(app)
    .post('/admin/orientation/settings')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf, teacherTrainingTrainingId: String(trainingId) });

  const links = await orientationTrainingLinks();
  assert.equal(links.teacherTraining, trainingId);

  // Re-opening Settings should show it pre-selected.
  const after = await request(app).get('/admin/orientation/settings').set('Cookie', admin.cookie);
  assert.match(after.text, new RegExp(`<option value="${trainingId}" selected>Teacher Orientation Video</option>`));
});

// A real request: "Orientation settings. Tour and open house section
// should be removed. Only linking trainings for parent orientation and
// teacher orientation." The settings PAGE should offer exactly those two
// dropdowns and no Tour/Open House ones; submitting the settings form
// (even with a tourTrainingId/openHouseTrainingId smuggled in, since
// nothing in the form itself offers one any more) must never create a
// link for either.
test('Orientation Settings only offers linking Parent Orientation and Teacher Orientation - no Tour or Open House section', async () => {
  const admin = await loginAsAdmin();
  const { trainingId } = await buildOneQuestionTraining('Some Training');

  const settingsPage = await request(app).get('/admin/orientation/settings').set('Cookie', admin.cookie);
  assert.match(settingsPage.text, /Parent Orientation - Linked Training/);
  assert.match(settingsPage.text, /Teacher Orientation - Linked Training/);
  assert.doesNotMatch(settingsPage.text, /Tour - Linked Training/);
  assert.doesNotMatch(settingsPage.text, /Open House - Linked Training/);
  assert.doesNotMatch(settingsPage.text, /name="tourTrainingId"/);
  assert.doesNotMatch(settingsPage.text, /name="openHouseTrainingId"/);
  const csrf = extractCsrf(settingsPage.text);

  await request(app)
    .post('/admin/orientation/settings')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf, tourTrainingId: String(trainingId), openHouseTrainingId: String(trainingId) });

  const links = await orientationTrainingLinks();
  assert.equal(links.tour, undefined, 'Tour must never get a Training link from Settings');
  assert.equal(links.openHouse, undefined, 'Open House must never get a Training link from Settings');
});

// "Tour check in and open house check in will automatically show a check
// mark in those columns matching those members who were scanned in" - a
// statement of existing behavior (handleCheckin in routes/admin-
// orientation.js already calls setOrientationField directly), confirmed
// here end to end through the real Tour Check-In route rather than
// assuming it still works just because Settings changed.
test('Tour Check-In still checks the Tour column directly for a scanned-in member, with no Training involved at all', async () => {
  const admin = await loginAsAdmin();
  const { studentId, primaryParentId } = await makeFamilyWithStudentAndTwoParents();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Tour Checkin Class', room: 'Room D' });
  await setEnrollment(classId, [studentId]);

  const checkinPage = await request(app).get('/admin/orientation/tour-checkin').set('Cookie', admin.cookie);
  const csrf = extractCsrf(checkinPage.text);

  await request(app)
    .post('/admin/orientation/tour-checkin')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf, members: String(primaryParentId) });

  const row = await db.prepare('SELECT tour_complete FROM orientation_progress WHERE member_id = ?').get(primaryParentId);
  assert.ok(row);
  assert.equal(Number(row.tour_complete), 1);
});

test('passing a linked Training auto-checks the matching Orientation column for that member', async () => {
  await setOrientationLink('tour', null);
  const { trainingId, quizLessonId } = await buildOneQuestionTraining('Facility Tour Walkthrough');
  await setOrientationLink('tour', trainingId);

  const memberId = await makeMember('Auto Complete Parent', 'auto-complete-1');
  const before = await db.prepare('SELECT tour_complete FROM orientation_progress WHERE member_id = ?').get(memberId);
  assert.equal(before, undefined, 'no orientation progress row should exist before the training is passed');

  const result = await passTraining(trainingId, quizLessonId, memberId);
  assert.equal(result.passed, true);

  const semesterId = await defaultSemesterId();
  const row = await db
    .prepare('SELECT tour_complete FROM orientation_progress WHERE member_id = ? AND (?::int IS NULL AND semester_id IS NULL OR semester_id = ?::int)')
    .get(memberId, semesterId, semesterId);
  assert.ok(row, 'passing the linked training should create an orientation_progress row');
  assert.equal(Number(row.tour_complete), 1, 'the tour column should auto-complete');
});

test('a FAILED attempt at a linked Training does not auto-complete anything', async () => {
  const { trainingId, quizLessonId } = await buildOneQuestionTraining('Open House Orientation (fail path)');
  await setOrientationLink('openHouse', trainingId);

  const memberId = await makeMember('Fail Path Parent', 'fail-path-1');
  const result = await failTraining(trainingId, quizLessonId, memberId);
  assert.equal(result.passed, false);

  const row = await db.prepare('SELECT * FROM orientation_progress WHERE member_id = ?').get(memberId);
  assert.equal(row, undefined, 'a failed attempt must never auto-complete an orientation column');
});

// A real bug report: "I linked some of the trainings in orientation
// settings and it is not showing green check marks next to those that
// completed the trainings." - the member had ALREADY passed the training
// before the admin ever linked it to a column, so the normal "auto-check
// on pass" path (above) never ran for them. Linking it after the fact
// must retroactively check the column.
test('linking a Training that members already passed retroactively checks their column', async () => {
  const { trainingId, quizLessonId } = await buildOneQuestionTraining('Already Passed Before Linking');
  const memberId = await makeMember('Already Passed Parent', 'already-passed-1');

  const result = await passTraining(trainingId, quizLessonId, memberId);
  assert.equal(result.passed, true);
  const beforeLink = await db.prepare('SELECT * FROM orientation_progress WHERE member_id = ?').get(memberId);
  assert.equal(beforeLink, undefined, 'nothing to auto-complete yet - the column is not linked');

  await setOrientationLink('openHouse', trainingId);

  const semesterId = await defaultSemesterId();
  const row = await db
    .prepare('SELECT open_house_complete FROM orientation_progress WHERE member_id = ? AND (?::int IS NULL AND semester_id IS NULL OR semester_id = ?::int)')
    .get(memberId, semesterId, semesterId);
  assert.ok(row, 'linking the training should backfill an orientation_progress row for the already-passed member');
  assert.equal(Number(row.open_house_complete), 1);
});

// A failed attempt must stay failed even once the training gets linked
// afterward - only a passed attempt should ever backfill a column.
test('linking a Training does not retroactively check the column for a member who only FAILED it', async () => {
  const { trainingId, quizLessonId } = await buildOneQuestionTraining('Already Failed Before Linking');
  const memberId = await makeMember('Already Failed Parent', 'already-failed-1');

  const result = await failTraining(trainingId, quizLessonId, memberId);
  assert.equal(result.passed, false);

  await setOrientationLink('video', trainingId);

  const row = await db.prepare('SELECT * FROM orientation_progress WHERE member_id = ?').get(memberId);
  assert.equal(row, undefined, 'a failed attempt must never be backfilled, even after the training is linked');
});

test('a Training with no linked column does not touch Orientation at all', async () => {
  const { trainingId, quizLessonId } = await buildOneQuestionTraining('Unrelated Training');
  const memberId = await makeMember('Unrelated Parent', 'unrelated-1');
  const result = await passTraining(trainingId, quizLessonId, memberId);
  assert.equal(result.passed, true);

  const row = await db.prepare('SELECT * FROM orientation_progress WHERE member_id = ?').get(memberId);
  assert.equal(row, undefined);
});

// A real bug report: "primary member signed up from each of the signed up
// families is not showing their green check mark for completing trainings
// that they did." Orientation Tracking only ever displays progress keyed
// to the family's own primary parent (same row Schedule Cards' own
// primaryParentsFor would pick), but a Training can be passed by whichever
// family member actually took it - a non-primary parent, or the admin's
// assignment simply wasn't given to the one flagged Primary. Covers the
// whole chain end to end: family with 2 parents, the SECOND (non-primary)
// one passes a linked Training, and the checkmark must still show on the
// Orientation Tracking row for the PRIMARY parent - the one the admin is
// actually looking at.
async function makeFamilyWithStudentAndTwoParents() {
  const family = await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING *').get(`Test Family ${Date.now()}-${Math.random()}`);
  const primaryParentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent) VALUES (?, ?, 'parent', ?, 1)")
      .run(`Primary Parent ${family.id}`, `primary-${family.id}`, family.id)
  ).lastInsertRowid;
  const secondParentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent) VALUES (?, ?, 'parent', ?, 0)")
      .run(`Second Parent ${family.id}`, `second-${family.id}`, family.id)
  ).lastInsertRowid;
  const studentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES (?, ?, 'student', ?)")
      .run(`Student ${family.id}`, `student-${family.id}`, family.id)
  ).lastInsertRowid;
  return { familyId: family.id, primaryParentId, secondParentId, studentId };
}

test('a Training passed by a non-primary parent still checks the column on the family\'s PRIMARY parent row', async () => {
  const { primaryParentId, secondParentId, studentId } = await makeFamilyWithStudentAndTwoParents();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Orientation Credit Class', room: 'Room A' });
  await setEnrollment(classId, [studentId]);

  const { trainingId, quizLessonId } = await buildOneQuestionTraining('Parent Orientation (non-primary passes)');
  await setOrientationLink('video', trainingId);

  const result = await passTraining(trainingId, quizLessonId, secondParentId);
  assert.equal(result.passed, true);

  // The checkmark must land on the PRIMARY parent's own row, not the one
  // who actually clicked through the training.
  const primaryRow = await db.prepare('SELECT video_complete FROM orientation_progress WHERE member_id = ?').get(primaryParentId);
  assert.ok(primaryRow, 'the primary parent should have an orientation_progress row');
  assert.equal(Number(primaryRow.video_complete), 1);

  const secondRow = await db.prepare('SELECT * FROM orientation_progress WHERE member_id = ?').get(secondParentId);
  assert.equal(secondRow, undefined, 'the non-primary parent who actually passed it must not get their own separate row');

  const rows = await orientationRows(null);
  const familyRow = rows.find((r) => r.memberId === primaryParentId);
  assert.ok(familyRow, 'Orientation Tracking should list this family under the primary parent');
  assert.equal(familyRow.video, true, 'the green check must show on the row the admin actually sees');
});

test('linking a Training retroactively credits the PRIMARY parent even when a non-primary parent already passed it', async () => {
  const { primaryParentId, secondParentId, studentId } = await makeFamilyWithStudentAndTwoParents();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Orientation Retroactive Credit Class', room: 'Room B' });
  await setEnrollment(classId, [studentId]);

  const { trainingId, quizLessonId } = await buildOneQuestionTraining('Teacher Orientation (retroactive, non-primary)');
  const result = await passTraining(trainingId, quizLessonId, secondParentId);
  assert.equal(result.passed, true);

  await setOrientationLink('teacherTraining', trainingId);

  const primaryRow = await db.prepare('SELECT teacher_training_complete FROM orientation_progress WHERE member_id = ?').get(primaryParentId);
  assert.ok(primaryRow, 'retroactively linking should backfill the primary parent, not the member who actually passed it');
  assert.equal(Number(primaryRow.teacher_training_complete), 1);
});

// A real bug report: "the columns linked to trainings, parent orientation
// and teacher orientation are not automatically checking green if that
// member completed the designated training. Everything is set properly."
// applyTrainingCompletion used to always guess "the most recently CREATED
// semester" as the target to write the checkmark under - if a co-op has
// since created a newer semester shell (e.g. getting a head start on next
// semester's setup) while this family is still enrolled under an OLDER
// one, the checkmark landed on a semester Orientation Tracking was never
// showing this family under at all.
test('a passed Training checks the column under the family\'s OWN enrolled semester, not just whichever semester is newest', async () => {
  const older = await createSemester('Fall 2026');
  const newer = await createSemester('Spring 2027'); // created after, and numerically newer - but this family has nothing to do with it

  const { primaryParentId, studentId } = await makeFamilyWithStudentAndTwoParents();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Older Semester Class', room: 'Room C', semesterId: older.id });
  await setEnrollment(classId, [studentId]);

  const { trainingId, quizLessonId } = await buildOneQuestionTraining('Parent Orientation (older semester family)');
  await setOrientationLink('video', trainingId);

  const result = await passTraining(trainingId, quizLessonId, primaryParentId);
  assert.equal(result.passed, true);

  const row = await db.prepare('SELECT video_complete FROM orientation_progress WHERE member_id = ? AND semester_id = ?').get(primaryParentId, older.id);
  assert.ok(row, 'the checkmark must be written under the semester this family is actually enrolled in');
  assert.equal(Number(row.video_complete), 1);

  const wrongSemesterRow = await db.prepare('SELECT * FROM orientation_progress WHERE member_id = ? AND semester_id = ?').get(primaryParentId, newer.id);
  assert.equal(wrongSemesterRow, undefined, 'must not also write (or instead write) under the newer, unrelated semester');

  const rowsForOlderSemester = await orientationRows(older.id);
  const familyRow = rowsForOlderSemester.find((r) => r.memberId === primaryParentId);
  assert.ok(familyRow, 'the family must show up under the semester they are actually enrolled in');
  assert.equal(familyRow.video, true, 'the admin viewing the correct (older) semester must see the green check');
});
