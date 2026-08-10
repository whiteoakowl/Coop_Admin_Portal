// Real HTTP-level coverage for a bug report this session: "Class Check In"
// on the kiosk home screen (views/kiosk-home.ejs) used to be a small grey
// pill tucked into the top-right corner-actions group, styled identically
// to utility controls like "Full Screen View"/"Admin" - easy to overlook
// next to the six big colorful landing-card tiles, and not purple like the
// user asked for ("Button should be purple to match kiosk purple button").
// Promoted it to a full landing-card (purple, matching Absence/Late Form
// and Name Tag Form) among the other primary actions instead. This suite
// just locks in the markup shape so that promotion doesn't silently regress
// back into a corner link.
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

test('kiosk home: "Class Check In" is a purple landing-card, not a corner link', async () => {
  const res = await request(app).get('/kiosk');
  assert.equal(res.status, 200);

  const cardMatch = /<a class="landing-card landing-card-purple[^"]*" href="\/kiosk\/class-checkin">/.exec(res.text);
  assert.ok(cardMatch, 'expected a purple landing-card linking to /kiosk/class-checkin');

  assert.doesNotMatch(
    res.text,
    /<a class="admin-corner-link" href="\/kiosk\/class-checkin">/,
    'Class Check In should no longer be one of the small top-corner pill links'
  );
});
