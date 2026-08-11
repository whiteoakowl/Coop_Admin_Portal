// Real HTTP-level coverage for "Class Check In & Out" on the kiosk home
// screen (views/kiosk-home.ejs). This went through two shapes this
// session: it started as a small grey top-corner pill (styled like the
// plain "Full Screen View"/"Admin" utility controls), got promoted to a
// full purple landing-card tile so it wouldn't be overlooked, and was then
// explicitly reverted back to a small top-corner pill - "class check in &
// out should still be a small button top right and keep the color and
// icon" - just now purple (matching .landing-card-purple) and with its
// graduation-cap icon, instead of losing that color/icon by going back to
// a plain admin-corner-link. This suite locks in that final shape.
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

test('kiosk home: "Class Check In & Out" is a small purple top-right corner button, not a landing-card tile', async () => {
  const res = await request(app).get('/kiosk');
  assert.equal(res.status, 200);

  assert.match(
    res.text,
    /<a class="class-checkin-corner-btn" href="\/kiosk\/class-checkin"><svg class="icon"><use href="#icon-graduation-cap"\/><\/svg> Class Check In &amp; Out<\/a>/,
    'expected a small purple corner button with the graduation-cap icon, linking to /kiosk/class-checkin'
  );

  assert.doesNotMatch(
    res.text,
    /<a class="landing-card landing-card-purple[^"]*" href="\/kiosk\/class-checkin">/,
    'Class Check In & Out should no longer be one of the big landing-grid tiles'
  );

  assert.doesNotMatch(
    res.text,
    /<a class="admin-corner-link" href="\/kiosk\/class-checkin">/,
    'and should not have reverted all the way to a plain grey admin-corner-link either - it keeps its purple color and icon'
  );
});
