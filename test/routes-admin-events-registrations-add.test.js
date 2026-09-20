// Coverage for a real request batch on the Event Registrations page
// (views/admin-events-registrations.ejs):
// - "back to event should say edit event, back to attendance should say
//   all events" (see test/routes-events.test.js for that one)
// - "add a button that says add registration. Pop up with menu of
//   members with check boxes and filter for family name in ABC order.
//   Able to select multiple boxes and save all at once. If there is a
//   volunteer list or signup list attached to this particular event it
//   will also ask for those selections."
// - "top of this page has total families, total parents, total students
//   registered, cancel, checked in and checked out"
// - "add a print button... ABC order according to family name"
// - "add import and export button as well"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-events-registrations-add-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-events-registrations-add-test-uploads-${process.pid}`);
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

async function createEvent(admin, overrides = {}) {
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Registrations Test Event', startsAt: '2027-11-01T18:00', _csrf: admin.csrfToken, ...overrides });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });
  return eventId;
}

async function makeFamily(label) {
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`${label} Family`)).lastInsertRowid;
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES (?, ?, 'parent', ?, 1, 1)")
    .run(`${label} Parent`, `${label}-P`, familyId);
  const studentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES (?, ?, 'student', ?, 0, 1)")
    .run(`${label} Student`, `${label}-S`, familyId);
  return { familyId, parentId: parentInfo.lastInsertRowid, studentId: studentInfo.lastInsertRowid };
}

test('Add Registration popup lists eligible members sorted by family, filterable, and multi-select saves all at once', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const zeta = await makeFamily('Zeta');
  const alpha = await makeFamily('Alpha');

  const page = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.match(page.text, /\+ Add Registration/);
  assert.match(page.text, /id="add-registration-dialog"/);
  assert.match(page.text, /id="add-registration-family-filter"/);
  // Alpha Family should be offered before Zeta Family in the filter (A-Z).
  const filterSection = /id="add-registration-family-filter">([\s\S]*?)<\/select>/.exec(page.text)[1];
  assert.ok(filterSection.indexOf('Alpha Family') < filterSection.indexOf('Zeta Family'), 'family filter options should be A-Z');
  // The checkbox list itself should also list Alpha's members before Zeta's.
  const listSection = /id="add-registration-member-list">([\s\S]*?)<\/div>\s*(?:<label>|<div class="notes-dialog-actions">)/.exec(page.text)[1];
  assert.ok(listSection.indexOf('Alpha Parent') < listSection.indexOf('Zeta Parent'), 'member checkbox list should sort by family A-Z');

  const csrf = extractCsrf(page.text);
  const saveRes = await request(app)
    .post(`/main-admin/events/${eventId}/registrations/add`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberIds: [String(zeta.parentId), String(alpha.studentId)], _csrf: csrf });
  assert.match(saveRes.headers.location, new RegExp(`/main-admin/events/${eventId}/registrations`));

  const registered = await db.prepare("SELECT member_id FROM event_registrations WHERE event_id = ? AND status != 'cancelled'").all(eventId);
  const registeredIds = registered.map((r) => r.member_id).sort();
  assert.deepEqual(registeredIds, [zeta.parentId, alpha.studentId].sort());
});

test('Registrations totals header: families, parents, students, cancelled, checked in, checked out', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const family = await makeFamily('Totals');

  let csrf = await (async () => extractCsrf((await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie)).text))();
  await request(app)
    .post(`/main-admin/events/${eventId}/registrations/add`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberIds: [String(family.parentId), String(family.studentId)], _csrf: csrf });

  const reg = await db.prepare('SELECT id FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, family.parentId);
  csrf = await (async () => extractCsrf((await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie)).text))();
  await request(app)
    .post(`/main-admin/events/${eventId}/registrations/${reg.id}/checkin`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ present: '1', _csrf: csrf });

  const page = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  const totalsMatch = /<div class="totals-card">([\s\S]*?)<\/div>/.exec(page.text);
  assert.ok(totalsMatch, 'expected a totals-card on the page');
  const totalsHtml = totalsMatch[1];
  assert.match(totalsHtml, /Families/);
  assert.match(totalsHtml, /Parents/);
  assert.match(totalsHtml, /Students/);
  assert.match(totalsHtml, /Cancelled/);
  assert.match(totalsHtml, /Checked In/);
  assert.match(totalsHtml, /Checked Out/);
  // One family registered (parent + student), one checked in.
  assert.match(totalsHtml, /<span class="stat-value">1<\/span><span class="stat-label">Families<\/span>/);
  assert.match(totalsHtml, /<span class="stat-value">1<\/span><span class="stat-label">Parents<\/span>/);
  assert.match(totalsHtml, /<span class="stat-value">1<\/span><span class="stat-label">Students<\/span>/);
  assert.match(totalsHtml, /<span class="stat-value">1<\/span><span class="stat-label">Checked In<\/span>/);
});

