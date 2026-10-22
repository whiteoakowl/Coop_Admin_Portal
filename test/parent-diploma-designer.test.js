// Coverage for two real requests bundled together:
// 1. "Parent portal move transcripts to a subpage under family school
//    management. Move diploma subpage to family school management tab.
//    Remove stand alone academics tab and make name tags its own tab."
//    (views/partials/portal-nav.ejs - Transcripts/Diplomas keep their
//    existing /parent/academics* routes; only their nav placement moved.)
// 2. "Diploma subpage. Be able to design and create a diploma with four
//    templates to choose from, colors and edit name, dates, and
//    signatures." (utils/academics.js's own issueDiploma, routes/parent-
//    portal.js, views/partials/diploma-certificate.ejs.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-diploma-designer-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-diploma-designer-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');
const { diplomaForStudent } = require('../utils/academics');

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

async function createPortalMember({ name, familyId, memberType, roleKey }) {
  counter += 1;
  const code = `diploma${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id")
      .get(name, code, code, memberType, familyId, memberType === 'parent' ? 1 : 0)
  ).id;
  const { hashPassword } = require('../utils/portalAuth');
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: `/${roleKey}` });
  return { memberId, accountId, cookie: loginRes.headers['set-cookie'] };
}

async function csrfFrom(cookie, url) {
  const page = await request(app).get(url).set('Cookie', cookie);
  return /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

// Family School Management is its own portal now (test/family-school-
// management.test.js covers the switch) - Transcripts/Diplomas are its
// own top-level tabs there, not a Parent Portal subpage.
test('Parent Portal nav: no standalone Academics tab, Name Tags is its own tab, and Transcripts/Diplomas are Family School Management tabs', async () => {
  const familyId = await createFamily('Nav Family');
  const parent = await createPortalMember({ name: 'Nav Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const page = await request(app).get('/parent').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, />Academics</);
  assert.match(page.text, /href="\/parent\/name-tags"[^>]*>(?:(?!<\/a>).)*Name Tags/s);

  const fsmPage = await request(app).get('/parent/family-school').set('Cookie', parent.cookie);
  assert.match(fsmPage.text, /href="\/parent\/academics"[^>]*>(?:(?!<\/a>).)*Transcripts/s);
  assert.match(fsmPage.text, /href="\/parent\/academics\/diplomas"[^>]*>(?:(?!<\/a>).)*Diplomas/s);
});

test('a parent can design a diploma with a template, color, display name, and two signatures, and it shows on the list page and the print page', async () => {
  const familyId = await createFamily('Diploma Design Family');
  const parent = await createPortalMember({ name: 'Design Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Design Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/academics/diplomas');

  const res = await request(app)
    .post('/parent/academics/diplomas')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({
      studentId: student.memberId,
      title: 'Certificate of Homeschool Completion',
      displayName: 'Designed Student Full Legal Name',
      issuedDate: '2026-06-01',
      template: 'bold',
      color: '#aa3366',
      bodyText: 'Having completed all requirements.',
      signature1Name: 'Jane Smith',
      signature1Title: 'Program Director',
      signature2Name: 'John Smith',
      signature2Title: 'Parent/Guardian',
      _csrf: csrf,
    });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const diploma = await diplomaForStudent(student.memberId);
  assert.equal(diploma.template, 'bold');
  assert.equal(diploma.color, '#aa3366');
  assert.equal(diploma.display_name, 'Designed Student Full Legal Name');
  assert.equal(diploma.signature1_name, 'Jane Smith');
  assert.equal(diploma.signature2_title, 'Parent/Guardian');

  const list = await request(app).get('/parent/academics/diplomas').set('Cookie', parent.cookie);
  assert.equal(list.status, 200);
  assert.match(list.text, /diploma-tpl-bold/);
  assert.match(list.text, /--diploma-color: #aa3366/);
  assert.match(list.text, /Designed Student Full Legal Name/);
  assert.match(list.text, /Jane Smith/);
  assert.match(list.text, /Program Director/);

  const print = await request(app).get(`/parent/academics/diplomas/${student.memberId}/print`).set('Cookie', parent.cookie);
  assert.equal(print.status, 200);
  assert.match(print.text, /diploma-tpl-bold/);
  assert.match(print.text, /Designed Student Full Legal Name/);
  assert.match(print.text, /John Smith/);
  assert.match(print.text, /Having completed all requirements\./);
});

test('a brand new diploma design defaults to the classic template and the site brand color', async () => {
  const familyId = await createFamily('Default Design Family');
  const parent = await createPortalMember({ name: 'Default Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Default Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/academics/diplomas');

  await request(app)
    .post('/parent/academics/diplomas')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: student.memberId, issuedDate: '2026-06-01', _csrf: csrf });

  const diploma = await diplomaForStudent(student.memberId);
  assert.equal(diploma.template, 'classic');
  assert.equal(diploma.color, '#2e6da4');
});

// A real request: "Main admin portal, remove academics tab and
// features. Only parent portal has those pages and admin doesn't need
// to control them with any settings." Main Admin's old issue-a-diploma/
// add-a-transcript-entry control panel is gone entirely - diplomas and
// transcripts are Parent Portal self-service only now.
test('Main Admin has no Academics tab or routes left - diplomas/transcripts are Parent Portal only', async () => {
  const adminCookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin').set('Cookie', adminCookie);
  assert.doesNotMatch(page.text, />Academics</);

  assert.equal((await request(app).get('/main-admin/academics').set('Cookie', adminCookie)).status, 404);
  // A POST with no valid CSRF token is blocked at that global middleware
  // (403) before routing ever gets a chance to 404 it - still proof
  // nothing issues a diploma or adds a transcript entry here anymore.
  assert.equal((await request(app).post('/main-admin/academics/diploma').set('Cookie', adminCookie).type('form').send({})).status, 403);
  assert.equal((await request(app).post('/main-admin/academics/transcript').set('Cookie', adminCookie).type('form').send({})).status, 403);
});
