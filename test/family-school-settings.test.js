// Coverage for a real request: "Family school management settings
// subpage. Parent can add school name, school logo and colors. NC
// homeschool ID number. The school name, logo and colors will be used
// as the header for all family school management pdf pages and
// printing pages." utils/familySchool.js's own getFamilySchoolSettings/
// saveFamilySchoolSettings, routes/parent-family-school.js's new GET/
// POST /family-school/settings, and the shared views/partials/family-
// school-print-header.ejs every *-print.ejs view now reads from.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `fs-settings-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `fs-settings-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');
test.before(() => app.ready);
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let counter = 0;
async function createFamily(name) {
  counter += 1;
  return (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`${name} ${counter}`)).id;
}

async function createParent(familyId) {
  counter += 1;
  const code = `fsset${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get(`Parent ${counter}`, code, code, familyId)
  ).id;
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  return { memberId, cookie: loginRes.headers['set-cookie'] };
}

async function csrfFrom(cookie, url) {
  const page = await request(app).get(url).set('Cookie', cookie);
  return /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

test('saving school name/colors/NC ID on the Settings page persists and shows back pre-filled', async () => {
  const familyId = await createFamily('Settings Family');
  const parent = await createParent(familyId);

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/settings');
  const res = await request(app)
    .post('/parent/family-school/settings?_csrf=' + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .field('schoolName', 'The Johnson Family Academy')
    .field('colorPrimary', '#123456')
    .field('colorSecondary', '#abcdef')
    .field('ncHomeschoolId', '987654')
    .field('_csrf', csrf);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const page = await request(app).get('/parent/family-school/settings').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /value="The Johnson Family Academy"/);
  assert.match(page.text, /value="#123456"/);
  assert.match(page.text, /value="#abcdef"/);
  assert.match(page.text, /value="987654"/);
});

test('uploading a logo stores it and the preview/header both show it', async () => {
  const familyId = await createFamily('Logo Family');
  const parent = await createParent(familyId);

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/settings');
  const res = await request(app)
    .post('/parent/family-school/settings?_csrf=' + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .field('schoolName', 'Logo Test Academy')
    .field('_csrf', csrf)
    .attach('logo', PNG_1X1, { filename: 'logo.png', contentType: 'image/png' });
  assert.equal(res.status, 302);

  const page = await request(app).get('/parent/family-school/settings').set('Cookie', parent.cookie);
  assert.match(page.text, /fs-settings-logo-preview/);

  const row = await db.prepare('SELECT logo_key FROM family_school_settings WHERE family_id = ?').get(familyId);
  assert.ok(row.logo_key, 'expected a stored logo_key');

  const overview = await request(app).get('/parent/family-school').set('Cookie', parent.cookie);
  assert.equal(overview.status, 200);
});

test('the school name/logo/colors appear as the print header on every Family School Management print page', async () => {
  const familyId = await createFamily('Branding Family');
  const parent = await createParent(familyId);
  const student = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Branding Student', 'branding-student-barcode', 'student', ?, 1) RETURNING id")
      .get(familyId)
  ).id;
  void student;

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/settings');
  await request(app)
    .post('/parent/family-school/settings?_csrf=' + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .field('schoolName', 'Branded Homeschool Co-op')
    .field('colorPrimary', '#ff0000')
    .field('_csrf', csrf);

  const pages = [
    '/parent/family-school/print',
    '/parent/family-school/grades/print',
    '/parent/family-school/attendance/print',
    '/parent/family-school/journal/print',
    '/parent/family-school/annual-planner/print',
  ];
  for (const url of pages) {
    const res = await request(app).get(url).set('Cookie', parent.cookie);
    assert.equal(res.status, 200, `expected 200 from ${url}`);
    assert.match(res.text, /Branded Homeschool Co-op/, `expected branded school name on ${url}`);
    // The site's own <title>/nav brand (always "Sanford Homeschoolers")
    // is untouched - only the print-header's own title line, which
    // this family's own settings now drive, needs to NOT be the
    // generic fallback.
    const printHeaderMatch = /<div class="print-header family-school-print-header">[\s\S]*?<\/div>\s*<\/div>/.exec(res.text);
    assert.ok(printHeaderMatch, `expected a print-header block on ${url}`);
    assert.doesNotMatch(printHeaderMatch[0], /Sanford Homeschoolers/, `expected the generic fallback name gone from the print header on ${url}`);
    assert.match(res.text, /color:\s*#ff0000/, `expected the primary color applied on ${url}`);
  }
});

test('a family with no settings saved yet still falls back to the generic Sanford Homeschoolers header', async () => {
  const familyId = await createFamily('No Settings Family');
  const parent = await createParent(familyId);
  void familyId;

  const res = await request(app).get('/parent/family-school/print').set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Sanford Homeschoolers/);
});
