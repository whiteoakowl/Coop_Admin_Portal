// A real bug report: "Events are not appearing on parent portal." Traced
// to a member-submitted event a Main Admin clicked straight into from its
// own Requests tab title link (views/admin-events-list.ejs) and published
// from the builder page (views/admin-events-builder.ejs's own Publish
// button) without ever clicking the separate Approve button first.
// setEventStatus (utils/events.js) used to only ever touch `status`, so
// the event ended up status='published' + approval_status='pending'
// forever - "Published" in every Main Admin view (routes/admin-events.js's
// own Calendar tab query never filters on approval_status), yet invisible
// on every member-facing page (routes/events.js's own listEvents call
// requires approval_status='approved'). Publishing now also approves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-publish-without-approval-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-publish-without-approval-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');
const events = require('../utils/events');

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
  return loginRes.headers['set-cookie'];
}

test('publishing a still-pending submitted event (no prior Approve click) also approves it, and it shows on the parent calendar', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Publish Approval Family') RETURNING id").get()).id;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES ('Publish Approval Parent', 'publish-approval-1', 'parent', ?, 1, 1) RETURNING id")
      .get(familyId)
  ).id;
  const parentEmail = 'publish-approval-1@example.com';
  const parentAcctId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, parentEmail, hashPassword('testpassword123'))
  ).id;
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(parentAcctId, parentRole.id);

  const startsAt = (await db.prepare("SELECT to_char(now() + interval '5 days', 'YYYY-MM-DD HH24:MI:SS') AS t").get()).t;
  const eventId = await events.submitEvent({ title: 'Publish Bug Fall Fest', startsAt, visibility: 'members' }, parentAcctId);

  let ev = await events.getEvent(eventId);
  assert.equal(ev.status, 'draft');
  assert.equal(ev.approval_status, 'pending');

  const adminCookie = await loginAsMainAdmin();
  const builderPage = await request(app).get(`/main-admin/events/${eventId}/builder`).set('Cookie', adminCookie);
  const csrfToken = extractCsrf(builderPage.text);

  // Publishing directly from the builder - the same thing the Requests
  // tab's own title link lets an admin do without ever hitting Approve.
  const statusRes = await request(app)
    .post(`/main-admin/events/${eventId}/status`)
    .set('Cookie', adminCookie)
    .type('form')
    .send({ status: 'published', _csrf: csrfToken });
  assert.equal(statusRes.status, 302);

  ev = await events.getEvent(eventId);
  assert.equal(ev.status, 'published');
  assert.equal(ev.approval_status, 'approved');

  const loginRes = await request(app).post('/login').type('form').send({ email: parentEmail, password: 'testpassword123' });
  const parentCookie = loginRes.headers['set-cookie'];
  const calendarPage = await request(app).get('/events?view=calendar&portal=parent').set('Cookie', parentCookie);
  assert.match(calendarPage.text, /Publish Bug Fall Fest/);
});

test('the normal Requests -> Approve -> Drafts -> Publish flow is unaffected (already approved, publishing is a no-op on approval_status)', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Normal Flow Family') RETURNING id").get()).id;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES ('Normal Flow Parent', 'normal-flow-1', 'parent', ?, 1, 1) RETURNING id")
      .get(familyId)
  ).id;
  const parentAcctId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, 'normal-flow-1@example.com', hashPassword('testpassword123'))
  ).id;

  const startsAt = (await db.prepare("SELECT to_char(now() + interval '5 days', 'YYYY-MM-DD HH24:MI:SS') AS t").get()).t;
  const eventId = await events.submitEvent({ title: 'Normal Flow Event', startsAt, visibility: 'members' }, parentAcctId);

  const adminCookie = await loginAsMainAdmin();
  const requestsPage = await request(app).get('/main-admin/events?tab=requests').set('Cookie', adminCookie);
  const csrfToken = extractCsrf(requestsPage.text);

  await request(app).post(`/main-admin/events/${eventId}/decide`).set('Cookie', adminCookie).type('form').send({ decision: 'approve', _csrf: csrfToken });
  let ev = await events.getEvent(eventId);
  assert.equal(ev.approval_status, 'approved');
  assert.equal(ev.status, 'draft');

  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', adminCookie).type('form').send({ status: 'published', _csrf: csrfToken });
  ev = await events.getEvent(eventId);
  assert.equal(ev.status, 'published');
  assert.equal(ev.approval_status, 'approved');
});
