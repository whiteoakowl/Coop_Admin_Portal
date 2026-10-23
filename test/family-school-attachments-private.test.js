// Coverage for a real decision: "They should be private" - the
// family-school-attachments Supabase Storage bucket (school logos,
// lesson attachments, journal attachments, weekly planner files) is
// private, not public, so there is no stable public URL for any of
// these files. Serving one instead goes through the app's own proxy-
// download route (routes/family-school-files.js: GET /family-school/
// files/:key), authorized per-request by utils/familySchool.js's own
// attachmentAccessForFamily() - this covers that route end to end:
// the owning family can actually download the real bytes back out
// with the right Content-Type, a different family gets a flat 404 (not
// a hint that the key exists), an unauthenticated request never gets
// served at all, and a student can reach a lesson attachment shared
// with their own family even though the route itself lives outside
// both the /parent and /student routers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `fs-attachments-private-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `fs-attachments-private-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');

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
  const code = `fsattach${counter}`;
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

// A real, 1x1 PNG (not just arbitrary bytes) so Content-Type assertions
// below are checking something genuine, same fixture every other
// family-school upload test already uses.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

async function getFileResponse(url, cookie) {
  return request(app)
    .get(url)
    .set('Cookie', cookie || '')
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

test('a parent can download their own uploaded school logo through the private file route, with the right Content-Type', async () => {
  const familyId = await createFamily('Logo Owner Family');
  const parent = await createPortalMember({ name: 'Logo Owner Parent', familyId, memberType: 'parent', roleKey: 'parent' });

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/settings');
  await request(app)
    .post('/parent/family-school/settings?_csrf=' + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .field('schoolName', 'Private Bucket Academy')
    .field('_csrf', csrf)
    .attach('logo', PNG_1X1, { filename: 'logo.png', contentType: 'image/png' });

  const row = await db.prepare('SELECT logo_key FROM family_school_settings WHERE family_id = ?').get(familyId);
  assert.ok(row.logo_key, 'expected a stored logo_key');

  const fileRes = await getFileResponse(`/family-school/files/${row.logo_key}`, parent.cookie);
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.headers['content-type'], 'image/png');
  assert.ok(fileRes.body.equals(PNG_1X1), 'the served bytes should match the uploaded PNG exactly');
});

// A real bug report: "I can upload and save the photo now but you
// can't see the image. Its broken." Root cause: server.js sets
// X-Content-Type-Options: nosniff globally, so a served file with no
// Content-Type set (Express's default for a raw Buffer is application/
// octet-stream) can't be re-guessed back to "actually an image" by the
// browser - any row missing its mimetype (predates the logo_mime
// column, or just never captured one for some other reason) would
// render as a broken image with no error anywhere. Simulates that by
// nulling out the real logo_mime this fixture just stored.
test('a logo with no stored mimetype still serves with a real image Content-Type, not application/octet-stream', async () => {
  const familyId = await createFamily('Logo No Mime Family');
  const parent = await createPortalMember({ name: 'Logo No Mime Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/settings');
  await request(app)
    .post('/parent/family-school/settings?_csrf=' + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .field('schoolName', 'No Mime Academy')
    .field('_csrf', csrf)
    .attach('logo', PNG_1X1, { filename: 'logo.png', contentType: 'image/png' });
  const row = await db.prepare('SELECT logo_key FROM family_school_settings WHERE family_id = ?').get(familyId);
  await db.prepare('UPDATE family_school_settings SET logo_mime = NULL WHERE family_id = ?').run(familyId);

  const fileRes = await getFileResponse(`/family-school/files/${row.logo_key}`, parent.cookie);
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.headers['content-type'], 'image/png', 'falls back to the .png extension, not application/octet-stream');
  assert.ok(fileRes.body.equals(PNG_1X1));
});

test('a parent from a different family gets a 404 trying the same logo key - never confirms it exists', async () => {
  const ownerFamilyId = await createFamily('Logo Owner Family 2');
  const owner = await createPortalMember({ name: 'Logo Owner Parent 2', familyId: ownerFamilyId, memberType: 'parent', roleKey: 'parent' });
  const csrf = await csrfFrom(owner.cookie, '/parent/family-school/settings');
  await request(app)
    .post('/parent/family-school/settings?_csrf=' + encodeURIComponent(csrf))
    .set('Cookie', owner.cookie)
    .field('schoolName', 'Another Academy')
    .field('_csrf', csrf)
    .attach('logo', PNG_1X1, { filename: 'logo.png', contentType: 'image/png' });
  const row = await db.prepare('SELECT logo_key FROM family_school_settings WHERE family_id = ?').get(ownerFamilyId);

  const intruderFamilyId = await createFamily('Logo Intruder Family');
  const intruder = await createPortalMember({ name: 'Logo Intruder Parent', familyId: intruderFamilyId, memberType: 'parent', roleKey: 'parent' });

  const res = await request(app).get(`/family-school/files/${row.logo_key}`).set('Cookie', intruder.cookie);
  assert.equal(res.status, 404);
});

test('an unauthenticated request to the file route is never served (redirected to login)', async () => {
  const familyId = await createFamily('Logo Anon Family');
  const parent = await createPortalMember({ name: 'Logo Anon Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/settings');
  await request(app)
    .post('/parent/family-school/settings?_csrf=' + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .field('schoolName', 'Anon Test Academy')
    .field('_csrf', csrf)
    .attach('logo', PNG_1X1, { filename: 'logo.png', contentType: 'image/png' });
  const row = await db.prepare('SELECT logo_key FROM family_school_settings WHERE family_id = ?').get(familyId);

  const res = await request(app).get(`/family-school/files/${row.logo_key}`);
  assert.equal(res.status, 302, 'no session at all should redirect to login, not serve the file');
});

// A real feature this bucket also backs: "These classes will then
// appear under the students portal to work ok and complete" - a lesson
// attachment the parent uploaded needs to be fetchable through this
// SAME route from the student side too, even though routes/family-
// school-files.js lives outside both the /parent and /student routers.
test('a student can download a lesson attachment shared with their own family, but a different family cannot', async () => {
  const familyId = await createFamily('Lesson Attachment Family');
  const parent = await createPortalMember({ name: 'Lesson Attachment Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Lesson Attachment Student', familyId, memberType: 'student', roleKey: 'student' });

  let csrf = await csrfFrom(parent.cookie, '/parent/family-school/classes');
  await request(app)
    .post('/parent/family-school/classes?_csrf=' + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ _csrf: csrf, className: 'Private Attachments 101' });
  const cls = await db.prepare('SELECT id FROM family_school_classes WHERE family_id = ?').get(familyId);

  csrf = await csrfFrom(parent.cookie, `/parent/family-school/classes/${cls.id}`);
  await request(app)
    .post(`/parent/family-school/classes/${cls.id}/students?_csrf=` + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ _csrf: csrf, studentIds: String(student.memberId) });

  await request(app)
    .post(`/parent/family-school/classes/${cls.id}/lessons?_csrf=` + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ _csrf: csrf, title: 'Lesson One' });
  const lesson = await db.prepare('SELECT id FROM family_school_lessons WHERE class_id = ?').get(cls.id);

  csrf = await csrfFrom(parent.cookie, `/parent/family-school/lessons/${lesson.id}`);
  await request(app)
    .post(`/parent/family-school/lessons/${lesson.id}/content?_csrf=` + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .field('_csrf', csrf)
    .field('type', 'assignment_upload')
    .field('title', 'Worksheet')
    .attach('attachment', PNG_1X1, { filename: 'worksheet.png', contentType: 'image/png' });
  const contentItem = await db.prepare('SELECT attachment_url, attachment_mime FROM family_school_content_items WHERE lesson_id = ?').get(lesson.id);
  assert.ok(contentItem.attachment_url, 'expected a stored attachment key');
  assert.equal(contentItem.attachment_mime, 'image/png');

  const studentRes = await getFileResponse(`/family-school/files/${contentItem.attachment_url}`, student.cookie);
  assert.equal(studentRes.status, 200, 'the student in this same family should be able to download it');
  assert.equal(studentRes.headers['content-type'], 'image/png');
  assert.ok(studentRes.body.equals(PNG_1X1));

  const outsiderFamilyId = await createFamily('Lesson Attachment Outsider Family');
  const outsider = await createPortalMember({ name: 'Lesson Attachment Outsider', familyId: outsiderFamilyId, memberType: 'parent', roleKey: 'parent' });
  const outsiderRes = await request(app).get(`/family-school/files/${contentItem.attachment_url}`).set('Cookie', outsider.cookie);
  assert.equal(outsiderRes.status, 404);
});
