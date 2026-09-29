// Five bundled real requests for the Parent Portal homepage:
// 1. "Class registration card should show how many classes each student
//    is registered for... Button should say classroom dashboard and take
//    the parent to the classroom dashboard list of classes their family
//    is signed up for." -> button relabeled, now links to
//    /parent/classes/dashboard instead of /parent/classes.
// 2. "Take off the my family card and replace it with upcoming events
//    from the event calendar. Button should say view event calendar."
// 3. "Committees description should say. Signup for a Committee and help
//    us create fun events for the group!"
// 4. "Should have a card showing the rankings for Parent reading
//    challenge."
// 5. "Card showing business directory listing. And a card showing
//    classifieds listings."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-home-cards-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-home-cards-test-uploads-${process.pid}`);
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

let seedCounter = 0;

async function loginAsPortalParent() {
  const n = ++seedCounter;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`Home Cards Family ${n}`)).id;
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES (?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get('Cards Parent', `home-cards-parent-${n}`, familyId)
  ).id;
  const email = `home-cards-parent-${n}@example.com`;
  const acctId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(parentId, email, hashPassword('testpassword123'))
  ).id;
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acctId, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123' });
  return { cookie: loginRes.headers['set-cookie'], familyId, parentId, acctId };
}

test('Parent Portal homepage: Classroom Dashboard button replaces Browse Classes', async () => {
  const { cookie } = await loginAsPortalParent();
  const page = await request(app).get('/parent').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<a class="roster-action-btn" href="\/parent\/classes\/dashboard">Classroom Dashboard<\/a>/);
  assert.doesNotMatch(page.text, /Browse Classes/);
});

test('Parent Portal homepage: My Family card is gone, replaced by an Upcoming Events card', async () => {
  const { cookie } = await loginAsPortalParent();
  await db
    .prepare("INSERT INTO events (title, starts_at, status) VALUES ('Fall Fest', to_char(now() + interval '5 days', 'YYYY-MM-DD HH24:MI:SS'), 'published')")
    .run();

  const page = await request(app).get('/parent').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /<h2>My Family<\/h2>/);
  assert.match(page.text, /<h2>Upcoming Events<\/h2>/);
  assert.match(page.text, /Fall Fest/);
  assert.match(page.text, /<a class="roster-action-btn" href="\/events">View Event Calendar<\/a>/);
});

test('Parent Portal homepage: Committees card has the new description', async () => {
  const { cookie } = await loginAsPortalParent();
  const page = await request(app).get('/parent').set('Cookie', cookie);
  assert.match(page.text, /Signup for a Committee and help us create fun events for the group!/);
});

test('Parent Portal homepage: Parent Reading Challenge card shows rankings', async () => {
  const { cookie, parentId } = await loginAsPortalParent();
  await db.prepare("INSERT INTO reading_logs (member_id, book_title, hours, log_date) VALUES (?, 'A Book', 3, now_text())").run(parentId);

  const page = await request(app).get('/parent').set('Cookie', cookie);
  assert.match(page.text, /<h2>Parent Reading Challenge<\/h2>/);
  assert.match(page.text, /#1 Cards Parent/);
  assert.match(page.text, /<a class="roster-action-btn" href="\/parent\/leaderboard">View Reading Challenge<\/a>/);
});

test('Parent Portal homepage: Business Directory and Classifieds cards show active listings', async () => {
  const { cookie } = await loginAsPortalParent();
  await db
    .prepare("INSERT INTO business_directory_listings (business_name, status, visibility) VALUES ('Sunny Bakery', 'active', 'members')")
    .run();
  await db
    .prepare("INSERT INTO classified_listings (title, status, visibility) VALUES ('Used Piano', 'active', 'members')")
    .run();

  const page = await request(app).get('/parent').set('Cookie', cookie);
  assert.match(page.text, /<h2>Business Directory<\/h2>/);
  assert.match(page.text, /Sunny Bakery/);
  assert.match(page.text, /<a class="roster-action-btn" href="\/directory">View Business Directory<\/a>/);

  assert.match(page.text, /<h2>Classifieds<\/h2>/);
  assert.match(page.text, /Used Piano/);
  assert.match(page.text, /<a class="roster-action-btn" href="\/classifieds">View Classifieds<\/a>/);
});
