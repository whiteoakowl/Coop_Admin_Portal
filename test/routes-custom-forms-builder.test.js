// Route-level coverage for the Main Admin Custom Forms builder's
// Jotform-style upgrade (a real request: "Main admin portal, forms tab.
// Should have full editing features and view just like jotform.
// Exactly.") - pages/sections with drag-reorder, per-field conditional
// "only show when" logic (enforced both in the builder/fill-out
// rendering and, more importantly, server-side during submission), a
// fuller field-type palette, per-form theme, and a sortable/filterable
// submissions list with a working CSV export. See test/routes-custom-
// forms.test.js for the original schema's own coverage (field types,
// assignments, one-submission-per-member, the file-upload filter) -
// this file only covers what the upgrade in supabase/migrations/
// 20261225010000_custom_forms_builder_upgrade.sql and utils/
// customForms.js added on top of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `custom-forms-builder-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `custom-forms-builder-test-uploads-${process.pid}`);
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
const customForms = require('../utils/customForms');
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
  const familyName = `Builder Test Family ${familyCounter}`;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Builder Parent ${familyCounter}`, code, code, familyId);
  const email = `builderparent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/forms' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/forms').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid };
}

async function createForm(admin, title) {
  const createRes = await request(app).post('/main-admin/forms').set('Cookie', admin.cookie).type('form').send({ title, _csrf: admin.csrfToken });
  return /\/main-admin\/forms\/(\d+)\/builder/.exec(createRes.headers.location)[1];
}

