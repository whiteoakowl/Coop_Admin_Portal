// Real request: "any pages, do not refresh the page when clicking button
// or icons. it should do the task and stay on the screen so you don't
// have to search for families and members again." Covers the Members
// list's own per-row Delete (both portals), Archive, and Reactivate/
// Unarchive (Main Admin) buttons - now fetch()-driven (public/js/member-
// row-actions.js) instead of plain <form> submits, mirroring the send-
// icon's own AJAX pattern (public/js/member-name-tag-request.js) - and
// the Edit mode bulk actions' redirect, which now preserves whatever
// Filter/Family/search/page querystring the Members list actually had
// instead of always bouncing back to the bare, unfiltered list URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `member-row-actions-no-refresh-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `member-row-actions-no-refresh-test-uploads-${process.pid}`);
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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginCoopAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

async function loginMainAdmin() {
  const loginRes = await request(app)
    .post('/login')
    .type('form')
    .send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('Co-op Admin Members list per-row Delete', async (t) => {
  const cookie = await loginCoopAdmin();

  await t.test('the row renders a plain button with the delete data attributes, not a hidden <form>', async () => {
    const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Row Action Delete Member', 'row-action-delete-member', 'student') RETURNING id").get()).id;
    const res = await request(app).get('/admin/members').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`data-member-delete-url="/admin/members/${memberId}/delete"`));
    assert.match(res.text, /data-member-delete-message="Permanently delete Row Action Delete Member\? This removes them from all rosters, volunteer lists, and all attendance history\. This cannot be undone\."/);
    assert.doesNotMatch(res.text, new RegExp(`id="delete-form-${memberId}"`));
  });

  await t.test('a fetch()-style POST (X-Requested-With: fetch) deletes the member and returns JSON instead of redirecting', async () => {
    const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Fetch Delete Member', 'fetch-delete-member', 'student') RETURNING id").get()).id;
    const page = await request(app).get('/admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post(`/admin/members/${memberId}/delete`)
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(await db.prepare('SELECT id FROM members WHERE id = ?').get(memberId), undefined);
  });

  await t.test('a plain (non-fetch) POST still redirects, unchanged', async () => {
    const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Plain Delete Member', 'plain-delete-member', 'student') RETURNING id").get()).id;
    const page = await request(app).get('/admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app).post(`/admin/members/${memberId}/delete`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);
  });
});

test('Co-op Admin Members list bulk actions preserve the list\'s own filter querystring on redirect', async (t) => {
  const cookie = await loginCoopAdmin();

  await t.test('bulk-archive redirects back to the Referer\'s own querystring, not the bare /admin/members', async () => {
    const id = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Bulk Referer One', 'bulk-referer-1', 'student') RETURNING id").get()).id;
    const page = await request(app).get('/admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post('/admin/members/bulk-archive')
      .set('Cookie', cookie)
      .set('Referer', 'http://localhost/admin/members?filter=parent&page=2')
      .type('form')
      .send({ _csrf: csrfToken, memberIds: [String(id)] });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/admin\/members\?/);
    assert.match(res.headers.location, /filter=parent/);
    assert.match(res.headers.location, /page=2/);
    assert.match(res.headers.location, /notice=Archived%201%20member/);
  });

  await t.test('with no Referer at all, still falls back to the bare list URL (unchanged behavior)', async () => {
    const id = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Bulk No Referer', 'bulk-no-referer', 'student') RETURNING id").get()).id;
    const page = await request(app).get('/admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post('/admin/members/bulk-archive')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken, memberIds: [String(id)] });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/members?notice=Archived%201%20member(s).');
  });

  await t.test('a Referer pointing somewhere else entirely is ignored, not trusted as a redirect target', async () => {
    const id = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Bulk Spoofed Referer', 'bulk-spoofed-referer', 'student') RETURNING id").get()).id;
    const page = await request(app).get('/admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post('/admin/members/bulk-archive')
      .set('Cookie', cookie)
      .set('Referer', 'http://localhost/admin/some-other-page?whatever=1')
      .type('form')
      .send({ _csrf: csrfToken, memberIds: [String(id)] });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/members?notice=Archived%201%20member(s).');
  });

  await t.test('bulk-unarchive falls back to the archived tab\'s own ?archived=1 when there\'s no Referer', async () => {
    const id = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Bulk Unarchive No Referer', 'bulk-unarchive-no-referer', 'student', 0) RETURNING id").get()).id;
    const page = await request(app).get('/admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post('/admin/members/bulk-unarchive')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken, memberIds: [String(id)] });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/members?archived=1&notice=Restored%201%20member(s).');
  });
});

test('Main Admin Members list per-row Archive/Delete/Reactivate', async (t) => {
  const cookie = await loginMainAdmin();

  await t.test('the live-tab row renders a plain Archive button with the archive data attribute, not a <form>', async () => {
    const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Main Row Action Archive', 'main-row-action-archive', 'student') RETURNING id").get()).id;
    const res = await request(app).get('/main-admin/members').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`data-member-archive-url="/main-admin/members/${memberId}/archive"`));
  });

  await t.test('the archive-tab row renders plain Reactivate/Delete buttons with their data attributes, not <form>s', async () => {
    const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Main Row Action Archived', 'main-row-action-archived', 'student', 0) RETURNING id").get()).id;
    const res = await request(app).get('/main-admin/members?tab=archive').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`data-member-unarchive-url="/main-admin/members/${memberId}/unarchive"`));
    assert.match(res.text, new RegExp(`data-member-delete-url="/main-admin/members/${memberId}/delete"`));
    assert.match(res.text, /data-member-delete-message="Permanently delete Main Row Action Archived\? This removes them from all rosters and attendance history\. This cannot be undone\."/);
  });

  await t.test('a fetch()-style POST to archive returns JSON instead of redirecting', async () => {
    const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Main Fetch Archive', 'main-fetch-archive', 'student') RETURNING id").get()).id;
    const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post(`/main-admin/members/${memberId}/archive`)
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(Number((await db.prepare('SELECT active FROM members WHERE id = ?').get(memberId)).active), 0);
  });

  await t.test('a fetch()-style POST to unarchive returns JSON instead of redirecting', async () => {
    const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Main Fetch Unarchive', 'main-fetch-unarchive', 'student', 0) RETURNING id").get()).id;
    const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post(`/main-admin/members/${memberId}/unarchive`)
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(Number((await db.prepare('SELECT active FROM members WHERE id = ?').get(memberId)).active), 1);
  });

  await t.test('a fetch()-style POST to delete returns JSON instead of redirecting', async () => {
    const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Main Fetch Delete', 'main-fetch-delete', 'student') RETURNING id").get()).id;
    const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post(`/main-admin/members/${memberId}/delete`)
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(await db.prepare('SELECT id FROM members WHERE id = ?').get(memberId), undefined);
  });

  await t.test('a plain (non-fetch) POST to archive/unarchive/delete still redirects, unchanged', async () => {
    const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Main Plain Archive', 'main-plain-archive', 'student') RETURNING id").get()).id;
    const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app).post(`/main-admin/members/${memberId}/archive`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);
  });
});

test('Main Admin Members list bulk actions preserve the Members tab\'s own filter querystring on redirect', async (t) => {
  const cookie = await loginMainAdmin();

  await t.test('bulk-delete redirects back to the Referer\'s own querystring, not the bare /main-admin/members', async () => {
    const id = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Main Bulk Referer', 'main-bulk-referer', 'student') RETURNING id").get()).id;
    const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post('/main-admin/members/bulk-delete')
      .set('Cookie', cookie)
      .set('Referer', 'http://localhost/main-admin/members?filter=student&roster=5')
      .type('form')
      .send({ _csrf: csrfToken, memberIds: [String(id)] });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/main-admin\/members\?/);
    assert.match(res.headers.location, /filter=student/);
    assert.match(res.headers.location, /roster=5/);
    assert.match(res.headers.location, /notice=Deleted%201%20member/);
  });

  await t.test('with no Referer at all, still falls back to the bare list URL (unchanged behavior)', async () => {
    const id = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Main Bulk No Referer', 'main-bulk-no-referer', 'student') RETURNING id").get()).id;
    const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post('/main-admin/members/bulk-archive')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken, memberIds: [String(id)] });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/main-admin/members?notice=Archived%201%20member(s).');
  });
});
