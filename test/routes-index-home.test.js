// Real HTTP-level coverage for Find a Parent / Full Screen View / Admin
// on the site root (views/index.ejs) - the actual landing page people
// reach the app on, as opposed to views/kiosk-home.ejs's own /kiosk full-
// screen view (see test/routes-kiosk-home.test.js). These were 3
// independently `position: fixed`-corner pills (Find a Parent top-left,
// Full Screen View + Admin top-right), which could overlap each other on
// a narrow/mobile viewport - reported as exactly that. Merged into one
// full-width bottom action bar with equal-width buttons, matching
// kiosk-home.ejs's own fix for the identical problem.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `index-home-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `index-home-test-uploads-${process.pid}`);
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

test('site root: Find a Parent, Full Screen View, and Admin share one bottom action bar', async (t) => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);

  await t.test('all three live in the bottom action bar, inside a <footer> landmark (not a bare <div>, which axe-core flags as page content not contained by any landmark)', () => {
    const groupMatch = /<footer class="landing-action-bar">([\s\S]*?)<\/footer>/.exec(res.text);
    assert.ok(groupMatch, 'expected a <footer class="landing-action-bar"> group');
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn landing-action-bar-btn-orange" href="\/kiosk\/find-parent">/);
    assert.match(groupMatch[1], /id="fullscreen-toggle-btn"/);
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn landing-action-bar-btn-neutral" href="\/admin">Admin<\/a>/);
  });

  await t.test('Find a Parent keeps its icon', () => {
    assert.match(res.text, /<svg class="icon"><use href="#icon-search"\/><\/svg> Find a Parent<\/a>/);
  });

  await t.test('the old independently-positioned corner groups are gone', () => {
    assert.doesNotMatch(res.text, /landing-corner-actions-left/);
    assert.doesNotMatch(res.text, /<header>/);
  });

  await t.test('the landing-grid cards are unaffected', () => {
    assert.match(res.text, /Floater Assignments/);
    assert.match(res.text, /Check In</);
    assert.match(res.text, /Check Out</);
  });
});
