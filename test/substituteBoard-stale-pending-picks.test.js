// substituteBoard no longer auto-picks a candidate for an open slot (see
// utils/substitutes.js's own comment on why - a real request: "don't
// suggest floaters. just offer the drop down menu of choices that aren't
// already assigned"), so there's no more auto-suggested 'pending' pick
// left to go stale when its own floater is later removed from the
// Floater List - that scenario this file used to cover is gone along
// with the feature. What's still worth covering: an ADMIN's own approved
// pick (setAssignment, always 'approved') must never be silently cleared
// just because that person later leaves the Floater List - only an
// admin's own later action should ever change it.
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
const { substituteBoard, createPermanentJob, setAssignment } = require('../utils/substitutes');

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

// Same stale-hardcoded-date bug as test/routes-admin-substitutes-fetch-
// assign.test.js's own nextMonday() comment: '2026-09-02' was in the future
// when this file was written but isn't anymore. Computed fresh each run so
// this can't go stale again - targetDow (0=Sunday...6=Saturday) lands on
// the correct real weekday since utils/substitutes.js's own DAY_WEEKDAY
// check cares about it (3=Wednesday below).
function nextWeekday(targetDow) {
  const d = new Date();
  d.setDate(d.getDate() + (((targetDow - d.getDay() + 7) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

test('an APPROVED pick is never auto-cleared just because the person later leaves the Floater List - that stays an admin decision', async () => {
  const day = 'wednesday';
  const list = await getListByDay(day);
  const hour1 = (await sectionsForList(list.id)).find((s) => s.position === 1);

  const chosen = await makeParent('Chosen Floater', 'stale-chosen');
  await addMemberToSection(list.id, chosen, hour1.id);
  await createPermanentJob({ day, hourPosition: 1, title: 'Approved Pick Job', room: 'R' });

  const date = nextWeekday(3); // a Wednesday
  await setAssignment(date, 'job', (await db.prepare("SELECT id FROM permanent_jobs WHERE day = ? AND title = 'Approved Pick Job'").get(day)).id, chosen, false);

  await removeMemberFromSection(list.id, chosen, hour1.id);

  const board = await substituteBoard(day, date);
  const slot = board.find((h) => h.position === 1).slots.find((s) => s.label === 'Approved Pick Job');
  assert.ok(slot.assigned, 'an approved pick must not be silently cleared');
  assert.equal(slot.assigned.id, chosen);
  assert.equal(slot.assigned.status, 'approved');
});
