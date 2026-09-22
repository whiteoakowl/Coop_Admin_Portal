// Real HTTP-level coverage for routes/admin-documents.js's upload route -
// a real bug report: "When uploading documents on the admin side. It
// times out and says something went wrong. File doesn't upload." Root
// cause: multer's fileSize limit threw a MulterError (LIMIT_FILE_SIZE)
// that nothing in this route caught, so it fell all the way through to
// server.js's generic catch-all error handler and rendered the generic
// 500 page ("Something went wrong") instead of the same friendly,
// specific redirect every other upload failure on this route already
// gets - see routes/admin-documents.js's own header comment on
// uploadDocument for the full story.
//
// A later real request batch: "document upload... should move to the
// documents page" (upload/manage now live on /admin/documents itself,
// not Settings), "each document line should have a copy link button for
// easy public sharing" (confirmed: a genuinely public, no-login link -
// see routes/documents.js, a separate router keyed off each document's
// own random public_token), "option to add an image as well," and "I
// can't upload larger files" (this route's own plain-multipart path is
// now only the local/LAN fallback with no Netlify body-size ceiling to
// respect - see LOCAL_MAX_DOCUMENT_BYTES's own comment - real size relief
// comes from the separate direct-to-Storage upload-url/upload-complete
// pair, only reachable when Supabase Storage is configured).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-documents-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-documents-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/documents').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('a real request: "document upload... should move to the documents page and be a button called add/edit documents"', async () => {
  const { cookie } = await loginAsAdmin();
  const page = await request(app).get('/admin/documents').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, />Add\/Edit Documents</);
  assert.match(page.text, /id="manage-documents-dialog"/);
  assert.match(page.text, /<form[^>]*action="\/admin\/documents\/upload"/);

  const settingsPage = await request(app).get('/admin/settings').set('Cookie', cookie);
  assert.doesNotMatch(settingsPage.text, /tab=documents">Documents/, 'Settings should no longer have its own Documents tab');
});

test('POST /admin/documents/upload with a real small PDF succeeds and lists the document', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const res = await request(app)
    .post('/admin/documents/upload?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .field('title', 'Parent Handbook')
    .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'handbook.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/admin\/documents\?notice=/);
  assert.doesNotMatch(res.headers.location, /error=/);

  const row = await db.prepare("SELECT * FROM documents WHERE title = 'Parent Handbook'").get();
  assert.ok(row, 'the document should be recorded in the database');
  assert.equal(row.original_name, 'handbook.pdf');
  assert.ok(row.public_token, 'every document should get a public_token, even from the local-fallback upload path');
});

test('a real request: "option to add an image as well... image will appear on the document line"', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const res = await request(app)
    .post('/admin/documents/upload?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .field('title', 'Handbook With Cover')
    .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'cover-handbook.pdf', contentType: 'application/pdf' })
    .attach('image', Buffer.from('fake png bytes'), { filename: 'cover.png', contentType: 'image/png' });

  assert.equal(res.status, 302);
  assert.doesNotMatch(res.headers.location, /error=/);

  const row = await db.prepare("SELECT * FROM documents WHERE title = 'Handbook With Cover'").get();
  assert.ok(row.image_path, 'the image should be recorded');
  assert.equal(row.image_mime_type, 'image/png');

  const managePage = await request(app).get('/admin/documents').set('Cookie', cookie);
  assert.match(managePage.text, new RegExp(`class="document-manage-row-thumb" src="/admin/documents/${row.id}/image"`));

  const imageRes = await request(app).get(`/admin/documents/${row.id}/image`).set('Cookie', cookie);
  assert.equal(imageRes.status, 200);
  assert.equal(imageRes.headers['content-type'], 'image/png');

  // "on the document click card with title below it, all one card" - the
  // click-through card shows the image instead of the generic file icon.
  assert.match(managePage.text, new RegExp(`class="landing-card-image" src="/admin/documents/${row.id}/image"`));
});

