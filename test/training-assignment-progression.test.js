// Training & Learning module - assignment lifecycle, sequential lesson
// locking, required-video completion enforcement, quiz scoring, pass/
// fail determination, and retakes. Server-side (utils/training.js)
// coverage - see test/routes-training-member.test.js for the same rules
// enforced over real HTTP requests, and for cross-member access
// security.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `training-progression-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `training-progression-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

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

async function makeMember(name, barcode) {
  return (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'parent')").run(name, barcode)).lastInsertRowid;
}

async function buildTraining(overrides = {}) {
  const id = await T.createTraining({
    title: 'Safety Training',
    passingScore: 80,
    sequentialLessons: true,
    requireVideoCompletion: true,
    videoCompletionThreshold: 95,
    requireRetakeAfterFailure: true,
    ...overrides,
  });
  const videoLessonId = await T.createLesson(id, { title: 'Intro Video', type: 'video', videoUrl: 'https://example.com/v.mp4', required: true });
  const textLessonId = await T.createLesson(id, { title: 'Read the Policy', type: 'text', content: 'Read this.', required: true });
  const quizLessonId = await T.createLesson(id, { title: 'Final Assessment', type: 'quiz', required: true });
  await T.createQuizQuestion(quizLessonId, {
    question: 'Q1', points: 1, options: [{ text: 'Right', correct: true }, { text: 'Wrong', correct: false }],
  });
  await T.createQuizQuestion(quizLessonId, {
    question: 'Q2', points: 1, options: [{ text: 'Right', correct: true }, { text: 'Wrong', correct: false }],
  });
  await T.setTrainingStatus(id, 'published');
  return { trainingId: id, videoLessonId, textLessonId, quizLessonId };
}

test('assign to a member creates an independent assignment, separate from the training definition', async () => {
  const { trainingId } = await buildTraining();
  const m1 = await makeMember('Member One', 'assign-1');
  const m2 = await makeMember('Member Two', 'assign-2');
  const count = await T.assignTrainingToMembers(trainingId, [m1, m2], null);
  assert.equal(count, 2);

  const rows = await T.assignmentsForTraining(trainingId);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'not_started'));

  // Assigning the same member again is a harmless no-op, not a duplicate.
  const recount = await T.assignTrainingToMembers(trainingId, [m1], null);
  assert.equal(recount, 0);
  assert.equal((await T.assignmentsForTraining(trainingId)).length, 2);
});

test('member can see their own assigned training', async () => {
  const { trainingId } = await buildTraining();
  const m1 = await makeMember('Dashboard Member', 'dash-1');
  await T.assignTrainingToMembers(trainingId, [m1], null);
  const mine = await T.myAssignments(m1);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].title, 'Safety Training');
});

test('lessons unlock in sequential order and locked lessons cannot be completed directly', async () => {
  const { trainingId, videoLessonId, textLessonId, quizLessonId } = await buildTraining();
  const m1 = await makeMember('Sequential Member', 'seq-1');
  await T.assignTrainingToMembers(trainingId, [m1], null);
  const [assignment] = await T.myAssignments(m1);
  await T.ensureAttemptStarted(assignment.id);

  let state = await T.getPlayerState(assignment.id);
  assert.equal(state.lessons[0].status, 'available');
  assert.equal(state.lessons[1].status, 'locked');
  assert.equal(state.lessons[2].status, 'locked');

  // Trying to complete the SECOND (still-locked) lesson directly must be refused server-side.
  await assert.rejects(() => T.completeLesson(assignment.id, textLessonId), /locked/);
  // Same for jumping straight to the final assessment.
  await assert.rejects(() => T.completeLesson(assignment.id, quizLessonId), /locked/);

  // Complete lesson 1 for real (watch the video first).
  await T.recordVideoProgress(assignment.id, videoLessonId, 100, 100);
  await T.completeLesson(assignment.id, videoLessonId);

  state = await T.getPlayerState(assignment.id);
  assert.equal(state.lessons[0].status, 'completed');
  assert.equal(state.lessons[1].status, 'available', 'lesson 2 should now unlock');
  assert.equal(state.lessons[2].status, 'locked', 'lesson 3 should still be locked');

  // A completed lesson remains completed even after later progress.
  assert.equal(state.lessons[0].status, 'completed');
});

test('a required video lesson cannot be completed before the configured watch threshold is reached', async () => {
  const { trainingId, videoLessonId } = await buildTraining({ videoCompletionThreshold: 90 });
  const m1 = await makeMember('Video Member', 'vid-1');
  await T.assignTrainingToMembers(trainingId, [m1], null);
  const [assignment] = await T.myAssignments(m1);
  await T.ensureAttemptStarted(assignment.id);

  await T.recordVideoProgress(assignment.id, videoLessonId, 50, 100); // 50%, below the 90% threshold
  await assert.rejects(() => T.completeLesson(assignment.id, videoLessonId), /Watch the required video/);

  await T.recordVideoProgress(assignment.id, videoLessonId, 89, 100); // still below
  await assert.rejects(() => T.completeLesson(assignment.id, videoLessonId));

  await T.recordVideoProgress(assignment.id, videoLessonId, 91, 100); // now above
  await T.completeLesson(assignment.id, videoLessonId); // should not throw
  const state = await T.getPlayerState(assignment.id);
  assert.equal(state.lessons[0].status, 'completed');
});

