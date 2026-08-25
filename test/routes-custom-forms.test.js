// Route-level coverage for Custom Forms (Community & Commerce track,
// item 7). See utils/customForms.js's own comments and
// supabase/migrations/20260825070000_custom_forms.sql for the design
// this exercises: one generic field-type system, "assign to specific
// people or groups" access control, and one submission per (form,
// member).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `custom-forms-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `custom-forms-test-uploads-${process.pid}`);
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
async function createParentAccount() {
  familyCounter += 1;
  const familyName = `Test Family ${familyCounter}`;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Parent ${familyCounter}`, code, code, familyId);
  const email = `parent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/forms' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/forms').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid, familyId };
}

async function createAndPublishForm(admin, title) {
  const createRes = await request(app).post('/main-admin/forms').set('Cookie', admin.cookie).type('form').send({ title, _csrf: admin.csrfToken });
  const formId = /\/main-admin\/forms\/(\d+)\/builder/.exec(createRes.headers.location)[1];
  await request(app).post(`/main-admin/forms/${formId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });
  return formId;
}

test('forms require sign-in - no public browsing', async () => {
  const res = await request(app).get('/forms');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\?next=/);
});

test('an unassigned published form is open to any signed-in account, and answers of every simple type are stored', async () => {
  const admin = await loginAsMainAdmin();
  const formId = await createAndPublishForm(admin, 'General Feedback');
  await request(app)
    .post(`/main-admin/forms/${formId}/fields`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ fieldType: 'short_text', label: 'Favorite color', isRequired: 'on', _csrf: admin.csrfToken });
  await request(app)
    .post(`/main-admin/forms/${formId}/fields`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ fieldType: 'single_choice', label: 'Preferred day', options: 'Monday\nWednesday', _csrf: admin.csrfToken });
  await request(app)
    .post(`/main-admin/forms/${formId}/fields`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ fieldType: 'checkbox', label: 'Subscribe to updates', _csrf: admin.csrfToken });

  const parent = await createParentAccount();
  const listPage = await request(app).get('/forms').set('Cookie', parent.cookie);
  assert.match(listPage.text, /General Feedback/);

  const fields = await db.prepare('SELECT id, field_type FROM custom_form_fields WHERE form_id = ? ORDER BY position').all(formId);
  const [colorField, dayField, subField] = fields;

  const submitRes = await request(app)
    .post(`/forms/${formId}/submit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({
      memberId: String(parent.memberId),
      [`field_${colorField.id}`]: 'Blue',
      [`field_${dayField.id}`]: 'Wednesday',
      [`field_${subField.id}`]: '1',
      _csrf: parent.csrfToken,
    });
  assert.match(submitRes.headers.location, new RegExp(`/forms/${formId}/mine/${parent.memberId}`));

  const submission = await db.prepare('SELECT id FROM custom_form_submissions WHERE form_id = ? AND member_id = ?').get(formId, parent.memberId);
  const answers = await db.prepare('SELECT field_id, value_text FROM custom_form_answers WHERE submission_id = ?').all(submission.id);
  const byField = new Map(answers.map((a) => [a.field_id, a.value_text]));
  assert.equal(byField.get(colorField.id), 'Blue');
  assert.equal(byField.get(dayField.id), 'Wednesday');
  assert.equal(byField.get(subField.id), '1');
});

