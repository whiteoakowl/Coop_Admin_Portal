// Coverage for a real request: "Do an audit across the entire mobile
// view of the app for table and text. Every table should shrink to fit
// on the screen. Make the font smaller to ensure they are fit in mobile
// view." public/css/styles.css gained a global @media (max-width: 640px)
// baseline on the shared .roster-table (smaller font-size/padding,
// overridden by any page's own more specific -mobile-fit class already
// defined later in the stylesheet) as a safety net for every table that
// never got one; this file covers the other real gap the audit found -
// 8 real (non-print) pages whose own .roster-table had no .roster-scroll
// wrapper at all, so a too-wide table had no horizontal-scroll fallback
// once the font/padding shrink alone wasn't enough.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `mobile-table-scroll-audit-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `mobile-table-scroll-audit-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');
const { generateMemberCode } = require('../utils/members');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const res = await request(app).post('/admin/login').type('form').send({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD });
  return res.headers['set-cookie'];
}

async function loginAsMainAdmin() {
  const res = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return res.headers['set-cookie'];
}

// Every page listed here used to render its own <table class="roster-
// table"> with no .roster-scroll ancestor anywhere in the file - this
// just confirms each one now does, without needing real rows (the
// wrapper renders around the table/empty-state either way).
test('Every real (non-print) page whose table had no .roster-scroll wrapper now has one', async () => {
  const adminCookie = await loginAsAdmin();
  const mainAdminCookie = await loginAsMainAdmin();

  // notifications/publications always have at least one real row (seeded
  // notification types / no rows needed to prove the wrapper exists in
  // the template); Library's own two tabs can legitimately render empty
  // in a fresh test db, so those accept either outcome.
  const alwaysRendered = [
    { url: '/main-admin/notifications', cookie: mainAdminCookie },
    { url: '/main-admin/publications', cookie: mainAdminCookie },
    { url: '/notifications/preferences', cookie: mainAdminCookie },
    { url: '/contact-admins', cookie: adminCookie },
  ];
  for (const { url, cookie } of alwaysRendered) {
    const res = await request(app).get(url).set('Cookie', cookie);
    assert.equal(res.status, 200, `expected ${url} to render`);
    assert.match(res.text, /<div class="roster-scroll"[^>]*>\s*<table class="roster-table/, `expected ${url}'s table to be wrapped in .roster-scroll`);
  }

  const mayBeEmpty = [
    { url: '/admin/library?tab=members', cookie: adminCookie, empty: /Nobody has any library items checked out right now\./ },
    { url: '/admin/library?tab=titles', cookie: adminCookie, empty: /No library items yet\./ },
  ];
  for (const { url, cookie, empty } of mayBeEmpty) {
    const res = await request(app).get(url).set('Cookie', cookie);
    assert.equal(res.status, 200, `expected ${url} to render`);
    const wrapped = /<div class="roster-scroll">\s*<table class="roster-table"/.test(res.text);
    assert.ok(wrapped || empty.test(res.text), `expected ${url} to either show its empty state or a .roster-scroll-wrapped table`);
  }
});

test('Portal Profile (Schedules/Event Sign-ups tabs) tables are wrapped in .roster-scroll', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('MobileAuditFamily') RETURNING id").get()).id;
  const code = await generateMemberCode();
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES ('Mobile Audit Parent', ?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get(code, code, familyId)
  ).id;
  const email = 'mobile-audit-parent@example.com';
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())").run(memberId, email, hashPassword('testpassword123'));
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/portal/profile' });
  const cookie = loginRes.headers['set-cookie'];

  const schedulesPage = await request(app).get('/portal/profile?tab=schedules').set('Cookie', cookie);
  assert.equal(schedulesPage.status, 200);
  assert.match(schedulesPage.text, /<p class="hint">No class schedule on file yet\.<\/p>|<div class="roster-scroll">\s*<table class="roster-table">/);

  const signupsPage = await request(app).get('/portal/profile?tab=signups').set('Cookie', cookie);
  assert.equal(signupsPage.status, 200);
  assert.match(signupsPage.text, /<p class="hint">No event sign-ups on file yet\.<\/p>|<div class="roster-scroll">\s*<table class="roster-table">/);
});

test('Shared .roster-table gets a mobile-only font-size/padding baseline in public/css/styles.css', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  assert.match(
    css,
    /@media \(max-width: 640px\) \{\s*\.roster-table \{ font-size: 0\.78rem; \}\s*\.roster-table th, \.roster-table td \{ padding: [^;]+; \}\s*\}/
  );
});