async function publish(admin, formId) {
  await request(app).post(`/main-admin/forms/${formId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });
}

async function addField(admin, formId, body) {
  await request(app).post(`/main-admin/forms/${formId}/fields`).set('Cookie', admin.cookie).type('form').send({ ...body, _csrf: admin.csrfToken });
  return db.prepare('SELECT * FROM custom_form_fields WHERE form_id = ? ORDER BY id DESC LIMIT 1').get(formId);
}

// --- Pure logic (utils/customForms.js) ---

test('evaluateCondition/isFieldVisible - the same rule server-rendering and submission-time validation both read', () => {
  const equalsRule = { fieldId: 1, operator: 'equals', value: 'Yes' };
  assert.equal(customForms.evaluateCondition(equalsRule, { 1: 'Yes' }), true);
  assert.equal(customForms.evaluateCondition(equalsRule, { 1: 'No' }), false);
  assert.equal(customForms.evaluateCondition(null, { 1: 'anything' }), true, 'no rule at all means always visible');

  const containsRule = { fieldId: 2, operator: 'contains', value: 'setup' };
  assert.equal(customForms.evaluateCondition(containsRule, { 2: ['Setup', 'Cleanup'] }), true, 'an array value (multiple_choice labels) is checked element-wise');
  assert.equal(customForms.evaluateCondition(containsRule, { 2: ['Cleanup'] }), false);

  assert.equal(customForms.evaluateCondition({ fieldId: 3, operator: 'is_answered' }, { 3: '  ' }), false, 'whitespace-only does not count as answered');
  assert.equal(customForms.evaluateCondition({ fieldId: 3, operator: 'is_blank' }, { 3: '' }), true);

  const field = { id: 10, conditional_logic: JSON.stringify({ fieldId: 1, operator: 'equals', value: 'Yes' }), page_id: 100 };
  const pages = [{ id: 100, conditional_logic: null }];
  assert.equal(customForms.isFieldVisible(field, { 1: 'Yes' }, pages), true);
  assert.equal(customForms.isFieldVisible(field, { 1: 'No' }, pages), false, 'the field\'s own rule failing hides it even though its page has none');

  const hiddenPage = [{ id: 100, conditional_logic: JSON.stringify({ fieldId: 1, operator: 'equals', value: 'Yes' }) }];
  const unconditionalField = { id: 11, conditional_logic: null, page_id: 100 };
  assert.equal(customForms.isFieldVisible(unconditionalField, { 1: 'No' }, hiddenPage), false, 'a field with no rule of its own is still hidden when its whole PAGE is hidden');
});

test('parseConditionalLogic rejects malformed or unrecognized-operator JSON rather than throwing', () => {
  assert.equal(customForms.parseConditionalLogic(null), null);
  assert.equal(customForms.parseConditionalLogic('not json'), null);
  assert.equal(customForms.parseConditionalLogic(JSON.stringify({ fieldId: 1, operator: 'bogus_op', value: 'x' })), null);
  assert.deepEqual(customForms.parseConditionalLogic(JSON.stringify({ fieldId: 5, operator: 'equals', value: 'Yes' })), { fieldId: 5, operator: 'equals', value: 'Yes' });
});

// --- Pages / sections ---

test('a new form starts with exactly one page, and pages can be added, edited, reordered, and deleted', async () => {
  const admin = await loginAsMainAdmin();
  const formId = await createForm(admin, 'Pages Test Form');

  const initialPages = await db.prepare('SELECT * FROM custom_form_pages WHERE form_id = ?').all(formId);
  assert.equal(initialPages.length, 1, 'createForm should seed exactly one default page');

  await request(app).post(`/main-admin/forms/${formId}/pages`).set('Cookie', admin.cookie).type('form').send({ title: 'Page Two', description: 'Second section', _csrf: admin.csrfToken });
  const twoPages = await db.prepare('SELECT * FROM custom_form_pages WHERE form_id = ? ORDER BY position').all(formId);
  assert.equal(twoPages.length, 2);

  const builderHtml = await request(app).get(`/main-admin/forms/${formId}/builder`).set('Cookie', admin.cookie);
  assert.equal(builderHtml.status, 200);
  assert.match(builderHtml.text, /Page Two/);

  // Reorder: swap the two pages
  const reversed = [...twoPages].reverse().map((p) => p.id);
  const reorderRes = await request(app).post(`/main-admin/forms/${formId}/pages/reorder`).set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrfToken).send({ blockIds: reversed });
  assert.equal(reorderRes.status, 200);
  const afterReorder = await db.prepare('SELECT id FROM custom_form_pages WHERE form_id = ? ORDER BY position').all(formId);
  assert.deepEqual(afterReorder.map((p) => p.id), reversed);

  // Deleting the only-remaining... no, there are 2, so deleting one should succeed and move its fields
  await addField(admin, formId, { fieldType: 'short_text', label: 'On page two', pageId: String(twoPages[1].id) });
  const deleteRes = await request(app).post(`/main-admin/forms/${formId}/pages/${twoPages[1].id}/delete`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  assert.match(decodeURIComponent(deleteRes.headers.location), /moved to the remaining page/);
  const remainingPages = await db.prepare('SELECT id FROM custom_form_pages WHERE form_id = ?').all(formId);
  assert.equal(remainingPages.length, 1);
  const movedField = await db.prepare("SELECT page_id FROM custom_form_fields WHERE form_id = ? AND label = 'On page two'").get(formId);
  assert.equal(movedField.page_id, remainingPages[0].id, 'the deleted page\'s field should have moved to the surviving page, not vanished');

  // A form must always have at least one page
  const refusedDelete = await request(app).post(`/main-admin/forms/${formId}/pages/${remainingPages[0].id}/delete`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  assert.match(decodeURIComponent(refusedDelete.headers.location), /must have at least one page/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS c FROM custom_form_pages WHERE form_id = ?').get(formId)).c, 1);
});

test('fields can be dragged into a new order within their page, scoped to that page and form', async () => {
  const admin = await loginAsMainAdmin();
  const formId = await createForm(admin, 'Field Reorder Form');
  const page = await db.prepare('SELECT id FROM custom_form_pages WHERE form_id = ?').get(formId);

  const a = await addField(admin, formId, { fieldType: 'short_text', label: 'A', pageId: String(page.id) });
  const b = await addField(admin, formId, { fieldType: 'short_text', label: 'B', pageId: String(page.id) });
  const c = await addField(admin, formId, { fieldType: 'short_text', label: 'C', pageId: String(page.id) });

  const reorderRes = await request(app)
    .post(`/main-admin/forms/${formId}/fields/reorder`)
    .set('Cookie', admin.cookie)
    .set('X-CSRF-Token', admin.csrfToken)
    .send({ blockIds: [c.id, a.id, b.id], pageId: page.id });
  assert.equal(reorderRes.status, 200);

  const afterReorder = await db.prepare('SELECT id FROM custom_form_fields WHERE form_id = ? AND page_id = ? ORDER BY position').all(formId, page.id);
  assert.deepEqual(afterReorder.map((f) => f.id), [c.id, a.id, b.id]);
});

// --- Conditional logic, end to end ---

test('a field hidden by conditional logic is never required at submission time, even though it is marked required', async () => {
  const admin = await loginAsMainAdmin();
  const formId = await createForm(admin, 'Conditional Logic Form');

  const nameField = await addField(admin, formId, { fieldType: 'short_text', label: 'Name', isRequired: 'on' });
  const wantsExtraField = await addField(admin, formId, { fieldType: 'single_choice', label: 'Need extra help?', options: 'Yes\nNo', isRequired: 'on' });
  const detailsField = await addField(admin, formId, {
    fieldType: 'long_text',
    label: 'Describe what you need',
    isRequired: 'on',
    conditionFieldId: String(wantsExtraField.id),
    conditionOperator: 'equals',
    conditionValue: 'Yes',
  });
  assert.deepEqual(JSON.parse(detailsField.conditional_logic), { fieldId: wantsExtraField.id, operator: 'equals', value: 'Yes' });

  await publish(admin, formId);
  const parent = await createParentAccount();

  // Answers "No" - the required "Describe what you need" field is hidden
  // by its own conditional rule and must never block submission even
  // though it's required and left blank.
  const submitRes = await request(app)
    .post(`/forms/${formId}/submit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({
      memberId: String(parent.memberId),
      [`field_${nameField.id}`]: 'Jamie',
      [`field_${wantsExtraField.id}`]: 'No',
      _csrf: parent.csrfToken,
    });
  assert.match(submitRes.headers.location, new RegExp(`/forms/${formId}/mine/${parent.memberId}`), 'a required field hidden by conditional logic must not block submission: ' + decodeURIComponent(submitRes.headers.location));

  const submission = await db.prepare('SELECT id FROM custom_form_submissions WHERE form_id = ? AND member_id = ?').get(formId, parent.memberId);
  const detailsAnswer = await db.prepare('SELECT value_text FROM custom_form_answers WHERE submission_id = ? AND field_id = ?').get(submission.id, detailsField.id);
  assert.ok(!detailsAnswer || !detailsAnswer.value_text, 'the hidden field should be stored blank, not forced to have a value');
});

