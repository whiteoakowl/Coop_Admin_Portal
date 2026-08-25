// Route-level coverage for Global Search (Community & Commerce track,
// item 14), mounted at /search - not to be confused with the
// pre-existing Track A /admin/search (routes/admin-search.js, its own
// test/routes-search.test.js), an unrelated member-lookup tool this
// track never touches. See utils/globalSearch.js's own header comment:
// every source is fetched through the SAME already-access-checked
// listing function its own member-facing router already calls, so
// search never bypasses a visibility check a browsing page would have
// enforced - this file's own private-class-forum test is the clearest
// proof of that.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `global-search-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `global-search-test-uploads-${process.pid}`);
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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyName = `Search Test Family ${familyCounter}`;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Search Parent ${familyCounter}`, code, code, familyId);
  const email = `searchparent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/search' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/search').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid, familyId };
}

test('search requires sign-in', async () => {
  const res = await request(app).get('/search?q=anything');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\?next=/);
});

test('an empty query returns no results without erroring', async () => {
  const parent = await createParentAccount();
  const res = await request(app).get('/search').set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
});

test('a query with no matches returns a clean empty state', async () => {
  const parent = await createParentAccount();
  const res = await request(app).get('/search?q=zzzznonexistentquery9999').set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /No results/);
});

test('search finds a published event by title', async () => {
  const admin = await loginAsMainAdmin();
  const parent = await createParentAccount();
  const createRes = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Unique Autumn Harvest Fair', startsAt: '2027-02-01T10:00', visibility: 'members', _csrf: admin.csrfToken });
  const eventId = /\/main-admin\/events\/(\d+)\/builder/.exec(createRes.headers.location)[1];
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });

  const res = await request(app).get('/search?q=Autumn Harvest').set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Unique Autumn Harvest Fair/);
  assert.match(res.text, new RegExp(`/events/${eventId}"`));
});

test('search finds an active store product', async () => {
  const admin = await loginAsMainAdmin();
  const parent = await createParentAccount();
  const createRes = await request(app).post('/main-admin/store').set('Cookie', admin.cookie).type('form').send({ name: 'Distinctive Zebra Water Bottle', price: '12.00', availability: 'online', _csrf: admin.csrfToken });
  const productId = /\/main-admin\/store\/(\d+)\/edit/.exec(createRes.headers.location)[1];
  await request(app).post(`/main-admin/store/${productId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'active', _csrf: admin.csrfToken });

  const res = await request(app).get('/search?q=Zebra Water Bottle').set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Distinctive Zebra Water Bottle/);
});

test('a private class forum thread is only found in search by that class\'s own enrolled family, never by an outsider', async () => {
  const admin = await loginAsMainAdmin();
  const classInfo = await db.prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 2, 'Search Test Pottery')").run();
  const classId = classInfo.lastInsertRowid;

  const enrolledParent = await createParentAccount();
  const studentCode = await generateMemberCode();
  const studentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES ('Pottery Student', ?, ?, 'student', ?, 1)")
    .run(studentCode, studentCode, enrolledParent.familyId);
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, studentInfo.lastInsertRowid);

  const outsiderParent = await createParentAccount();

  const catRes = await request(app)
    .post('/main-admin/forums')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Search Test Pottery Forum', scope: 'class', classId: String(classId), _csrf: admin.csrfToken });
  assert.equal(catRes.status, 302);
  const category = await db.prepare("SELECT id FROM forum_categories WHERE name = 'Search Test Pottery Forum'").get();

  await request(app)
    .post(`/forums/${category.id}/threads`)
    .set('Cookie', enrolledParent.cookie)
    .type('form')
    .send({ title: 'Secretive Glaze Recipe Thread', body: 'Only pottery families should see this.', _csrf: enrolledParent.csrfToken });

  const outsiderSearch = await request(app).get('/search?q=Secretive Glaze').set('Cookie', outsiderParent.cookie);
  assert.equal(outsiderSearch.status, 200);
  assert.doesNotMatch(outsiderSearch.text, /Secretive Glaze Recipe Thread/);

  const enrolledSearch = await request(app).get('/search?q=Secretive Glaze').set('Cookie', enrolledParent.cookie);
  assert.equal(enrolledSearch.status, 200);
  assert.match(enrolledSearch.text, /Secretive Glaze Recipe Thread/);
});
