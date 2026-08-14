// Real HTTP-level coverage for the site root (views/index.ejs) - the
// actual landing page people reach the app on, as opposed to
// views/kiosk-home.ejs's own separate /kiosk full-screen view (see
// test/routes-kiosk-home.test.js). Went through two shapes: first Find a
// Parent/Full Screen View/Admin sharing one bottom bar (a bug report on
// them overlapping each other up top), then corrected to what's actually
// wanted here - Find a Parent/Class Check In & Out/Admin in a solid-
// orange bottom bar, with Full Screen View moved back to its own
// top-right corner (clear of the centered logo/banner, not part of this
// group at all).
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

test('site root: Find a Parent, Class Check In & Out, and Admin share one solid-orange bottom bar', async (t) => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);

  await t.test('all three live in the bottom action bar, inside a <footer> landmark, all the orange variant', () => {
    const groupMatch = /<footer class="landing-action-bar">([\s\S]*?)<\/footer>/.exec(res.text);
    assert.ok(groupMatch, 'expected a <footer class="landing-action-bar"> group');
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn landing-action-bar-btn-orange" href="\/kiosk\/find-parent">/);
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn landing-action-bar-btn-orange" href="\/kiosk\/class-checkin">/);
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn landing-action-bar-btn-orange" href="\/admin">Admin<\/a>/);
    assert.doesNotMatch(groupMatch[1], /landing-action-bar-btn-green|landing-action-bar-btn-neutral|fullscreen-toggle-btn/);
  });

  await t.test('Find a Parent and Class Check In & Out keep their icons', () => {
    assert.match(res.text, /<svg class="icon"><use href="#icon-search"\/><\/svg> Find a Parent<\/a>/);
    assert.match(res.text, /<svg class="icon"><use href="#icon-graduation-cap"\/><\/svg> Class Check In &amp; Out<\/a>/);
  });

  await t.test('Full Screen View moved back to its own top-right corner group, not the bottom bar', () => {
    const topGroupMatch = /<div class="landing-corner-actions">([\s\S]*?)<\/div>/.exec(res.text);
    assert.ok(topGroupMatch, 'expected a top-right .landing-corner-actions group');
    assert.match(topGroupMatch[1], /id="fullscreen-toggle-btn"/);
  });

  await t.test('the landing-grid cards are grouped by color and reordered: Check In, Check Out, Setup/Cleanup, Floater Assignments, Name Tag, Absence', () => {
    const gridMatch = /<div class="landing-grid">([\s\S]*?)<\/div>/.exec(res.text);
    assert.ok(gridMatch, 'expected a .landing-grid');
    const labels = [...gridMatch[1].matchAll(/<span class="landing-label">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(labels, [
      'Check In',
      'Check Out',
      'Setup/Cleanup Teams',
      'Floater Assignments',
      'Name Tag Form',
      'Absence/Late Form',
    ]);
  });
});