test('the same required field DOES block submission once its condition is actually met', async () => {
  const admin = await loginAsMainAdmin();
  const formId = await createForm(admin, 'Conditional Logic Enforced Form');
  const wantsExtraField = await addField(admin, formId, { fieldType: 'single_choice', label: 'Need extra help?', options: 'Yes\nNo', isRequired: 'on' });
  const detailsField = await addField(admin, formId, {
    fieldType: 'long_text',
    label: 'Describe what you need',
    isRequired: 'on',
    conditionFieldId: String(wantsExtraField.id),
    conditionOperator: 'equals',
    conditionValue: 'Yes',
  });

  await publish(admin, formId);
  const parent = await createParentAccount();

  const submitRes = await request(app)
    .post(`/forms/${formId}/submit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), [`field_${wantsExtraField.id}`]: 'Yes', _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(submitRes.headers.location), new RegExp(`"${detailsField.label}" is required`));
});

test('a page hidden by its own conditional logic hides every field on it from the required check', async () => {
  const admin = await loginAsMainAdmin();
  const formId = await createForm(admin, 'Conditional Page Form');
  const gateField = await addField(admin, formId, { fieldType: 'checkbox', label: 'Are you a returning family?' });

  await request(app).post(`/main-admin/forms/${formId}/pages`).set('Cookie', admin.cookie).type('form').send({
    title: 'Returning Family Details',
    conditionFieldId: String(gateField.id),
    conditionOperator: 'equals',
    conditionValue: '1',
    _csrf: admin.csrfToken,
  });
  const page2 = await db.prepare('SELECT * FROM custom_form_pages WHERE form_id = ? ORDER BY position DESC LIMIT 1').get(formId);
  assert.ok(customForms.parseConditionalLogic(page2.conditional_logic), 'the new page should have stored a conditional_logic rule');

  const requiredOnHiddenPage = await addField(admin, formId, { fieldType: 'short_text', label: 'Last year\'s co-op', isRequired: 'on', pageId: String(page2.id) });

  await publish(admin, formId);
  const parent = await createParentAccount();

  // Leaves the checkbox unchecked ('0') - page 2 (and everything on it,
  // including the required field) should be invisible, so leaving it
  // blank must not block submission.
  const submitRes = await request(app)
    .post(`/forms/${formId}/submit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), [`field_${gateField.id}`]: '', _csrf: parent.csrfToken });
  assert.match(submitRes.headers.location, new RegExp(`/forms/${formId}/mine/${parent.memberId}`), 'a required field on a conditionally-hidden PAGE must not block submission: ' + decodeURIComponent(submitRes.headers.location));
});