test('multiple_choice stores every selected option, and required fields block submission when missing', async () => {
  const admin = await loginAsMainAdmin();
  const formId = await createAndPublishForm(admin, 'Volunteer Interests');
  await request(app)
    .post(`/main-admin/forms/${formId}/fields`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ fieldType: 'short_text', label: 'Name', isRequired: 'on', _csrf: admin.csrfToken });
  await request(app)
    .post(`/main-admin/forms/${formId}/fields`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ fieldType: 'multiple_choice', label: 'Interests', options: 'Setup\nCleanup\nFundraising', _csrf: admin.csrfToken });

  const fields = await db.prepare('SELECT id, field_type FROM custom_form_fields WHERE form_id = ? ORDER BY position').all(formId);
  const [nameField, interestsField] = fields;
  const options = await db.prepare('SELECT id, label FROM custom_form_field_options WHERE field_id = ?').all(interestsField.id);
  const setup = options.find((o) => o.label === 'Setup');
  const fundraising = options.find((o) => o.label === 'Fundraising');

  const parent = await createParentAccount();

  const missingRequired = await request(app)
    .post(`/forms/${formId}/submit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), [`field_${nameField.id}`]: '', _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(missingRequired.headers.location), /is required/);

  await request(app)
    .post(`/forms/${formId}/submit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({
      memberId: String(parent.memberId),
      [`field_${nameField.id}`]: 'A Volunteer',
      [`field_${interestsField.id}`]: [String(setup.id), String(fundraising.id)],
      _csrf: parent.csrfToken,
    });

  const submission = await db.prepare('SELECT id FROM custom_form_submissions WHERE form_id = ? AND member_id = ?').get(formId, parent.memberId);
  const answer = await db.prepare('SELECT id FROM custom_form_answers WHERE submission_id = ? AND field_id = ?').get(submission.id, interestsField.id);
  const choices = await db
    .prepare('SELECT o.label FROM custom_form_answer_choices c JOIN custom_form_field_options o ON o.id = c.option_id WHERE c.answer_id = ? ORDER BY o.position')
    .all(answer.id);
  assert.deepEqual(choices.map((c) => c.label), ['Setup', 'Fundraising']);
});

test('a form assigned to a specific member is hidden from everyone else', async () => {
  const admin = await loginAsMainAdmin();
  const formId = await createAndPublishForm(admin, 'Field Trip Permission');
  const targetParent = await createParentAccount();
  const outsiderParent = await createParentAccount();

  await request(app).post(`/main-admin/forms/${formId}/assignments`).set('Cookie', admin.cookie).type('form').send({ memberId: String(targetParent.memberId), _csrf: admin.csrfToken });

  const targetView = await request(app).get(`/forms/${formId}`).set('Cookie', targetParent.cookie);
  assert.equal(targetView.status, 200);

  const outsiderView = await request(app).get(`/forms/${formId}`).set('Cookie', outsiderParent.cookie);
  assert.equal(outsiderView.status, 403);

  const outsiderList = await request(app).get('/forms').set('Cookie', outsiderParent.cookie);
  assert.doesNotMatch(outsiderList.text, /Field Trip Permission/);
});

test('a form assigned to a role (group) is open to every account holding that role', async () => {
  const admin = await loginAsMainAdmin();
  const formId = await createAndPublishForm(admin, 'Parent Survey');
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await request(app).post(`/main-admin/forms/${formId}/assignments`).set('Cookie', admin.cookie).type('form').send({ roleId: String(parentRole.id), _csrf: admin.csrfToken });

  const anyParent = await createParentAccount();
  const view = await request(app).get(`/forms/${formId}`).set('Cookie', anyParent.cookie);
  assert.equal(view.status, 200);
});

test('resubmitting a form redirects to the existing submission instead of creating a second one', async () => {
  const admin = await loginAsMainAdmin();
  const formId = await createAndPublishForm(admin, 'One-Time Survey');
  await request(app)
    .post(`/main-admin/forms/${formId}/fields`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ fieldType: 'short_text', label: 'Comment', _csrf: admin.csrfToken });
  const field = await db.prepare('SELECT id FROM custom_form_fields WHERE form_id = ?').get(formId);

  const parent = await createParentAccount();
  await request(app)
    .post(`/forms/${formId}/submit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), [`field_${field.id}`]: 'First', _csrf: parent.csrfToken });
  await request(app)
    .post(`/forms/${formId}/submit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), [`field_${field.id}`]: 'Second', _csrf: parent.csrfToken });

  const count = Number((await db.prepare('SELECT COUNT(*) AS c FROM custom_form_submissions WHERE form_id = ? AND member_id = ?').get(formId, parent.memberId)).c);
  assert.equal(count, 1);
});

test('an account cannot submit a form for a member outside its own family', async () => {
  const admin = await loginAsMainAdmin();
  const formId = await createAndPublishForm(admin, 'Open Survey');
  const parentA = await createParentAccount();
  const parentB = await createParentAccount();

  const res = await request(app)
    .post(`/forms/${formId}/submit`)
    .set('Cookie', parentA.cookie)
    .type('form')
    .send({ memberId: String(parentB.memberId), _csrf: parentA.csrfToken });
  assert.match(decodeURIComponent(res.headers.location), /You can only submit for yourself or your own family/);

  const row = await db.prepare('SELECT 1 FROM custom_form_submissions WHERE form_id = ? AND member_id = ?').get(formId, parentB.memberId);
  assert.equal(row, undefined);
});
