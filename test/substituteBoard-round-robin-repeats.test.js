// A real user request: "floater suggested assignments should always be
// different people in each position and each hour. it should exhaust the
// list all 4 hours and all positions before suggesting someone else
// again." substituteBoard-vary-across-hours.test.js already covers the
// FIRST pass through a floater pool (one auto-pick per hour, never the
// same person twice while anyone unused remains) - this covers what
// happens once that first pass is used up and repeats become
// unavoidable. Before this fix, substituteBoard tracked "used today" as
// a plain boolean Set: once everyone in the pool had been picked once,
// every later hour's "fresh" candidate list was empty, and the fallback
// collapsed back onto the exact same rank/alphabetically-first person for
// the rest of the day instead of continuing to rotate - confirmed live
// with a 2-person pool and 4 one-job hours: hours 1-2 correctly split the
// pair, but hours 3 AND 4 both landed on the same person again (3-1
// instead of 2-2). Fixed by tracking WHEN each person was last used
// (lastUsedSeq) instead of just whether, so the fallback picks whoever's
// gone longest since their last turn - a real round-robin instead of a
// one-shot pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `substituteboard-round-robin-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `substituteboard-round-robin-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { getListByDay, sectionsForList, addMemberToSection, setSectionRank } = require('../utils/volunteers');
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

test('substituteBoard keeps rotating through a small floater pool once every member has had one turn, instead of clumping repeats onto one person', async () => {
  const day = 'monday';
  const list = await getListByDay(day);
  const sections = await sectionsForList(list.id);

  // Only 2 people, both "first" rank, on all 4 hour sections - smaller
  // than the 4 one-job-per-hour slots below, so a second pass through the
  // pool is unavoidable by hour 3.
  const alpha = await makeParent('Alpha RoundRobin', 'rr-alpha');
  const beta = await makeParent('Beta RoundRobin', 'rr-beta');
  for (const memberId of [alpha, beta]) {
    for (const s of sections) {
      await addMemberToSection(list.id, memberId, s.id);
      await setSectionRank(list.id, memberId, s.id, 'first');
    }
  }

  for (let hourPosition = 1; hourPosition <= 4; hourPosition++) {
    await createPermanentJob({ day, hourPosition, title: `RR Job Hour ${hourPosition}`, room: 'Room' });
  }

  const date = '2026-08-31'; // a Monday
  const board = await substituteBoard(day, date);
  const counts = { [alpha]: 0, [beta]: 0 };
  for (const hour of board) {
    for (const slot of hour.slots) {
      if (slot.assigned) counts[slot.assigned.id] = (counts[slot.assigned.id] || 0) + 1;
    }
  }

  assert.equal(counts[alpha], 2, 'with 4 slots and 2 equally-ranked people, each should be picked exactly twice');
  assert.equal(counts[beta], 2, 'with 4 slots and 2 equally-ranked people, each should be picked exactly twice');
});

test('substituteBoard still auto-picks a Backup Only floater when they are the only candidate for a slot', async () => {
  // wednesday, not monday - the previous test's Alpha/Beta are on every
  // monday hour section, which would otherwise leak into this hour's
  // pool since both tests share one DB file for the whole test file.
  const day = 'wednesday';
  const list = await getListByDay(day);
  const sections = await sectionsForList(list.id);
  const hour1 = sections.find((s) => s.position === 1);

  const backupOnly = await makeParent('Backup Only RoundRobin', 'rr-backup');
  await addMemberToSection(list.id, backupOnly, hour1.id);
  await setSectionRank(list.id, backupOnly, hour1.id, 'backup');

  await createPermanentJob({ day, hourPosition: 1, title: 'RR Backup Only Job', room: 'Room' });

  const date = '2026-09-02'; // a Wednesday
  const board = await substituteBoard(day, date);
  const hour1Result = board.find((h) => h.position === 1);
  const slot = hour1Result.slots.find((s) => s.label === 'RR Backup Only Job');

  assert.ok(slot.assigned, 'the only candidate, backup-rank or not, should still get auto-picked');
  assert.equal(slot.assigned.id, backupOnly);
  assert.equal(slot.assigned.rank, 'backup', 'assignedInfo should carry the real rank so the dropdown can label it correctly');
});
