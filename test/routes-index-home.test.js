// Real HTTP-level coverage for the site root (views/index.ejs) - the
// actual landing page people reach the app on, as opposed to
// views/kiosk-home.ejs's own separate /kiosk full-screen view (see
// test/routes-kiosk-home.test.js). Went through a few shapes: first Find
// a Parent/Full Screen View/Admin sharing one bottom bar (a bug report on
// them overlapping each other up top on mobile), then Find a Parent/Class
// Check In & Out/Admin in a solid-orange bottom bar with Full Screen View
// moved to its own corner - but applied at every viewport width, which
// changed the desktop/tablet layout too (a second bug report), then
// restyled again (icon-on-top/label-below tab items on a solid
// var(--accent) bar) to match the admin dashboard's own mobile bottom
// bar (.admin-mobile-tabs) instead of looking like a different UI
// pattern. Settled here: the bottom bar (.landing-action-bar, display:
// none outside a max-width: 640px query) only replaces the original
// independently-positioned corner pills (.landing-desktop-only) below
// that same breakpoint (see public/css/styles.css) - desktop/tablet
// keeps exactly the original corner layout, since it never had the
// overlap problem the bar exists to fix. Both markup shapes are always
// in the response; only CSS decides which one is visible.
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

test('site root: mobile action bar and desktop/tablet corner pills both render, CSS picks one', async (t) => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);

  await t.test('the mobile-only bottom bar has Find a Parent, Class Check In & Out, and Admin as icon-on-top/label-below tab items', () => {
    const groupMatch = /<footer class="landing-action-bar">([\s\S]*?)<\/footer>/.exec(res.text);
    assert.ok(groupMatch, 'expected a <footer class="landing-action-bar"> group');
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn" href="\/kiosk\/find-parent">/);
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn" href="\/kiosk\/class-checkin">/);
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn" href="\/admin">/);
  });

  await t.test('the desktop/tablet-only corner pills are also present: Find a Parent top-left, Admin top-right alongside Full Screen View', () => {
    assert.match(res.text, /<div class="landing-corner-actions-left landing-desktop-only">[\s\S]*?<a class="find-parent-btn" href="\/kiosk\/find-parent">/);
    const topGroupMatch = /<div class="landing-corner-actions">([\s\S]*?)<\/div>/.exec(res.text);
    assert.ok(topGroupMatch, 'expected a top-right .landing-corner-actions group');
    assert.match(topGroupMatch[1], /id="fullscreen-toggle-btn"/);
    assert.match(topGroupMatch[1], /<a class="admin-corner-link landing-desktop-only" href="\/admin">Admin<\/a>/);
  });

  await t.test('the bottom bar items keep their icons and labels', () => {
    assert.match(res.text, /<svg class="icon"><use href="#icon-search"\/><\/svg><span>Find a Parent<\/span><\/a>/);
    assert.match(res.text, /<svg class="icon"><use href="#icon-graduation-cap"\/><\/svg><span>Class Check In &amp; Out<\/span><\/a>/);
    assert.match(res.text, /<svg class="icon"><use href="#icon-lock"\/><\/svg><span>Admin<\/span><\/a>/);
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
