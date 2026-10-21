// Real request: "all print button should show a print preview full real
// page on a page with a print button. That print button will then send
// it to the printer." The Members page's own Print button used to call
// window.print() directly on the live, editable card list - now it opens
// a dedicated read-only preview page (admin-members-print.ejs) in a new
// tab first, same convention as every other print button in this app
// (see routes/admin-rosters.js's own /rosters/print and
// test/routes-admin-rosters-print-preview.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-members-print-preview-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-members-print-preview-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

let seedCounter = 0;

// Co-op Admin's own Members list only shows members whose family has an
// enrolled student (see routes/admin-members.js's own GET /members
// comment) - each helper below enrolls its student in its own fresh
// class so that holds regardless of what else the test db has seeded.
async function enrollStudent(studentId) {
  seedCounter += 1;
  const classId = (
    await db
      .prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, ?) RETURNING id")
      .get(`Print Preview Class ${seedCounter}`)
  ).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, studentId);
}

async function createEnrolledStudent(name) {
  seedCounter += 1;
  const code = `coopmembersprint${seedCounter}`;
  const studentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'student', 1) RETURNING id")
      .get(name, code, code)
  ).id;
  await enrollStudent(studentId);
  return studentId;
}

// A family qualifies once ANY of its students is enrolled - every other
// member of that family (its parent included) comes along too, same as
// createEnrolledStudent's own single-student shape above.
async function createEnrolledFamily(parentName, studentName) {
  seedCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`Print Preview Family ${seedCounter}`)).id;
  const parentCode = `coopmembersprintparent${seedCounter}`;
  await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'parent', ?, 1)").run(parentName, parentCode, parentCode, familyId);
  const studentCode = `coopmembersprintchild${seedCounter}`;
  const studentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1) RETURNING id")
      .get(studentName, studentCode, studentCode, familyId)
  ).id;
  await enrollStudent(studentId);
}

test('GET /admin/members', async (t) => {
  const cookie = await loginAsAdmin();

  await t.test('the Print button links to the preview route in a new tab instead of calling window.print() directly', async () => {
    const res = await request(app).get('/admin/members').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /<a class="icon-btn" href="\/admin\/members\/print"[^>]*target="_blank"[^>]*aria-label="Print"/);
    assert.doesNotMatch(res.text, /onclick="window\.print\(\)" aria-label="Print"/);
  });

  await t.test('the Print link carries the current type filter', async () => {
    const res = await request(app).get('/admin/members?type=student').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /href="\/admin\/members\/print\?type=student"/);
  });
});

test('GET /admin/members/print', async (t) => {
  const cookie = await loginAsAdmin();

  await t.test('renders a read-only preview with a Print button and the branded print header', async () => {
    await createEnrolledStudent('Print Preview Coop Student');

    const res = await request(app).get('/admin/members/print').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /print-preview-header/);
    assert.match(res.text, /onclick="window\.print\(\)"/);
    assert.match(res.text, /<p class="print-header-sub">Members<\/p>/);
    assert.match(res.text, /Print Preview Coop Student/);
  });

  await t.test('respects the same type filter as the live page', async () => {
    await createEnrolledFamily('Filtered Preview Parent', 'Filtered Preview Student');

    const res = await request(app).get('/admin/members/print?type=student').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Filtered Preview Student/);
    assert.doesNotMatch(res.text, /Filtered Preview Parent/);
  });
});
