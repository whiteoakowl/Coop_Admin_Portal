// Real HTTP-level coverage for the kiosk home screen (views/kiosk-
// home.ejs, the /kiosk full-screen view - the site root now serves the
// new public marketing homepage instead, see routes/public-site.js; a
// physical kiosk device bookmarks this /kiosk route directly). A
// desktop/tablet-only orange top menu bar
// (Name Tag Form, Absence/Late Form, Find a Parent, Class Check In &
// Out, Admin), two stacked desktop/tablet button columns (Check In/
// Check Out - green; Floater Assignments/Setup-Cleanup Teams - purple),
// a mobile-only 4-button grid in that same order/coloring (Name Tag
// Form and Absence/Late Form deliberately dropped from the mobile grid
// - they live in the mobile bottom bar instead), and a mobile-only
// bottom bar carrying all 5 top-menu links with a vertical divider
// between each. Below 640px the desktop shapes are hidden and the
// mobile ones take over instead - both markup shapes are always in the
// response; only CSS (public/css/styles.css's .landing-desktop-only /
// .landing-mobile-grid) decides which one is visible.
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

  await t.test('the mobile-only bottom bar has all 5 top-menu links (Name Tag Form, Absence/Late Form, Find a Parent, Class Check In & Out, Admin) as icon-on-top/label-below tab items', () => {
    const groupMatch = /<footer class="landing-action-bar">([\s\S]*?)<\/footer>/.exec(res.text);
    assert.ok(groupMatch, 'expected a <footer class="landing-action-bar"> group');
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn" href="\/name-tag">/);
    assert.match(groupMatch[1], /<a class="landing-action-bar-btn" href="\/absence">/);
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
    const groupMatch = /<div class="landing-columns landing-desktop-only">([\s\S]*?)<\/div>\s*<\/div>/.exec(res.text);
    assert.ok(groupMatch, 'expected a .landing-columns group');
    const [leftColumn, rightColumn] = groupMatch[1].split('<div class="landing-column">').slice(1);
    assert.match(leftColumn, /<a class="landing-card landing-card-green landing-card-wide" href="\/kiosk\/checkin">/);
    assert.match(leftColumn, /<a class="landing-card landing-card-green landing-card-wide" href="\/kiosk\/checkout">/);
    assert.match(rightColumn, /<a class="landing-card landing-card-purple landing-card-wide" href="\/volunteers">/);
    assert.match(rightColumn, /<a class="landing-card landing-card-purple landing-card-wide" href="\/setup">/);
  });

  await t.test('the mobile-only grid has exactly 4 cards, in order Check In, Check Out (green), Floater Assignments, Setup/Cleanup Teams (purple) - Name Tag Form/Absence/Late Form live in the bottom bar instead', () => {
    const groupMatch = /<div class="landing-mobile-grid">([\s\S]*?)<\/div>\s*<\/main>/.exec(res.text);
    assert.ok(groupMatch, 'expected a .landing-mobile-grid group');
    const labels = [...groupMatch[1].matchAll(/<span class="landing-label">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(labels, ['Check In', 'Check Out', 'Floater Assignments', 'Setup/Cleanup Teams']);
    assert.match(groupMatch[1], /<a class="landing-card landing-card-green" href="\/kiosk\/checkin">/);
    assert.match(groupMatch[1], /<a class="landing-card landing-card-green" href="\/kiosk\/checkout">/);
    assert.match(groupMatch[1], /<a class="landing-card landing-card-purple" href="\/volunteers">/);
    assert.match(groupMatch[1], /<a class="landing-card landing-card-purple" href="\/setup">/);
  });

  // A real request: "remove full screen button on all kiosk pages now
  // that we have the kiosk button." The small standalone Full Screen
  // View corner icon this page used to also show is gone - the Kiosk
  // Mode button (#kiosk-mode-btn / #kiosk-mode-btn-mobile) below is the
  // only fullscreen entry point on the kiosk home page now.
  await t.test('the old standalone Full Screen View corner button is gone - Kiosk Mode is the only fullscreen entry point', () => {
    assert.doesNotMatch(res.text, /class="landing-corner-actions"/);
    assert.doesNotMatch(res.text, /id="fullscreen-toggle-btn"/);
    assert.match(res.text, /id="kiosk-mode-btn"/);
    assert.match(res.text, /id="kiosk-mode-btn-mobile"/);
  });

  await t.test('the new owl crest logo is used, not the old logo file', () => {
    assert.match(res.text, /<img class="landing-logo-sm" src="\/img\/logo-owl\.png"/);
  });

  // A real bug report: "exiting full screen on kiosk should ask for an
  // id number, otherwis it's stays in full screen kiosk mode." The Exit
  // Full Screen button existed with nothing wired to gate it - the PIN
  // dialog partial was never included on this page at all, so public/js/
  // fullscreen-toggle.js's own requestExit() fell straight through to
  // document.exitFullscreen() with no prompt. It now points at the
  // kiosk's own unauthenticated verify route (the default admin one
  // would 401/redirect here - the kiosk has no admin session).
  await t.test('the PIN dialog is included, pointed at the kiosk\'s own unauthenticated verify route', () => {
    assert.match(res.text, /id="fullscreen-exit-pin-dialog"/);
    assert.match(res.text, /data-verify-url="\/kiosk\/fullscreen\/verify-pin"/);
    assert.match(res.text, /<form method="POST" action="\/kiosk\/fullscreen\/verify-pin">/);
  });
});

test('POST /kiosk/fullscreen/verify-pin: the kiosk\'s own unauthenticated equivalent of the admin route', async (t) => {
  await t.test('the correct PIN succeeds with no admin session at all', async () => {
    const res = await request(app).post('/kiosk/fullscreen/verify-pin').type('form').send({ pin: '0000' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  await t.test('an incorrect PIN is rejected', async () => {
    const res = await request(app).post('/kiosk/fullscreen/verify-pin').type('form').send({ pin: '9999' });
    assert.equal(res.status, 401);
    assert.equal(res.body.ok, false);
  });
});
