// Phase 5 audit item: an axe-core accessibility pass over the app's most
// important screens, wired into CI as its own opt-in step (see
// package.json's "test:a11y" script and .github/workflows/smoke-test.yml)
// rather than folded into the plain `npm test` node:test run.
//
// Why a separate script, not test/*.test.js: node's test runner
// auto-discovers every .js file under any directory literally named
// `test` (see its docs on default test file patterns), so anything in
// test/ - regardless of filename - runs on a bare `npm test`. This suite
// needs a real Chromium browser (Playwright), which most environments
// running the fast, dependency-light `npm test` won't have installed;
// living outside test/ (in a11y/, not matching any of node's other
// default patterns like *.test.js either) keeps it out of that
// auto-discovery entirely, so it only ever runs when explicitly invoked
// via `npm run test:a11y`.
//
// Boots the real app (server.js) on a real bound port - not supertest's
// virtual request/response cycle - because Playwright's browser needs an
// actual URL to navigate to. Each page gets its own fresh browser +
// context, matching the isolation every other route test gets from a
// fresh DB, so one page's failure (or a hung/crashed page) can't affect
// another's result.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `a11y-check-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `a11y-check-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'a11y-check-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'a11ycheckadmin';
process.env.ADMIN_PASSWORD = 'a11ycheckpassword123';

const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');
const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');

const CHROMIUM_PATH = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const PAGE_TIMEOUT_MS = 20000;

let httpServer;
let base;
let adminCookies;
let classCheckinCookies;
let testClassId;
let browser;

test.before(async () => {
  // Every test/routes-*.test.js file awaits this right after requiring
  // server.js - this file just never did, since it lives outside test/
  // and was missed by every sweep that added the same await elsewhere
  // (see MIGRATION.md's "hanging for hours" writeup on why this matters:
  // the db layer is fully async now, so a request/query landing before
  // schema + seeding + roster bootstrap finish can fail on data that
  // doesn't exist yet).
  await app.ready;

  // One browser for the whole file, reused across every page check below
  // (a fresh browser process per page - launched, then thrown away - is
  // the expensive part; a fresh *context* per check, done in axeCheck()
  // below, is all the isolation any of these checks actually need).
  browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

  httpServer = http.createServer(app);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  base = `http://localhost:${httpServer.address().port}`;

  // Admin session, via a raw login POST rather than driving the login
  // form through the browser - faster and avoids coupling this suite's
  // setup to the login page's own markup (which is itself one of the
  // pages under test below).
  const loginRes = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=a11ycheckadmin&password=a11ycheckpassword123`,
    redirect: 'manual',
  });
  adminCookies = parseCookies(loginRes.headers.getSetCookie());

  // Class Check-In kiosk session (separate PIN-gated cookie, unrelated to
  // the admin login above - see routes/kiosk-class-checkin.js).
  const unlockRes = await fetch(`${base}/kiosk/class-checkin/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'pin=0000',
    redirect: 'manual',
  });
  classCheckinCookies = parseCookies(unlockRes.headers.getSetCookie());

  // One real class, enrolled student, and today marked as a session date,
  // so the class list/attendance/scan pages render real content instead
  // of empty states.
  const today = todayISO();
  const studentRoster = await db.prepare("SELECT id FROM rosters WHERE name = 'Monday Students'").get();
  await db
    .prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING')
    .run(studentRoster.id, today);
  const classInfo = await db
    .prepare("INSERT INTO classes (day, hour_position, class_name, color) VALUES ('monday', 1, 'A11y Check Class', '#EE9A4D')")
    .run();
  testClassId = classInfo.lastInsertRowid;
  const rosterInfo = await db
    .prepare("INSERT INTO rosters (name, category, schedule_day) VALUES ('A11y Check Class', 'Class Roster', 'monday')")
    .run();
  await db.prepare('UPDATE classes SET roster_id = ? WHERE id = ?').run(rosterInfo.lastInsertRowid, testClassId);
  const memberInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('A11y Check Kid', 'a11y-check-kid-barcode', 'student')")
    .run();
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')").run(rosterInfo.lastInsertRowid, memberInfo.lastInsertRowid);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')").run(studentRoster.id, memberInfo.lastInsertRowid);
});

