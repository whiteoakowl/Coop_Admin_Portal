// Real HTTP-level coverage for "Class Check In & Out" and "Admin" on the
// kiosk home screen (views/kiosk-home.ejs). Both went through a few shapes
// this session before landing here: Class Check In & Out started as a
// small grey top-corner pill, got promoted to a full landing-card tile,
// got reverted back to a small top-corner pill (purple, keeping its
// graduation-cap icon), and finally moved down to the bottom-right corner
// alongside Admin - both recolored green ("color only matches the green
// buttons on the kiosk pages"), while Full Screen View stays put in the
// original top-right corner group. This suite locks in that final shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `kiosk-home-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `kiosk-home-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('kiosk home: Class Check In & Out and Admin are green bottom-right corner buttons', async (t) => {
  const res = await request(app).get('/kiosk');
  assert.equal(res.status, 200);

  await t.test('both live in the bottom-right corner group', () => {
    const groupMatch = /<div class="landing-corner-actions-bottom-right">([\s\S]*?)<\/div>/.exec(res.text);
    assert.ok(groupMatch, 'expected a .landing-corner-actions-bottom-right group');
    assert.match(groupMatch[1], /<a class="class-checkin-corner-btn" href="\/kiosk\/class-checkin">/);
    assert.match(groupMatch[1], /<a class="admin-corner-link-green" href="\/admin">Admin<\/a>/);
  });

  await t.test('Class Check In & Out keeps its graduation-cap icon', () => {
    assert.match(
      res.text,
      /<a class="class-checkin-corner-btn" href="\/kiosk\/class-checkin"><svg class="icon"><use href="#icon-graduation-cap"\/><\/svg> Class Check In &amp; Out<\/a>/
    );
  });

  await t.test('neither is a big landing-grid tile anymore', () => {
    assert.doesNotMatch(res.text, /<a class="landing-card landing-card-purple[^"]*" href="\/kiosk\/class-checkin">/);
  });

  await t.test('Full Screen View is unaffected, still in the original top-right corner group', () => {
    const topGroupMatch = /<div class="landing-corner-actions">([\s\S]*?)<\/div>/.exec(res.text);
    assert.ok(topGroupMatch);
    assert.match(topGroupMatch[1], /id="fullscreen-toggle-btn"/);
    assert.doesNotMatch(topGroupMatch[1], /\/kiosk\/class-checkin|\/admin"/, 'Class Check In & Out and Admin should have moved out of this group');
  });
});
