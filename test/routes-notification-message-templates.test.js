// Coverage for a real request: "Main admin portal and co-op admin
// portal settings gear. Add a text/email notification settings card.
// There you can change the default message for different things like
// floater assignments, class wait list, event waitlist, event
// registration, class registration, etc." See utils/notificationTemplates.js
// for the storage/render layer and the migration's own header comment
// for why each real outcome (confirmed/waitlisted, approved/rejected)
// is its own row rather than one template with if/else logic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `notification-message-templates-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `notification-message-templates-test-uploads-${process.pid}`);
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
const { generateMemberCode } = require('../utils/members');
const { hashPassword } = require('../utils/portalAuth');
const notificationTemplates = require('../utils/notificationTemplates');

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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('utils/notificationTemplates.js: renderTemplate fills {{placeholders}} from the stored row', async () => {
  const rendered = await notificationTemplates.renderTemplate('class_waitlist_promoted', { className: 'Art Class', studentName: 'Jamie' });
  assert.equal(rendered.subject, 'Off the waitlist: Art Class');
  assert.equal(rendered.body, 'A spot opened up - Jamie is now confirmed for "Art Class".');
});

test('a missing variable leaves the {{placeholder}} text in place rather than throwing', async () => {
  const rendered = await notificationTemplates.renderTemplate('event_cancelled', {});
  assert.match(rendered.body, /\{\{eventTitle\}\}/);
});

test('Main Admin: Text/Email Notifications card on the Settings hub links to /main-admin/notifications', async () => {
  const admin = await loginAsMainAdmin();
  const hub = await request(app).get('/main-admin/settings').set('Cookie', admin.cookie);
  assert.match(hub.text, /href="\/main-admin\/notifications"/);
  assert.match(hub.text, /Text\/Email Notifications/);
});

test('Main Admin: /main-admin/notifications shows every template grouped, and saving one persists and re-renders it', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/notifications').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Floater Assignments/);
  assert.match(page.text, /Class Registration/);
  assert.match(page.text, /Event Registration/);
  assert.match(page.text, /\{\{position\}\}/);

  const csrfToken = extractCsrf(page.text);
  const saveRes = await request(app)
    .post('/main-admin/notifications/templates/event_cancelled')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ subject: 'Cancelled: {{eventTitle}}', body: 'We had to cancel {{eventTitle}} - sorry!', _csrf: csrfToken });
  assert.equal(saveRes.status, 302);

  const row = await db.prepare("SELECT * FROM notification_message_templates WHERE template_key = 'event_cancelled'").get();
  assert.equal(row.subject, 'Cancelled: {{eventTitle}}');
  assert.equal(row.body, 'We had to cancel {{eventTitle}} - sorry!');

  const after = await request(app).get('/main-admin/notifications').set('Cookie', admin.cookie);
  assert.match(after.text, /We had to cancel \{\{eventTitle\}\} - sorry!/);
});

test('Main Admin: saving an unknown template key 404s instead of inserting a stray row', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/notifications').set('Cookie', admin.cookie);
  const csrfToken = extractCsrf(page.text);
  const res = await request(app)
    .post('/main-admin/notifications/templates/not_a_real_key')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ subject: 'x', body: 'y', _csrf: csrfToken });
  assert.equal(res.status, 404);
});

test('Co-op Admin: Settings hub has a Text/Email Notifications card, and the tab shows/saves the same templates', async () => {
  const admin = await loginAsAdmin();
  const hub = await request(app).get('/admin/settings').set('Cookie', admin.cookie);
  assert.match(hub.text, /href="\/admin\/settings\?tab=notificationtemplates"/);

  const tab = await request(app).get('/admin/settings?tab=notificationtemplates').set('Cookie', admin.cookie);
  assert.equal(tab.status, 200);
  assert.match(tab.text, /Floater Assignments/);
  assert.match(tab.text, /Event Waitlist/);

  const csrfToken = extractCsrf(tab.text);
  const saveRes = await request(app)
    .post('/admin/settings/notification-templates/floater_assignment_default')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ body: "You've been assigned {{position}}.", _csrf: csrfToken });
  assert.equal(saveRes.status, 200, 'Co-op Admin settings POST handlers render directly, same as class-checkin-pin');
  assert.match(saveRes.text, /Message saved\./);

  const row = await db.prepare("SELECT * FROM notification_message_templates WHERE template_key = 'floater_assignment_default'").get();
  assert.equal(row.body, "You've been assigned {{position}}.");
});

test('a class_waitlist_promoted notification actually sent uses the stored (possibly edited) template, not hardcoded text', async () => {
  await notificationTemplates.updateTemplate('class_waitlist_promoted', 'Spot opened: {{className}}', '{{studentName}}, you are in for {{className}} now!');

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Template Test Family') RETURNING id").get()).id;
  const code1 = await generateMemberCode();
  const enrolledStudentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES ('Enrolled Kid', ?, ?, 'student', ?, 1) RETURNING id")
      .get(`template-test-enrolled-${code1}`, code1, familyId)
  ).id;
  const code2 = await generateMemberCode();
  const waitlistedStudentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES ('Waitlisted Kid', ?, ?, 'student', ?, 1) RETURNING id")
      .get(`template-test-waitlisted-${code2}`, code2, familyId)
  ).id;
  const waitlistedParentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES ('Waitlisted Parent', 'template-test-wl-parent-1', 'parent', ?, 1, 1) RETURNING id")
      .get(familyId)
  ).id;
  const waitlistedAcctId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(waitlistedParentId, 'template-test-wl-parent@example.com', hashPassword('testpassword123'))
  ).id;
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(waitlistedAcctId, parentRole.id);

  const classId = (await db.prepare("INSERT INTO classes (day, hour_position, class_name, capacity, registration_open) VALUES ('monday', 1, 'Template Test Class', 1, 1) RETURNING id").get()).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, enrolledStudentId);
  await db
    .prepare("INSERT INTO class_registrations (class_id, student_id, registered_by_account_id, status) VALUES (?, ?, ?, 'confirmed')")
    .run(classId, enrolledStudentId, waitlistedAcctId);
  await db
    .prepare("INSERT INTO class_registrations (class_id, student_id, registered_by_account_id, status, waitlist_position) VALUES (?, ?, ?, 'waitlisted', 1)")
    .run(classId, waitlistedStudentId, waitlistedAcctId);

  // Unregistering the ENROLLED student opens the one slot and promotes
  // the waitlisted one (utils/classRegistration.js's own promoteNextWaitlisted,
  // only reachable when the cancelled registration's own status was
  // 'confirmed' - the real trigger for notify('class_waitlist_promoted')).
  const classRegistration = require('../utils/classRegistration');
  await classRegistration.unregisterFromClass({ classId, studentId: enrolledStudentId, accountId: waitlistedAcctId });

  const notif = await db.prepare("SELECT * FROM notifications WHERE member_account_id = ? AND type_key = 'class_waitlist_promoted' ORDER BY id DESC LIMIT 1").get(waitlistedAcctId);
  assert.ok(notif, 'expected a class_waitlist_promoted notification to have been created');
  assert.equal(notif.title, 'Spot opened: Template Test Class');
  assert.equal(notif.body, 'Waitlisted Kid, you are in for Template Test Class now!');
});
