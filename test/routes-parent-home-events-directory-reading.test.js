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
  // A real request rebuilt this card's button into a dedicated .parent-
  // home-cta (see views/parent-home.ejs/public/css/styles.css's own
  // "Change the parent portal dashboard to have cards exactly like this"
  // comment) - no longer a plain .roster-action-btn, but still the same
  // real link to the same real destination.
  assert.match(page.text, /<a class="parent-home-cta parent-home-cta-outline-indigo" href="\/parent\/classes\/dashboard">/);
  assert.match(page.text, /Classroom Dashboard/);
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
  // A real bug report: "event calendar should land on calendar view, not
  // list view" - this link (and every other parent-facing Events link)
  // forces view=calendar&portal=parent instead of a bare /events, which
  // otherwise falls back to whatever the org-wide default view setting
  // happens to be (see routes/events.js's own comment). A real request
  // later rebuilt this into the card's own header "View All" link (see
  // the Classroom Dashboard test above's own comment on the class
  // rename) rather than a bottom "View Event Calendar" button - same
  // real destination.
  assert.match(page.text, /<a class="parent-home-card-v2-viewall" href="\/events\?view=calendar&(?:amp;)?portal=parent">/);
});

test('Parent Portal homepage: Join a Committee is a Quick Links item, not its own card', async () => {
  const { cookie } = await loginAsPortalParent();
  const page = await request(app).get('/parent').set('Cookie', cookie);
  // A real request: "Join a Committee should just be a link under quick
  // links" - the earlier standalone Committees card is gone; it's now a
  // plain list item alongside the other Quick Links.
  assert.match(page.text, /<h2>Quick Links<\/h2>/);
  assert.match(page.text, /<li><a href="\/committees">Join a Committee<\/a><\/li>/);
  assert.doesNotMatch(page.text, /<h2>Committees<\/h2>/);
});

test('Parent Portal homepage: Reading Challenge card shows a plain ranked leaderboard', async () => {
  const { cookie, parentId } = await loginAsPortalParent();
  await db.prepare("INSERT INTO reading_logs (member_id, book_title, hours, log_date) VALUES (?, 'A Book', 3, now_text())").run(parentId);

  const page = await request(app).get('/parent').set('Cookie', cookie);
  // A real request pinned the Reading Challenge card back to "only show
  // the parent reading challenge leaderboard" - no weekly-goal progress
  // bar, no "Top Reader" callout, no Log Reading button, just the ranked
  // list (see views/parent-home.ejs's own comment).
  assert.match(page.text, /<h2>Reading Challenge<\/h2>/);
  assert.match(page.text, /parent-home-leaderboard-list/);
  assert.match(page.text, /parent-home-rank-badge">#1</);
  assert.match(page.text, /Cards Parent/);
  assert.match(page.text, /<a class="parent-home-card-v2-viewall" href="\/parent\/leaderboard">/);
  assert.doesNotMatch(page.text, /Top Reader/);
  assert.doesNotMatch(page.text, /This week's goal/);
  assert.doesNotMatch(page.text, /Log Reading/);
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
  // A real request rebuilt each card's bottom button into its own real
  // "post/add a listing" destination (/directory/mine, /classifieds/mine
  // - the same pages' own real "My Listings + new listing form" route),
  // moving the plain "View Business Directory"/"View Classifieds" links
  // up into each card's header "View All" link instead (see views/
  // parent-home.ejs/public/css/styles.css's own "Change the parent
  // portal dashboard to have cards exactly like this" comment).
  assert.match(page.text, /<h2>Business Directory<\/h2>/);
  assert.match(page.text, /Sunny Bakery/);
  assert.match(page.text, /<a class="parent-home-card-v2-viewall" href="\/directory">/);
  assert.match(page.text, /<a class="parent-home-cta parent-home-cta-outline-purple" href="\/directory\/mine">/);

  assert.match(page.text, /<h2>Classifieds<\/h2>/);
  assert.match(page.text, /Used Piano/);
  assert.match(page.text, /<a class="parent-home-card-v2-viewall" href="\/classifieds">/);
  assert.match(page.text, /<a class="parent-home-cta parent-home-cta-outline-amber" href="\/classifieds\/mine">/);
});
