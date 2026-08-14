// Real HTTP-level coverage for the kiosk home screen (views/kiosk-
// home.ejs, the separate /kiosk full-screen view - see
// test/routes-index-home.test.js for the actual site root). Went through
// a few shapes: independently `position: fixed`-corner pills (Find a
// Parent top-left, Class Check In & Out + Admin bottom-right, Full Screen
// View top-right), which could overlap each other and the page content on
// a narrow/mobile viewport - a bug report on exactly that - then merged
// into one full-width bottom action bar, but applied at every viewport
// width, which changed the desktop/tablet layout too (a second bug
// report, on the site root but the identical fix applies here), then
// restyled again to icon-on-top/label-below tab items on a solid
// var(--accent) bar, matching the admin dashboard's own mobile bottom bar
// (.admin-mobile-tabs). Settled here: the bottom bar (.landing-action-bar,
// display: none outside a max-width: 640px query) only replaces the
// original corner pills (.landing-desktop-only) below that same
// breakpoint (see public/css/styles.css) - desktop/tablet keeps the
// original corner layout unchanged. Both markup shapes are always in the
// response; only CSS decides which one is visible.
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

test.before(() => app.ready);

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('kiosk home: mobile action bar and desktop/tablet corner pills both render, CSS picks one', async (t) => {
  const res = await request(app).get('/kiosk');
  assert.equal(res.status, 200);

  await t.test('the mobile-only bottom bar has Find a Parent, Class Check In & Out, and Admin as icon-on-top/label-below tab items', () => {
    const groupMatch = /<footer class="landing-action-bar">([\s\S]*?)<\/footer>/.exec(res.text);
    assert.ok(groupMatch, 'expected a <footer class="landing-action-bar"> group');
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn" href="\/kiosk\/find-parent">/);
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn" href="\/kiosk\/class-checkin">/);
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn" href="\/admin">/);
  });

  await t.test('the bottom bar items keep their icons and labels', () => {
    assert.match(res.text, /<svg class="icon"><use href="#icon-search"\/><\/svg><span>Find a Parent<\/span><\/a>/);
    assert.match(
      res.text,
      /<svg class="icon"><use href="#icon-graduation-cap"\/><\/svg><span>Class Check In &amp; Out<\/span><\/a>/
    );
    assert.match(res.text, /<svg class="icon"><use href="#icon-lock"\/><\/svg><span>Admin<\/span><\/a>/);
  });

  await t.test('none of the three is a big landing-grid tile', () => {
    assert.doesNotMatch(res.text, /<a class="landing-card[^"]*" href="\/kiosk\/(find-parent|class-checkin)">/);
    assert.doesNotMatch(res.text, /<a class="landing-card[^"]*" href="\/admin">/);
  });

  await t.test('the desktop/tablet-only corner pills are also present: Find a Parent top-left, Class Check In & Out + Admin bottom-right', () => {
    assert.match(res.text, /<div class="landing-corner-actions-left landing-desktop-only">[\s\S]*?<a class="find-parent-btn" href="\/kiosk\/find-parent">/);
    const bottomGroupMatch = /<div class="landing-corner-actions-bottom-right landing-desktop-only">([\s\S]*?)<\/div>/.exec(res.text);
    assert.ok(bottomGroupMatch, 'expected a .landing-corner-actions-bottom-right group');
    assert.match(bottomGroupMatch[1], /<a class="class-checkin-corner-btn" href="\/kiosk\/class-checkin">/);
    assert.match(bottomGroupMatch[1], /<a class="admin-corner-link-green" href="\/admin">Admin<\/a>/);
  });

  await t.test('Full Screen View is unaffected, still in the original top-right corner group at every viewport width', () => {
    const topGroupMatch = /<div class="landing-corner-actions">([\s\S]*?)<\/div>/.exec(res.text);
    assert.ok(topGroupMatch);
    assert.match(topGroupMatch[1], /id="fullscreen-toggle-btn"/);
    assert.doesNotMatch(topGroupMatch[1], /\/kiosk\/class-checkin|\/admin"|\/kiosk\/find-parent/, 'the other buttons stay in their own groups, not this one');
  });
});
