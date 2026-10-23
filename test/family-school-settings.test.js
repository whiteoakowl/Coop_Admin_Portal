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
const { familySettingsForPdf } = require('../utils/familySchool');

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

test('saving school name/colors/NC ID/homeschooled-since on the Settings page persists and shows back pre-filled', async () => {
  const familyId = await createFamily('Settings Family');
  const parent = await createParent(familyId);

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/settings');
  const res = await request(app)
    .post('/parent/family-school/settings?_csrf=' + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .field('schoolName', 'The Johnson Family Academy')
    .field('colorPrimary', '#123456')
    .field('colorSecondary', '#abcdef')
    .field('colorText', '#334455')
    .field('ncHomeschoolId', '987654')
    .field('homeschooledSince', '2026-08-23')
    .field('_csrf', csrf);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const page = await request(app).get('/parent/family-school/settings').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /value="The Johnson Family Academy"/);
  assert.match(page.text, /value="#123456"/);
  assert.match(page.text, /value="#abcdef"/);
  assert.match(page.text, /value="#334455"/);
  assert.match(page.text, /value="987654"/);
  assert.match(page.text, /name="homeschooledSince" value="2026-08-23"/);
  // A real request: "Primary color should say title color. Secondary
  // color should say background color. Add another color choice for
  // font color."
  assert.match(page.text, /Title Color/);
  assert.match(page.text, /Background Color/);
  assert.match(page.text, /Font Color/);
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

// A real bug report: "the logo the family uploaded is showing broken
// on every pdf for family school management portal." Root cause: the
// live logoUrl points at the private-bucket proxy route, which needs a
// session cookie - fine for a real person's own browser, but the
// headless Chromium that renders a PDF (utils/pdfRender.js) was never
// logged in as anyone, so that same URL always 302'd to login instead
// of the image. familySettingsForPdf() is the fix every /download.pdf
// route now runs its familySettings through first - inlines the real
// bytes as a data: URI, which needs no request (or cookie) at all.
test('familySettingsForPdf inlines the logo as a data: URI instead of the cookie-gated proxy URL', async () => {
  const familyId = await createFamily('Pdf Logo Family');
  const parent = await createParent(familyId);
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/settings');
  await request(app)
    .post('/parent/family-school/settings?_csrf=' + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .field('schoolName', 'Pdf Logo Academy')
    .field('_csrf', csrf)
    .attach('logo', PNG_1X1, { filename: 'logo.png', contentType: 'image/png' });

  const row = await db.prepare('SELECT * FROM family_school_settings WHERE family_id = ?').get(familyId);
  assert.ok(row.logo_key);

  const liveSettings = { ...row, logoUrl: `/family-school/files/${row.logo_key}` };
  const pdfSettings = await familySettingsForPdf(liveSettings);
  assert.match(pdfSettings.logoUrl, /^data:image\/png;base64,/, 'should be an inline data: URI, not the cookie-gated proxy path');
  const embeddedBytes = Buffer.from(pdfSettings.logoUrl.split(',')[1], 'base64');
  assert.ok(embeddedBytes.equals(PNG_1X1), 'the embedded bytes should match the uploaded logo exactly');

  // A family that never uploaded a logo has no logo_key to inline -
  // familySettingsForPdf must pass those settings through unchanged
  // rather than erroring or producing a broken data: URI.
  const noLogoSettings = { ...liveSettings, logo_key: null, logoUrl: null };
  assert.deepEqual(await familySettingsForPdf(noLogoSettings), noLogoSettings);
});

// The end-to-end path behind that same bug report: a real Download PDF
// request, with a real uploaded logo, must still succeed (and keep
// producing a real PDF) now that the logo is served through a private,
// authenticated route rather than a public Storage URL.
test('Download PDF still succeeds with a real PDF when the family has a logo uploaded', async () => {
  const familyId = await createFamily('Pdf Logo Download Family');
  const parent = await createParent(familyId);
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/settings');
  await request(app)
    .post('/parent/family-school/settings?_csrf=' + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .field('schoolName', 'Pdf Download Academy')
    .field('_csrf', csrf)
    .attach('logo', PNG_1X1, { filename: 'logo.png', contentType: 'image/png' });

  const pdfRes = await request(app)
    .get('/parent/family-school/download.pdf')
    .set('Cookie', parent.cookie)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.body.slice(0, 5).toString(), '%PDF-');
});

// A real request: "Secondary color should color the card that shows
// this information on the homepage. Add another color choice for font
// color." - Background Color now fills the Overview card itself (not
// just a border accent), and the new Font Color colors the meta lines
// under the title (the title itself keeps its own, separate Title
// Color).
test('on the homepage, Background Color fills the school-info card and Font Color colors its meta lines', async () => {
  const familyId = await createFamily('Card Color Family');
  const parent = await createParent(familyId);

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/settings');
  await request(app)
    .post('/parent/family-school/settings?_csrf=' + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .field('schoolName', 'Card Color Academy')
    .field('colorPrimary', '#111111')
    .field('colorSecondary', '#222222')
    .field('colorText', '#333333')
    .field('ncHomeschoolId', '555555')
    .field('_csrf', csrf);

  const overview = await request(app).get('/parent/family-school').set('Cookie', parent.cookie);
  assert.equal(overview.status, 200);
  assert.match(overview.text, /class="fs-school-header no-print" style="background-color: #222222;"/);
  assert.match(overview.text, /class="fs-school-header-name" style="color: #111111;"/);
  assert.match(overview.text, /NC Homeschool ID: 555555<\/p>/);
  assert.match(overview.text, /style="color: #333333;">NC Homeschool ID: 555555/);
  assert.doesNotMatch(overview.text, /border-color: #222222/, 'Background Color should fill the card, not just border it');
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

// A real request: "Family school management, settings tab, should move
// to settings gear. Family school management, parent portal have the
// same linked settings gear. This should also be a card view like admin
// gear settings." Covers: the gear icon on both the FSM portal and the
// Parent Portal points at the same new hub page; that hub is a card
// grid (not the bare account-settings list) with a card for the FSM
// settings form and a card for the generic My Privacy page; and the old
// bare "Settings" tab is gone from FSM's own top nav.
test('Settings gear: both Family School Management and Parent Portal gears open the same card-view hub, and the old Settings nav tab is gone', async () => {
  const familyId = await createFamily('Gear Settings Family');
  const parent = await createParent(familyId);

  const fsmHome = await request(app).get('/parent/family-school').set('Cookie', parent.cookie);
  assert.equal(fsmHome.status, 200);
  assert.match(fsmHome.text, /href="\/parent\/family-school\/settings-hub"[^>]*>\s*<svg class="icon"><use href="#icon-gear"\/>/);
  assert.doesNotMatch(fsmHome.text, /href="\/parent\/family-school\/settings"[^>]*>[\s\S]{0,80}Settings</);

  const parentHome = await request(app).get('/parent').set('Cookie', parent.cookie);
  assert.equal(parentHome.status, 200);
  assert.match(parentHome.text, /href="\/parent\/family-school\/settings-hub\?portal=parent"[^>]*>\s*<svg class="icon"><use href="#icon-gear"\/>/);

  const hub = await request(app).get('/parent/family-school/settings-hub').set('Cookie', parent.cookie);
  assert.equal(hub.status, 200);
  assert.match(hub.text, /class="team-card-grid settings-hub-card-grid"/);
  assert.match(hub.text, /href="\/parent\/family-school\/settings"[^>]*>[\s\S]*?Family School Settings/);
  assert.match(hub.text, /href="\/portal\/settings"[^>]*>[\s\S]*?My Privacy/);
  // A later real request: "a notifications settings card to control
  // email, text and push notifications" - links to the existing shared
  // Notification Preferences page rather than a new one.
  assert.match(hub.text, /href="\/notifications\/preferences"[^>]*>[\s\S]*?Notifications/);
});
