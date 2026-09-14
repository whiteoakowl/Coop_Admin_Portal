// A real bug report: "when you click any done or continue buttons in
// kiosk mode it automatically exits kiosk mode." Kiosk Mode is the
// browser's Fullscreen API (public/js/fullscreen-toggle.js), which is
// destroyed by any real page navigation - a plain <form method="POST">
// submit is exactly as real a navigation as a link click, so every
// "Done"/"Unlock"/"Submit" form a kiosk screen can reach needed to opt
// into public/js/fullscreen-nav.js's swap-based, fullscreen-preserving
// submission via a data-preserve-fullscreen attribute (see that file's
// own comment on the submit listener). This only asserts the markup
// carries that attribute - the actual swap-vs-real-navigation behavior
// only diverges inside an actual Fullscreen API state, which isn't
// reachable from a server-rendered-HTML-only test like this one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `kiosk-fullscreen-forms-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `kiosk-fullscreen-forms-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('Class Check-In PIN gate: the Unlock form opts into fullscreen-preserving submission', async () => {
  const res = await request(app).get('/kiosk/class-checkin');
  assert.equal(res.status, 200);
  assert.match(res.text, /<form method="POST" action="\/kiosk\/class-checkin\/unlock" class="stack-form" data-preserve-fullscreen>/);
});

test('Class Check-In Days/Playground Days: the "Done" (lock) form opts into fullscreen-preserving submission', async () => {
  const agent = request.agent(app);
  await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });

  const daysPage = await agent.get('/kiosk/class-checkin/classes');
  assert.equal(daysPage.status, 200);
  assert.match(daysPage.text, /<form method="POST" action="\/kiosk\/class-checkin\/lock" data-preserve-fullscreen>/);

  const playgroundDaysPage = await agent.get('/kiosk/class-checkin/playground');
  assert.equal(playgroundDaysPage.status, 200);
  assert.match(playgroundDaysPage.text, /<form method="POST" action="\/kiosk\/class-checkin\/lock" data-preserve-fullscreen>/);
});

test('Class Check-In Classes list: the Hour filter uses fullscreenNavigate instead of a raw window.location assignment', async () => {
  const agent = request.agent(app);
  await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });

  const res = await agent.get('/kiosk/class-checkin/classes/monday');
  assert.equal(res.status, 200);
  assert.match(res.text, /onchange="window\.fullscreenNavigate\('\/kiosk\/class-checkin\/classes\/monday'/);
  assert.doesNotMatch(res.text, /onchange="window\.location = /);
});

test('Absence and Name Tag public forms opt into fullscreen-preserving submission', async () => {
  const absencePage = await request(app).get('/absence');
  assert.equal(absencePage.status, 200);
  assert.match(absencePage.text, /<form method="POST" action="\/absence\/submit" id="absence-form" class="form-outer-panel" data-preserve-fullscreen>/);

  const nameTagPage = await request(app).get('/name-tag');
  assert.equal(nameTagPage.status, 200);
  assert.match(nameTagPage.text, /<form method="POST" action="\/name-tag\/submit" id="name-tag-form" class="form-outer-panel" data-redirect-home="" data-preserve-fullscreen>/);
});
