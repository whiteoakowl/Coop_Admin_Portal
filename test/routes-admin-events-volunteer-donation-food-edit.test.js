// A real request: "volunteer roles, food signup, donations, and extra
// fields. There should be able to click on each item created in these
// sections to edit, include trash button, clear the member signed up,
// edit number required or description." Mirrors the Ticket Types/Extra
// Fields click-to-edit dialog pattern (see views/admin-events-builder.ejs)
// for the other three Volunteers-tab sections, plus the new admin
// "clear the member signed up" feature on each.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-vdf-edit-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-vdf-edit-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
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

async function createEvent(admin) {
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'VDF Edit Test Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken });
  return Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
}

let memberCounter = 0;
async function createMember() {
  memberCounter += 1;
  const code = await generateMemberCode();
  const info = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'parent', 1)")
    .run(`VDF Member ${memberCounter}`, code, code);
  return { id: info.lastInsertRowid, name: `VDF Member ${memberCounter}` };
}

test('Volunteer Roles: row has no trash icon, clicking opens an edit dialog with Save/Close/Delete', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await request(app)
    .post(`/main-admin/events/${eventId}/volunteer-roles`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ roleName: 'Setup Crew', slotsNeeded: '2', timeLabel: '8:00-9:00am', _csrf: admin.csrfToken });

  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=volunteers&section=volunteers`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="training-lesson-row ticket-type-row" onclick="document\.getElementById\('edit-role-dialog-\d+'\)\.showModal\(\)"/);
  assert.match(page.text, /Setup Crew.*0\/2 filled.*8:00-9:00am/s);
  assert.doesNotMatch(page.text, /icon-btn-danger" aria-label="Delete Setup Crew"/);
  assert.match(page.text, />Delete Volunteer Role</);
});

test('editing a volunteer role through its dialog updates the fields', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const addRes = await request(app)
    .post(`/main-admin/events/${eventId}/volunteer-roles`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ roleName: 'Setup Crew', slotsNeeded: '2', _csrf: admin.csrfToken });
  assert.equal(addRes.status, 302);
  const role = await db.prepare('SELECT * FROM event_volunteer_roles WHERE event_id = ?').get(eventId);

  await request(app)
    .post(`/main-admin/events/${eventId}/volunteer-roles/${role.id}/update`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ roleName: 'Cleanup Crew', slotsNeeded: '5', timeLabel: '9:00-10:00am', location: 'Gym', description: 'Stack chairs', _csrf: admin.csrfToken });

  const updated = await db.prepare('SELECT * FROM event_volunteer_roles WHERE id = ?').get(role.id);
  assert.equal(updated.role_name, 'Cleanup Crew');
  assert.equal(updated.slots_needed, 5);
  assert.equal(updated.time_label, '9:00-10:00am');
  assert.equal(updated.location, 'Gym');
  assert.equal(updated.description, 'Stack chairs');
});

test('clearing a volunteer signup un-assigns that member, reopening the slot', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await request(app)
    .post(`/main-admin/events/${eventId}/volunteer-roles`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ roleName: 'Setup Crew', slotsNeeded: '1', _csrf: admin.csrfToken });
  const role = await db.prepare('SELECT * FROM event_volunteer_roles WHERE event_id = ?').get(eventId);
  const member = await createMember();
  await db.prepare('INSERT INTO event_volunteer_signups (volunteer_role_id, member_id) VALUES (?, ?)').run(role.id, member.id);

  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=volunteers&section=volunteers`).set('Cookie', admin.cookie);
  assert.match(page.text, new RegExp(`/main-admin/events/${eventId}/volunteer-roles/${role.id}/signups/${member.id}/clear`));

  const res = await request(app)
    .post(`/main-admin/events/${eventId}/volunteer-roles/${role.id}/signups/${member.id}/clear`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });
  assert.equal(res.status, 302);

  const remaining = await db.prepare('SELECT * FROM event_volunteer_signups WHERE volunteer_role_id = ?').all(role.id);
  assert.equal(remaining.length, 0);
});