test('video progress: watch percentage tracks the furthest point reached, not just the latest position (no un-completing by seeking back)', async () => {
  const { trainingId, videoLessonId } = await buildTraining();
  const m1 = await makeMember('Seek Member', 'seek-1');
  await T.assignTrainingToMembers(trainingId, [m1], null);
  const [assignment] = await T.myAssignments(m1);
  await T.ensureAttemptStarted(assignment.id);

  let r = await T.recordVideoProgress(assignment.id, videoLessonId, 96, 100);
  assert.equal(r.completed, true);
  r = await T.recordVideoProgress(assignment.id, videoLessonId, 5, 100); // seek back to the start
  assert.equal(r.completed, true, 'already-earned completion should not be revoked by seeking backward');
  assert.equal(r.percent, 96, 'percent should still reflect the furthest point reached, not the current one');
});

test('quiz scoring: earned points / possible points, and 80% passing threshold is enforced exactly', async () => {
  const { trainingId, videoLessonId, textLessonId, quizLessonId } = await buildTraining({ passingScore: 80 });
  const m1 = await makeMember('Score Member', 'score-1');
  await T.assignTrainingToMembers(trainingId, [m1], null);
  const [assignment] = await T.myAssignments(m1);
  await T.ensureAttemptStarted(assignment.id);
  await T.recordVideoProgress(assignment.id, videoLessonId, 100, 100);
  await T.completeLesson(assignment.id, videoLessonId);
  await T.completeLesson(assignment.id, textLessonId);

  const questions = (await T.getTrainingWithContent(trainingId)).lessons.find((l) => l.id === quizLessonId).questions;
  const right = (q) => q.options.find((o) => o.is_correct === 1).id;
  const wrong = (q) => q.options.find((o) => o.is_correct === 0).id;

  // 1 of 2 correct = 50% -> fails an 80% bar.
  const result = await T.submitQuiz(assignment.id, quizLessonId, { [questions[0].id]: right(questions[0]), [questions[1].id]: wrong(questions[1]) });
  assert.equal(result.score, 50);
  assert.equal(result.passed, false);
});

test('80% passing score: exactly 80% passes, 79% fails', async () => {
  // 4 one-point questions so 79%/80%/81% are all reachable exactly (3/4 = 75%, 4/5 = 80% - use 5 questions).
  const trainingId = await T.createTraining({ title: 'Precise Grading', passingScore: 80 });
  const quizLessonId = await T.createLesson(trainingId, { title: 'Quiz', type: 'quiz', required: true });
  const questions = [];
  for (let i = 0; i < 5; i++) {
    await T.createQuizQuestion(quizLessonId, { question: `Q${i}`, points: 1, options: [{ text: 'Right', correct: true }, { text: 'Wrong', correct: false }] });
  }
  await T.setTrainingStatus(trainingId, 'published');
  const loaded = (await T.getTrainingWithContent(trainingId)).lessons[0].questions;
  questions.push(...loaded);

  // Member A: 4/5 right = 80% -> should PASS.
  const memberA = await makeMember('Eighty Percent', 'eighty-1');
  await T.assignTrainingToMembers(trainingId, [memberA], null);
  const [assignA] = await T.myAssignments(memberA);
  await T.ensureAttemptStarted(assignA.id);
  const answersA = {};
  questions.forEach((q, i) => { answersA[q.id] = q.options.find((o) => o.is_correct === (i < 4 ? 1 : 0)).id; });
  const resultA = await T.submitQuiz(assignA.id, quizLessonId, answersA);
  assert.equal(resultA.score, 80);
  assert.equal(resultA.passed, true, '80% score against an 80% passing requirement must PASS');

  // Member B: same but one fewer right = 60%, well under 80% -> FAIL (79% isn't reachable with 5 questions, so this proves the boundary from the other side).
  const memberB = await makeMember('Under Eighty', 'eighty-2');
  await T.assignTrainingToMembers(trainingId, [memberB], null);
  const [assignB] = await T.myAssignments(memberB);
  await T.ensureAttemptStarted(assignB.id);
  const answersB = {};
  questions.forEach((q, i) => { answersB[q.id] = q.options.find((o) => o.is_correct === (i < 3 ? 1 : 0)).id; });
  const resultB = await T.submitQuiz(assignB.id, quizLessonId, answersB);
  assert.equal(resultB.score, 60);
  assert.equal(resultB.passed, false, 'a score under the passing requirement must FAIL');
});