test.after(async () => {
  await browser.close();
  httpServer.close();
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function parseCookies(setCookieHeaders) {
  const url = new URL(base || 'http://localhost');
  return (setCookieHeaders || []).map((sc) => {
    const [pair] = sc.split(';');
    const idx = pair.indexOf('=');
    return { name: pair.slice(0, idx), value: pair.slice(idx + 1), domain: url.hostname, path: '/' };
  });
}

// Fresh context per page (the shared browser above is reused, not
// relaunched) and returns the axe-core violations found, formatted for a
// readable assertion failure - the target selector and a one-line
// summary per violating node, not axe's full (much longer) report.
async function axeCheck(urlPath, { cookies } = {}) {
  const context = await browser.newContext();
  try {
    if (cookies && cookies.length) await context.addCookies(cookies);
    const page = await context.newPage();
    // Every page's own <head> (views/partials/head.ejs) pulls the
    // Google Fonts webfont over the real network - fine for real users,
    // but here it means 'load' below can't resolve until that third-
    // party request finishes, and a slow/proxied/offline network turns
    // each of this file's 14 page checks into a ~20s wait apiece (this
    // block is what actually made the run fast again after that was
    // diagnosed). Aborting it is safe for axe-core's own purposes -
    // color-contrast reads computed CSS color values, not glyph
    // rendering, and the fallback stack in styles.css's own font-family
    // rules still applies - so this doesn't change what's being checked,
    // only how long checking it takes to start.
    await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
    await page.goto(base + urlPath, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
    const results = await new AxeBuilder({ page }).analyze();
    return results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
    }));
  } finally {
    await context.close();
  }
}

function assertClean(violations, label) {
  assert.deepEqual(
    violations,
    [],
    `${label} has ${violations.length} accessibility violation(s):\n` +
      violations.map((v) => `  [${v.impact}] ${v.id} - ${v.help}\n` + v.nodes.map((n) => `    ${JSON.stringify(n.target)}: ${n.summary}`).join('\n')).join('\n')
  );
}

test('axe-core accessibility check', { timeout: 600000 }, async (t) => {
  await t.test('home landing page (/)', async () => {
    assertClean(await axeCheck('/'), '/');
  });

  await t.test('kiosk home (/kiosk)', async () => {
    assertClean(await axeCheck('/kiosk'), '/kiosk');
  });

  await t.test('admin login (/admin/login)', async () => {
    assertClean(await axeCheck('/admin/login'), '/admin/login');
  });

  await t.test('main kiosk check-in (/kiosk/checkin)', async () => {
    assertClean(await axeCheck('/kiosk/checkin'), '/kiosk/checkin');
  });

  await t.test('main kiosk check-out (/kiosk/checkout)', async () => {
    assertClean(await axeCheck('/kiosk/checkout'), '/kiosk/checkout');
  });

  await t.test('find a parent (/kiosk/find-parent)', async () => {
    assertClean(await axeCheck('/kiosk/find-parent'), '/kiosk/find-parent');
  });

  await t.test('class check-in PIN page (/kiosk/class-checkin)', async () => {
    assertClean(await axeCheck('/kiosk/class-checkin'), '/kiosk/class-checkin');
  });

  await t.test('class check-in day picker (unlocked)', async () => {
    assertClean(await axeCheck('/kiosk/class-checkin/classes', { cookies: classCheckinCookies }), '/kiosk/class-checkin/classes');
  });

  await t.test("class check-in day's class list (unlocked)", async () => {
    assertClean(
      await axeCheck('/kiosk/class-checkin/classes/monday', { cookies: classCheckinCookies }),
      '/kiosk/class-checkin/classes/monday'
    );
  });

  await t.test('class check-in attendance sheet (unlocked)', async () => {
    assertClean(
      await axeCheck(`/kiosk/class-checkin/classes/${testClassId}/attendance`, { cookies: classCheckinCookies }),
      `/kiosk/class-checkin/classes/${testClassId}/attendance`
    );
  });

  await t.test('class check-in scan page (unlocked)', async () => {
    assertClean(
      await axeCheck(`/kiosk/class-checkin/classes/${testClassId}/scan?mode=checkin`, { cookies: classCheckinCookies }),
      `/kiosk/class-checkin/classes/${testClassId}/scan`
    );
  });

  await t.test('admin dashboard (/admin, logged in)', async () => {
    assertClean(await axeCheck('/admin', { cookies: adminCookies }), '/admin');
  });

  await t.test('admin members list (/admin/members, logged in)', async () => {
    assertClean(await axeCheck('/admin/members', { cookies: adminCookies }), '/admin/members');
  });

  await t.test('admin settings (/admin/settings, logged in)', async () => {
    assertClean(await axeCheck('/admin/settings', { cookies: adminCookies }), '/admin/settings');
  });
});
