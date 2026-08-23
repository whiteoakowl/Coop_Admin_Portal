// Training & Learning module - HTTP-level security coverage. Confirms
// the rules utils/training.js enforces (see training-assignment-
// progression.test.js) can't be bypassed by talking to the routes
// directly: a member cannot complete a locked lesson, submit an
// arbitrary score, or reach another member's assignment, and the admin
// Training Builder/Assignment/Reporting routes require an admin session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `training-security-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `training-security-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const T = require('../utils/training');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function csrfFrom(html) {
  const m = /name="csrf-token" content="([^"]*)"/.exec(html);
  return m ? m[1] : null;
}

async function loginAsAdmin() {
  const agent = request.agent(app);
  await agent.post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return agent;
}

async function makeMember(name, barcode) {
  return (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'parent')").run(name, barcode)).lastInsertRowid;
}

async function buildPublishedTraining() {
  const id = await T.createTraining({ title: 'Locked Room Training', passingScore: 80, sequentialLessons: true });
  const l1 = await T.createLesson(id, { title: 'First', type: 'text', content: 'a', required: true });
  const l2 = await T.createLesson(id, { title: 'Second', type: 'text', content: 'b', required: true });
  await T.setTrainingStatus(id, 'published');
  return { trainingId: id, l1, l2 };
}

test('every admin Training route redirects an unauthenticated request to login', async () => {
  const { trainingId } = await buildPublishedTraining();
  for (const path of [
    '/admin/training',
    `/admin/training/${trainingId}/builder`,
    `/admin/training/${trainingId}/assign`,
    `/admin/training/${trainingId}/report`,
  ]) {
    const res = await request(app).get(path);
    assert.equal(res.status, 302, `${path} should redirect when logged out`);
    assert.match(res.headers.location, /\/admin\/login/);
  }
  const res = await request(app).post('/admin/training').type('form').send({ title: 'Should Not Work' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/admin\/login/);
});

test('a member cannot complete a locked lesson through a direct API call, even naming it explicitly', async () => {
  const { trainingId, l2 } = await buildPublishedTraining();
  const memberId = await makeMember('Lock Bypass Attempt', 'lockbypass-1');
  await T.assignTrainingToMembers(trainingId, [memberId], null);
  const assignment = await db.prepare('SELECT id FROM training_assignments WHERE training_id = ? AND member_id = ?').get(trainingId, memberId);

  const agent = request.agent(app);
  await agent.post('/training/identify').type('form').send({ memberId: String(memberId) });
  await agent.get(`/training/${assignment.id}/play`); // starts the attempt, lesson 2 stays locked

  const res = await agent.post(`/training/${assignment.id}/lessons/${l2}/complete`);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/, 'completing the still-locked second lesson must be refused');

  const progress = await db.prepare('SELECT status FROM training_lesson_progress WHERE lesson_id = ?').get(l2);
  assert.equal(progress.status, 'locked', 'the lesson must still show as locked in the database');
});

test('a member cannot submit an arbitrary score or pass/fail result - grading is always server-computed from real answers', async () => {
  const trainingId = await T.createTraining({ title: 'No Trust Training', passingScore: 80 });
  const lessonId = await T.createLesson(trainingId, { title: 'Quiz', type: 'quiz', required: true });
  await T.createQuizQuestion(lessonId, { question: 'Q1', points: 1, options: [{ text: 'Right', correct: true }, { text: 'Wrong', correct: false }] });
  await T.setTrainingStatus(trainingId, 'published');
  const memberId = await makeMember('Score Forger', 'forge-1');
  await T.assignTrainingToMembers(trainingId, [memberId], null);
  const assignment = await db.prepare('SELECT id FROM training_assignments WHERE training_id = ? AND member_id = ?').get(trainingId, memberId);

  const agent = request.agent(app);
  await agent.post('/training/identify').type('form').send({ memberId: String(memberId) });
  await agent.get(`/training/${assignment.id}/play`);

  const question = await db.prepare('SELECT * FROM training_quiz_questions WHERE lesson_id = ?').get(lessonId);
  const wrongOption = await db.prepare('SELECT * FROM training_quiz_options WHERE question_id = ? AND is_correct = 0').get(question.id);

  // Answer wrong AND try to also smuggle score/passed/status fields in the
  // POST body - none of those extra fields exist in the real form, but a
  // direct API caller could still send them.
  await agent.post(`/training/${assignment.id}/lessons/${lessonId}/quiz`).type('form').send({
    [`answer_${question.id}`]: String(wrongOption.id),
    score: '100',
    passed: 'true',
    status: 'passed',
  });

  const row = await db.prepare('SELECT * FROM training_assignments WHERE id = ?').get(assignment.id);
  assert.equal(row.status, 'failed', 'server-computed grade (wrong answer) must win over any client-submitted score/status fields');
  assert.equal(row.latest_score, 0);
});

