// Five bundled real requests for the Parent Portal homepage:
// 1. "Class registration card should show how many classes each student
//    is registered for... Button should say classroom dashboard and take
//    the parent to the classroom dashboard list of classes their family
//    is signed up for." -> button relabeled, now links to
//    /parent/classes/dashboard instead of /parent/classes. A later real
//    request ("Remove class registration card. Add training card with
//    assigned trainings below forms card") dropped this card entirely -
//    see the Training card test below instead.
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

test('Parent Portal homepage: Class Registrations card is gone', async () => {
  const { cookie } = await loginAsPortalParent();
  const page = await request(app).get('/parent').set('Cookie', cookie);
  assert.equal(page.status, 200);
  // A real request: "Remove class registration card" - the whole card
  // (counts-by-child list + its Classroom Dashboard button) is gone, not
  // just relabeled. /parent/classes/dashboard itself is untouched - still
  // reachable from the Classes nav group's own subpages.
  assert.doesNotMatch(page.text, /<h2>Class Registrations<\/h2>/);
  assert.doesNotMatch(page.text, /parent-home-cta-outline-indigo/);
});

// A real request: "Add training card with assigned trainings below forms
// card" - same trainingModule.myAssignments(member.id) the nav-shelled
// /parent/training page itself shows, in a new card stacked under Forms.
test('Parent Portal homepage: Training card shows this parent\'s assigned trainings', async () => {
  const { cookie, parentId } = await loginAsPortalParent();
  const trainingId = (await db.prepare("INSERT INTO trainings (title, status) VALUES ('Safety Basics', 'published') RETURNING id").get()).id;
  await db.prepare("INSERT INTO training_assignments (training_id, member_id, status) VALUES (?, ?, 'not_started')").run(trainingId, parentId);

  const page = await request(app).get('/parent').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h2>Training<\/h2>/);
  assert.match(page.text, /Safety Basics/);
  assert.match(page.text, /badge-pill-gray">Not Started</);
  assert.match(page.text, /<a class="parent-home-card-v2-viewall" href="\/parent\/training">/);
});

test('Parent Portal homepage: Training card has an empty state when nothing is assigned', async () => {
  const { cookie } = await loginAsPortalParent();
  const page = await request(app).get('/parent').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h2>Training<\/h2>/);
  assert.match(page.text, /No training assigned right now\./);
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
  // later rebuilt this into the card's own header "View All" link
  // (same .parent-home-card-v2-viewall pattern every card on this page
  // uses) rather than a bottom "View Event Calendar" button - same real
  // destination.
  assert.match(page.text, /<a class="parent-home-card-v2-viewall" href="\/events\?view=calendar&(?:amp;)?portal=parent">/);
});

test('Parent Portal homepage: Join a Committee is a Forms item, not its own card', async () => {
  const { cookie } = await loginAsPortalParent();
  const page = await request(app).get('/parent').set('Cookie', cookie);
  // A real request: "Join a Committee should just be a link under quick
  // links" - the earlier standalone Committees card is gone; it's now a
  // plain list item alongside the other Quick Links. A later real
  // request ("Change the quicklinks title to forms") renamed the card
  // itself from Quick Links to Forms, same list.
  assert.match(page.text, /<h2>Forms<\/h2>/);
  assert.match(page.text, /<li><a href="\/committees">Join a Committee<\/a><\/li>/);
  assert.doesNotMatch(page.text, /<h2>Committees<\/h2>/);
  assert.doesNotMatch(page.text, /<h2>Quick Links<\/h2>/);
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
  assert.match(page.text, /<a class="parent-home-cta parent-home-cta-outline-blue" href="\/directory\/mine">/);

  assert.match(page.text, /<h2>Classifieds<\/h2>/);
  assert.match(page.text, /Used Piano/);
  assert.match(page.text, /<a class="parent-home-card-v2-viewall" href="\/classifieds">/);
  assert.match(page.text, /<a class="parent-home-cta parent-home-cta-outline-blue" href="\/classifieds\/mine">/);
});

