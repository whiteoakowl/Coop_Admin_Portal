// Real HTTP-level coverage for the kiosk home screen (views/kiosk-
// home.ejs, the separate /kiosk full-screen view - see
// test/routes-index-home.test.js for the actual site root). Redesigned
// to a desktop/tablet-only orange top menu bar (Name Tag Form, Absence/
// Late Form, Find a Parent, Class Check In & Out, Admin) plus two
// stacked button columns (Check In/Check Out - green; Floater
// Assignments/Setup-Cleanup Teams - purple), replacing the original
// corner-pill layout (Find a Parent top-left, Class Check In & Out +
// Admin bottom-right) that index.ejs (the site root) still uses. Below
// 640px the original single-grid layout takes over instead, alongside
// the existing mobile bottom action bar (Find a Parent/Class Check In &
// Out/Admin) - both markup shapes are always in the response; only CSS
// (public/css/styles.css's .landing-desktop-only / .landing-mobile-grid)
// decides which one is visible.
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

test('kiosk home: mobile grid/action bar and desktop/tablet top menu/columns both render, CSS picks one', async (t) => {
  const res = await request(app).get('/kiosk');
  assert.equal(res.status, 200);

  await t.test('the mobile-only bottom bar has Find a Parent, Class Check In & Out, and Admin as icon-on-top/label-below tab items', () => {
    const groupMatch = /<footer class="landing-action-bar">([\s\S]*?)<\/footer>/.exec(res.text);
    assert.ok(groupMatch, 'expected a <footer class="landing-action-bar"> group');
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn" href="\/kiosk\/find-parent">/);
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn" href="\/kiosk\/class-checkin">/);
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn" href="\/admin">/);
  });

  await t.test('the desktop/tablet-only top menu bar has all 5 secondary links', () => {
    const groupMatch = /<nav class="landing-top-menu landing-desktop-only">([\s\S]*?)<\/nav>/.exec(res.text);
    assert.ok(groupMatch, 'expected a .landing-top-menu group');
    assert.match(groupMatch[1], /<a class="landing-top-menu-link" href="\/name-tag">/);
    assert.match(groupMatch[1], /<a class="landing-top-menu-link" href="\/absence">/);
    assert.match(groupMatch[1], /<a class="landing-top-menu-link" href="\/kiosk\/find-parent">/);
    assert.match(groupMatch[1], /<a class="landing-top-menu-link" href="\/kiosk\/class-checkin">/);
    assert.match(groupMatch[1], /<a class="landing-top-menu-link" href="\/admin">/);
  });

  await t.test('the desktop/tablet-only columns have Check In/Check Out (green) on the left and Floater Assignments/Setup-Cleanup Teams (purple) on the right', () => {
    const groupMatch = /<div class="landing-columns landing-desktop-only">([\s\S]*?)<\/div>\s*<\/div>\s*<div class="landing-mobile-grid">/.exec(res.text);
    assert.ok(groupMatch, 'expected a .landing-columns group');
    const [leftColumn, rightColumn] = groupMatch[1].split('<div class="landing-column">').slice(1);
    assert.match(leftColumn, /<a class="landing-card landing-card-green landing-card-wide" href="\/kiosk\/checkin">/);
    assert.match(leftColumn, /<a class="landing-card landing-card-green landing-card-wide" href="\/kiosk\/checkout">/);
    assert.match(rightColumn, /<a class="landing-card landing-card-purple landing-card-wide" href="\/volunteers\//);
    assert.match(rightColumn, /<a class="landing-card landing-card-purple landing-card-wide" href="\/setup\//);
  });

  await t.test('the mobile-only grid still has all 6 original cards', () => {
    const groupMatch = /<div class="landing-mobile-grid">([\s\S]*?)<\/div>\s*<\/main>/.exec(res.text);
    assert.ok(groupMatch, 'expected a .landing-mobile-grid group');
    ['/kiosk/checkin', '/kiosk/checkout', '/absence', '/name-tag'].forEach((href) => {
      assert.match(groupMatch[1], new RegExp(`href="${href.replace(/\//g, '\\/')}"`));
    });
    assert.match(groupMatch[1], /href="\/volunteers\//);
    assert.match(groupMatch[1], /href="\/setup\//);
  });

  await t.test('Full Screen View is unaffected, still in its own top-right corner group at every viewport width', () => {
    const topGroupMatch = /<div class="landing-corner-actions">([\s\S]*?)<\/div>/.exec(res.text);
    assert.ok(topGroupMatch);
    assert.match(topGroupMatch[1], /id="fullscreen-toggle-btn"/);
  });

  await t.test('the new owl crest logo is used, not the old logo file', () => {
    assert.match(res.text, /<img class="landing-logo-sm" src="\/img\/logo-owl\.png"/);
  });
});
