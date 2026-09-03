// Real HTTP-level coverage for the global admin search (Phase 4 audit item
// #75, routes/admin-search.js + utils/search.js). The one thing worth
// pinning down at the route level rather than just trusting a unit test
// on the matching logic alone: each matched member's Attendance/Floater/
// Library badges have to reflect THAT member's own cross-link data, not
// just "any match found something somewhere" - a regression there would
// still return 200 with plausible-looking output, easy to miss without an
// assertion tying each badge to the specific member it belongs to. Boots
// the real app (server.js) against a throwaway DB, same pattern as the
// other test/routes-*.test.js files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-search-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-search-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

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

// Pulls each <tr>'s member name and the set of badge labels in its
// "Found In" cell, in document order - used to tie a specific badge back
// to the specific member it's supposed to describe. The name cell itself
// is a clickable link (a later, real request: "make member names
// clickable -> profile across every list surface"), not plain text.
function memberRows(html) {
  const rows = [];
  const rowRe = /<tr>\s*<td><a class="member-name-link"[^>]*>([^<]+)<\/a><\/td>[\s\S]*?<td class="search-found-in-cell">([\s\S]*?)<\/td>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const badges = [...m[2].matchAll(/>([A-Za-z][^<]*)<\/(?:a|span)>/g)].map((b) => b[1].trim());
    rows.push({ name: m[1].trim(), badges });
  }
  return rows;
}

test.before(async () => {
  // Node's test runner does not run multiple top-level test.before() hooks
  // strictly sequentially - a second hook can start before an earlier
  // one (even one that just awaits app.ready) has resolved - so this hook
  // has to await app.ready itself rather than relying on hook order.
  await app.ready;
  const insertMember = db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, ?)");

  const attendanceKidId = (await insertMember.run('Zzsearch Attendance Kid', 'zzsearch-att', 'student')).lastInsertRowid;
  const anyRoster = await db.prepare('SELECT id FROM rosters LIMIT 1').get();
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, '2024-03-04', 'present', 'kiosk')")
    .run(attendanceKidId, anyRoster.id);

  const floaterParentId = (await insertMember.run('Zzsearch Floater Parent', 'zzsearch-floater', 'parent')).lastInsertRowid;
  const list = await db.prepare("SELECT id FROM volunteer_lists WHERE day = 'monday'").get();
  const section = await db.prepare('SELECT id FROM volunteer_sections WHERE volunteer_list_id = ? LIMIT 1').get(list.id);
  await db.prepare('INSERT INTO volunteer_members (volunteer_list_id, member_id, section_id, rank) VALUES (?, ?, ?, ?)').run(list.id, floaterParentId, section.id, 'sometimes');

  const libraryKidId = (await insertMember.run('Zzsearch Library Kid', 'zzsearch-lib', 'student')).lastInsertRowid;
  const itemId = (await db.prepare("INSERT INTO library_items (title, barcode) VALUES ('Zzsearch Book Title', 'zzsearch-book-1')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO library_checkouts (member_id, item_id, checked_out_at) VALUES (?, ?, ?)').run(libraryKidId, itemId, Date.now());

  await insertMember.run('Zzsearch Plain Kid', 'zzsearch-plain', 'student');

  await db.prepare("INSERT INTO library_items (title, barcode) VALUES ('Zzsearch Unclaimed Book', 'zzsearch-book-2')").run();
});

test('global admin search', async (t) => {
  const cookie = await loginAsAdmin();

  await t.test('unauthenticated requests redirect to login', async () => {
    const res = await request(app).get('/admin/search?q=Zzsearch');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/admin\/login/);
  });

  await t.test('visiting with no query shows the initial prompt, not a "no matches" message', async () => {
    const res = await request(app).get('/admin/search').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Search for a member/);
    assert.doesNotMatch(res.text, /No matches for/);
  });

  await t.test('a query with no matches shows the empty state', async () => {
    const res = await request(app).get('/admin/search?q=totally-nonexistent-xyz').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /No matches for/);
  });

  await t.test('each matched member shows exactly their own cross-link badges, not a shared/blended set', async () => {
    const res = await request(app).get('/admin/search?q=Zzsearch').set('Cookie', cookie);
    assert.equal(res.status, 200);
    const rows = memberRows(res.text);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.badges]));

    assert.deepEqual(byName['Zzsearch Attendance Kid'], ['Attendance']);
    assert.deepEqual(byName['Zzsearch Floater Parent'], ['Floater']);
    assert.deepEqual(byName['Zzsearch Library Kid'], ['Library (1)']);
    assert.deepEqual(byName['Zzsearch Plain Kid'], ['none yet']);
  });

  await t.test('library items matching the query appear in their own section', async () => {
    const res = await request(app).get('/admin/search?q=Zzsearch').set('Cookie', cookie);
    assert.match(res.text, /Zzsearch Book Title/);
    assert.match(res.text, /Zzsearch Unclaimed Book/);
    assert.match(res.text, /Checked Out/);
    assert.match(res.text, /Checked In/);
  });

  await t.test('searching by barcode finds the member', async () => {
    const res = await request(app).get('/admin/search?q=zzsearch-att').set('Cookie', cookie);
    assert.match(res.text, /Zzsearch Attendance Kid/);
  });

  await t.test('the Attendance badge links to that member\'s Attendance tab', async () => {
    const res = await request(app).get('/admin/search?q=Zzsearch+Attendance+Kid').set('Cookie', cookie);
    const idMatch = /href="\/admin\/members\/(\d+)\?tab=attendance"/.exec(res.text);
    assert.ok(idMatch, 'expected an Attendance-tab link');
  });
});
