// Real HTTP-level coverage for routes/contact-admins.js - a real request:
// "On parent, student and teacher portal on mobile add an email icon at
// the top for contacting group leaders. On desktop it says contact
// admins. The page will show a contact form with a dropdown menu to
// choose an admin department to send a message to. Under admin settings
// we can control where the messages go to for each admin member such as
// a specific email address." Repurposes the old Co-op-Admin-only page
// (previously sourced from the orphaned leadership_contacts table) per
// the requester's own confirmed choices: reuse the existing Admin
// Positions feature for the department dropdown, and reopen the page to
// every portal via requirePortalAuth.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `contact-admins-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `contact-admins-test-uploads-${process.pid}`);
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
const { addAdminPosition, addAdminPositionForMember, setMemberAdminPositionContactEmail } = require('../utils/adminPositions');

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

let seedCounter = 0;

// member_type only ever allows 'student'/'parent'/'admin' (see the check
// constraint on the members table) - the 'teacher' ROLE is layered on top
// via member_account_roles for an otherwise ordinary 'parent'-type member,
// same as every other teacher test account in this suite (see
// test/routes-admin-class-schedule-registration-schedule.test.js's own
// createTeacherAccount for this exact pattern).
async function loginAsPortalRole(roleKey) {
  const n = ++seedCounter;
  const memberType = roleKey === 'student' ? 'student' : 'parent';
  const email = `contact-${roleKey}-${n}@example.com`;
  // members.email (not just member_accounts.email) has to be set here to
  // match real self-signup (routes/portal-auth.js's own POST /register
  // sets both on the same row) - utils/adminPositions.js's
  // membersByAdminPosition/recipientEmailsForPosition deliberately read
  // the member's OWN email off this column (the same one every mailto:
  // link elsewhere in the app already uses), not member_accounts.email.
  const memberId = (
    await db
      .prepare(`INSERT INTO members (name, barcode, member_type, email, active) VALUES (?, ?, ?, ?, 1) RETURNING id`)
      .get(`Contact Test ${roleKey} ${n}`, `contact-${roleKey}-${n}`, memberType, email)
  ).id;
  const acctId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acctId, role.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123' });
  return { cookie: loginRes.headers['set-cookie'], memberId, acctId, email };
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('GET /contact-admins: the department dropdown only lists Admin Positions with at least one holder', async () => {
  await addAdminPosition('Treasurer (Empty)');
  const presidentId = await addAdminPosition('President (Contact Test)');
  const { memberId } = await loginAsPortalRole('parent');
  await addAdminPositionForMember(memberId, presidentId);

  const { cookie } = await loginAsPortalRole('parent');
  const res = await request(app).get('/contact-admins').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /President \(Contact Test\)/);
  assert.doesNotMatch(res.text, /Treasurer \(Empty\)/);
});

test('GET /contact-admins: sender email is prefilled read-only from the logged-in member', async () => {
  const { cookie, email } = await loginAsPortalRole('parent');
  const res = await request(app).get('/contact-admins').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`value="${email}" readonly`));
});

