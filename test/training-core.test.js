// Training & Learning module - Training Builder core CRUD (utils/
// training.js): create/edit a training, add/reorder lessons, configure
// passing score/completion rules, publish/archive, and the delete guard
// that protects historical assignment data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `training-core-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `training-core-test-uploads-${process.pid}`);
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

test('create training with configured completion rules', async () => {
  const id = await T.createTraining({
    title: 'New Employee Orientation',
    description: 'Orientation for new co-op volunteers',
    estimatedMinutes: 45,
    passingScore: 80,
    sequentialLessons: true,
    requireVideoCompletion: true,
    videoCompletionThreshold: 95,
    requireRetakeAfterFailure: true,
  });
  const training = await T.getTraining(id);
  assert.equal(training.title, 'New Employee Orientation');
  assert.equal(training.passing_score, 80);
  assert.equal(training.status, 'draft');
  assert.equal(training.sequential_lessons, 1);
  assert.equal(training.video_completion_threshold, 95);
});

test('edit training updates settings without touching status', async () => {
  const id = await T.createTraining({ title: 'Editable', passingScore: 70 });
  await T.updateTraining(id, { title: 'Editable (renamed)', passingScore: 90, sequentialLessons: true });
  const training = await T.getTraining(id);
  assert.equal(training.title, 'Editable (renamed)');
  assert.equal(training.passing_score, 90);
  assert.equal(training.status, 'draft');
});

test('add/edit/delete/reorder lessons', async () => {
  const id = await T.createTraining({ title: 'Lesson Ordering', passingScore: 80 });
  const l1 = await T.createLesson(id, { title: 'One', type: 'text', content: 'a' });
  const l2 = await T.createLesson(id, { title: 'Two', type: 'video', videoUrl: 'https://x/y.mp4' });
  const l3 = await T.createLesson(id, { title: 'Three', type: 'quiz' });

  let lessons = (await T.getTrainingWithContent(id)).lessons;
  assert.deepEqual(lessons.map((l) => l.title), ['One', 'Two', 'Three']);

  await T.moveLesson(l3, 'up'); // swap Two/Three
  lessons = (await T.getTrainingWithContent(id)).lessons;
  assert.deepEqual(lessons.map((l) => l.title), ['One', 'Three', 'Two']);

  await T.updateLesson(l1, { title: 'One (edited)', type: 'text', content: 'b' });
  lessons = (await T.getTrainingWithContent(id)).lessons;
  assert.equal(lessons.find((l) => l.id === l1).title, 'One (edited)');

  await T.deleteLesson(l2);
  lessons = (await T.getTrainingWithContent(id)).lessons;
  assert.equal(lessons.length, 2);
  assert.ok(!lessons.some((l) => l.id === l2));
});

test('publish requires at least one lesson', async () => {
  const id = await T.createTraining({ title: 'Empty', passingScore: 80 });
  await assert.rejects(() => T.setTrainingStatus(id, 'published'));
  await T.createLesson(id, { title: 'One', type: 'text', content: 'a' });
  await T.setTrainingStatus(id, 'published');
  const training = await T.getTraining(id);
  assert.equal(training.status, 'published');
});

test('archive and move back to draft', async () => {
  const id = await T.createTraining({ title: 'Archivable', passingScore: 80 });
  await T.createLesson(id, { title: 'One', type: 'text', content: 'a' });
  await T.setTrainingStatus(id, 'published');
  await T.setTrainingStatus(id, 'archived');
  assert.equal((await T.getTraining(id)).status, 'archived');
  await T.setTrainingStatus(id, 'draft');
  assert.equal((await T.getTraining(id)).status, 'draft');
});

test('delete is refused once a training has any real assignment - Archive is the only supported retirement path', async () => {
  const id = await T.createTraining({ title: 'Guarded', passingScore: 80 });
  await T.createLesson(id, { title: 'One', type: 'text', content: 'a' });
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Guard Member', 'guard-1', 'parent')").run()).lastInsertRowid;
  await T.setTrainingStatus(id, 'published');
  await T.assignTrainingToMembers(id, [memberId], null);
  await T.setTrainingStatus(id, 'draft');

  const deleted = await T.deleteTraining(id);
  assert.equal(deleted, false, 'delete should be refused');
  assert.ok(await T.getTraining(id), 'training should still exist');
});

test('delete succeeds for a draft training with zero assignments', async () => {
  const id = await T.createTraining({ title: 'Deletable', passingScore: 80 });
  const deleted = await T.deleteTraining(id);
  assert.equal(deleted, true);
  assert.equal(await T.getTraining(id), undefined);
});

test('quiz question builder: create, edit, reorder, points, correct answer', async () => {
  const id = await T.createTraining({ title: 'Quiz Builder', passingScore: 80 });
  const quizLessonId = await T.createLesson(id, { title: 'Assessment', type: 'quiz' });

  const q1 = await T.createQuizQuestion(quizLessonId, {
    question: 'What should you do before operating the equipment?',
    points: 1,
    options: [
      { text: 'Inspect the equipment', correct: true },
      { text: 'Skip the inspection', correct: false },
      { text: 'Ask another employee to do it', correct: false },
      { text: 'Begin operating immediately', correct: false },
    ],
  });
  const q2 = await T.createQuizQuestion(quizLessonId, { question: 'Q2', points: 2, options: [{ text: 'A', correct: true }, { text: 'B', correct: false }] });

  let lesson = (await T.getTrainingWithContent(id)).lessons[0];
  assert.equal(lesson.questions.length, 2);
  assert.equal(lesson.questions[0].points, 1);
  assert.equal(lesson.questions[0].options.length, 4);
  assert.equal(lesson.questions[0].options.find((o) => o.is_correct === 1).option_text, 'Inspect the equipment');

  await T.moveQuizQuestion(q2, 'up');
  lesson = (await T.getTrainingWithContent(id)).lessons[0];
  assert.equal(lesson.questions[0].id, q2);

  await T.updateQuizQuestion(q1, { question: 'Updated question text', points: 5, options: [{ text: 'X', correct: false }, { text: 'Y', correct: true }] });
  lesson = (await T.getTrainingWithContent(id)).lessons[0];
  const updated = lesson.questions.find((q) => q.id === q1);
  assert.equal(updated.question, 'Updated question text');
  assert.equal(updated.points, 5);
  assert.equal(updated.options.find((o) => o.is_correct === 1).option_text, 'Y');

  await T.deleteQuizQuestion(q2);
  lesson = (await T.getTrainingWithContent(id)).lessons[0];
  assert.equal(lesson.questions.length, 1);
});

test('a question needs at least 2 options and exactly one marked correct', async () => {
  const id = await T.createTraining({ title: 'Validation', passingScore: 80 });
  const lessonId = await T.createLesson(id, { title: 'Quiz', type: 'quiz' });
  await assert.rejects(() => T.createQuizQuestion(lessonId, { question: 'Q', points: 1, options: [{ text: 'only one', correct: true }] }));
  await assert.rejects(() => T.createQuizQuestion(lessonId, { question: 'Q', points: 1, options: [{ text: 'A', correct: false }, { text: 'B', correct: false }] }));
});
