// A real bug report: "the suggested floater name dropdown menus are also
// not updating as the floater teams are updated." routes-admin-volunteers-
// dropdown-excludes-removed.test.js already covers removing someone from
// the Floater List BEFORE any board/dropdown was ever computed for them -
// this covers the case that test doesn't: substituteBoard auto-picks (and
// persists as 'pending') a candidate for an open slot the FIRST time a
// date's board is viewed. resolveSlot only ever auto-picks when no row
// exists yet, so once that pending row was written, nothing re-checked
// whether its own person was still even eligible - removing them from the
// Floater List afterward left the board (and the dropdown built from it in
// routes/admin-volunteers.js, which always keeps a slot's current pick
// selectable even once they've dropped out of suggestedFloaters) still
// showing them as "currently assigned" indefinitely.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `substituteboard-stale-pending-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `substituteboard-stale-pending-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { getListByDay, sectionsForList, addMemberToSection, removeMemberFromSection } = require('../utils/volunteers');
const { substituteBoard, createPermanentJob } = require('../utils/substitutes');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function makeParent(name, barcode) {
  return (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'parent')").run(name, barcode)).lastInsertRowid;
}

test('a stale pending auto-suggestion clears itself once its own floater is removed from the Floater List, instead of staying pinned forever', async () => {
  const day = 'monday';
  const list = await getListByDay(day);
  const hour1 = (await sectionsForList(list.id)).find((s) => s.position === 1);

  const lonely = await makeParent('Lonely Floater', 'stale-lonely');
  await addMemberToSection(list.id, lonely, hour1.id);
  await createPermanentJob({ day, hourPosition: 1, title: 'Stale Pending Job', room: 'R' });

  const date = '2026-08-31'; // a Monday
  let board = await substituteBoard(day, date);
  let slot = board.find((h) => h.position === 1).slots.find((s) => s.label === 'Stale Pending Job');
  assert.ok(slot.assigned, 'the only candidate should get auto-picked');
  assert.equal(slot.assigned.id, lonely);
  assert.equal(slot.assigned.status, 'pending', 'an auto-pick is pending, not an admin-approved decision');

  await removeMemberFromSection(list.id, lonely, hour1.id);

  board = await substituteBoard(day, date);
  slot = board.find((h) => h.position === 1).slots.find((s) => s.label === 'Stale Pending Job');
  assert.equal(slot.assigned, null, 'with no one left on the list for this hour, the stale pending pick should clear rather than stay pinned to someone no longer eligible');
});

test('an APPROVED pick is never auto-cleared just because the person later leaves the Floater List - that stays an admin decision', async () => {
  const day = 'wednesday'; // isolate from the monday test above (shared DB file)
  const list = await getListByDay(day);
  const hour1 = (await sectionsForList(list.id)).find((s) => s.position === 1);

  const { setAssignment } = require('../utils/substitutes');
  const chosen = await makeParent('Chosen Floater', 'stale-chosen');
  await addMemberToSection(list.id, chosen, hour1.id);
  await createPermanentJob({ day, hourPosition: 1, title: 'Approved Pick Job', room: 'R' });

  const date = '2026-09-02'; // a Wednesday
  await setAssignment(date, 'job', (await db.prepare("SELECT id FROM permanent_jobs WHERE day = ? AND title = 'Approved Pick Job'").get(day)).id, chosen, false);

  await removeMemberFromSection(list.id, chosen, hour1.id);

  const board = await substituteBoard(day, date);
  const slot = board.find((h) => h.position === 1).slots.find((s) => s.label === 'Approved Pick Job');
  assert.ok(slot.assigned, 'an approved pick must not be silently cleared');
  assert.equal(slot.assigned.id, chosen);
  assert.equal(slot.assigned.status, 'approved');
});
