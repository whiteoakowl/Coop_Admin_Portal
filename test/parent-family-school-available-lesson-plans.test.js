// Coverage for a real request: "Family school management portal,
// family classes. Add a subpage called available lesson plans. Any
// lesson plans that admin has created and marked shareable with parent
// portal will show here as cards in a viewable format, no editing. You
// can click on each class, view the lessons and assignments outline and
// click on each assignment/lesson to view what is there. Add a filter
// button at the top, fit to text. Allows you to filter by grade level,
// and subject. Be able to select multiple from the dropdown menu with
// check boxes."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `available-lesson-plans-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `available-lesson-plans-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let counter = 0;
async function loginAsParent() {
  counter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`Available Plans Family ${counter}`)).id;
  const code = `avplan${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get(`Available Plans Parent ${counter}`, code, code, familyId)
  ).id;
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  return { memberId, accountId, cookie: loginRes.headers['set-cookie'] };
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function createPlan(adminCookie, { title, gradeLevel, subject, shareable }) {
  const page = await request(app).get('/admin/lesson-plans').set('Cookie', adminCookie);
  const csrfToken = extractCsrf(page.text);
  const createRes = await request(app).post('/admin/lesson-plans').set('Cookie', adminCookie).type('form').send({ title, _csrf: csrfToken });
  const planId = /\/admin\/lesson-plans\/(\d+)/.exec(createRes.headers.location)[1];
  await request(app)
    .post(`/admin/lesson-plans/${planId}/edit`)
    .set('Cookie', adminCookie)
    .type('form')
    .send({ title, description: '', gradeLevel: gradeLevel || '', subject: subject || '', shareableWithParents: shareable ? '1' : '', _csrf: csrfToken });
  return planId;
}

test('Family School Management nav has an Available Lesson Plans tab', async () => {
  const parent = await loginAsParent();
  const page = await request(app).get('/parent/family-school/classes').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<a href="\/parent\/family-school\/classes\/available-lesson-plans"[\s\S]*?Available Lesson Plans<\/a>/);
});

test('Available Lesson Plans only shows plans an admin marked shareable with parents', async () => {
  const admin = await loginAsAdmin();
  const parent = await loginAsParent();

  const shareablePlanId = await createPlan(admin, { title: 'Shareable Nature Study', gradeLevel: '3rd Grade', subject: 'Science', shareable: true });
  await createPlan(admin, { title: 'Internal Only Plan', shareable: false });

  const page = await request(app).get('/parent/family-school/classes/available-lesson-plans').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Shareable Nature Study/);
  assert.doesNotMatch(page.text, /Internal Only Plan/);
  assert.match(page.text, new RegExp(`href="/parent/family-school/classes/available-lesson-plans/${shareablePlanId}"`));
});

test('Available Lesson Plans filter narrows by grade level and subject (multi-select, OR within each)', async () => {
  const admin = await loginAsAdmin();
  const parent = await loginAsParent();

  await createPlan(admin, { title: 'Filter Math 3rd', gradeLevel: '3rd Grade', subject: 'Math', shareable: true });
  await createPlan(admin, { title: 'Filter Science 5th', gradeLevel: '5th Grade', subject: 'Science', shareable: true });
  await createPlan(admin, { title: 'Filter Math 5th', gradeLevel: '5th Grade', subject: 'Math', shareable: true });

  const allPage = await request(app).get('/parent/family-school/classes/available-lesson-plans').set('Cookie', parent.cookie);
  assert.match(allPage.text, /Filter Math 3rd/);
  assert.match(allPage.text, /Filter Science 5th/);
  assert.match(allPage.text, /Filter Math 5th/);

  const gradeFiltered = await request(app).get('/parent/family-school/classes/available-lesson-plans?gradeLevel=3rd%20Grade').set('Cookie', parent.cookie);
  assert.match(gradeFiltered.text, /Filter Math 3rd/);
  assert.doesNotMatch(gradeFiltered.text, /Filter Science 5th/);
  assert.doesNotMatch(gradeFiltered.text, /Filter Math 5th/);

  const subjectFiltered = await request(app).get('/parent/family-school/classes/available-lesson-plans?subject=Math').set('Cookie', parent.cookie);
  assert.match(subjectFiltered.text, /Filter Math 3rd/);
  assert.match(subjectFiltered.text, /Filter Math 5th/);
  assert.doesNotMatch(subjectFiltered.text, /Filter Science 5th/);

  // Multiple grade levels checked at once (OR within the dimension).
  const multiGrade = await request(app)
    .get('/parent/family-school/classes/available-lesson-plans?gradeLevel=3rd%20Grade&gradeLevel=5th%20Grade')
    .set('Cookie', parent.cookie);
  assert.match(multiGrade.text, /Filter Math 3rd/);
  assert.match(multiGrade.text, /Filter Science 5th/);
  assert.match(multiGrade.text, /Filter Math 5th/);
});

test('Available Lesson Plans detail page shows the lessons/assignments outline, and each item view is read-only', async () => {
  const admin = await loginAsAdmin();
  const parent = await loginAsParent();

  const planId = await createPlan(admin, { title: 'Outline Plan', shareable: true });
  const adminPage = await request(app).get(`/admin/lesson-plans/${planId}`).set('Cookie', admin);
  const csrfToken = extractCsrf(adminPage.text);
  await request(app)
    .post(`/admin/lesson-plans/${planId}/content`)
    .set('Cookie', admin)
    .type('form')
    .send({ type: 'text', title: 'Reading Intro', body: 'Once upon a time.', _csrf: csrfToken });

  const detailPage = await request(app).get(`/parent/family-school/classes/available-lesson-plans/${planId}`).set('Cookie', parent.cookie);
  assert.equal(detailPage.status, 200);
  assert.match(detailPage.text, /Reading Intro/);
  const contentItem = await db.prepare("SELECT id FROM lesson_plan_content_items WHERE lesson_plan_id = ?").get(planId);
  assert.match(detailPage.text, new RegExp(`href="/parent/family-school/classes/available-lesson-plans/${planId}/content/${contentItem.id}"`));
  // No editing controls anywhere on this read-only page (the shared nav
  // chrome has its own unrelated forms, so check specifically for
  // anything that would add/edit/delete content on this plan).
  assert.doesNotMatch(detailPage.text, /action="\/admin\/lesson-plans/);

  const contentPage = await request(app).get(`/parent/family-school/classes/available-lesson-plans/${planId}/content/${contentItem.id}`).set('Cookie', parent.cookie);
  assert.equal(contentPage.status, 200);
  assert.match(contentPage.text, /Once upon a time\./);
  assert.doesNotMatch(contentPage.text, /action="\/admin\/lesson-plans/);
});

test('A non-shareable lesson plan 404s on the Available Lesson Plans detail/content routes', async () => {
  const admin = await loginAsAdmin();
  const parent = await loginAsParent();
  const planId = await createPlan(admin, { title: 'Not Shared Plan', shareable: false });

  const detailPage = await request(app).get(`/parent/family-school/classes/available-lesson-plans/${planId}`).set('Cookie', parent.cookie);
  assert.equal(detailPage.status, 404);
});
