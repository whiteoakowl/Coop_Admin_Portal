// Coverage for Main Admin's new Volunteers section - a real request:
// "main admin portal, volunteer tab, sub pages committees, sign up list,
// volunteer list. sign up list you can create a list of things for
// people to sign up for. volunteer list you can create a list of jobs by
// date or hour that members can sign up for. be able to create multiple
// lists of each. be able to attach these lists to events. add a button
// on the parent portal homepage for committee sign up, click the button
// and they can fill out a form and choose committee positions to help
// with. on main admin portal under volunteers, committee tab you can
// create committees, disable and enable them with check boxes, and
// delete trash button. click on each committee and you can view who is
// signed up for that committee and email button next to each member or
// select all email button, check boxes. when viewing list of committees
// there is also an edit button. click edit button to edit the
// description of the committee, leader and contact information."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-volunteers-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-volunteers-test-uploads-${process.pid}`);
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

let familyCounter = 0;
async function createFamily() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Vol Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
      .run(`VolParent${familyCounter} Jones${familyCounter}`, parentCode, parentCode, familyId)
  ).lastInsertRowid;
  const email = `volparent${familyCounter}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
      .run(parentId, email, hashPassword('testpassword123'))
  ).lastInsertRowid;
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, parentRole.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/parent').set('Cookie', cookie);
  return { familyId, parentId, accountId, cookie, csrfToken: extractCsrf(page.text) };
}

test('Volunteers sidebar: nav group with Committees/Sign-Up Lists/Volunteer Lists subpages', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin').set('Cookie', admin.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<details class="admin-nav-group">\s*<summary>[\s\S]*?Volunteers/);
  assert.match(res.text, /href="\/main-admin\/volunteers">Committees</);
  assert.match(res.text, /href="\/main-admin\/volunteers\?tab=signup-lists">Sign-Up Lists</);
  assert.match(res.text, /href="\/main-admin\/volunteers\?tab=volunteer-lists">Volunteer Lists</);
});

test('Committees: create, edit, enable/disable with a checkbox, and delete', async () => {
  const admin = await loginAsMainAdmin();
  const createRes = await request(app)
    .post('/main-admin/volunteers/committees')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Fundraising', description: 'Raises money', leaderName: 'Jane Doe', contactInfo: 'jane@example.com', _csrf: admin.csrfToken });
  assert.match(createRes.headers.location, /notice=/);

  const listRes = await request(app).get('/main-admin/volunteers').set('Cookie', admin.cookie);
  assert.match(listRes.text, /Fundraising/);
  assert.match(listRes.text, /Jane Doe/);
  const committee = await db.prepare('SELECT * FROM committees WHERE name = ?').get('Fundraising');
  assert.equal(committee.enabled, 1, 'a new committee starts enabled');

  // Edit description/leader/contact from the detail page's own Edit dialog.
  const detailRes = await request(app).get(`/main-admin/volunteers/committees/${committee.id}`).set('Cookie', admin.cookie);
  assert.equal(detailRes.status, 200);
  assert.match(detailRes.text, /id="edit-committee-dialog"/);
  await request(app)
    .post(`/main-admin/volunteers/committees/${committee.id}/update`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Fundraising Committee', description: 'Updated', leaderName: 'Jane Smith', contactInfo: 'jane.smith@example.com', _csrf: admin.csrfToken });
  const updated = await db.prepare('SELECT * FROM committees WHERE id = ?').get(committee.id);
  assert.equal(updated.name, 'Fundraising Committee');
  assert.equal(updated.leader_name, 'Jane Smith');
  assert.equal(updated.contact_info, 'jane.smith@example.com');

  // Disable via the checkbox form on the list page.
  await request(app).post(`/main-admin/volunteers/committees/${committee.id}/enabled`).set('Cookie', admin.cookie).type('form').send({ enabled: '0', _csrf: admin.csrfToken });
  assert.equal((await db.prepare('SELECT enabled FROM committees WHERE id = ?').get(committee.id)).enabled, 0);
  await request(app).post(`/main-admin/volunteers/committees/${committee.id}/enabled`).set('Cookie', admin.cookie).type('form').send({ enabled: '1', _csrf: admin.csrfToken });
  assert.equal((await db.prepare('SELECT enabled FROM committees WHERE id = ?').get(committee.id)).enabled, 1);

  // Delete via the trash button.
  await request(app).post(`/main-admin/volunteers/committees/${committee.id}/delete`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  assert.equal(await db.prepare('SELECT * FROM committees WHERE id = ?').get(committee.id), undefined);
});

test('Committee detail: positions, member signups, email links (individual + select-all)', async () => {
  const admin = await loginAsMainAdmin();
  await request(app)
    .post('/main-admin/volunteers/committees')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Events Committee', _csrf: admin.csrfToken });
  const committeeId = (await db.prepare('SELECT id FROM committees WHERE name = ?').get('Events Committee')).id;

  await request(app)
    .post(`/main-admin/volunteers/committees/${committeeId}/positions`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ positionName: 'Chair', slotsNeeded: '1', _csrf: admin.csrfToken });
  const position = await db.prepare('SELECT * FROM committee_positions WHERE committee_id = ?').get(committeeId);

  const family = await createFamily();
  await db.prepare("UPDATE members SET email = 'volparent1@example.com' WHERE id = ?").run(family.parentId);
  await db.prepare('INSERT INTO committee_signups (position_id, member_id, signed_up_by_account_id) VALUES (?, ?, ?)').run(position.id, family.parentId, family.accountId);

  const detailRes = await request(app).get(`/main-admin/volunteers/committees/${committeeId}`).set('Cookie', admin.cookie);
  assert.equal(detailRes.status, 200);
  assert.match(detailRes.text, /Chair/);
  assert.match(detailRes.text, new RegExp(`VolParent1 Jones1`));
  assert.match(detailRes.text, /class="committee-select-all"/);
  assert.match(detailRes.text, /class="roster-action-btn committee-email-selected"/);
  assert.match(detailRes.text, /href="mailto:volparent1@example.com"/);

  // Removing the position is the admin's own delete/trash action.
  await request(app)
    .post(`/main-admin/volunteers/committees/${committeeId}/positions/${position.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });
  assert.equal(await db.prepare('SELECT * FROM committee_positions WHERE id = ?').get(position.id), undefined);
});

