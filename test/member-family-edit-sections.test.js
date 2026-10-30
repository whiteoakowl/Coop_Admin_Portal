// Coverage for a real request: "This page should look exactly like the
// membership request form. The additional parent sections and
// information, children sections and information. With family
// information below." (Main Admin's own Edit Member page) and "Parent
// portal, profile icon, edit button, should look exactly like the
// membership request form. All sections and features should be the
// same." Both admin portals' Edit Member pages, and Parent Portal's own
// Edit Profile page, now render an "Additional Parents/Guardians" and a
// "Children" section (partials/member-edit-family-sections.ejs) listing
// every OTHER member of the same family, each editable in place, plus
// a +Add Adult/+Add Child button to create a brand-new one - all saved
// together with the rest of the page in one submission (utils/
// memberFamilyEdit.js), replacing the old separate inline "Family
// Members" quick-edit table and "Add to This Family" quick-add dialog.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `member-family-edit-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `member-family-edit-test-uploads-${process.pid}`);
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
const { hashPassword, verifyPassword } = require('../utils/portalAuth');
const { generateMemberCode } = require('../utils/members');
const membershipFormFields = require('../utils/membershipFormFields');

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

async function loginAsCoopAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

let familyCounter = 0;
async function makeFamily(prefix) {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`${prefix} Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parent = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1) RETURNING id")
    .get(`${prefix} Primary Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const otherParentCode = await generateMemberCode();
  const otherParent = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, phone, active) VALUES (?, ?, ?, ?, ?, '555-0000', 1) RETURNING id")
    .get(`${prefix} Other Parent ${familyCounter}`, otherParentCode, otherParentCode, 'parent', familyId);
  const kidCode = await generateMemberCode();
  const kid = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, birthday, active) VALUES (?, ?, ?, 'student', ?, '2016-01-01', 1) RETURNING id")
    .get(`${prefix} Kid ${familyCounter}`, kidCode, kidCode, familyId);
  return { familyId, parentId: parent.id, otherParentId: otherParent.id, kidId: kid.id };
}

test('Main Admin Edit Member page prefills Additional Parent/Children blocks with existing family members', async () => {
  const cookie = await loginAsMainAdmin();
  const fam = await makeFamily('MainPrefill');
  const page = await request(app).get(`/main-admin/members/${fam.parentId}/edit`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Additional Parents \/ Guardians/);
  assert.match(page.text, new RegExp(`name="additionalParents\\[0\\]\\[id\\]" value="${fam.otherParentId}"`));
  assert.match(page.text, new RegExp(`name="additionalParents\\[0\\]\\[name\\]" value="MainPrefill Other Parent ${familyCounter}"`));
  assert.match(page.text, /name="additionalParents\[0\]\[phone\]" value="555-0000"/);
  assert.match(page.text, />Children</);
  assert.match(page.text, new RegExp(`name="children\\[0\\]\\[id\\]" value="${fam.kidId}"`));
  assert.match(page.text, /name="children\[0\]\[birthdate\]" value="2016-01-01"/);
  assert.match(page.text, /id="add-adult-btn"/);
  assert.match(page.text, /id="add-child-btn"/);
});