// --- Multi-page rendering ---

test('a multi-page form renders a progress indicator on the fill-out page; a single-page form does not', async () => {
  const admin = await loginAsMainAdmin();
  const singleFormId = await createForm(admin, 'Single Page Form');
  await addField(admin, singleFormId, { fieldType: 'short_text', label: 'Only field' });
  await publish(admin, singleFormId);

  const multiFormId = await createForm(admin, 'Multi Page Form');
  await addField(admin, multiFormId, { fieldType: 'short_text', label: 'Page one field' });
  await request(app).post(`/main-admin/forms/${multiFormId}/pages`).set('Cookie', admin.cookie).type('form').send({ title: 'Page Two', _csrf: admin.csrfToken });
  await publish(admin, multiFormId);

  const parent = await createParentAccount();
  const singlePage = await request(app).get(`/forms/${singleFormId}`).set('Cookie', parent.cookie);
  assert.doesNotMatch(singlePage.text, /data-cf-progress/, 'a one-page form must not show a progress indicator');

  const multiPage = await request(app).get(`/forms/${multiFormId}`).set('Cookie', parent.cookie);
  assert.match(multiPage.text, /data-cf-progress/);
  assert.match(multiPage.text, /Page Two/);
  assert.match(multiPage.text, /data-cf-next/, 'a multi-page form should offer a Next control');
});

// --- Theme ---

