// Coverage for a real request: "Signup lists and volunteer lists add
// button that says copy link. When you click it will say copied and you
// will have copied the member link to the volunteer or signup list to
// paste somewhere else to share." Before this, neither list type had a
// standalone member-facing page at all (only reachable embedded inside
// an attached event's own page) - routes/signup-volunteer-lists.js gives
// each list its own /signup-lists/:id or /volunteer-lists/:id page
// (whether or not it's attached to an event), which is what the new
// Copy Link button on each Main Admin list detail page now copies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `signup-volunteer-lists-copy-link-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `signup-volunteer-lists-copy-link-test-uploads-${process.pid}`);
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

async function createParentAccount(label) {
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`${label} Family`)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`${label} Parent`, code, code, familyId);
  const email = `${label.toLowerCase().replace(/\s+/g, '-')}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/committees' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/committees').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid };
}

test('Sign-Up List detail page (Main Admin) shows a Copy Link button pointing at the new standalone member page', async () => {
  const admin = await loginAsMainAdmin();
  const createRes = await request(app).post('/main-admin/volunteers/signup-lists').set('Cookie', admin.cookie).type('form').send({ title: 'Copy Link Signup List', _csrf: admin.csrfToken });
  const listId = Number(/\/signup-lists\/(\d+)/.exec(createRes.headers.location)[1]);

  const detail = await request(app).get(`/main-admin/volunteers/signup-lists/${listId}`).set('Cookie', admin.cookie);
  assert.match(detail.text, new RegExp(`data-copy-link="https?://[^"]+/signup-lists/${listId}"`));
  assert.match(detail.text, /Copy Link/);
});

test('Volunteer List detail page (Main Admin) shows a Copy Link button pointing at the new standalone member page', async () => {
  const admin = await loginAsMainAdmin();
  const createRes = await request(app).post('/main-admin/volunteers/volunteer-lists').set('Cookie', admin.cookie).type('form').send({ title: 'Copy Link Volunteer List', _csrf: admin.csrfToken });
  const listId = Number(/\/volunteer-lists\/(\d+)/.exec(createRes.headers.location)[1]);

  const detail = await request(app).get(`/main-admin/volunteers/volunteer-lists/${listId}`).set('Cookie', admin.cookie);
  assert.match(detail.text, new RegExp(`data-copy-link="https?://[^"]+/volunteer-lists/${listId}"`));
  assert.match(detail.text, /Copy Link/);
});

test('Standalone /signup-lists/:id page works even for a list with no event attached, and a member can claim an item', async () => {
  const admin = await loginAsMainAdmin();
  const createRes = await request(app).post('/main-admin/volunteers/signup-lists').set('Cookie', admin.cookie).type('form').send({ title: 'Standalone Signup List', _csrf: admin.csrfToken });
  const listId = Number(/\/signup-lists\/(\d+)/.exec(createRes.headers.location)[1]);
  await request(app)
    .post(`/main-admin/volunteers/signup-lists/${listId}/items`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ itemName: 'Napkins', quantityNeeded: '2', _csrf: admin.csrfToken });

  const parent = await createParentAccount('Standalone Signup');
  const page = await request(app).get(`/signup-lists/${listId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Napkins/);
  assert.match(page.text, new RegExp(`action="/signup-lists/${listId}/items/\\d+/claim"`));

  const itemRow = await db.prepare('SELECT id FROM sign_up_list_items WHERE list_id = ?').get(listId);
  const claimRes = await request(app)
    .post(`/signup-lists/${listId}/items/${itemRow.id}/claim`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), quantity: '1', _csrf: parent.csrfToken });
  assert.match(claimRes.headers.location, new RegExp(`/signup-lists/${listId}`));
  const claim = await db.prepare('SELECT * FROM sign_up_list_claims WHERE item_id = ? AND member_id = ?').get(itemRow.id, parent.memberId);
  assert.ok(claim, 'expected the claim to be recorded');
});

test('Standalone /volunteer-lists/:id page works even for a list with no event attached, and a member can sign up/cancel a shift', async () => {
  const admin = await loginAsMainAdmin();
  const createRes = await request(app).post('/main-admin/volunteers/volunteer-lists').set('Cookie', admin.cookie).type('form').send({ title: 'Standalone Volunteer List', _csrf: admin.csrfToken });
  const listId = Number(/\/volunteer-lists\/(\d+)/.exec(createRes.headers.location)[1]);
  await request(app)
    .post(`/main-admin/volunteers/volunteer-lists/${listId}/shifts`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ jobName: 'Setup', slotsNeeded: '2', _csrf: admin.csrfToken });

  const parent = await createParentAccount('Standalone Volunteer');
  const page = await request(app).get(`/volunteer-lists/${listId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Setup/);

  const shift = await db.prepare('SELECT id FROM volunteer_signup_list_shifts WHERE list_id = ?').get(listId);
  const signupRes = await request(app)
    .post(`/volunteer-lists/${listId}/shifts/${shift.id}/signup`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  assert.match(signupRes.headers.location, new RegExp(`/volunteer-lists/${listId}`));
  let signup = await db.prepare('SELECT * FROM volunteer_signup_list_signups WHERE shift_id = ? AND member_id = ?').get(shift.id, parent.memberId);
  assert.ok(signup, 'expected the signup to be recorded');

  await request(app)
    .post(`/volunteer-lists/${listId}/shifts/${shift.id}/cancel`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  signup = await db.prepare('SELECT * FROM volunteer_signup_list_signups WHERE shift_id = ? AND member_id = ?').get(shift.id, parent.memberId);
  assert.equal(signup, undefined, 'expected the signup to be cancelled');
});

test('Standalone list pages require sign-in', async () => {
  const admin = await loginAsMainAdmin();
  const createRes = await request(app).post('/main-admin/volunteers/signup-lists').set('Cookie', admin.cookie).type('form').send({ title: 'Signed Out Test List', _csrf: admin.csrfToken });
  const listId = Number(/\/signup-lists\/(\d+)/.exec(createRes.headers.location)[1]);
  const res = await request(app).get(`/signup-lists/${listId}`);
  assert.equal(res.status, 302);
});
