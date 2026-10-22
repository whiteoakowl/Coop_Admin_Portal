// Coverage for a real follow-up request on the Annual Planner (see
// family-school-planner.test.js's own header comment for this
// subpage's full history): "Year dropdown menu, add the next 20 years
// of dates starting with 2030-2031. Export, pdf and print button to
// the right. On the same row, add curriculum and year picking drop
// down button to the left." (utils/familySchool.js's own
// schoolYearOptions, views/parent-family-school-annual-planner.ejs's
// own toolbar reorder.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `annual-planner-year-range-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `annual-planner-year-range-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');
test.before(() => app.ready);
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');
const { schoolYearOptions } = require('../utils/familySchool');

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

async function createParent(familyId) {
  counter += 1;
  const code = `apyr${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get(`Parent ${counter}`, code, code, familyId)
  ).id;
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  return { cookie: loginRes.headers['set-cookie'] };
}

test('schoolYearOptions always includes 2030-2031 through 2049-2050 (20 school years), regardless of the currently selected year', () => {
  const options = schoolYearOptions();
  for (let y = 2030; y <= 2049; y++) {
    assert.ok(options.includes(`${y}-${y + 1}`), `expected ${y}-${y + 1} in the year options`);
  }
  // Still covers near the actually-selected year too - not just the
  // 2030+ floor.
  const optionsFarPast = schoolYearOptions('2010-2011');
  assert.ok(optionsFarPast.includes('2010-2011'));
  assert.ok(optionsFarPast.includes('2049-2050'));
});

test('Annual Planner: one toolbar row has Add Curriculum + the School Year select on the left, Export/Print/PDF icons on the right', async () => {
  const familyId = await createFamily('Toolbar Family');
  const parent = await createParent(familyId);
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Toolbar Student', 'toolbar-student-barcode', 'student', ?, 1)").run(familyId);

  const page = await request(app).get('/parent/family-school/annual-planner').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);

  const toolbarMatch = /<div class="roster-toolbar-left">[\s\S]*?<\/div>\s*<div class="roster-btn-row roster-btn-row-fit-text">[\s\S]*?<\/div>/.exec(page.text);
  assert.ok(toolbarMatch, 'expected the combined left/right toolbar row');
  const toolbarHtml = toolbarMatch[0];
  assert.match(toolbarHtml, /\+ Add Curriculum/);
  assert.match(toolbarHtml, /annual-planner-school-year/);
  assert.match(toolbarHtml, /aria-label="Export CSV"/);
  assert.match(toolbarHtml, /aria-label="Print"/);
  assert.match(toolbarHtml, /aria-label="Download PDF"/);

  // Left group (Add Curriculum + year select) comes before the right
  // group (the three icons) in document order.
  const addCurriculumIndex = page.text.indexOf('+ Add Curriculum');
  const exportIconIndex = page.text.indexOf('aria-label="Export CSV"');
  assert.ok(addCurriculumIndex < exportIconIndex, 'expected Add Curriculum/year picker before the Export/Print/PDF icons');

  const option2030 = /<option value="2030-2031"[^>]*>2030-2031<\/option>/.exec(page.text);
  assert.ok(option2030, 'expected 2030-2031 as a selectable year option');
});