test('POST /contact-admins: a complete submission is saved and resolves to the member\'s own email when no contact_email override is set', async () => {
  const positionId = await addAdminPosition('Secretary (No Override)');
  const holder = await loginAsPortalRole('parent');
  await addAdminPositionForMember(holder.memberId, positionId);

  const sender = await loginAsPortalRole('student');
  const page = await request(app).get('/contact-admins').set('Cookie', sender.cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post('/contact-admins')
    .set('Cookie', sender.cookie)
    .type('form')
    .send({ positionId, title: 'Question', message: 'Hello there', _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const saved = await db.prepare('SELECT * FROM contact_admin_messages WHERE sender_email = ?').get(sender.email);
  assert.ok(saved);
  assert.equal(saved.leadership_team, 'Secretary (No Override)');
  assert.equal(saved.title, 'Question');
  assert.equal(saved.message, 'Hello there');
  assert.equal(saved.recipient_email, holder.email);
});

test('POST /contact-admins: a per-position contact_email override wins over the holder\'s own account email', async () => {
  const positionId = await addAdminPosition('Vice President (Override)');
  const holder = await loginAsPortalRole('teacher');
  await addAdminPositionForMember(holder.memberId, positionId);
  await setMemberAdminPositionContactEmail(holder.memberId, positionId, 'department-override@example.com');

  const sender = await loginAsPortalRole('teacher');
  const page = await request(app).get('/contact-admins').set('Cookie', sender.cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post('/contact-admins')
    .set('Cookie', sender.cookie)
    .type('form')
    .send({ positionId, title: 'Override test', message: 'Should go to the override address', _csrf: csrfToken });
  assert.equal(res.status, 302);

  const saved = await db.prepare('SELECT * FROM contact_admin_messages WHERE title = ?').get('Override test');
  assert.ok(saved);
  assert.equal(saved.recipient_email, 'department-override@example.com');
});

test('POST /contact-admins: a submission missing a required field is rejected, not saved', async () => {
  const sender = await loginAsPortalRole('parent');
  const page = await request(app).get('/contact-admins').set('Cookie', sender.cookie);
  const csrfToken = extractCsrf(page.text);
  const before = Number((await db.prepare('SELECT COUNT(*) AS c FROM contact_admin_messages').get()).c);

  const res = await request(app)
    .post('/contact-admins')
    .set('Cookie', sender.cookie)
    .type('form')
    .send({ positionId: '', title: 'Question', message: 'Hello there', _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);
  const after = Number((await db.prepare('SELECT COUNT(*) AS c FROM contact_admin_messages').get()).c);
  assert.equal(after, before, 'nothing should have been inserted');
});

test('Parent/Student/Teacher portal nav shows a Contact Admins icon; Main Admin does not', async () => {
  const parent = await loginAsPortalRole('parent');
  const student = await loginAsPortalRole('student');
  const teacher = await loginAsPortalRole('teacher');
  const mainAdminCookie = await loginAsMainAdmin();

  const parentPage = await request(app).get('/parent').set('Cookie', parent.cookie);
  assert.match(parentPage.text, /Contact Admins/);

  const studentPage = await request(app).get('/student').set('Cookie', student.cookie);
  assert.match(studentPage.text, /Contact Admins/);

  const teacherPage = await request(app).get('/teacher').set('Cookie', teacher.cookie);
  assert.match(teacherPage.text, /Contact Admins/);

  const mainAdminPage = await request(app).get('/main-admin').set('Cookie', mainAdminCookie);
  assert.equal(mainAdminPage.status, 200);
  assert.doesNotMatch(mainAdminPage.text, /Contact Admins/);
});

test('Main Admin: Contact Admin Messages inbox lists a submitted message and can archive it', async () => {
  const positionId = await addAdminPosition('Fundraising (Inbox Test)');
  const holder = await loginAsPortalRole('parent');
  await addAdminPositionForMember(holder.memberId, positionId);

  const sender = await loginAsPortalRole('parent');
  const page = await request(app).get('/contact-admins').set('Cookie', sender.cookie);
  const csrfToken = extractCsrf(page.text);
  await request(app)
    .post('/contact-admins')
    .set('Cookie', sender.cookie)
    .type('form')
    .send({ positionId, title: 'Inbox Test Subject', message: 'Inbox test body', _csrf: csrfToken });

  const mainAdminCookie = await loginAsMainAdmin();
  const inboxPage = await request(app).get('/main-admin/contact-admin-messages').set('Cookie', mainAdminCookie);
  assert.equal(inboxPage.status, 200);
  assert.match(inboxPage.text, /Inbox Test Subject/);
  assert.match(inboxPage.text, /Fundraising \(Inbox Test\)/);

  const idMatch = new RegExp('/main-admin/contact-admin-messages/(\\d+)/archive').exec(inboxPage.text);
  assert.ok(idMatch, 'expected an archive form for the new message');
  const inboxCsrf = extractCsrf(inboxPage.text);
  const archiveRes = await request(app)
    .post(`/main-admin/contact-admin-messages/${idMatch[1]}/archive`)
    .set('Cookie', mainAdminCookie)
    .type('form')
    .send({ _csrf: inboxCsrf });
  assert.equal(archiveRes.status, 302);

  const activeAfter = await request(app).get('/main-admin/contact-admin-messages').set('Cookie', mainAdminCookie);
  assert.doesNotMatch(activeAfter.text, /Inbox Test Subject/);
  const archivedAfter = await request(app).get('/main-admin/contact-admin-messages?archived=1').set('Cookie', mainAdminCookie);
  assert.match(archivedAfter.text, /Inbox Test Subject/);
});

test('Main Admin: Contact Admin Messages inbox paginates past the default page size', async () => {
  await db.prepare("DELETE FROM contact_admin_messages WHERE archived = 0").run();
  for (let i = 0; i < 55; i += 1) {
    await db
      .prepare(`INSERT INTO contact_admin_messages (leadership_team, sender_email, title, message) VALUES (?, ?, ?, ?)`)
      .run('Pagination Test Dept', 'sender@example.com', `Pagination Message ${i}`, 'Body');
  }

  const mainAdminCookie = await loginAsMainAdmin();
  const page1 = await request(app).get('/main-admin/contact-admin-messages').set('Cookie', mainAdminCookie);
  assert.equal(page1.status, 200);
  assert.equal((page1.text.match(/Pagination Message \d+/g) || []).length, 50, 'page 1 should only show pageSize (50) rows');
  assert.match(page1.text, /class="pagination-bar/, 'pagination controls should render once past one page');

  const page2 = await request(app).get('/main-admin/contact-admin-messages?page=2').set('Cookie', mainAdminCookie);
  assert.equal((page2.text.match(/Pagination Message \d+/g) || []).length, 5, 'page 2 should show the remaining 5 rows');
});
