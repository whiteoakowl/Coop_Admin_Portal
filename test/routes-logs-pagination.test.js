// Real HTTP-level coverage for the Logs page's pagination (Phase 4 audit
// item, part 2 - utils/pagination.js). Unlike the Members list, these
// three tabs (absence, checkinout, nametag) didn't already have a
// separate screen/print table - adding pagination here specifically had
// to avoid a regression where Print would silently show only the current
// page instead of the full filtered log. That's the one thing worth
// testing at the route level rather than just trusting the pagination
// math (already covered by test/pagination.test.js). Boots the real app
// (server.js) against a throwaway DB, same pattern as the other
// test/routes-*.test.js files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-logs-pagination-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-logs-pagination-test-uploads-${process.pid}`);
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

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

test.before(async () => {
  await app.ready;
  const insertMember = db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')");
  const insertAbsence = db.prepare(
    "INSERT INTO attendance (member_id, roster_id, session_date, status, source, reason_category, reason_text) VALUES (?, 2, '2024-03-04', 'absent', 'absence_form', 'personal', 'testing')"
  );
  const insertCheckin = db.prepare(
    "INSERT INTO attendance (member_id, roster_id, session_date, status, source, check_in_time) VALUES (?, 4, '2024-03-04', 'present', 'kiosk', ?)"
  );
  const insertNametag = db.prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'lost_tag', 'monday', 'testing')");

  for (let i = 1; i <= 60; i++) {
    const name = `Log Test Kid ${String(i).padStart(2, '0')}`;
    const memberId = (await insertMember.run(name, `log-test-kid-${i}`)).lastInsertRowid;
    await insertAbsence.run(memberId);
    await insertCheckin.run(memberId, Date.now() + i);
    await insertNametag.run(memberId);
  }
});

test('Logs page pagination', async (t) => {
  const cookie = await loginAsAdmin();

  const cases = [
    { tab: 'absence', printTableCols: 6 },
    { tab: 'checkinout', printTableCols: 6 },
    { tab: 'nametag', printTableCols: 5 }, // no Archive/Unarchive action column in print
  ];

  for (const { tab, printTableCols } of cases) {
    await t.test(`${tab}: page 1 shows 50 on screen, all 60 in the print table`, async () => {
      const res = await request(app).get(`/admin/logs?tab=${tab}`).set('Cookie', cookie);
      assert.equal(res.status, 200);
      assert.equal(countOccurrences(res.text, '<td>Log Test Kid'), 50 + 60, 'screen (50) + print (60) = 110');
      assert.match(res.text, /Showing 1&ndash;50 of 60/);
      // The old static "Page N of M" text is now an interactive dropdown
      // (a real request: "a drop down to choose page number") - option 1
      // selected, "of 2" trailing it.
      assert.match(res.text, /<option value="1" selected>1<\/option>/);
      assert.match(res.text, /of 2\s*<\/label>/);
    });

    await t.test(`${tab}: page 2 shows the remaining 10 on screen, still all 60 in the print table`, async () => {
      const res = await request(app).get(`/admin/logs?tab=${tab}&page=2`).set('Cookie', cookie);
      assert.equal(res.status, 200);
      assert.equal(countOccurrences(res.text, '<td>Log Test Kid'), 10 + 60, 'screen (10) + print (60) = 70');
      assert.match(res.text, /Showing 51&ndash;60 of 60/);
    });

    await t.test(`${tab}: an out-of-range page clamps to the last real page`, async () => {
      const res = await request(app).get(`/admin/logs?tab=${tab}&page=999`).set('Cookie', cookie);
      assert.equal(res.status, 200);
      assert.match(res.text, /<option value="2" selected>2<\/option>/);
    });

    await t.test(`${tab}: the print table has ${printTableCols} header columns`, async () => {
      const res = await request(app).get(`/admin/logs?tab=${tab}`).set('Cookie', cookie);
      const printTableMatch = /<table class="roster-table members-table condensed-table logs-print-table">[\s\S]*?<\/thead>/.exec(res.text);
      assert.ok(printTableMatch, 'expected a logs-print-table with a thead');
      // <th\b (not <thead>, which also starts with "<th") - a naive /<th/
      // count would include the <thead> wrapper tag itself as a spurious
      // extra match, off by one on every table.
      const headerCount = (printTableMatch[0].match(/<th(?=[ >])/g) || []).length;
      assert.equal(headerCount, printTableCols);
    });
  }

  await t.test('the nametag Next link preserves the archived filter', async () => {
    const res = await request(app).get('/admin/logs?tab=nametag&archived=0').set('Cookie', cookie);
    // archived=0 isn't "archived", so the link should NOT carry &archived=1
    assert.doesNotMatch(res.text, /archived=1&amp;page=2/);
  });
});
