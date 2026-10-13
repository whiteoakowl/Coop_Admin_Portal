// Real HTTP-level coverage for a real request: "when you click edit
// profile for a member, it should show the other parents and children's
// information as well for easy editing." Both Co-op Admin's and Main
// Admin's own Edit Profile pages now render an inline "Family Members"
// editor (views/partials/family-members-editor.ejs) listing every OTHER
// member of the same family (utils/members.js's familyOf), each with its
// own compact Name/Phone/Email(/Birthday+Grade Level for a student) form
// posting to its own narrow quick-edit route - deliberately not the same
// route as the full Add/Edit Member form, so it can never blank out a
// sibling's photo/address/family/admin positions/sections/portal roles.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `member-edit-family-editor-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `member-edit-family-editor-test-uploads-${process.pid}`);
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

async function loginAsCoopAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function makeFamily(label) {
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`${label} Family`)).id;
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, email, phone) VALUES (?, ?, 'parent', ?, ?, ?) RETURNING id")
      .get(`${label} Parent`, `${label}-parent`, familyId, `${label.toLowerCase()}-parent@example.com`, '555-0001')
  ).id;
  const kidId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, birthday, grade_level) VALUES (?, ?, 'student', ?, '2015-04-12', '4th') RETURNING id")
      .get(`${label} Kid`, `${label}-kid`, familyId)
  ).id;
  return { familyId, parentId, kidId };
}