test('a real request: "each document line should have a copy link button for easy public sharing" - a genuinely public, no-login link', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const res = await request(app)
    .post('/admin/documents/upload?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .field('title', 'Public Handbook')
    .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'public-handbook.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 302);

  const row = await db.prepare("SELECT * FROM documents WHERE title = 'Public Handbook'").get();
  const managePage = await request(app).get('/admin/documents').set('Cookie', cookie);
  assert.match(managePage.text, new RegExp(`data-copy-link="http://[^"]*/documents/${row.public_token}"`));

  // No admin session at all - a real member of the public.
  const publicPage = await request(app).get(`/documents/${row.public_token}`);
  assert.equal(publicPage.status, 200);
  assert.match(publicPage.text, /Public Handbook/);

  const publicFile = await request(app).get(`/documents/${row.public_token}/file`).buffer(true).parse((streamRes, cb) => {
    const chunks = [];
    streamRes.on('data', (chunk) => chunks.push(chunk));
    streamRes.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(publicFile.status, 200);
  assert.equal(publicFile.headers['content-type'], 'application/pdf');
  assert.equal(publicFile.body.toString(), '%PDF-1.4 fake pdf content');

  const wrongToken = await request(app).get('/documents/not-a-real-token');
  assert.equal(wrongToken.status, 404);

  // The public token, not the row's own id, is what the link is keyed on -
  // guessing a small integer must not work.
  const byId = await request(app).get(`/documents/${row.id}`);
  assert.equal(byId.status, 404);
});

test('the direct-to-Storage upload endpoints exist and behave correctly with no Storage configured (the normal test/local case)', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const urlRes = await request(app)
    .post('/admin/documents/upload-url')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, filename: 'big.pdf' });
  assert.equal(urlRes.status, 501, 'no Storage configured in this environment, so direct upload is unavailable - the client falls back to the plain form');

  const completeRes = await request(app)
    .post('/admin/documents/upload-complete')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, title: 'Direct Upload Doc', fileKey: 'some-generated-key.pdf', fileOriginalName: 'report.pdf', fileMimeType: 'application/pdf' });
  assert.equal(completeRes.status, 200);
  assert.match(completeRes.body.redirect, /^\/admin\/documents\?notice=/);

  const row = await db.prepare("SELECT * FROM documents WHERE title = 'Direct Upload Doc'").get();
  assert.equal(row.file_path, 'some-generated-key.pdf');
  assert.ok(row.public_token);
});

test('POST /admin/documents/upload with a file over the local fallback limit redirects with a friendly error, not a 500', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const oversized = Buffer.alloc(21 * 1024 * 1024, 'a');
  const res = await request(app)
    .post('/admin/documents/upload?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .field('title', 'Too Big')
    .attach('file', oversized, { filename: 'huge.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 302, 'a too-large file should redirect back to the form, not crash into a 500');
  assert.match(res.headers.location, /^\/admin\/documents\?error=/);
  const notice = decodeURIComponent(/error=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(notice, /too large/i);

  const row = await db.prepare("SELECT * FROM documents WHERE title = 'Too Big'").get();
  assert.equal(row, undefined, 'the oversized upload should never be recorded');
});

test('POST /admin/documents/upload with no file redirects with the existing "please choose a file" error', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const res = await request(app)
    .post('/admin/documents/upload?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .field('title', 'No File');

  assert.equal(res.status, 302);
  const notice = decodeURIComponent(/error=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(notice, /choose a PDF or Word file/);
});

test('deleting a document with an image removes both, and the public link stops working', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  await request(app)
    .post('/admin/documents/upload?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .field('title', 'Delete Me')
    .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'delete-me.pdf', contentType: 'application/pdf' })
    .attach('image', Buffer.from('fake png bytes'), { filename: 'delete-me.png', contentType: 'image/png' });

  const row = await db.prepare("SELECT * FROM documents WHERE title = 'Delete Me'").get();
  const delRes = await request(app)
    .post(`/admin/documents/${row.id}/delete?_csrf=${encodeURIComponent(csrfToken)}`)
    .set('Cookie', cookie);
  assert.equal(delRes.status, 302);

  const gone = await db.prepare('SELECT * FROM documents WHERE id = ?').get(row.id);
  assert.equal(gone, undefined);

  const publicPage = await request(app).get(`/documents/${row.public_token}`);
  assert.equal(publicPage.status, 404);
});