test('Committee member-facing sign up: parent portal has a Committee Sign Up button, and a family can sign up/cancel', async () => {
  const admin = await loginAsMainAdmin();
  await request(app).post('/main-admin/volunteers/committees').set('Cookie', admin.cookie).type('form').send({ name: 'Welcome Committee', _csrf: admin.csrfToken });
  const committee = await db.prepare('SELECT * FROM committees WHERE name = ?').get('Welcome Committee');
  await request(app).post(`/main-admin/volunteers/committees/${committee.id}/positions`).set('Cookie', admin.cookie).type('form').send({ positionName: 'Greeter', _csrf: admin.csrfToken });
  const position = await db.prepare('SELECT * FROM committee_positions WHERE committee_id = ?').get(committee.id);

  const family = await createFamily();
  const homeRes = await request(app).get('/parent').set('Cookie', family.cookie);
  assert.match(homeRes.text, /Committee Sign Up/);
  assert.match(homeRes.text, /href="\/committees"/);

  const committeesPage = await request(app).get('/committees').set('Cookie', family.cookie);
  assert.equal(committeesPage.status, 200);
  assert.match(committeesPage.text, /Welcome Committee/);
  assert.match(committeesPage.text, /Greeter/);

  const signupRes = await request(app)
    .post(`/committees/${position.id}/signup`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ memberId: family.parentId, _csrf: family.csrfToken });
  assert.match(signupRes.headers.location, /notice=/);
  assert.ok(await db.prepare('SELECT 1 FROM committee_signups WHERE position_id = ? AND member_id = ?').get(position.id, family.parentId));

  const cancelRes = await request(app)
    .post(`/committees/${position.id}/cancel`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ memberId: family.parentId, _csrf: family.csrfToken });
  assert.match(cancelRes.headers.location, /notice=/);
  assert.equal(await db.prepare('SELECT 1 FROM committee_signups WHERE position_id = ? AND member_id = ?').get(position.id, family.parentId), undefined);

  // A different family cannot sign up someone else's member.
  const otherFamily = await createFamily();
  const blocked = await request(app)
    .post(`/committees/${position.id}/signup`)
    .set('Cookie', otherFamily.cookie)
    .type('form')
    .send({ memberId: family.parentId, _csrf: otherFamily.csrfToken });
  assert.match(blocked.headers.location, /error=/);
});

