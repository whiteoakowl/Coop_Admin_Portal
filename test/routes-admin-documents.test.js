// Real HTTP-level coverage for routes/admin-documents.js's upload route -
// a real bug report: "When uploading documents on the admin side. It
// times out and says something went wrong. File doesn't upload." Root
// cause: multer's fileSize limit threw a MulterError (LIMIT_FILE_SIZE)
// that nothing in this route caught, so it fell all the way through to
// server.js's generic catch-all error handler and rendered the generic
// 500 page ("Something went wrong") instead of the same friendly,
// specific redirect every other upload failure on this route already
// gets - see routes/admin-documents.js's own header comment on
// uploadDocument for the full story (also: 5MB now, not the old 20MB,
// to actually fit this app's Netlify Function deployment).
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

test('POST /admin/documents/upload with a real small PDF succeeds and lists the document', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const res = await request(app)
    .post('/admin/documents/upload?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .field('title', 'Parent Handbook')
    .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'handbook.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);
  assert.doesNotMatch(res.headers.location, /error=/);

  const row = await db.prepare("SELECT * FROM documents WHERE title = 'Parent Handbook'").get();
  assert.ok(row, 'the document should be recorded in the database');
  assert.equal(row.original_name, 'handbook.pdf');
});

test('POST /admin/documents/upload with a file over the 5MB limit redirects with a friendly error, not a 500', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const oversized = Buffer.alloc(6 * 1024 * 1024, 'a');
  const res = await request(app)
    .post('/admin/documents/upload?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .field('title', 'Too Big')
    .attach('file', oversized, { filename: 'huge.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 302, 'a too-large file should redirect back to the form, not crash into a 500');
  assert.match(res.headers.location, /\/admin\/settings\?tab=documents/);
  const notice = decodeURIComponent(/error=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(notice, /too large/i);
  assert.match(notice, /5MB/);

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
