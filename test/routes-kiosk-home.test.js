// Real HTTP-level coverage for Find a Parent / Class Check In & Out /
// Admin on the kiosk home screen (views/kiosk-home.ejs). These went
// through a few shapes before landing here: independently
// `position: fixed`-corner pills (Find a Parent top-left, Class Check In &
// Out + Admin bottom-right), which could overlap each other and the page
// content on a narrow/mobile viewport - a bug report on exactly that -
// then merged into one full-width bottom action bar with equal-width
// buttons, while Full Screen View stays put in the original top-right
// corner group. This suite locks in that final shape.
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

test('kiosk home: Find a Parent, Class Check In & Out, and Admin share one bottom action bar', async (t) => {
  const res = await request(app).get('/kiosk');
  assert.equal(res.status, 200);

  await t.test('all three live in the bottom action bar, inside a <footer> landmark (not a bare <div>, which axe-core flags as page content not contained by any landmark)', () => {
    const groupMatch = /<footer class="landing-action-bar">([\s\S]*?)<\/footer>/.exec(res.text);
    assert.ok(groupMatch, 'expected a <footer class="landing-action-bar"> group');
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn landing-action-bar-btn-orange" href="\/kiosk\/find-parent">/);
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn landing-action-bar-btn-green" href="\/kiosk\/class-checkin">/);
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn landing-action-bar-btn-green" href="\/admin">Admin<\/a>/);
  });

  await t.test('Find a Parent and Class Check In & Out keep their icons', () => {
    assert.match(res.text, /<svg class="icon"><use href="#icon-search"\/><\/svg> Find a Parent<\/a>/);
    assert.match(
      res.text,
      /<svg class="icon"><use href="#icon-graduation-cap"\/><\/svg> Class Check In &amp; Out<\/a>/
    );
  });

  await t.test('none of the three is a big landing-grid tile', () => {
    assert.doesNotMatch(res.text, /<a class="landing-card[^"]*" href="\/kiosk\/(find-parent|class-checkin)">/);
    assert.doesNotMatch(res.text, /<a class="landing-card[^"]*" href="\/admin">/);
  });

  await t.test('the old independently-positioned corner groups are gone', () => {
    assert.doesNotMatch(res.text, /landing-corner-actions-left/);
    assert.doesNotMatch(res.text, /landing-corner-actions-bottom-right/);
  });

  await t.test('Full Screen View is unaffected, still in the original top-right corner group', () => {
    const topGroupMatch = /<div class="landing-corner-actions">([\s\S]*?)<\/div>/.exec(res.text);
    assert.ok(topGroupMatch);
    assert.match(topGroupMatch[1], /id="fullscreen-toggle-btn"/);
    assert.doesNotMatch(topGroupMatch[1], /\/kiosk\/class-checkin|\/admin"|\/kiosk\/find-parent/, 'the other three buttons should have moved out of this group');
  });
});
