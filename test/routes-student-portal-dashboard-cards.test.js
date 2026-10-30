// Coverage for a real request: "Student portal homepage. Add three cards
// each a solid color matching the kiosk page. Orange, blue and green.
// First says group dashboard, 2nd says classroom dashboard. 3rd says fun
// dashboard. When you click on each of these page it shows all the other
// pages under that category in card style, two columns, solid colors
// matching the website." routes/student-portal.js's own
// STUDENT_DASHBOARD_CATEGORIES groups the portal's existing nav links
// into group/classroom/fun; nothing here invents a new destination page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `student-dashboard-cards-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `student-dashboard-cards-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let counter = 0;
async function createStudent(name) {
  counter += 1;
  const code = `dashcard${counter}`;
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES (?) RETURNING id").get(`${name} Family`)).id;
  const email = `${code}@example.com`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1) RETURNING id")
      .get(name, code, code, familyId)
  ).id;
  const acctId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acctId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/student' });
  return { memberId, cookie: loginRes.headers['set-cookie'] };
}

test('Student Portal homepage: three solid-color dashboard cards, orange/blue/green', async () => {
  const student = await createStudent('Cards Student');
  const page = await request(app).get('/student').set('Cookie', student.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /landing-card landing-card-orange" href="\/student\/dashboard\/group"/);
  assert.match(page.text, />Group Dashboard</);
  assert.match(page.text, /landing-card landing-card-blue" href="\/student\/dashboard\/classroom"/);
  assert.match(page.text, />Classroom Dashboard</);
  assert.match(page.text, /landing-card landing-card-green" href="\/student\/dashboard\/fun"/);
  assert.match(page.text, />Fun Dashboard</);
  // Order on the page: Group, then Classroom, then Fun.
  const groupIdx = page.text.indexOf('/student/dashboard/group');
  const classroomIdx = page.text.indexOf('/student/dashboard/classroom');
  const funIdx = page.text.indexOf('/student/dashboard/fun');
  assert.ok(groupIdx < classroomIdx && classroomIdx < funIdx);
});

test('Group Dashboard category page lists its pages in a 2-column orange card grid', async () => {
  const student = await createStudent('Group Student');
  const page = await request(app).get('/student/dashboard/group').set('Cookie', student.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>Group Dashboard<\/h1>/);
  assert.match(page.text, /class="landing-grid landing-grid-two landing-card-rect"/);
  assert.match(page.text, /landing-card landing-card-orange" href="\/student\/events"/);
  assert.match(page.text, />My Event Registrations</);
  assert.match(page.text, /landing-card landing-card-orange" href="\/student\/babysitter"/);
});

test('Classroom Dashboard category page lists its pages in a 2-column blue card grid', async () => {
  const student = await createStudent('Classroom Student');
  const page = await request(app).get('/student/dashboard/classroom').set('Cookie', student.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>Classroom Dashboard<\/h1>/);
  assert.match(page.text, /class="landing-grid landing-grid-two landing-card-rect"/);
  assert.match(page.text, /landing-card landing-card-blue" href="\/student\/classes\/dashboard"/);
  assert.match(page.text, />Grades</);
  assert.match(page.text, /landing-card landing-card-blue" href="\/student\/family-school\/weekly-planner"/);
  assert.match(page.text, /landing-card landing-card-blue" href="\/student\/family-school\/portfolio"/);
});

test('Fun Dashboard category page lists its pages in a 2-column green card grid', async () => {
  const student = await createStudent('Fun Student');
  const page = await request(app).get('/student/dashboard/fun').set('Cookie', student.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>Fun Dashboard<\/h1>/);
  assert.match(page.text, /class="landing-grid landing-grid-two landing-card-rect"/);
  assert.match(page.text, /landing-card landing-card-green" href="\/student\/games"/);
  assert.match(page.text, />Vocabulary</);
});

test('An unknown dashboard category 404s', async () => {
  const student = await createStudent('Unknown Category Student');
  const page = await request(app).get('/student/dashboard/nonsense').set('Cookie', student.cookie);
  assert.equal(page.status, 404);
});