test('Sign-Up Lists: create multiple lists, attach one to an event, add items, and a member claims one', async () => {
  const admin = await loginAsMainAdmin();
  const eventCreate = await request(app).post('/main-admin/events').set('Cookie', admin.cookie).type('form').send({ title: 'Fall Potluck', startsAt: '2027-10-01T18:00', _csrf: admin.csrfToken });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(eventCreate.headers.location)[1]);
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });

  const list1 = await request(app).post('/main-admin/volunteers/signup-lists').set('Cookie', admin.cookie).type('form').send({ title: 'Potluck Dishes', eventId: String(eventId), _csrf: admin.csrfToken });
  const list2 = await request(app).post('/main-admin/volunteers/signup-lists').set('Cookie', admin.cookie).type('form').send({ title: 'Supply Drive', _csrf: admin.csrfToken });
  assert.match(list1.headers.location, /notice=/);
  assert.match(list2.headers.location, /notice=/);
  const lists = await db.prepare('SELECT * FROM sign_up_lists ORDER BY id').all();
  assert.equal(lists.length, 2, 'multiple lists can be created');

  const listPage = await request(app).get('/main-admin/volunteers?tab=signup-lists').set('Cookie', admin.cookie);
  assert.match(listPage.text, /Potluck Dishes/);
  assert.match(listPage.text, /Supply Drive/);
  assert.match(listPage.text, /Fall Potluck/, 'the attached event title should show in the list');

  const listId = lists.find((l) => l.title === 'Potluck Dishes').id;
  await request(app).post(`/main-admin/volunteers/signup-lists/${listId}/items`).set('Cookie', admin.cookie).type('form').send({ itemName: 'Cookies', quantityNeeded: '2', _csrf: admin.csrfToken });
  const item = await db.prepare('SELECT * FROM sign_up_list_items WHERE list_id = ?').get(listId);

  const family = await createFamily();
  const eventPage = await request(app).get(`/events/${eventId}`).set('Cookie', family.cookie);
  assert.match(eventPage.text, /Potluck Dishes/);
  assert.match(eventPage.text, /Cookies/);
  assert.doesNotMatch(eventPage.text, /Supply Drive/, 'an unattached list should not show on the event page');

  const claimRes = await request(app)
    .post(`/events/${eventId}/signup-list-items/${item.id}/claim`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ memberId: family.parentId, quantity: '1', _csrf: family.csrfToken });
  assert.match(claimRes.headers.location, /notice=/);
  const claim = await db.prepare('SELECT * FROM sign_up_list_claims WHERE item_id = ?').get(item.id);
  assert.equal(claim.member_id, family.parentId);
  assert.equal(claim.quantity_claimed, 1);
});

test('Volunteer Lists: create a list of shifts by date/hour, attach to an event, and a member signs up/cancels', async () => {
  const admin = await loginAsMainAdmin();
  const eventCreate = await request(app).post('/main-admin/events').set('Cookie', admin.cookie).type('form').send({ title: 'Winter Gala', startsAt: '2027-12-01T18:00', _csrf: admin.csrfToken });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(eventCreate.headers.location)[1]);
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });

  const listRes = await request(app)
    .post('/main-admin/volunteers/volunteer-lists')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Gala Setup Crew', eventId: String(eventId), _csrf: admin.csrfToken });
  const listId = Number(listRes.headers.location.match(/volunteer-lists\/(\d+)/)[1]);

  await request(app)
    .post(`/main-admin/volunteers/volunteer-lists/${listId}/shifts`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ jobName: 'Chair Setup', shiftDate: '2027-12-01', startTime: '08:00', endTime: '09:00', slotsNeeded: '1', _csrf: admin.csrfToken });
  const shift = await db.prepare('SELECT * FROM volunteer_signup_list_shifts WHERE list_id = ?').get(listId);
  assert.equal(shift.job_name, 'Chair Setup');
  assert.equal(shift.shift_date, '2027-12-01');

  const detailRes = await request(app).get(`/main-admin/volunteers/volunteer-lists/${listId}`).set('Cookie', admin.cookie);
  assert.match(detailRes.text, /Chair Setup/);
  assert.match(detailRes.text, /2027-12-01/);

  const family = await createFamily();
  const eventPage = await request(app).get(`/events/${eventId}`).set('Cookie', family.cookie);
  assert.match(eventPage.text, /Gala Setup Crew/);
  assert.match(eventPage.text, /Chair Setup/);

  const signupRes = await request(app)
    .post(`/events/${eventId}/volunteer-list-shifts/${shift.id}/signup`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ memberId: family.parentId, _csrf: family.csrfToken });
  assert.match(signupRes.headers.location, /notice=/);
  assert.ok(await db.prepare('SELECT 1 FROM volunteer_signup_list_signups WHERE shift_id = ? AND member_id = ?').get(shift.id, family.parentId));

  // Full shift no longer offers a Sign Up button for someone else.
  const otherFamily = await createFamily();
  const fullEventPage = await request(app).get(`/events/${eventId}`).set('Cookie', otherFamily.cookie);
  assert.doesNotMatch(fullEventPage.text, new RegExp(`${otherFamily.parentId}[^]*Sign Up`));

  const cancelRes = await request(app)
    .post(`/events/${eventId}/volunteer-list-shifts/${shift.id}/cancel`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ memberId: family.parentId, _csrf: family.csrfToken });
  assert.match(cancelRes.headers.location, /notice=/);
  assert.equal(await db.prepare('SELECT 1 FROM volunteer_signup_list_signups WHERE shift_id = ? AND member_id = ?').get(shift.id, family.parentId), undefined);
});

test('the pre-existing Floater Assignments feature (utils/volunteers.js) is untouched by the new Volunteers section', async () => {
  // Floater Assignments is a Co-op Admin feature at /admin/volunteers,
  // a completely different URL prefix from the new Main Admin section's
  // own /main-admin/volunteers - just confirm the route that depends on
  // utils/volunteers.js's own getListByDay still boots and renders end
  // to end (a real regression risk this session: utils/volunteers.js was
  // briefly, accidentally overwritten while building this new feature,
  // which crashed server boot entirely via
  // classSchedule.js's autoAssignFloatersForDay).
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD });
  const cookie = loginRes.headers['set-cookie'];
  const res = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  assert.equal(res.status, 200);
});