test('Main Admin: editing an existing Additional Parent block updates that real member, not the primary one', async () => {
  const cookie = await loginAsMainAdmin();
  const fam = await makeFamily('MainEditAdult');
  const page = await request(app).get(`/main-admin/members/${fam.parentId}/edit`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/main-admin/members/${fam.parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      name: `MainEditAdult Primary Parent ${familyCounter}`,
      familyId: String(fam.familyId),
      'additionalParents[0][id]': String(fam.otherParentId),
      'additionalParents[0][name]': 'Renamed Other Parent',
      'additionalParents[0][phone]': '555-9999',
      'additionalParents[0][sameAddress]': '1',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const other = await db.prepare('SELECT name, phone, family_id FROM members WHERE id = ?').get(fam.otherParentId);
  assert.equal(other.name, 'Renamed Other Parent');
  assert.equal(other.phone, '555-9999');
  assert.equal(other.family_id, fam.familyId, 'still the same family - this route never reassigns an existing family member elsewhere');

  const primary = await db.prepare('SELECT name FROM members WHERE id = ?').get(fam.parentId);
  assert.equal(primary.name, `MainEditAdult Primary Parent ${familyCounter}`, 'the primary member\'s own edit still saved too');
});

test('Main Admin: a blank Full Name on an existing block is a no-op, never a delete', async () => {
  const cookie = await loginAsMainAdmin();
  const fam = await makeFamily('MainBlankName');
  const page = await request(app).get(`/main-admin/members/${fam.parentId}/edit`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  await request(app)
    .post(`/main-admin/members/${fam.parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      name: `MainBlankName Primary Parent ${familyCounter}`,
      'additionalParents[0][id]': String(fam.otherParentId),
      'additionalParents[0][name]': '',
      _csrf: csrfToken,
    });

  const other = await db.prepare('SELECT name FROM members WHERE id = ?').get(fam.otherParentId);
  assert.equal(other.name, `MainBlankName Other Parent ${familyCounter}`, 'unchanged, and the member still exists');
});

test('Main Admin: +Add Adult (a blank block with no id) creates a brand-new family member', async () => {
  const cookie = await loginAsMainAdmin();
  const fam = await makeFamily('MainAddAdult');
  const page = await request(app).get(`/main-admin/members/${fam.parentId}/edit`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/main-admin/members/${fam.parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      name: `MainAddAdult Primary Parent ${familyCounter}`,
      familyId: String(fam.familyId),
      'additionalParents[0][id]': String(fam.otherParentId),
      'additionalParents[0][name]': `MainAddAdult Other Parent ${familyCounter}`,
      'additionalParents[1][id]': '',
      'additionalParents[1][name]': 'Brand New Adult',
      'additionalParents[1][email]': 'brandnewadult@example.com',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const created = await db.prepare("SELECT * FROM members WHERE name = 'Brand New Adult'").get();
  assert.ok(created, 'the new adult should have been created');
  assert.equal(created.member_type, 'parent');
  assert.equal(created.family_id, fam.familyId);
  assert.equal(created.email, 'brandnewadult@example.com');
});

// A real request: "All members should automatically have the password
// changeme123... Being on the member list means they already have an
// active account and this password." No opt-in checkbox anymore - an
// email (a contact Email for an adult, a typed Student Login Email for
// a child) is already enough on its own.
// A real request: "Not volunteer for setup crew check box. It should be
// the same address as parent number 1 check box. Allow member to create
// portal. The two checkboxes on the member request form." - the "Give
// this parent/student their own portal login" checkbox is back on both
// blocks, same as the public form's own; checking it (not just typing
// an email) is what creates the account, defaulting to changeme123 when
// no password is typed.
test('Main Admin: +Add Child with the login checkbox checked creates a new student and an active changeme123 account, no password typed', async () => {
  const cookie = await loginAsMainAdmin();
  const fam = await makeFamily('MainAddChild');
  const page = await request(app).get(`/main-admin/members/${fam.parentId}/edit`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/main-admin/members/${fam.parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      name: `MainAddChild Primary Parent ${familyCounter}`,
      familyId: String(fam.familyId),
      'children[0][id]': String(fam.kidId),
      'children[0][name]': `MainAddChild Kid ${familyCounter}`,
      'children[0][birthdate]': '2016-01-01',
      'children[1][id]': '',
      'children[1][name]': 'Brand New Kid',
      'children[1][birthdate]': '2017-02-02',
      'children[1][wantsLogin]': '1',
      'children[1][loginEmail]': 'brandnewkid@example.com',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const created = await db.prepare("SELECT * FROM members WHERE name = 'Brand New Kid'").get();
  assert.ok(created, 'the new child should have been created');
  assert.equal(created.member_type, 'student');
  assert.equal(created.birthday, '2017-02-02');
  const account = await db.prepare("SELECT email, status, password_hash FROM member_accounts WHERE member_id = ?").get(created.id);
  assert.equal(account.email, 'brandnewkid@example.com');
  assert.equal(account.status, 'active');
  assert.ok(await verifyPassword(account, 'changeme123'), 'defaults to changeme123 when no password was typed');
});

test('Main Admin: a Student Login Email typed without checking the login checkbox never creates an account', async () => {
  const cookie = await loginAsMainAdmin();
  const fam = await makeFamily('MainNoCheckbox');
  const page = await request(app).get(`/main-admin/members/${fam.parentId}/edit`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  await request(app)
    .post(`/main-admin/members/${fam.parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      name: `MainNoCheckbox Primary Parent ${familyCounter}`,
      familyId: String(fam.familyId),
      'children[0][id]': '',
      'children[0][name]': 'Unchecked Kid',
      'children[0][loginEmail]': 'uncheckedkid@example.com',
      // 'children[0][wantsLogin]' intentionally omitted.
      _csrf: csrfToken,
    });

  const created = await db.prepare("SELECT * FROM members WHERE name = 'Unchecked Kid'").get();
  assert.ok(created, 'the child itself is still created');
  const account = await db.prepare('SELECT id FROM member_accounts WHERE member_id = ?').get(created.id);
  assert.equal(account, undefined, 'no account without the checkbox, even with an email typed');
});

test('Main Admin: checking the login checkbox for an existing Additional Parent with an email but no account yet creates one', async () => {
  const cookie = await loginAsMainAdmin();
  const fam = await makeFamily('MainAutoAccount');
  await db.prepare('UPDATE members SET email = ? WHERE id = ?').run('autoaccount@example.com', fam.otherParentId);
  const page = await request(app).get(`/main-admin/members/${fam.parentId}/edit`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/main-admin/members/${fam.parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      name: `MainAutoAccount Primary Parent ${familyCounter}`,
      familyId: String(fam.familyId),
      'additionalParents[0][id]': String(fam.otherParentId),
      'additionalParents[0][name]': `MainAutoAccount Other Parent ${familyCounter}`,
      'additionalParents[0][email]': 'autoaccount@example.com',
      'additionalParents[0][wantsLogin]': '1',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const account = await db.prepare("SELECT email, status, password_hash FROM member_accounts WHERE member_id = ?").get(fam.otherParentId);
  assert.ok(account, 'checking the login checkbox should have created an account, even with no password typed');
  assert.equal(account.email, 'autoaccount@example.com');
  assert.equal(account.status, 'active');
  assert.ok(await verifyPassword(account, 'changeme123'));
});

test('Main Admin: leaving the login checkbox unchecked for an existing Additional Parent with an email never creates an account', async () => {
  const cookie = await loginAsMainAdmin();
  const fam = await makeFamily('MainNoCheckboxExisting');
  await db.prepare('UPDATE members SET email = ? WHERE id = ?').run('nocheckboxexisting@example.com', fam.otherParentId);
  const page = await request(app).get(`/main-admin/members/${fam.parentId}/edit`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  await request(app)
    .post(`/main-admin/members/${fam.parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      name: `MainNoCheckboxExisting Primary Parent ${familyCounter}`,
      familyId: String(fam.familyId),
      'additionalParents[0][id]': String(fam.otherParentId),
      'additionalParents[0][name]': `MainNoCheckboxExisting Other Parent ${familyCounter}`,
      'additionalParents[0][email]': 'nocheckboxexisting@example.com',
      // 'additionalParents[0][wantsLogin]' intentionally omitted.
      _csrf: csrfToken,
    });

  const account = await db.prepare('SELECT id FROM member_accounts WHERE member_id = ?').get(fam.otherParentId);
  assert.equal(account, undefined, 'no account without the checkbox, even with an email on file');
});

test('Main Admin: saving a member\'s own edit form with an email but no account and no password typed creates one automatically', async () => {
  const cookie = await loginAsMainAdmin();
  const fam = await makeFamily('MainPrimaryAutoAccount');
  const page = await request(app).get(`/main-admin/members/${fam.parentId}/edit`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/main-admin/members/${fam.parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      name: `MainPrimaryAutoAccount Primary Parent ${familyCounter}`,
      email: 'primaryautoaccount@example.com',
      familyId: String(fam.familyId),
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const account = await db.prepare("SELECT email, status, password_hash FROM member_accounts WHERE member_id = ?").get(fam.parentId);
  assert.ok(account, 'an account should have been created automatically for the primary member too, with no password typed');
  assert.equal(account.email, 'primaryautoaccount@example.com');
  assert.equal(account.status, 'active');
  assert.ok(await verifyPassword(account, 'changeme123'));
});

test('Co-op Admin Edit Member page never offers any password field on Additional Parent/Children blocks, and can never create a portal account from there', async () => {
  const cookie = await loginAsCoopAdmin();
  const fam = await makeFamily('CoopNoLogin');
  const page = await request(app).get(`/admin/members/${fam.parentId}/edit`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Additional Parents \/ Guardians/);
  assert.doesNotMatch(page.text, /loginPassword/, 'Co-op Admin can never create or change a portal login anywhere on this page');

  const csrfToken = extractCsrf(page.text);
  const res = await request(app)
    .post(`/admin/members/${fam.parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      name: `CoopNoLogin Primary Parent ${familyCounter}`,
      familyId: String(fam.familyId),
      'additionalParents[0][id]': '',
      'additionalParents[0][name]': 'Spoofed New Adult',
      'additionalParents[0][email]': 'spoofed@example.com',
      'additionalParents[0][loginPassword]': 'spoofedpassword123',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const created = await db.prepare("SELECT * FROM members WHERE name = 'Spoofed New Adult'").get();
  assert.ok(created, 'the new adult itself is still created');
  const account = await db.prepare('SELECT id FROM member_accounts WHERE member_id = ?').get(created.id);
  assert.equal(account, undefined, 'but a spoofed submission can never create a portal account from Co-op Admin');
});

test('Parent Portal Edit Profile page shows and saves Additional Parent/Children sections for the signed-in member\'s own family', async () => {
  const fam = await makeFamily('ParentSelfEdit');
  const email = `parentselfedit${familyCounter}@example.com`;
  await db.prepare("UPDATE members SET email = ? WHERE id = ?").run(email, fam.parentId);
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(fam.parentId, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/portal/profile/edit' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/portal/profile/edit').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Additional Parents \/ Guardians/);
  assert.match(page.text, new RegExp(`name="additionalParents\\[0\\]\\[id\\]" value="${fam.otherParentId}"`));
  // Admin-only Family reassignment never shows here.
  assert.doesNotMatch(page.text, /name="familyId"/);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post('/portal/profile/edit')
    .set('Cookie', cookie)
    .type('form')
    .send({
      name: (await db.prepare('SELECT name FROM members WHERE id = ?').get(fam.parentId)).name,
      'additionalParents[0][id]': String(fam.otherParentId),
      'additionalParents[0][name]': 'Parent-Edited Other Parent',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const other = await db.prepare('SELECT name FROM members WHERE id = ?').get(fam.otherParentId);
  assert.equal(other.name, 'Parent-Edited Other Parent');
});

// A real request: "Don't forget the check box questions. This should
// look IDENTICAL to the membership request form." - admin-defined extra
// questions (utils/membershipFormFields.js, some of which are
// checkboxes) now render on the unified edit pages too, prefilled with
// whatever the member already answered, and save a changed answer the
// same way the public form itself does.
test('Main Admin Edit Member page renders an admin-defined Parent checkbox question, prefilled, and saves a changed answer', async () => {
  const cookie = await loginAsMainAdmin();
  const fam = await makeFamily('MainCheckboxQ');
  const fieldId = await membershipFormFields.createField('parent', 'Volunteers for setup crew?', 'checkbox', '', false);
  await membershipFormFields.saveFieldValues(fam.parentId, 'parent', { ['f' + fieldId]: '1' });

  const page = await request(app).get(`/main-admin/members/${fam.parentId}/edit`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Volunteers for setup crew\?/);
  assert.match(page.text, new RegExp(`name="customFields\\[f${fieldId}\\]" value="1" checked`));
  const csrfToken = extractCsrf(page.text);

  await request(app)
    .post(`/main-admin/members/${fam.parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      name: `MainCheckboxQ Primary Parent ${familyCounter}`,
      familyId: String(fam.familyId),
      // customFields[f<id>] intentionally omitted - simulates an
      // unchecked checkbox, which a real browser never submits either.
      _csrf: csrfToken,
    });

  const value = await db.prepare('SELECT value FROM membership_form_field_values WHERE field_id = ? AND member_id = ?').get(fieldId, fam.parentId);
  assert.equal(value.value, '0', 'an unchecked checkbox question saves as 0, same as the public form');
});

test('Main Admin Edit Member page renders an admin-defined Child question within its own Children block, prefilled, and saves a changed answer', async () => {
  const cookie = await loginAsMainAdmin();
  const fam = await makeFamily('MainChildQ');
  const fieldId = await membershipFormFields.createField('child', 'Allergy-free snacks only?', 'checkbox', '', false);

  const page = await request(app).get(`/main-admin/members/${fam.parentId}/edit`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Allergy-free snacks only\?/);
  assert.match(page.text, new RegExp(`name="children\\[0\\]\\[customFields\\]\\[f${fieldId}\\]"`));
  const csrfToken = extractCsrf(page.text);

  await request(app)
    .post(`/main-admin/members/${fam.parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      name: `MainChildQ Primary Parent ${familyCounter}`,
      familyId: String(fam.familyId),
      'children[0][id]': String(fam.kidId),
      'children[0][name]': `MainChildQ Kid ${familyCounter}`,
      [`children[0][customFields][f${fieldId}]`]: '1',
      _csrf: csrfToken,
    });

  const value = await db.prepare('SELECT value FROM membership_form_field_values WHERE field_id = ? AND member_id = ?').get(fieldId, fam.kidId);
  assert.equal(value.value, '1');
});
