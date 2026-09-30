// A real request: "Organized by should be a drop down to choose Sanford
// Homeschoolers or a parent name. Can select multiple. Will show on
// parent portal who Organized the event and their email address." Also
// covers the accompanying layout request: "description should move down
// under tags and above activity information." See utils/events.js's own
// organizersForEvent/setEventOrganizers and the event_organizers
// migration's own comment for why this replaced the old free-text
// organized_by column instead of just relabeling it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-events-organized-by-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-events-organized-by-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createEvent(admin) {
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Organized By Test Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken });
  return Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
}

async function addParent(name, email) {
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`${name} Family`)).lastInsertRowid;
  const barcode = `bc-${name.replace(/\s+/g, '').toLowerCase()}`;
  const row = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id, active, email) VALUES (?, ?, 'parent', ?, 1, ?) RETURNING id")
    .get(name, barcode, familyId, email);
  return row.id;
}

test('Details tab offers Sanford Homeschoolers + every active parent as Organized By options', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const parentId = await addParent('Jane Organizer', 'jane@example.com');

  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', admin.cookie);
  assert.match(page.text, /Organized By/);
  assert.match(page.text, new RegExp(`value="org"[^>]*/>\\s*Sanford Homeschoolers`));
  assert.match(page.text, new RegExp(`value="member:${parentId}"[^>]*/>\\s*Jane Organizer`));
  // The old free-text organizedBy input is gone.
  assert.doesNotMatch(page.text, /name="organizedBy"/);
});

test('saving organizers (Sanford Homeschoolers + a parent) persists and round-trips as checked options', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const parentId = await addParent('Sam Organizer', 'sam@example.com');

  await request(app)
    .post(`/main-admin/events/${eventId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Organized By Test Event', startsAt: '2027-09-01T18:00', organizers: ['org', `member:${parentId}`], _csrf: admin.csrfToken });

  const rows = await db.prepare('SELECT member_id FROM event_organizers WHERE event_id = ? ORDER BY id').all(eventId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].member_id, null);
  assert.equal(rows[1].member_id, parentId);

  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', admin.cookie);
  assert.match(page.text, new RegExp(`value="org"[^>]*checked`));
  assert.match(page.text, new RegExp(`value="member:${parentId}"[^>]*checked`));
});

test('re-saving Details with no organizers checked clears them (replace-all, not additive)', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const parentId = await addParent('Removed Organizer', 'removed@example.com');
  await request(app)
    .post(`/main-admin/events/${eventId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Organized By Test Event', startsAt: '2027-09-01T18:00', organizers: [`member:${parentId}`], _csrf: admin.csrfToken });
  let rows = await db.prepare('SELECT * FROM event_organizers WHERE event_id = ?').all(eventId);
  assert.equal(rows.length, 1);

  await request(app)
    .post(`/main-admin/events/${eventId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Organized By Test Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken });
  rows = await db.prepare('SELECT * FROM event_organizers WHERE event_id = ?').all(eventId);
  assert.equal(rows.length, 0);
});

test('the public event page shows "Organized by" with Sanford Homeschoolers and each parent\'s own email', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const parentId = await addParent('Pat Organizer', 'pat@example.com');
  await request(app)
    .post(`/main-admin/events/${eventId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Organized By Test Event', startsAt: '2027-09-01T18:00', organizers: ['org', `member:${parentId}`], _csrf: admin.csrfToken });
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });

  const detail = await request(app).get(`/events/${eventId}`).set('Cookie', admin.cookie);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Organized by/);
  assert.match(detail.text, /Sanford Homeschoolers/);
  assert.match(detail.text, /Pat Organizer \(pat@example\.com\)/);
});

test('an event with no organizers selected shows no "Organized by" line', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });

  const detail = await request(app).get(`/events/${eventId}`).set('Cookie', admin.cookie);
  assert.equal(detail.status, 200);
  assert.doesNotMatch(detail.text, /Organized by/);
});

// A real request: "description should move down under tags and above
// activity information."
test('Details tab field order: Tags, then Description, then the optional info sections', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', admin.cookie);
  const tagsIndex = page.text.indexOf('data-tag-input="tags"');
  const descriptionIndex = page.text.indexOf('data-forum-editor');
  const activityInfoIndex = page.text.indexOf('name="activityInfo"');
  assert.ok(tagsIndex > -1 && descriptionIndex > -1 && activityInfoIndex > -1);
  assert.ok(tagsIndex < descriptionIndex, 'Tags should come before Description');
  assert.ok(descriptionIndex < activityInfoIndex, 'Description should come before the optional info sections');
});
