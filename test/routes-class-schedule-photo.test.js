// A real request: "sql editor copy paste should be for event photo,
// class photo and shop photo" - events and store products already had a
// photo; this adds the same one-optional-photo feature to classes
// (utils/classSchedule.js's own setClassImage/classImageUrl, mirroring
// routes/admin-events.js's own saveEventImage), on the Co-op Admin's
// Class Details form, and shown on a parent's own "view a class" popup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-photo-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-photo-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { generateMemberCode } = require('../utils/members');
const { hashPassword } = require('../utils/portalAuth');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

async function createClass(admin, overrides) {
  const className = (overrides && overrides.className) || 'Photo Test Class';
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      day: 'monday',
      className,
      hourPosition: '1',
      room: 'Room A',
      color: '#EE9A4D',
      startTime: '9:00 AM',
      endTime: '9:45 AM',
      _csrf: admin.csrfToken,
      ...overrides,
    });
  return db.prepare('SELECT * FROM classes WHERE class_name = ?').get(className);
}

test('Class Details form has a photo upload field, and the manage page shows nothing before one is set', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin);

  const page = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /enctype="multipart\/form-data"/);
  assert.match(page.text, /name="image" accept="image\/\*"/);
  assert.doesNotMatch(page.text, /<img src="[^"]*" alt="" style="max-width: 240px/);
});

test('uploading a class photo saves image_key and the manage page then shows it', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Photo Upload Class' });

  // Multipart forms carry the CSRF token as a query param, not a body
  // field - middleware/csrfProtection.js is mounted ahead of the
  // per-route multer middleware that would parse a multipart body.
  const res = await request(app)
    .post(`/admin/class-schedule/classes/${cls.id}?_csrf=${encodeURIComponent(admin.csrfToken)}`)
    .set('Cookie', admin.cookie)
    .field('className', 'Photo Upload Class')
    .field('hourPosition', '1')
    .field('color', '#EE9A4D')
    .attach('image', Buffer.from('fake jpeg bytes'), { filename: 'class.jpg', contentType: 'image/jpeg' });
  assert.equal(res.status, 302);

  const updated = await db.prepare('SELECT * FROM classes WHERE id = ?').get(cls.id);
  assert.ok(updated.image_key, 'expected image_key to be set after uploading a photo');

  const manage = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage`).set('Cookie', admin.cookie);
  assert.match(manage.text, new RegExp(`<img src="/uploads/classes/${updated.image_key}"`));
});

test('a class photo shows on a parent\'s own view-class popup', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Parent View Photo Class' });

  await request(app)
    .post(`/admin/class-schedule/classes/${cls.id}?_csrf=${encodeURIComponent(admin.csrfToken)}`)
    .set('Cookie', admin.cookie)
    .field('className', 'Parent View Photo Class')
    .field('hourPosition', '1')
    .field('color', '#EE9A4D')
    .attach('image', Buffer.from('fake jpeg bytes'), { filename: 'class.jpg', contentType: 'image/jpeg' });
  const updated = await db.prepare('SELECT * FROM classes WHERE id = ?').get(cls.id);

  // A parent account, minimal setup, just enough to view the class fragment.
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Photo Parent Family')).lastInsertRowid;
  const code = await generateMemberCode();
  const memberInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run('Photo Parent', code, code, familyId);
  const email = 'photo-parent@example.com';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(memberInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];

  const fragment = await request(app).get(`/parent/classes/${cls.id}/fragment`).set('Cookie', cookie);
  assert.equal(fragment.status, 200);
  assert.match(fragment.text, new RegExp(`<img src="/uploads/classes/${updated.image_key}"`));
});
