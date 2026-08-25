// Route-level coverage for Photos/Albums and Publications/Articles
// (Community & Commerce track, item 12). See the migration's own header
// comment: visibility defaults to 'members' on both, 'public' is a
// deliberate, separate admin choice - never the default, given photo
// privacy. Photo files are proxied through an authenticated route
// (routes/photos.js), never a public bucket URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `photos-pubs-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `photos-pubs-test-uploads-${process.pid}`);
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
  const familyName = `Test Family ${familyCounter}`;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Parent ${familyCounter}`, code, code, familyId);
  const email = `parent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/photos' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/photos').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createAlbum(admin, visibility) {
  const res = await request(app).post('/main-admin/photos').set('Cookie', admin.cookie).type('form').send({ title: `Album ${visibility}-${Date.now()}`, visibility, _csrf: admin.csrfToken });
  return /\/main-admin\/photos\/(\d+)\/edit/.exec(res.headers.location)[1];
}

async function uploadPhoto(admin, albumId) {
  // Multipart forms carry the CSRF token as a query param, not a body
  // field - middleware/csrfProtection.js's own comment explains why
  // (it's mounted ahead of the per-route multer middleware that would
  // parse a multipart body, so req.body._csrf isn't populated yet).
  const res = await request(app)
    .post(`/main-admin/photos/${albumId}/photos?_csrf=${encodeURIComponent(admin.csrfToken)}`)
    .set('Cookie', admin.cookie)
    .field('caption', 'A test photo')
    .attach('images', Buffer.from('fake jpeg bytes'), { filename: 'test.jpg', contentType: 'image/jpeg' });
  assert.equal(res.status, 302);
  const photo = await db.prepare('SELECT * FROM photo_album_photos WHERE album_id = ? ORDER BY id DESC LIMIT 1').get(albumId);
  return photo;
}

test('admin photos requires sign-in', async () => {
  const res = await request(app).get('/main-admin/photos');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\?next=/);
});

test('admin publications requires sign-in', async () => {
  const res = await request(app).get('/main-admin/publications');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\?next=/);
});

test('a members-only album 404s for a signed-out visitor and its photo is unreachable by direct URL', async () => {
  const admin = await loginAsMainAdmin();
  const albumId = await createAlbum(admin, 'members');
  const photo = await uploadPhoto(admin, albumId);

  const albumPage = await request(app).get(`/photos/${albumId}`);
  assert.equal(albumPage.status, 302);
  assert.match(albumPage.headers.location, /^\/login\?next=/);

  const imageRes = await request(app).get(`/photos/${albumId}/image/${photo.id}`);
  assert.equal(imageRes.status, 302);
  assert.match(imageRes.headers.location, /^\/login\?next=/);
});

test('a members-only album is viewable, including its photo, by any signed-in member', async () => {
  const admin = await loginAsMainAdmin();
  const parent = await createParentAccount();
  const albumId = await createAlbum(admin, 'members');
  const photo = await uploadPhoto(admin, albumId);

  const albumPage = await request(app).get(`/photos/${albumId}`).set('Cookie', parent.cookie);
  assert.equal(albumPage.status, 200);
  assert.match(albumPage.text, /A test photo/);

  const imageRes = await request(app).get(`/photos/${albumId}/image/${photo.id}`).set('Cookie', parent.cookie);
  assert.equal(imageRes.status, 200);
});

test('a public album and its photo are viewable by a signed-out visitor', async () => {
  const admin = await loginAsMainAdmin();
  const albumId = await createAlbum(admin, 'public');
  const photo = await uploadPhoto(admin, albumId);

  const albumPage = await request(app).get(`/photos/${albumId}`);
  assert.equal(albumPage.status, 200);

  const imageRes = await request(app).get(`/photos/${albumId}/image/${photo.id}`);
  assert.equal(imageRes.status, 200);

  const listPage = await request(app).get('/photos');
  assert.equal(listPage.status, 200);
  assert.match(listPage.text, new RegExp(`/photos/${albumId}"`));
});

test('a new album defaults to members-only, not public', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app).post('/main-admin/photos').set('Cookie', admin.cookie).type('form').send({ title: 'Default Visibility Album', _csrf: admin.csrfToken });
  const albumId = /\/main-admin\/photos\/(\d+)\/edit/.exec(res.headers.location)[1];
  const album = await db.prepare('SELECT * FROM photo_albums WHERE id = ?').get(albumId);
  assert.equal(album.visibility, 'members');
});

test('a draft publication 404s even by direct URL; publishing makes it visible', async () => {
  const admin = await loginAsMainAdmin();
  const createRes = await request(app).post('/main-admin/publications').set('Cookie', admin.cookie).type('form').send({ title: 'Season Update', _csrf: admin.csrfToken });
  const id = /\/main-admin\/publications\/(\d+)\/edit/.exec(createRes.headers.location)[1];

  const draftView = await request(app).get(`/publications/${id}`);
  assert.equal(draftView.status, 404);

  await request(app)
    .post(`/main-admin/publications/${id}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Season Update', bodyHtml: '<p>Hello</p><script>alert(1)</script>', visibility: 'public', _csrf: admin.csrfToken });
  await request(app).post(`/main-admin/publications/${id}/publish`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });

  const published = await db.prepare('SELECT * FROM publications WHERE id = ?').get(id);
  assert.equal(published.status, 'published');
  assert.match(published.body_html, /<p>Hello<\/p>/);
  assert.doesNotMatch(published.body_html, /<script>/);

  const publicView = await request(app).get(`/publications/${id}`);
  assert.equal(publicView.status, 200);
  assert.match(publicView.text, /Hello/);
});

test('a members-only publication requires sign-in even once published', async () => {
  const admin = await loginAsMainAdmin();
  const parent = await createParentAccount();
  const createRes = await request(app).post('/main-admin/publications').set('Cookie', admin.cookie).type('form').send({ title: 'Members Only Article', _csrf: admin.csrfToken });
  const id = /\/main-admin\/publications\/(\d+)\/edit/.exec(createRes.headers.location)[1];
  await request(app)
    .post(`/main-admin/publications/${id}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Members Only Article', bodyHtml: '<p>Members only content</p>', visibility: 'members', _csrf: admin.csrfToken });
  await request(app).post(`/main-admin/publications/${id}/publish`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });

  const signedOut = await request(app).get(`/publications/${id}`);
  assert.equal(signedOut.status, 302);
  assert.match(signedOut.headers.location, /^\/login\?next=/);

  const signedIn = await request(app).get(`/publications/${id}`).set('Cookie', parent.cookie);
  assert.equal(signedIn.status, 200);

  const publicListing = await request(app).get('/publications');
  assert.doesNotMatch(publicListing.text, /Members Only Article/);
});

test('unpublishing removes a publication from the public listing again', async () => {
  const admin = await loginAsMainAdmin();
  const createRes = await request(app).post('/main-admin/publications').set('Cookie', admin.cookie).type('form').send({ title: 'Temporary Article', _csrf: admin.csrfToken });
  const id = /\/main-admin\/publications\/(\d+)\/edit/.exec(createRes.headers.location)[1];
  await request(app)
    .post(`/main-admin/publications/${id}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Temporary Article', bodyHtml: '<p>x</p>', visibility: 'public', _csrf: admin.csrfToken });
  await request(app).post(`/main-admin/publications/${id}/publish`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  await request(app).post(`/main-admin/publications/${id}/unpublish`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });

  const view = await request(app).get(`/publications/${id}`);
  assert.equal(view.status, 404);
});
