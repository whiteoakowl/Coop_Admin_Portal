// Coverage for a real request: "all bulk printing should have filter by
// family name." Every member-based bulk print picker on the Design/Print
// hub (Co-op Admin's /admin/design and Main Admin's /main-admin/name-tags)
// gets its own Family Name filter select (views/partials/family-filter-
// select.ejs), built from utils/members.js's allFamilies() and matched
// client-side against each row's own data-family-id (views/partials/
// print-picker-table.ejs) by public/js/design-print-hub.js's
// wireBulkMemberList - the same mechanism the existing Type filter already
// uses. The filter itself is client-side JS a jsdom-free route test can't
// exercise directly (same reasoning as test/routes-admin-design-teacher-
// filter.test.js) - this locks in the markup contract it depends on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `bulk-print-family-filter-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `bulk-print-family-filter-test-uploads-${process.pid}`);
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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app)
    .post('/login')
    .type('form')
    .send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

function rowAttrs(html, memberId) {
  // name="memberIds" (not a bare value="<id>") - a family's own id and a
  // member's own id are separate auto-increment sequences that can
  // collide (e.g. both starting at 1), and a bare value="1" can just as
  // easily match the Family Name filter's own <option value="1"> (which
  // renders earlier on the page than the picker table) as the real
  // member checkbox.
  const idx = html.indexOf(`name="memberIds" value="${memberId}"`);
  const rowStart = html.lastIndexOf('<tr class="print-picker-row"', idx);
  return html.slice(rowStart, idx);
}

test('Design/Print hub (Co-op Admin): every member-based print panel offers a Family Name filter, and rows carry data-family-id', async () => {
  const famA = (await db.prepare("INSERT INTO families (name) VALUES ('Anderson')").run()).lastInsertRowid;
  const famB = (await db.prepare("INSERT INTO families (name) VALUES ('Baker')").run()).lastInsertRowid;
  const { lastInsertRowid: memberA } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Andy Anderson', 'Andy Anderson', 'student', ?)")
    .run(famA);
  const { lastInsertRowid: memberB } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Bea Baker', 'Bea Baker', 'student', ?)")
    .run(famB);
  const { lastInsertRowid: memberNoFamily } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Family', 'No Family', 'student')")
    .run();

  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  assert.equal(res.status, 200);

  // One Family Name filter select per member-based panel: Schedule Cards,
  // Name Tags, Cards Both, Cards Duplex, Barcodes Only, Barcode Mailing
  // Labels. Name Tag Requests has its own select too, but only renders
  // once there's at least one pending request - covered separately below
  // (with a seeded request) rather than here.
  const expectedIds = [
    'schedule-print-family-select',
    'name-tag-bulk-family-select',
    'cards-both-bulk-family-select',
    'cards-duplex-bulk-family-select',
    'barcodes-bulk-family-select',
    'barcode-labels-bulk-family-select',
  ];
  for (const id of expectedIds) {
    const selectMatch = new RegExp(`<select class="name-tag-bulk-filter-select" id="${id}">[\\s\\S]*?</select>`).exec(res.text);
    assert.ok(selectMatch, `expected the ${id} Family Name filter select`);
    assert.match(selectMatch[0], /<option value="">All Families<\/option>/);
    assert.match(selectMatch[0], /<option value="\d+">Anderson Family<\/option>/);
    assert.match(selectMatch[0], /<option value="\d+">Baker Family<\/option>/);
  }

  // print-picker-table.ejs's real rows (Schedule Cards - the others are
  // skipRows, cloned client-side) carry data-family-id.
  assert.match(rowAttrs(res.text, memberA), new RegExp(`data-family-id="${famA}"`));
  assert.match(rowAttrs(res.text, memberB), new RegExp(`data-family-id="${famB}"`));
  assert.match(rowAttrs(res.text, memberNoFamily), /data-family-id=""/);
});

test('Design/Print hub (Co-op Admin): Name Tag Requests panel rows also carry data-family-id', async () => {
  const fam = (await db.prepare("INSERT INTO families (name) VALUES ('Clark')").run()).lastInsertRowid;
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Cara Clark', 'Cara Clark', 'student', ?)")
    .run(fam);
  await db.prepare("INSERT INTO name_tag_requests (member_id, request_type, day) VALUES (?, 'lost_tag', 'monday')").run(memberId);

  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  assert.equal(res.status, 200);

  assert.match(rowAttrs(res.text, memberId), new RegExp(`data-family-id="${fam}"`));
  assert.match(res.text, /<select class="name-tag-bulk-filter-select" id="name-tag-requests-family-select">/, 'the Name Tag Requests panel should offer a Family Name filter once it has a pending request to show');
});

test('Main Admin Design/Print hub: every member-based print panel offers a Family Name filter, and rows carry data-family-id', async () => {
  const fam = (await db.prepare("INSERT INTO families (name) VALUES ('Douglas')").run()).lastInsertRowid;
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Dan Douglas', 'Dan Douglas', 'student', ?)")
    .run(fam);

  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/name-tags?tab=print').set('Cookie', cookie);
  assert.equal(res.status, 200);

  const expectedIds = [
    'schedule-print-family-select',
    'name-tag-bulk-family-select',
    'cards-both-bulk-family-select',
    'cards-duplex-bulk-family-select',
    'barcodes-bulk-family-select',
    'barcode-labels-bulk-family-select',
  ];
  for (const id of expectedIds) {
    assert.match(res.text, new RegExp(`<select class="name-tag-bulk-filter-select" id="${id}">`), `expected the ${id} Family Name filter select`);
  }
  assert.match(rowAttrs(res.text, memberId), new RegExp(`data-family-id="${fam}"`));
});
