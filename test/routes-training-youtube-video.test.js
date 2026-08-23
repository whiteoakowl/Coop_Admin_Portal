// Real HTTP-level coverage for the same bug report: a video lesson whose
// Video URL is a YouTube link now renders a real YouTube embed
// (#training-youtube-player + the IFrame API script) instead of a plain
// <video> element that could never play it - see utils/training.js's
// youtubeVideoId and public/js/training-player.js. A direct video file
// URL must keep rendering exactly the same <video> element as before -
// this isn't a replacement for that path, just a second one alongside it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `training-youtube-video-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `training-youtube-video-test-uploads-${process.pid}`);
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

async function makeMember(name, barcode) {
  return (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'parent')").run(name, barcode)).lastInsertRowid;
}

async function playAsNewMember(videoUrl, memberName) {
  const trainingId = await T.createTraining({ title: `${memberName} Training`, passingScore: 80, sequentialLessons: true });
  await T.createLesson(trainingId, { title: 'Watch This', type: 'video', videoUrl, required: true });
  await T.setTrainingStatus(trainingId, 'published');
  const memberId = await makeMember(memberName, memberName);
  await T.assignTrainingToMembers(trainingId, [memberId], null);
  const assignment = await db.prepare('SELECT id FROM training_assignments WHERE training_id = ? AND member_id = ?').get(trainingId, memberId);

  const agent = request.agent(app);
  await agent.post('/training/identify').type('form').send({ memberId: String(memberId) });
  return agent.get(`/training/${assignment.id}/play`);
}

test('a YouTube video lesson renders the YouTube embed, not a plain <video> element', async () => {
  const res = await playAsNewMember('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'YouTube Lesson Member');
  assert.equal(res.status, 200);
  assert.match(res.text, /id="training-youtube-player"/);
  assert.match(res.text, /data-video-id="dQw4w9WgXcQ"/);
  assert.doesNotMatch(res.text, /id="training-video"/, 'the native <video> element should not also be rendered');
  assert.match(res.text, /<script src="\/js\/training-player\.js"><\/script>/, 'training-player.js (which loads the YouTube IFrame API) must still be included');
});

test('a direct video file URL still renders the plain <video> element, unchanged', async () => {
  const res = await playAsNewMember('https://example.com/orientation.mp4', 'Direct File Lesson Member');
  assert.equal(res.status, 200);
  assert.match(res.text, /id="training-video"/);
  assert.match(res.text, /src="https:\/\/example\.com\/orientation\.mp4"/);
  assert.doesNotMatch(res.text, /id="training-youtube-player"/, 'a non-YouTube URL must not trigger the YouTube embed path');
});

test('the YouTube player carries the same resume/assignment/lesson data attributes the native <video> element uses, for training-player.js to read', async () => {
  const res = await playAsNewMember('https://youtu.be/dQw4w9WgXcQ', 'Resume Data Member');
  assert.equal(res.status, 200);
  const attrMatch = /<div\s+id="training-youtube-player"([^>]*)>/.exec(res.text);
  assert.ok(attrMatch, 'expected the YouTube player div');
  assert.match(attrMatch[1], /data-assignment-id="\d+"/);
  assert.match(attrMatch[1], /data-lesson-id="\d+"/);
  assert.match(attrMatch[1], /data-resume-seconds="0"/);
});