test('a form\'s theme (primary color + button style) is saved and rendered on the fill-out page', async () => {
  const admin = await loginAsMainAdmin();
  const formId = await createForm(admin, 'Themed Form');
  await publish(admin, formId);

  await request(app)
    .post(`/main-admin/forms/${formId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Themed Form', themePrimaryColor: '#ab12cd', themeButtonStyle: 'pill', _csrf: admin.csrfToken });

  const stored = await db.prepare('SELECT theme_primary_color, theme_button_style FROM custom_forms WHERE id = ?').get(formId);
  assert.equal(stored.theme_primary_color, '#ab12cd');
  assert.equal(stored.theme_button_style, 'pill');

  const parent = await createParentAccount();
  const fillPage = await request(app).get(`/forms/${formId}`).set('Cookie', parent.cookie);
  assert.match(fillPage.text, /--cf-primary: #ab12cd/i);
  assert.match(fillPage.text, /--cf-radius: 999px/);

  // An invalid color/button style never gets persisted - falls back to
  // the existing-brand defaults rather than storing garbage.
  await request(app)
    .post(`/main-admin/forms/${formId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Themed Form', themePrimaryColor: 'javascript:alert(1)', themeButtonStyle: 'triangle', _csrf: admin.csrfToken });
  const sanitized = await db.prepare('SELECT theme_primary_color, theme_button_style FROM custom_forms WHERE id = ?').get(formId);
  assert.equal(sanitized.theme_primary_color, '#2e6da4');
  assert.equal(sanitized.theme_button_style, 'rounded');
});

// --- Fuller field-type palette ---

test('every new field type (email/phone/url/rating/scale) stores a plain text answer, and heading/paragraph never do', async () => {
  const admin = await loginAsMainAdmin();
  const formId = await createForm(admin, 'New Field Types Form');
  const email = await addField(admin, formId, { fieldType: 'email', label: 'Email' });
  const phone = await addField(admin, formId, { fieldType: 'phone', label: 'Phone' });
  const url = await addField(admin, formId, { fieldType: 'url', label: 'Website' });
  const rating = await addField(admin, formId, { fieldType: 'rating', label: 'Rate us' });
  const scale = await addField(admin, formId, { fieldType: 'scale', label: 'Likelihood' });
  await addField(admin, formId, { fieldType: 'heading', label: 'Section heading' });
  await addField(admin, formId, { fieldType: 'paragraph', label: 'internal note', helpText: 'Please fill out honestly.' });

  await publish(admin, formId);
  const parent = await createParentAccount();

  const fillPage = await request(app).get(`/forms/${formId}`).set('Cookie', parent.cookie);
  assert.equal(fillPage.status, 200);
  assert.match(fillPage.text, /Section heading/);
  assert.match(fillPage.text, /Please fill out honestly\./);
  assert.match(fillPage.text, /cf-rating/);
  assert.match(fillPage.text, /cf-scale/);

  await request(app)
    .post(`/forms/${formId}/submit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({
      memberId: String(parent.memberId),
      [`field_${email.id}`]: 'parent@example.com',
      [`field_${phone.id}`]: '555-123-4567',
      [`field_${url.id}`]: 'https://example.com',
      [`field_${rating.id}`]: '4',
      [`field_${scale.id}`]: '9',
      _csrf: parent.csrfToken,
    });

  const submission = await db.prepare('SELECT id FROM custom_form_submissions WHERE form_id = ? AND member_id = ?').get(formId, parent.memberId);
  const answers = await db.prepare('SELECT field_id, value_text FROM custom_form_answers WHERE submission_id = ?').all(submission.id);
  const byField = new Map(answers.map((a) => [a.field_id, a.value_text]));
  assert.equal(byField.get(email.id), 'parent@example.com');
  assert.equal(byField.get(rating.id), '4');
  assert.equal(byField.get(scale.id), '9');
  assert.equal(answers.length, 5, 'heading/paragraph must never get an answer row at all');
});

// --- Submissions list: sort, filter, CSV export ---

test('the submissions list can be sorted and filtered by member name, and CSV export lists every real field', async () => {
  const admin = await loginAsMainAdmin();
  const formId = await createForm(admin, 'Submissions List Form');
  const colorField = await addField(admin, formId, { fieldType: 'short_text', label: 'Favorite Color' });
  await addField(admin, formId, { fieldType: 'heading', label: 'A heading, not a question' });
  await publish(admin, formId);

  const alpha = await createParentAccount(); // "Builder Parent N"
  const beta = await createParentAccount();
  await request(app).post(`/forms/${formId}/submit`).set('Cookie', alpha.cookie).type('form').send({ memberId: String(alpha.memberId), [`field_${colorField.id}`]: 'Blue', _csrf: alpha.csrfToken });
  await request(app).post(`/forms/${formId}/submit`).set('Cookie', beta.cookie).type('form').send({ memberId: String(beta.memberId), [`field_${colorField.id}`]: 'Green', _csrf: beta.csrfToken });

  const sortedAsc = await request(app).get(`/main-admin/forms/${formId}/submissions?sort=member&dir=asc`).set('Cookie', admin.cookie);
  assert.equal(sortedAsc.status, 200);

  const filtered = await request(app).get(`/main-admin/forms/${formId}/submissions?q=${encodeURIComponent('Builder Parent')}`).set('Cookie', admin.cookie);
  assert.match(filtered.text, /Builder Parent/);

  const filteredOut = await request(app).get(`/main-admin/forms/${formId}/submissions?q=nobody-matches-this`).set('Cookie', admin.cookie);
  assert.doesNotMatch(filteredOut.text, /Builder Parent/);

  // A real latent bug this upgrade fixes: /submissions/export used to
  // be shadowed by the generic /submissions/:submissionId route
  // defined before it, so the literal segment "export" was parsed as a
  // submission id and 500'd - see routes/admin-custom-forms.js's own
  // comment on the reorder. This is the regression test for that.
  const csv = await request(app).get(`/main-admin/forms/${formId}/submissions/export`).set('Cookie', admin.cookie);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Favorite Color/);
  assert.match(csv.text, /Blue/);
  assert.match(csv.text, /Green/);
  assert.doesNotMatch(csv.text, /A heading, not a question/, 'a display-only heading field must never appear as a CSV column');

  // A real submission's own detail page still works (unchanged route,
  // just now reachable because /export no longer shadows it the other
  // way around).
  const submission = await db.prepare('SELECT id FROM custom_form_submissions WHERE form_id = ? LIMIT 1').get(formId);
  const detail = await request(app).get(`/main-admin/forms/${formId}/submissions/${submission.id}`).set('Cookie', admin.cookie);
  assert.equal(detail.status, 200);
});