for (const portal of [
  { name: 'Co-op Admin', login: loginAsCoopAdmin, editPath: (id) => `/admin/members/${id}/edit`, quickEditPath: (viewerId, memberId) => `/admin/members/${viewerId}/family/${memberId}/quick-edit` },
  { name: 'Main Admin', login: loginAsMainAdmin, editPath: (id) => `/main-admin/members/${id}/edit`, quickEditPath: (viewerId, memberId) => `/main-admin/members/${viewerId}/family/${memberId}/quick-edit` },
]) {
  test(`${portal.name}: Edit Profile page shows the rest of the family, inline-editable`, async (t) => {
    const { cookie, csrfToken } = await portal.login();

    await t.test('the other family member shows up with its own Name/Phone/Email/Birthday/Grade Level form, excluding the member being viewed', async () => {
      const { parentId, kidId } = await makeFamily(`${portal.name}ShowsFamily`);
      const res = await request(app).get(portal.editPath(parentId)).set('Cookie', cookie);
      assert.equal(res.status, 200);
      assert.match(res.text, /Family Members/);
      assert.match(res.text, new RegExp(`action="${portal.quickEditPath(parentId, kidId).replace(/\//g, '\\/')}"`));
      assert.match(res.text, /name="birthday" value="2015-04-12"/);
      assert.match(res.text, /<option value="4th" selected>4th<\/option>/);
      // The member being viewed is never offered its own quick-edit card.
      assert.doesNotMatch(res.text, new RegExp(`family\\/${parentId}\\/quick-edit`));
    });

    await t.test('a parent sibling\'s card has no Birthday/Grade Level fields', async () => {
      const { familyId, kidId } = await makeFamily(`${portal.name}ParentNoDob`);
      const otherParentId = (
        await db
          .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES (?, ?, 'parent', ?) RETURNING id")
          .get(`${portal.name}ParentNoDob Other Parent`, `${portal.name}-other-parent`, familyId)
      ).id;
      const res = await request(app).get(portal.editPath(kidId)).set('Cookie', cookie);
      const cardStart = res.text.indexOf(portal.quickEditPath(kidId, otherParentId));
      assert.ok(cardStart > -1, 'expected the other parent\'s own quick-edit card');
      const cardChunk = res.text.slice(cardStart, cardStart + 1200);
      assert.doesNotMatch(cardChunk, /name="birthday"/, 'a parent-type family member should get no Birthday field');
      assert.doesNotMatch(cardChunk, /name="gradeLevel"/, 'a parent-type family member should get no Grade Level field');
    });

    await t.test('a member with no family at all shows no Family Members section', async () => {
      const soloId = (
        await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'parent') RETURNING id").get(`${portal.name}SoloMember`, `${portal.name}-solo`)
      ).id;
      const res = await request(app).get(portal.editPath(soloId)).set('Cookie', cookie);
      assert.equal(res.status, 200);
      assert.doesNotMatch(res.text, /Family Members/);
    });

    await t.test('quick-edit updates Name/Phone/Email for a parent sibling, leaving member_type and other fields untouched', async () => {
      const { parentId, kidId } = await makeFamily(`${portal.name}QuickEditParent`);
      const res = await request(app)
        .post(portal.quickEditPath(kidId, parentId))
        .set('Cookie', cookie)
        .type('form')
        .send({ name: `${portal.name} Updated Parent Name`, phone: '555-9999', email: 'updated-parent@example.com', _csrf: csrfToken });
      assert.equal(res.status, 302);
      assert.match(res.headers.location, new RegExp(`${portal.editPath(kidId).replace(/\//g, '\\/')}\\?notice=`));

      const updated = await db.prepare('SELECT name, phone, email, member_type FROM members WHERE id = ?').get(parentId);
      assert.equal(updated.name, `${portal.name} Updated Parent Name`);
      assert.equal(updated.phone, '555-9999');
      assert.equal(updated.email, 'updated-parent@example.com');
      assert.equal(updated.member_type, 'parent');
    });

    await t.test('quick-edit updates Birthday/Grade Level for a student sibling', async () => {
      const { parentId, kidId } = await makeFamily(`${portal.name}QuickEditStudent`);
      const res = await request(app)
        .post(portal.quickEditPath(parentId, kidId))
        .set('Cookie', cookie)
        .type('form')
        .send({ name: `${portal.name}QuickEditStudent Kid`, birthday: '2016-01-01', gradeLevel: '3rd', _csrf: csrfToken });
      assert.equal(res.status, 302);

      const updated = await db.prepare('SELECT birthday, grade_level, member_type FROM members WHERE id = ?').get(kidId);
      assert.equal(updated.birthday, '2016-01-01');
      assert.equal(updated.grade_level, '3rd');
      assert.equal(updated.member_type, 'student');
    });

    await t.test('a submitted Birthday/Grade Level for a parent sibling is silently ignored, never flipping member_type', async () => {
      const { parentId, kidId } = await makeFamily(`${portal.name}ParentBirthdayIgnored`);
      const res = await request(app)
        .post(portal.quickEditPath(kidId, parentId))
        .set('Cookie', cookie)
        .type('form')
        .send({ name: `${portal.name}ParentBirthdayIgnored Parent`, birthday: '2016-01-01', gradeLevel: '3rd', _csrf: csrfToken });
      assert.equal(res.status, 302);

      const updated = await db.prepare('SELECT birthday, grade_level, member_type FROM members WHERE id = ?').get(parentId);
      assert.equal(updated.birthday, null, 'a parent sibling has no Birthday field to submit in the first place - any posted value must be ignored');
      assert.equal(updated.grade_level, null);
      assert.equal(updated.member_type, 'parent', 'member type must never change from this lightweight editor');
    });

    await t.test('a blank name is rejected with an error, no update applied', async () => {
      const { parentId, kidId } = await makeFamily(`${portal.name}BlankName`);
      const res = await request(app)
        .post(portal.quickEditPath(parentId, kidId))
        .set('Cookie', cookie)
        .type('form')
        .send({ name: '  ', _csrf: csrfToken });
      assert.equal(res.status, 302);
      assert.match(res.headers.location, /error=/);

      const unchanged = await db.prepare('SELECT name FROM members WHERE id = ?').get(kidId);
      assert.equal(unchanged.name, `${portal.name}BlankName Kid`);
    });

    await t.test('a name clashing with another member is rejected with an error', async () => {
      const { parentId, kidId } = await makeFamily(`${portal.name}ClashName`);
      const res = await request(app)
        .post(portal.quickEditPath(parentId, kidId))
        .set('Cookie', cookie)
        .type('form')
        .send({ name: `${portal.name}ClashName Parent`, _csrf: csrfToken });
      assert.equal(res.status, 302);
      assert.match(res.headers.location, /error=/);

      const unchanged = await db.prepare('SELECT name FROM members WHERE id = ?').get(kidId);
      assert.equal(unchanged.name, `${portal.name}ClashName Kid`);
    });

    await t.test('quick-editing a member outside the viewer\'s own family is rejected, not applied', async () => {
      const familyA = await makeFamily(`${portal.name}CrossFamilyA`);
      const familyB = await makeFamily(`${portal.name}CrossFamilyB`);
      const res = await request(app)
        .post(portal.quickEditPath(familyA.parentId, familyB.kidId))
        .set('Cookie', cookie)
        .type('form')
        .send({ name: 'Hijacked Name', _csrf: csrfToken });
      assert.equal(res.status, 302);
      assert.match(res.headers.location, /error=/);

      const unchanged = await db.prepare('SELECT name FROM members WHERE id = ?').get(familyB.kidId);
      assert.equal(unchanged.name, `${portal.name}CrossFamilyB Kid`);
    });
  });
}
