// Coverage for a real request: "Family school management, add a
// subpage for volunteer hours. Be able to track and add volunteer
// hours per student and have a log." (utils/familySchool.js's own
// volunteerHoursForStudent/totalVolunteerHoursForStudent/
// createVolunteerHourEntry/deleteVolunteerHourEntry, routes/parent-
// family-school.js's own /volunteer-hours routes.) A family's own
// self-tracked homeschool volunteer hours - NOT the separate co-op-wide
// Volunteers/Floater system.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `fs-volunteer-hours-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `fs-volunteer-hours-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let counter = 0;
async function createFamily(name) {
  counter += 1;
  return (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`${name} ${counter}`)).id;
}

async function createPortalMember({ name, familyId, memberType, roleKey }) {
  counter += 1;
  const code = `fsvolh${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id")
      .get(name, code, code, memberType, familyId, memberType === 'parent' ? 1 : 0)
  ).id;
  const { hashPassword } = require('../utils/portalAuth');
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: `/${roleKey}` });
  return { memberId, accountId, cookie: loginRes.headers['set-cookie'] };
}

async function csrfFrom(cookie, url) {
  const page = await request(app).get(url).set('Cookie', cookie);
  return /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
}

test('adding two volunteer-hour entries for a student creates both rows and the running total is correct', async () => {
  const familyId = await createFamily('Volunteer Hours Family');
  const parent = await createPortalMember({ name: 'Volunteer Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Volunteer Student', familyId, memberType: 'student', roleKey: 'student' });

  const csrf1 = await csrfFrom(parent.cookie, '/parent/family-school/volunteer-hours');
  const add1 = await request(app)
    .post('/parent/family-school/volunteer-hours')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(student.memberId), hourDate: '2026-06-01', hours: '2.5', activityDescription: 'Food pantry', _csrf: csrf1 });
  assert.equal(add1.status, 302);
  assert.match(add1.headers.location, /notice=/);

  const csrf2 = await csrfFrom(parent.cookie, '/parent/family-school/volunteer-hours');
  const add2 = await request(app)
    .post('/parent/family-school/volunteer-hours')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(student.memberId), hourDate: '2026-06-05', hours: '1.5', activityDescription: 'Library shelving', _csrf: csrf2 });
  assert.equal(add2.status, 302);

  const page = await request(app).get(`/parent/family-school/volunteer-hours?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  // A real request moved this total "to the bottom right of the
  // table" - same right-aligned convention Accounting's own totals use.
  assert.match(page.text, /class="accounting-section-total">Total Hours: 4</);
  // Log lists both entries - newest first.
  assert.match(page.text, /2026-06-05[\s\S]*Library shelving[\s\S]*2026-06-01[\s\S]*Food pantry/);

  const rows = await db.prepare('SELECT * FROM family_school_volunteer_hours WHERE student_id = ? ORDER BY hour_date').all(student.memberId);
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[0].hours), 2.5);
  assert.equal(Number(rows[1].hours), 1.5);
});