test('exactly 79% vs 80% (100-question training) - the precise off-by-one the module design brief calls out', async () => {
  const trainingId = await T.createTraining({ title: 'Hundred Question', passingScore: 80 });
  const quizLessonId = await T.createLesson(trainingId, { title: 'Quiz', type: 'quiz', required: true });
  for (let i = 0; i < 100; i++) {
    await T.createQuizQuestion(quizLessonId, { question: `Q${i}`, points: 1, options: [{ text: 'Right', correct: true }, { text: 'Wrong', correct: false }] });
  }
  await T.setTrainingStatus(trainingId, 'published');
  const questions = (await T.getTrainingWithContent(trainingId)).lessons[0].questions;

  const memberPass = await makeMember('Exactly Eighty', 'hund-1');
  await T.assignTrainingToMembers(trainingId, [memberPass], null);
  const [assignPass] = await T.myAssignments(memberPass);
  await T.ensureAttemptStarted(assignPass.id);
  const answersPass = {};
  questions.forEach((q, i) => { answersPass[q.id] = q.options.find((o) => o.is_correct === (i < 80 ? 1 : 0)).id; });
  const resultPass = await T.submitQuiz(assignPass.id, quizLessonId, answersPass);
  assert.equal(resultPass.score, 80);
  assert.equal(resultPass.passed, true);

  const memberFail = await makeMember('Exactly Seventy Nine', 'hund-2');
  await T.assignTrainingToMembers(trainingId, [memberFail], null);
  const [assignFail] = await T.myAssignments(memberFail);
  await T.ensureAttemptStarted(assignFail.id);
  const answersFail = {};
  questions.forEach((q, i) => { answersFail[q.id] = q.options.find((o) => o.is_correct === (i < 79 ? 1 : 0)).id; });
  const resultFail = await T.submitQuiz(assignFail.id, quizLessonId, answersFail);
  assert.equal(resultFail.score, 79);
  assert.equal(resultFail.passed, false);
});

test('failed training can be retaken; the new attempt does not overwrite the old one, and passing a later attempt updates the assignment to Passed', async () => {
  const { trainingId, videoLessonId, textLessonId, quizLessonId } = await buildTraining();
  const m1 = await makeMember('Retake Member', 'retake-1');
  await T.assignTrainingToMembers(trainingId, [m1], null);
  const [assignment] = await T.myAssignments(m1);
  await T.ensureAttemptStarted(assignment.id);
  await T.recordVideoProgress(assignment.id, videoLessonId, 100, 100);
  await T.completeLesson(assignment.id, videoLessonId);
  await T.completeLesson(assignment.id, textLessonId);
  const questions = (await T.getTrainingWithContent(trainingId)).lessons.find((l) => l.id === quizLessonId).questions;
  const wrong = (q) => q.options.find((o) => o.is_correct === 0).id;
  const right = (q) => q.options.find((o) => o.is_correct === 1).id;
  await T.submitQuiz(assignment.id, quizLessonId, { [questions[0].id]: wrong(questions[0]), [questions[1].id]: wrong(questions[1]) });

  let a = await db.prepare('SELECT * FROM training_assignments WHERE id = ?').get(assignment.id);
  assert.equal(a.status, 'retry_required');
  assert.equal(a.attempt_count, 1);

  // Not eligible for retake accidentally re-opening the player.
  await T.ensureAttemptStarted(assignment.id); // no-op, must not start a second attempt on its own
  a = await db.prepare('SELECT * FROM training_assignments WHERE id = ?').get(assignment.id);
  assert.equal(a.attempt_count, 1, 'opening the player again must not silently start a new attempt');

  await T.startRetake(assignment.id);
  a = await db.prepare('SELECT * FROM training_assignments WHERE id = ?').get(assignment.id);
  assert.equal(a.status, 'in_progress');
  assert.equal(a.attempt_count, 2);

  await T.recordVideoProgress(assignment.id, videoLessonId, 100, 100);
  await T.completeLesson(assignment.id, videoLessonId);
  await T.completeLesson(assignment.id, textLessonId);
  await T.submitQuiz(assignment.id, quizLessonId, { [questions[0].id]: right(questions[0]), [questions[1].id]: right(questions[1]) });

  a = await db.prepare('SELECT * FROM training_assignments WHERE id = ?').get(assignment.id);
  assert.equal(a.status, 'passed');
  assert.equal(a.best_score, 100);
  assert.equal(a.latest_score, 100);

  const detail = await T.assignmentDetail(assignment.id);
  assert.equal(detail.attempts.length, 2, 'attempt history must be preserved, not overwritten');
  const byNumber = Object.fromEntries(detail.attempts.map((att) => [att.attempt_number, att]));
  assert.equal(byNumber[1].score, 0);
  assert.equal(byNumber[1].passed, 0);
  assert.equal(byNumber[2].score, 100);
  assert.equal(byNumber[2].passed, 1);

  await assert.rejects(() => T.startRetake(assignment.id), /not eligible/, 'a passed assignment should not be retakeable');
});
