// A real user request: "Floater assignments... suggested different
// floaters each hour. try to not suggested the same person different
// hours in a day unless necessary." utils/substitutes.js's substituteBoard
// auto-picks a candidate per empty slot (persisted 'pending' until an
// admin approves/overrides it) - before this fix, every hour started
// fresh from the same rank-sorted floater pool, so the same top-ranked
// person got auto-picked hour after hour whenever they were free all day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `substituteboard-vary-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `substituteboard-vary-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { getListByDay, sectionsForList, addMemberToSection } = require('../utils/volunteers');
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

test('substituteBoard spreads auto-picks across hours instead of reusing the same top-ranked person every time', async () => {
  const day = 'monday';
  const list = await getListByDay(day);
  const sections = await sectionsForList(list.id);
  const hour1 = sections.find((s) => s.position === 1);
  const hour2 = sections.find((s) => s.position === 2);

  // Two parents, both "first" rank, free both hours - without the fix,
  // pickCandidate's fallback (first non-preferred, rank-tied) would pick
  // the same one of these two at both hours every time.
  const alice = await makeParent('Alice Anderson', 'vary-alice');
  const bob = await makeParent('Bob Baxter', 'vary-bob');
  for (const memberId of [alice, bob]) {
    await addMemberToSection(list.id, memberId, hour1.id);
    await addMemberToSection(list.id, memberId, hour2.id);
  }

  await createPermanentJob({ day, hourPosition: 1, title: 'Vary Test Job Hour 1', room: 'Room 1' });
  await createPermanentJob({ day, hourPosition: 2, title: 'Vary Test Job Hour 2', room: 'Room 2' });

  const date = '2026-08-31'; // a Monday
  const board = await substituteBoard(day, date);
  const hour1Result = board.find((h) => h.position === 1);
  const hour2Result = board.find((h) => h.position === 2);
  const hour1Slot = hour1Result.slots.find((s) => s.label === 'Vary Test Job Hour 1');
  const hour2Slot = hour2Result.slots.find((s) => s.label === 'Vary Test Job Hour 2');

  assert.ok(hour1Slot.assigned, 'hour 1 job should get an auto-picked candidate');
  assert.ok(hour2Slot.assigned, 'hour 2 job should get an auto-picked candidate');
  assert.notEqual(
    hour1Slot.assigned.id,
    hour2Slot.assigned.id,
    'with two equally-available candidates, each hour should get a different auto-picked floater'
  );
});