test('a member cannot access, view, or act on another member\'s assignment', async () => {
  const { trainingId, l1 } = await buildPublishedTraining();
  const ownerId = await makeMember('Rightful Owner', 'owner-1');
  const intruderId = await makeMember('Intruder', 'intruder-1');
  await T.assignTrainingToMembers(trainingId, [ownerId], null);
  const assignment = await db.prepare('SELECT id FROM training_assignments WHERE training_id = ? AND member_id = ?').get(trainingId, ownerId);

  const intruder = request.agent(app);
  await intruder.post('/training/identify').type('form').send({ memberId: String(intruderId) });

  let res = await intruder.get(`/training/${assignment.id}/play`);
  assert.equal(res.status, 404);

  res = await intruder.post(`/training/${assignment.id}/lessons/${l1}/complete`);
  assert.equal(res.status, 404);

  res = await intruder.post(`/training/${assignment.id}/lessons/${l1}/video-progress`).send({ currentSeconds: 100, durationSeconds: 100 });
  assert.equal(res.status, 404);

  res = await intruder.post(`/training/${assignment.id}/retake`);
  assert.equal(res.status, 404);

  // The real owner's own progress must be completely untouched by any of that.
  const stillIntact = await db.prepare('SELECT status FROM training_assignments WHERE id = ?').get(assignment.id);
  assert.equal(stillIntact.status, 'not_started');
});

test('visiting a training link with no identity picked yet redirects to the name picker, not an error', async () => {
  const { trainingId } = await buildPublishedTraining();
  const memberId = await makeMember('No Identity Yet', 'noident-1');
  await T.assignTrainingToMembers(trainingId, [memberId], null);
  const assignment = await db.prepare('SELECT id FROM training_assignments WHERE training_id = ? AND member_id = ?').get(trainingId, memberId);

  const res = await request(app).get(`/training/${assignment.id}/play`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/training');
});

test('the public /training name picker only lists real active members, and does not require any admin auth', async () => {
  await makeMember('Publicly Listed', 'public-listed-1');
  const res = await request(app).get('/training');
  assert.equal(res.status, 200);
  assert.match(res.text, /Publicly Listed/);
});

// A real request: "when members go to the training link and choose their
// name from the drop down menu it should be alphabetical according to
// last name" - the picker used to sort by first name.
test('the public /training name picker is sorted by last name, not first name', async () => {
  await makeMember('Zed Anderson', 'lastname-order-1');
  await makeMember('Amy Baxter', 'lastname-order-2');
  const res = await request(app).get('/training');
  assert.equal(res.status, 200);
  const zedPos = res.text.indexOf('>Zed Anderson<');
  const amyPos = res.text.indexOf('>Amy Baxter<');
  assert.ok(zedPos !== -1 && amyPos !== -1);
  assert.ok(zedPos < amyPos, 'Anderson should sort before Baxter by last name, even though "Amy" sorts before "Zed" by first name');
});

test('the Training Builder Publish/Assign/Delete actions require a valid admin CSRF token, same as every other admin form', async () => {
  const agent = await loginAsAdmin();
  const listPage = await agent.get('/admin/training');
  const realToken = csrfFrom(listPage.text);
  assert.ok(realToken);

  const res = await agent.post('/admin/training').type('form').send({ title: 'No Token', passingScore: 80, _csrf: 'not-the-real-token' });
  assert.equal(res.status, 403, 'a forged/missing CSRF token must be rejected');
});
