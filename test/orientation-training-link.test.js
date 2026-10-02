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
const { setOrientationLink, orientationTrainingLinks, defaultSemesterId } = require('../utils/orientation');

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

test('Orientation Settings: a Training can be linked to a column, independently of that column\'s plain URL', async () => {
  const admin = await loginAsAdmin();
  const { trainingId } = await buildOneQuestionTraining('Teacher Orientation Video');

  const settingsPage = await request(app).get('/admin/orientation/settings').set('Cookie', admin.cookie);
  assert.match(settingsPage.text, /Teacher Orientation Video/, 'the training should be offered in the dropdown');
  const csrf = extractCsrf(settingsPage.text);

  await request(app)
    .post('/admin/orientation/settings')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf, video: '', meetup: '', teacherTraining: '', tour: '', openHouse: '', teacherTrainingTrainingId: String(trainingId) });

  const links = await orientationTrainingLinks();
  assert.equal(links.teacherTraining, trainingId);

  // Re-opening Settings should show it pre-selected.
  const after = await request(app).get('/admin/orientation/settings').set('Cookie', admin.cookie);
  assert.match(after.text, new RegExp(`<option value="${trainingId}" selected>Teacher Orientation Video</option>`));
});

test('passing a linked Training auto-checks the matching Orientation column for that member', async () => {
  await setOrientationLink('tour', '', null);
  const { trainingId, quizLessonId } = await buildOneQuestionTraining('Facility Tour Walkthrough');
  await setOrientationLink('tour', '', trainingId);

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
  await setOrientationLink('openHouse', '', trainingId);

  const memberId = await makeMember('Fail Path Parent', 'fail-path-1');
  const result = await failTraining(trainingId, quizLessonId, memberId);
  assert.equal(result.passed, false);

  const row = await db.prepare('SELECT * FROM orientation_progress WHERE member_id = ?').get(memberId);
  assert.equal(row, undefined, 'a failed attempt must never auto-complete an orientation column');
});

test('a Training with no linked column does not touch Orientation at all', async () => {
  const { trainingId, quizLessonId } = await buildOneQuestionTraining('Unrelated Training');
  const memberId = await makeMember('Unrelated Parent', 'unrelated-1');
  const result = await passTraining(trainingId, quizLessonId, memberId);
  assert.equal(result.passed, true);

  const row = await db.prepare('SELECT * FROM orientation_progress WHERE member_id = ?').get(memberId);
  assert.equal(row, undefined);
});