test('deleting an entry removes it from the log and recalculates the total', async () => {
  const familyId = await createFamily('Volunteer Hours Delete Family');
  const parent = await createPortalMember({ name: 'Delete Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Delete Student', familyId, memberType: 'student', roleKey: 'student' });

  const csrf1 = await csrfFrom(parent.cookie, '/parent/family-school/volunteer-hours');
  await request(app)
    .post('/parent/family-school/volunteer-hours')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(student.memberId), hourDate: '2026-07-01', hours: '3', activityDescription: 'Setup crew', _csrf: csrf1 });
  const csrf2 = await csrfFrom(parent.cookie, '/parent/family-school/volunteer-hours');
  await request(app)
    .post('/parent/family-school/volunteer-hours')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(student.memberId), hourDate: '2026-07-02', hours: '2', activityDescription: 'Cleanup crew', _csrf: csrf2 });

  const entry = await db.prepare("SELECT id FROM family_school_volunteer_hours WHERE student_id = ? AND hour_date = '2026-07-02'").get(student.memberId);
  const deleteCsrf = await csrfFrom(parent.cookie, '/parent/family-school/volunteer-hours');
  const del = await request(app)
    .post(`/parent/family-school/volunteer-hours/${entry.id}/delete`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ _csrf: deleteCsrf });
  assert.equal(del.status, 302);

  const remaining = await db.prepare('SELECT * FROM family_school_volunteer_hours WHERE student_id = ?').all(student.memberId);
  assert.equal(remaining.length, 1);

  const page = await request(app).get(`/parent/family-school/volunteer-hours?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.match(page.text, /class="accounting-section-total">Total Hours: 3</);
});

test('a parent from a different family cannot delete another family\'s volunteer-hour entry', async () => {
  const ownFamilyId = await createFamily('Owner Family Volunteer');
  const owner = await createPortalMember({ name: 'Owner Parent', familyId: ownFamilyId, memberType: 'parent', roleKey: 'parent' });
  const ownStudent = await createPortalMember({ name: 'Owner Student', familyId: ownFamilyId, memberType: 'student', roleKey: 'student' });
  const ownCsrf = await csrfFrom(owner.cookie, '/parent/family-school/volunteer-hours');
  await request(app)
    .post('/parent/family-school/volunteer-hours')
    .set('Cookie', owner.cookie)
    .type('form')
    .send({ studentId: String(ownStudent.memberId), hourDate: '2026-08-01', hours: '1', activityDescription: 'Private', _csrf: ownCsrf });
  const entry = await db.prepare('SELECT id FROM family_school_volunteer_hours WHERE student_id = ?').get(ownStudent.memberId);

  const intruderFamilyId = await createFamily('Intruder Family Volunteer');
  const intruder = await createPortalMember({ name: 'Intruder Parent', familyId: intruderFamilyId, memberType: 'parent', roleKey: 'parent' });
  const intruderCsrf = await csrfFrom(intruder.cookie, '/parent/family-school/volunteer-hours');

  const res = await request(app)
    .post(`/parent/family-school/volunteer-hours/${entry.id}/delete`)
    .set('Cookie', intruder.cookie)
    .type('form')
    .send({ _csrf: intruderCsrf });
  assert.equal(res.status, 404);

  const stillThere = await db.prepare('SELECT * FROM family_school_volunteer_hours WHERE id = ?').get(entry.id);
  assert.ok(stillThere, 'the entry should not have been deleted by a parent outside the family');
});

test('invalid input (zero hours, or a non-date) is rejected without creating a row', async () => {
  const familyId = await createFamily('Volunteer Hours Validation Family');
  const parent = await createPortalMember({ name: 'Validation Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Validation Student', familyId, memberType: 'student', roleKey: 'student' });

  const csrf1 = await csrfFrom(parent.cookie, '/parent/family-school/volunteer-hours');
  const zeroHours = await request(app)
    .post('/parent/family-school/volunteer-hours')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(student.memberId), hourDate: '2026-09-01', hours: '0', activityDescription: 'Nope', _csrf: csrf1 });
  assert.match(zeroHours.headers.location, /error=/);

  const csrf2 = await csrfFrom(parent.cookie, '/parent/family-school/volunteer-hours');
  const badDate = await request(app)
    .post('/parent/family-school/volunteer-hours')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(student.memberId), hourDate: 'not-a-date', hours: '2', activityDescription: 'Nope', _csrf: csrf2 });
  assert.match(badDate.headers.location, /error=/);

  const rows = await db.prepare('SELECT * FROM family_school_volunteer_hours WHERE student_id = ?').all(student.memberId);
  assert.equal(rows.length, 0, 'neither invalid submission should have created a row');
});

// A real request: "Add export, pdf and print icons. All one row filter
// button, icons, add hours button." Plus a real bug report: "when you
// select filter no matter what you do the filter stays open" - fixed by
// giving the Filter <details> data-filter-details (the markup contract
// public/js/filter-details-dismiss.js, now loaded on this page, looks
// for to close it on an outside click).
test('Volunteer Hours: one toolbar row has Filter, Export/Print/PDF icons, and Add Hours in that order, and the Filter popover is wired to the outside-click dismiss script', async () => {
  const familyId = await createFamily('Volunteer Hours Toolbar Family');
  const parent = await createPortalMember({ name: 'Toolbar Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  await createPortalMember({ name: 'Toolbar Student', familyId, memberType: 'student', roleKey: 'student' });

  const page = await request(app).get('/parent/family-school/volunteer-hours').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<script src="\/js\/filter-details-dismiss\.js"><\/script>/);

  const toolbarMatch = /<div class="roster-btn-row roster-btn-row-fit-text no-print">[\s\S]*?<\/div>/.exec(page.text);
  assert.ok(toolbarMatch, 'expected one single toolbar row');
  const toolbarHtml = toolbarMatch[0];
  assert.match(toolbarHtml, /<details class="filter-details" data-filter-details>/);
  assert.match(toolbarHtml, /aria-label="Export CSV"/);
  assert.match(toolbarHtml, /aria-label="Print"/);
  assert.match(toolbarHtml, /aria-label="Download PDF"/);
  assert.match(toolbarHtml, /\+ Add Hours/);

  const filterIndex = page.text.indexOf('data-filter-details');
  const exportIndex = page.text.indexOf('aria-label="Export CSV"');
  const addHoursIndex = page.text.indexOf('+ Add Hours');
  assert.ok(filterIndex < exportIndex && exportIndex < addHoursIndex, 'expected Filter, then the icons, then Add Hours');
});

test('Volunteer Hours: Print preview and Download PDF both render, scoped to one student vs. the whole family', async () => {
  const familyId = await createFamily('Volunteer Hours Print Family');
  const parent = await createPortalMember({ name: 'Print Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const studentA = await createPortalMember({ name: 'Print Student A', familyId, memberType: 'student', roleKey: 'student' });
  const studentB = await createPortalMember({ name: 'Print Student B', familyId, memberType: 'student', roleKey: 'student' });

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/volunteer-hours');
  await request(app)
    .post('/parent/family-school/volunteer-hours')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(studentA.memberId), hourDate: '2026-10-01', hours: '2', activityDescription: 'Bake sale', _csrf: csrf });

  const previewRes = await request(app).get(`/parent/family-school/volunteer-hours/print?studentId=${studentA.memberId}`).set('Cookie', parent.cookie);
  assert.equal(previewRes.status, 200);
  assert.match(previewRes.text, /onclick="window\.print\(\)"/);
  assert.match(previewRes.text, /Print Student A/);
  assert.match(previewRes.text, /Bake sale/);
  assert.doesNotMatch(previewRes.text, /Print Student B/);
  void studentB;

  const pdfRes = await request(app)
    .get('/parent/family-school/volunteer-hours/download.pdf')
    .set('Cookie', parent.cookie)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  assert.equal(pdfRes.body.slice(0, 5).toString(), '%PDF-');
});
