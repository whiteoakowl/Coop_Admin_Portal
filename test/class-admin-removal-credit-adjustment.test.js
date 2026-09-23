// A real follow-up answer to the Co-op Class Settings rebuild folded the
// old per-class Auto-Refund on Cancel into two GLOBAL credit-adjustment
// settings split by who removed the student: "When a student is removed
// from a class by a parent, or a class is cancelled automatically..." vs
// "...by an admin." Co-op Admin's own roster-removal route had NO
// refund/billing logic at all before this (unlike the parent-initiated
// cancel path) - this covers the new adminRemoveStudentFromClass, which
// settles the class_registrations/charge bookkeeping the same way
// unregisterFromClass already does for a parent, just gated by the
// autoCreditOnAdminRemoval setting instead of autoCreditOnParentOrSystemRemoval.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-admin-removal-credit-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-admin-removal-credit-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, saveClassGlobalSettings } = require('../utils/classSchedule');
const { adminRemoveStudentFromClass } = require('../utils/classRegistration');
const { createCharge, getCharge, amountPaidForCharge, recordPayment } = require('../utils/payments');

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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function makeStudentWithPaidRegistration(classId, priceCents) {
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`Admin Removal Family ${classId}`)).id;
  const parentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES ('Admin Removal Parent', ?, 'parent', ?, 1, 1) RETURNING id")
      .get(`admin-removal-parent-${classId}`, familyId)
  ).id;
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Admin Removal Student', ?, 'student', ?, 1) RETURNING id")
      .get(`admin-removal-student-${classId}`, familyId)
  ).id;
  const accountId = (
    await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, ?, 'x', 'active') RETURNING id")
      .get(parentId, `admin-removal-${classId}@test.local`)
  ).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, studentId);
  const chargeId = await createCharge(studentId, accountId, 'class_registration', classId, 'Admin Removal Class - class registration', priceCents);
  await recordPayment(chargeId, priceCents, 'manual', accountId, 'Test payment in full.');
  const registrationId = (
    await db.prepare(
      "INSERT INTO class_registrations (class_id, student_id, registered_by_account_id, status, charge_id) VALUES (?, ?, ?, 'confirmed', ?) RETURNING id"
    ).get(classId, studentId, accountId, chargeId)
  ).id;
  return { studentId, accountId, chargeId, registrationId };
}

test('adminRemoveStudentFromClass leaves a paid charge untouched when autoCreditOnAdminRemoval is off (the default)', async () => {
  await saveClassGlobalSettings({ autoCreditOnAdminRemoval: false, autoCreditOnParentOrSystemRemoval: true });
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Admin Removal No Credit Class', priceCents: 2000 });
  const { studentId, chargeId, registrationId } = await makeStudentWithPaidRegistration(classId, 2000);

  await adminRemoveStudentFromClass(classId, studentId, null);

  const charge = await getCharge(chargeId);
  assert.equal(await amountPaidForCharge(chargeId), 2000, 'the payment should not be credited back when the admin setting is off');
  assert.equal(charge.status, 'paid');
  const registration = await db.prepare('SELECT * FROM class_registrations WHERE id = ?').get(registrationId);
  assert.equal(registration.status, 'cancelled');
});

test('adminRemoveStudentFromClass automatically credits a paid charge when autoCreditOnAdminRemoval is on', async () => {
  await saveClassGlobalSettings({ autoCreditOnAdminRemoval: true, autoCreditOnParentOrSystemRemoval: false });
  const classId = await createClass({ day: 'monday', hourPosition: 2, className: 'Admin Removal Credit Class', priceCents: 1500 });
  const { studentId, chargeId, registrationId } = await makeStudentWithPaidRegistration(classId, 1500);

  await adminRemoveStudentFromClass(classId, studentId, null);

  assert.equal(await amountPaidForCharge(chargeId), 0, 'the payment should be automatically credited back');
  const registration = await db.prepare('SELECT * FROM class_registrations WHERE id = ?').get(registrationId);
  assert.equal(registration.status, 'cancelled');
});

test('the roster-removal route wires adminRemoveStudentFromClass in, using the global admin credit setting (not the parent/system one)', async () => {
  const admin = await loginAsAdmin();
  await saveClassGlobalSettings({ autoCreditOnAdminRemoval: true, autoCreditOnParentOrSystemRemoval: false });
  const classId = await createClass({ day: 'monday', hourPosition: 3, className: 'Roster Remove Route Class', priceCents: 1000 });
  const { studentId, chargeId } = await makeStudentWithPaidRegistration(classId, 1000);

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/enrollment/${studentId}/remove`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });
  assert.equal(res.status, 302);

  assert.equal(await amountPaidForCharge(chargeId), 0, 'removing via the admin roster route should apply the same auto-credit setting');
  const enrollment = await db.prepare('SELECT 1 FROM class_enrollments WHERE class_id = ? AND student_id = ?').get(classId, studentId);
  assert.equal(enrollment, undefined, 'the roster removal itself should still happen via setEnrollment');
});
