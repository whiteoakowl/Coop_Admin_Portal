// Real HTTP-level coverage for routes/main-admin-documents.js - a real
// request: "there should also be a page on main admin to upload the
// documents" (only Co-op Admin had one - see routes/admin-documents.js
// and test/routes-admin-documents.test.js, which this mirrors). Shares
// the same `documents` table/bucket as Co-op Admin's own page and the
// Parent Portal's read-only Documents grid (routes/parent-portal.js), so
// a document uploaded from either admin page shows up for parents too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-documents-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-documents-test-uploads-${process.pid}`);
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

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/documents').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('GET /main-admin/documents shows the Add/Edit Documents button and upload form', async () => {
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/documents').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, />Add\/Edit Documents</);
  assert.match(page.text, /id="manage-documents-dialog"/);
  assert.match(page.text, /<form[^>]*action="\/main-admin\/documents\/upload"/);

  const hub = await request(app).get('/main-admin/settings').set('Cookie', cookie);
  assert.match(hub.text, /href="\/main-admin\/documents"[^]*?Documents/);
});

test('POST /main-admin/documents/upload with a real small PDF succeeds and lists the document', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();

  const res = await request(app)
    .post('/main-admin/documents/upload?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .field('title', 'Parent Handbook')
    .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'handbook.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/main-admin\/documents\?notice=/);
  assert.doesNotMatch(res.headers.location, /error=/);

  const row = await db.prepare("SELECT * FROM documents WHERE title = 'Parent Handbook'").get();
  assert.ok(row, 'the document should be recorded in the database');
  assert.equal(row.original_name, 'handbook.pdf');
  assert.ok(row.public_token);
});

// A document uploaded from Main Admin is the same shared table Co-op
// Admin's own page manages and the Parent Portal's read-only grid reads
// from - confirming there's really only one document library, not two
// separate ones per portal.
test('a document uploaded from Main Admin shows up on the Co-op Admin Documents page and the Parent Portal Documents page', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  await request(app)
    .post('/main-admin/documents/upload?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .field('title', 'Shared Library Doc')
    .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'shared.pdf', contentType: 'application/pdf' });

  const coopLoginRes = await request(app).post('/admin/login').type('form').send({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD });
  const coopCookie = coopLoginRes.headers['set-cookie'];
  const coopPage = await request(app).get('/admin/documents').set('Cookie', coopCookie);
  assert.match(coopPage.text, /Shared Library Doc/);

  const row = await db.prepare("SELECT * FROM documents WHERE title = 'Shared Library Doc'").get();
  const publicPage = await request(app).get(`/documents/${row.public_token}`);
  assert.equal(publicPage.status, 200);
  assert.match(publicPage.text, /Shared Library Doc/);
});

test('a real request: "option to add an image as well" on Main Admin\'s own Documents page', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();

  const res = await request(app)
    .post('/main-admin/documents/upload?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .field('title', 'Handbook With Cover')
    .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'cover-handbook.pdf', contentType: 'application/pdf' })
    .attach('image', Buffer.from('fake png bytes'), { filename: 'cover.png', contentType: 'image/png' });

  assert.equal(res.status, 302);
  assert.doesNotMatch(res.headers.location, /error=/);

  const row = await db.prepare("SELECT * FROM documents WHERE title = 'Handbook With Cover'").get();
  assert.ok(row.image_path);
  assert.equal(row.image_mime_type, 'image/png');

  const imageRes = await request(app).get(`/main-admin/documents/${row.id}/image`).set('Cookie', cookie);
  assert.equal(imageRes.status, 200);
  assert.equal(imageRes.headers['content-type'], 'image/png');

  const managePage = await request(app).get('/main-admin/documents').set('Cookie', cookie);
  assert.match(managePage.text, new RegExp(`class="document-manage-row-thumb" src="/main-admin/documents/${row.id}/image"`));
});

test('Copy Link button and the document view page (title, image, embedded file frame)', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  await request(app)
    .post('/main-admin/documents/upload?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .field('title', 'Viewable Doc')
    .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'viewable.pdf', contentType: 'application/pdf' });

  const row = await db.prepare("SELECT * FROM documents WHERE title = 'Viewable Doc'").get();
  const managePage = await request(app).get('/main-admin/documents').set('Cookie', cookie);
  assert.match(managePage.text, new RegExp(`data-copy-link="http://[^"]*/documents/${row.public_token}"`));

  const viewPage = await request(app).get(`/main-admin/documents/${row.id}/view`).set('Cookie', cookie);
  assert.equal(viewPage.status, 200);
  assert.match(viewPage.text, /Viewable Doc/);
  assert.match(viewPage.text, new RegExp(`src="/main-admin/documents/${row.id}/file"`));
});

test('POST /main-admin/documents/upload with a file over the local fallback limit redirects with a friendly error, not a 500', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();

  const oversized = Buffer.alloc(21 * 1024 * 1024, 'a');
  const res = await request(app)
    .post('/main-admin/documents/upload?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .field('title', 'Too Big')
    .attach('file', oversized, { filename: 'huge.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/main-admin\/documents\?error=/);
  const notice = decodeURIComponent(/error=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(notice, /too large/i);

  const row = await db.prepare("SELECT * FROM documents WHERE title = 'Too Big'").get();
  assert.equal(row, undefined);
});

test('deleting a document from Main Admin removes it, and the public link stops working', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  await request(app)
    .post('/main-admin/documents/upload?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .field('title', 'Delete Me From Main Admin')
    .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'delete-me.pdf', contentType: 'application/pdf' });

  const row = await db.prepare("SELECT * FROM documents WHERE title = 'Delete Me From Main Admin'").get();
  const delRes = await request(app)
    .post(`/main-admin/documents/${row.id}/delete?_csrf=${encodeURIComponent(csrfToken)}`)
    .set('Cookie', cookie);
  assert.equal(delRes.status, 302);

  const gone = await db.prepare('SELECT * FROM documents WHERE id = ?').get(row.id);
  assert.equal(gone, undefined);

  const publicPage = await request(app).get(`/documents/${row.public_token}`);
  assert.equal(publicPage.status, 404);
});

// A real explicit clarification: "Parents portal documents is click on
// files and view, no editing or uploading files for parents" - confirms
// the Parent Portal's own read-only Documents grid has no upload/edit
// controls at all, unlike either admin page.
test('Parent Portal Documents page has no upload/edit controls - view only', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('DocsViewOnlyFamily') RETURNING id").get()).id;
  const { generateMemberCode } = require('../utils/members');
  const { hashPassword } = require('../utils/portalAuth');
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES ('Docs View Parent', ?, ?, 'parent', ?, 1, 1) RETURNING id")
    .get(code, code, familyId);
  const email = 'docs-view-parent@example.com';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
    .get(parentInfo.id, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.id, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];

  const res = await request(app).get('/parent/documents').set('Cookie', cookie);
  assert.equal(res.status, 200);
  // The shared portal nav's own Log Out form is expected on every portal
  // page - what must NOT be here is any document upload/edit/delete form.
  assert.doesNotMatch(res.text, /enctype="multipart\/form-data"/, 'no upload form anywhere on the parent documents page');
  assert.doesNotMatch(res.text, /action="[^"]*documents[^"]*\/(upload|delete)/);
  assert.doesNotMatch(res.text, /Add\/Edit Documents/);
  assert.doesNotMatch(res.text, /type="file"/);
});