test('deleting a volunteer role through its dialog still removes it', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await request(app)
    .post(`/main-admin/events/${eventId}/volunteer-roles`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ roleName: 'Setup Crew', slotsNeeded: '1', _csrf: admin.csrfToken });
  const role = await db.prepare('SELECT * FROM event_volunteer_roles WHERE event_id = ?').get(eventId);

  await request(app)
    .post(`/main-admin/events/${eventId}/volunteer-roles/${role.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });

  const gone = await db.prepare('SELECT * FROM event_volunteer_roles WHERE id = ?').get(role.id);
  assert.equal(gone, undefined);
});

test('Donation Items: row has no trash icon, editing through the dialog updates fields, clearing a claim removes it', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await request(app)
    .post(`/main-admin/events/${eventId}/donation-items`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ itemName: '2-liter sodas', quantityNeeded: '3', _csrf: admin.csrfToken });
  const item = await db.prepare('SELECT * FROM event_donation_items WHERE event_id = ?').get(eventId);
  const member = await createMember();
  const claimInfo = await db.prepare('INSERT INTO event_donation_claims (donation_item_id, member_id, quantity_claimed) VALUES (?, ?, ?)').run(item.id, member.id, 1);

  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=volunteers&section=donations`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /icon-btn-danger" aria-label="Delete 2-liter sodas"/);
  assert.match(page.text, new RegExp(`/main-admin/events/${eventId}/donation-items/${item.id}/claims/${claimInfo.lastInsertRowid}/clear`));

  await request(app)
    .post(`/main-admin/events/${eventId}/donation-items/${item.id}/update`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ itemName: 'Water bottles', quantityNeeded: '10', notes: 'Case of 24', _csrf: admin.csrfToken });
  const updated = await db.prepare('SELECT * FROM event_donation_items WHERE id = ?').get(item.id);
  assert.equal(updated.item_name, 'Water bottles');
  assert.equal(updated.quantity_needed, 10);
  assert.equal(updated.notes, 'Case of 24');

  await request(app)
    .post(`/main-admin/events/${eventId}/donation-items/${item.id}/claims/${claimInfo.lastInsertRowid}/clear`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });
  const remaining = await db.prepare('SELECT * FROM event_donation_claims WHERE donation_item_id = ?').all(item.id);
  assert.equal(remaining.length, 0);
});

test('Food Items: row has no trash icon, editing through the dialog updates fields, clearing a claim removes it', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await request(app)
    .post(`/main-admin/events/${eventId}/food-items`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ itemName: 'Side dish for 8', quantityNeeded: '2', _csrf: admin.csrfToken });
  const item = await db.prepare('SELECT * FROM event_food_items WHERE event_id = ?').get(eventId);
  const member = await createMember();
  const claimInfo = await db.prepare('INSERT INTO event_food_claims (food_item_id, member_id, quantity_claimed) VALUES (?, ?, ?)').run(item.id, member.id, 1);

  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=volunteers&section=food`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /icon-btn-danger" aria-label="Delete Side dish for 8"/);
  assert.match(page.text, new RegExp(`/main-admin/events/${eventId}/food-items/${item.id}/claims/${claimInfo.lastInsertRowid}/clear`));

  await request(app)
    .post(`/main-admin/events/${eventId}/food-items/${item.id}/update`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ itemName: 'Main dish for 8', quantityNeeded: '4', notes: 'Needs a slow cooker', _csrf: admin.csrfToken });
  const updated = await db.prepare('SELECT * FROM event_food_items WHERE id = ?').get(item.id);
  assert.equal(updated.item_name, 'Main dish for 8');
  assert.equal(updated.quantity_needed, 4);
  assert.equal(updated.notes, 'Needs a slow cooker');

  await request(app)
    .post(`/main-admin/events/${eventId}/food-items/${item.id}/claims/${claimInfo.lastInsertRowid}/clear`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });
  const remaining = await db.prepare('SELECT * FROM event_food_claims WHERE food_item_id = ?').all(item.id);
  assert.equal(remaining.length, 0);
});