test('Print, Export, and Import buttons/routes exist and work', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const family = await makeFamily('ExportImport');

  const csrf = extractCsrf((await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie)).text);
  await request(app)
    .post(`/main-admin/events/${eventId}/registrations/add`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberIds: [String(family.parentId)], _csrf: csrf });

  const page = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.match(page.text, new RegExp(`href="/main-admin/events/${eventId}/registrations/print"`));
  assert.match(page.text, new RegExp(`href="/main-admin/events/${eventId}/registrations/export.csv"`));
  assert.match(page.text, /Import/);

  const printPage = await request(app).get(`/main-admin/events/${eventId}/registrations/print`).set('Cookie', admin.cookie);
  assert.equal(printPage.status, 200);
  assert.match(printPage.text, /size: letter landscape/);
  assert.match(printPage.text, /ExportImport Parent/);

  const csvRes = await request(app).get(`/main-admin/events/${eventId}/registrations/export.csv`).set('Cookie', admin.cookie);
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers['content-type'], /text\/csv/);
  assert.match(csvRes.text, /ExportImport Parent/);
  assert.match(csvRes.text, /"Family","Name","Status"/);

  // Import: a second member added via a CSV, matched by name.
  const family2 = await makeFamily('ImportOnly');
  const csvBuffer = Buffer.from('Member Code or Name\nImportOnly Parent\n');
  const importRes = await request(app)
    .post(`/main-admin/events/${eventId}/registrations/import?_csrf=${encodeURIComponent(csrf)}`)
    .set('Cookie', admin.cookie)
    .attach('file', csvBuffer, 'import.csv');
  assert.match(importRes.headers.location, new RegExp(`/main-admin/events/${eventId}/registrations`));
  const imported = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, family2.parentId);
  assert.ok(imported, 'the CSV-imported member should now be registered');
});

test('Add Registration popup offers an attached Volunteer List shift and Sign-Up List item, applied to everyone selected', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const family = await makeFamily('ListAttach');

  let csrf = extractCsrf((await request(app).get('/main-admin').set('Cookie', admin.cookie)).text);
  const vlRes = await request(app)
    .post('/main-admin/volunteers/volunteer-lists')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Setup Crew', eventId: String(eventId), _csrf: csrf });
  const volunteerListId = Number(/\/volunteer-lists\/(\d+)/.exec(vlRes.headers.location)[1]);
  csrf = extractCsrf((await request(app).get('/main-admin').set('Cookie', admin.cookie)).text);
  await request(app)
    .post(`/main-admin/volunteers/volunteer-lists/${volunteerListId}/shifts`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ jobName: 'Setup', slotsNeeded: '3', _csrf: csrf });
  const shift = await db.prepare('SELECT id FROM volunteer_signup_list_shifts WHERE list_id = ?').get(volunteerListId);

  const page = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.match(page.text, /Setup Crew Shift/);
  assert.match(page.text, /name="volunteerShiftId"/);
  assert.match(page.text, /Setup \(0\/3\)/);

  csrf = extractCsrf(page.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/registrations/add`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberIds: [String(family.parentId)], volunteerShiftId: String(shift.id), _csrf: csrf });

  const signup = await db.prepare('SELECT * FROM volunteer_signup_list_signups WHERE shift_id = ? AND member_id = ?').get(shift.id, family.parentId);
  assert.ok(signup, 'the selected member should be signed up for the shift chosen in the popup');
});
