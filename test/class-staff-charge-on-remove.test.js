// A real request: "charge per member and family charge is for events...
// class registration charging is for the students, and class assistants.
// Sometimes a class assistant may want to participate so we can give them
// the option to also pay for the supplies." A class priced
// 'students_and_staff' charges a teacher/assistant on self-signup (see
// routes/teacher-portal.js's own /classes/:id/join, which stamps the new
// payment_charges row onto class_staff.charge_id) the same way an
// enrolled student gets charged. Removing that staff member shouldn't
// leave an orphaned pending charge behind - utils/classSchedule.js's
// removeStaff mirrors class_registrations' own charge cleanup
// (utils/classRegistration.js's settleChargeOnCancel): cancel it if still
// unpaid, leave it alone if already paid (a Main Admin handles that by
// hand). This covers removeStaff directly rather than through the portal
// self-signup HTTP route, which needs a full portal login flow this test
// suite has no existing helper for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-staff-charge-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-staff-charge-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { createClass, addStaff, removeStaff } = require('../utils/classSchedule');
const { createCharge, getCharge, recordPayment } = require('../utils/payments');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function makeMember(name, barcode) {
  return (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'parent')").run(name, barcode)).lastInsertRowid;
}

async function makeAccount(memberId) {
  return (
    await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, ?, 'x', 'active')").run(memberId, `${memberId}@test.local`)
  ).lastInsertRowid;
}

test('removeStaff cancels a still-unpaid charge tied to that class_staff row', async () => {
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Charged Assistant Class', priceCents: 2500, pricePer: 'students_and_staff' });
  const assistantId = await makeMember('Paying Assistant', 'charge-remove-unpaid');
  const accountId = await makeAccount(assistantId);
  await addStaff(classId, assistantId, 'assistant');

  const chargeId = await createCharge(assistantId, accountId, 'class_registration', classId, 'Charged Assistant Class - class registration', 2500);
  await db.prepare('UPDATE class_staff SET charge_id = ? WHERE class_id = ? AND member_id = ?').run(chargeId, classId, assistantId);

  await removeStaff(classId, assistantId);

  const charge = await getCharge(chargeId);
  assert.equal(charge.status, 'cancelled', 'an unpaid charge should be cancelled when the staff member is removed');
});

test('removeStaff leaves an already-paid charge exactly as-is', async () => {
  const classId = await createClass({ day: 'monday', hourPosition: 2, className: 'Paid Assistant Class', priceCents: 3000, pricePer: 'students_and_staff' });
  const assistantId = await makeMember('Already Paid Assistant', 'charge-remove-paid');
  const accountId = await makeAccount(assistantId);
  await addStaff(classId, assistantId, 'assistant');

  const chargeId = await createCharge(assistantId, accountId, 'class_registration', classId, 'Paid Assistant Class - class registration', 3000);
  await db.prepare('UPDATE class_staff SET charge_id = ? WHERE class_id = ? AND member_id = ?').run(chargeId, classId, assistantId);
  await recordPayment(chargeId, 3000, 'manual', accountId, 'Test payment in full.');

  await removeStaff(classId, assistantId);

  const charge = await getCharge(chargeId);
  assert.equal(charge.status, 'paid', 'a fully-paid charge must not be silently cancelled just because staff was removed');
});

test('removeStaff is a no-op on the charge when the class_staff row never had one (an unpriced/students-only class)', async () => {
  const classId = await createClass({ day: 'monday', hourPosition: 3, className: 'Free Assistant Class' });
  const assistantId = await makeMember('No Charge Assistant', 'charge-remove-none');
  await addStaff(classId, assistantId, 'assistant');

  // Should not throw, and should still remove the row.
  await removeStaff(classId, assistantId);
  const row = await db.prepare('SELECT 1 FROM class_staff WHERE class_id = ? AND member_id = ?').get(classId, assistantId);
  assert.equal(row, undefined);
});