// A real request: "Events card the calendar date box should be orange."
// Static CSS-content check (no inline color was ever set here - the
// default badge color lives purely in the stylesheet), same pattern as
// admin-mobile-topbar-compositing.test.js's own note on why.
test('Parent Portal homepage: Upcoming Events date badge is orange', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  const match = /\.parent-home-date-badge\s*\{([^}]*)\}/.exec(css);
  assert.ok(match, 'expected the .parent-home-date-badge rule');
  assert.match(match[1], /background:\s*#e2762c/, 'the date badge should be orange, not the old blue');
});

// A real request: "The blue on the cards on the parent portal homepage
// should be the same blue as the background of the app" - originally
// var(--bg) directly; a later request ("The colored cards should all be
// the same blue that is found in the rest of the website. The pastel
// soft blue") moved it onto this app's own established --brand family
// of tokens instead (already the background/border/text its info
// banners, kiosk home, etc. use), not its own one-off hex.
test('Parent Portal homepage: the blue card accent matches the app\'s established brand blue', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  // The blue variant is one of several comma-separated selectors sharing
  // this one rule (see the stylesheet's own comment above it), so this
  // just confirms the selector is in that shared list rather than
  // requiring it to be the sole selector of its own rule.
  const match = /\.parent-home-card-v2-blue \.parent-home-card-v2-icon,?\s*\n?[\s\S]{0,400}?\{([^}]*)\}/.exec(css);
  assert.ok(match, 'expected the .parent-home-card-v2-blue icon rule');
  assert.match(match[1], /background:\s*var\(--brand-dark\)/, 'the blue card icon should reuse var(--brand-dark), not its own hex');
});

// A real bug report: "The screenshot is showing the parent portal with
// several colors. That isn't correct" - every card (Forms, Training,
// Upcoming Events, Reading Challenge, Classifieds, Business Directory)
// used to get its own distinct color (slate/rose/blue/green/amber/
// purple); "the parent portal homepage should still have blue cards"
// (singular palette) made every one of them parent-home-card-v2-blue
// instead. The other color variants' own CSS selectors stay defined
// (unused on this page) rather than deleted outright - see styles.css's
// own ".parent-home-cta" comment ("the class names stay... in case a
// future card wants its own color back").
test('Parent Portal homepage: every card is the same blue, no other colors', async () => {
  const { cookie } = await loginAsPortalParent();
  const page = await request(app).get('/parent').set('Cookie', cookie);
  assert.equal(page.status, 200);
  const cardClasses = [...page.text.matchAll(/class="parent-home-card-v2 (parent-home-card-v2-\w+)"/g)].map((m) => m[1]);
  assert.ok(cardClasses.length >= 6, `expected at least 6 cards, found ${cardClasses.length}`);
  assert.ok(cardClasses.every((c) => c === 'parent-home-card-v2-blue'), `expected every card to be blue, got: ${cardClasses.join(', ')}`);
});

// A real request: "Shrink the title bars of all of the cards by height" -
// shorter vertical padding than the original 1.25rem/1rem top/bottom, on
// the one shared .parent-home-card-v2-head every card (Forms, Training,
// Events, Reading Challenge, Classifieds, Business Directory) uses.
test('Parent Portal homepage: card title bars are shorter than before', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  const match = /\.parent-home-card-v2-head\s*\{([^}]*)\}/.exec(css);
  assert.ok(match, 'expected the .parent-home-card-v2-head rule');
  const paddingMatch = /padding:\s*([\d.]+)rem\s+[\d.]+rem\s+([\d.]+)rem/.exec(match[1]);
  assert.ok(paddingMatch, 'expected a shorthand top/sides/bottom padding');
  assert.ok(Number(paddingMatch[1]) < 1.25, 'top padding should be shorter than the original 1.25rem');
  assert.ok(Number(paddingMatch[2]) < 1, 'bottom padding should be shorter than the original 1rem');
});
