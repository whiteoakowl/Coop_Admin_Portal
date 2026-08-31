// Shared class-registration logic (register/cancel a student into a
// class, with waitlist + capacity + section-restriction + pricing/charge
// + cancellation policy) - a real request extended this beyond Parent
// Portal (the only place a parent could register a child) to also let a
// student register themselves once a class's own allow_student_register
// is turned on. Rather than duplicate this whole transaction in both
// routes/parent-portal.js and routes/student-portal.js, both call these
// two functions - `allowField` is which of the class's own
// allow_parent_register/allow_student_register columns gates that
// particular caller (a parent registering a child checks the former, a
// student registering themselves checks the latter; teacher/assistant
// self-signup is a different flow entirely - class_staff, not
// class_registrations - see routes/teacher-portal.js).
const db = require('../db');
const { sectionIdsForMember, classSectionIds, memberSatisfiesRestriction } = require('./sections');
const { ageGroupList } = require('./classSchedule');
const { createCharge, amountPaidForCharge, cancelCharge, recordPayment } = require('./payments');
const { isRegistrationOpenForAccount } = require('./registrationWindows');
const notifications = require('./notifications');

// Creates the payment_charges row for a student who just became
// 'confirmed' in a priced class - shared by both the initial registration
// and waitlist promotion (a promoted registration owes money starting
// now, exactly the same as registering straight into an open seat would
// have), so neither path can silently skip billing. Returns null for an
// unpriced class. Must be called with the open transaction handle (`tx`)
// - see createCharge's own comment on why.
//
// price_per no longer has a 'family' option (siblings sharing one
// charge) - that behavior turned out to be an EVENTS-only concept that
// had leaked onto the class pricing form; classes always bill each
// enrolled student their own separate charge now. price_per instead
// controls whether a teacher/assistant who signs up ALSO gets charged
// (see routes/teacher-portal.js's own join route) - 'students' vs
// 'students_and_staff'.
async function chargeForConfirmedRegistration(tx, cls, student, accountId) {
  if (cls.price_cents == null) return null;
  return createCharge(student.id, accountId, 'class_registration', cls.id, `${cls.class_name} - class registration`, cls.price_cents, tx);
}

// { ok: false, error } or { ok: true, notice, status, waitlistPosition }
async function registerForClass({ classId, studentId, accountId, portalRoles, allowField }) {
  const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls || !cls.registration_open) return { ok: false, error: 'Registration is not open for that class.' };
  if (!cls[allowField]) return { ok: false, error: 'Registration is not open for that class yet.' };
  if (!(await isRegistrationOpenForAccount(portalRoles))) return { ok: false, error: 'Registration is not open for your account yet.' };

  const restriction = await classSectionIds(classId);
  if (restriction.length && !memberSatisfiesRestriction(await sectionIdsForMember(studentId), restriction)) {
    return { ok: false, error: 'This class is limited to specific sections you are not part of.' };
  }
  const alreadyEnrolled = await db.prepare('SELECT 1 FROM class_enrollments WHERE class_id = ? AND student_id = ?').get(classId, studentId);
  if (alreadyEnrolled) return { ok: false, error: 'Already registered for that class.' };
  const alreadyWaitlisted = await db
    .prepare("SELECT 1 FROM class_registrations WHERE class_id = ? AND student_id = ? AND status = 'waitlisted'")
    .get(classId, studentId);
  if (alreadyWaitlisted) return { ok: false, error: 'Already on the waitlist for that class.' };

  const student = await db.prepare('SELECT * FROM members WHERE id = ?').get(studentId);
  // classes.age_group was previously display-only (the "Grade Kindergarten"/
  // "Grades 1-3" label shown everywhere a class is listed) - never actually
  // enforced here, so nothing stopped a wrong-grade student from being
  // registered straight through this route. A real request - "list the
  // appropriate age/grade students... that you can sign up" - only makes
  // sense if a mismatched one genuinely can't register, not just isn't
  // shown by whichever UI happens to filter for it, so this closes that gap
  // the same way section restriction just above already does.
  const allowedGrades = ageGroupList(cls.age_group);
  if (allowedGrades.length && !allowedGrades.includes(student.grade_level)) {
    return { ok: false, error: `${student.name} isn't in an eligible grade level for this class.` };
  }
  const enrolledCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM class_enrollments WHERE class_id = ?').get(classId)).c);
  const isFull = cls.capacity != null && enrolledCount >= cls.capacity;
  const status = isFull ? 'waitlisted' : 'confirmed';
  let waitlistPosition = null;

  await db.withTransaction(async (tx) => {
    let chargeId = null;
    if (status === 'confirmed') {
      chargeId = await chargeForConfirmedRegistration(tx, cls, student, accountId);
    }

    if (status === 'waitlisted') {
      const existingWaitlisted = Number((await tx.prepare("SELECT COUNT(*) AS c FROM class_registrations WHERE class_id = ? AND status = 'waitlisted'").get(classId)).c);
      waitlistPosition = existingWaitlisted + 1;
    }

    await tx
      .prepare('INSERT INTO class_registrations (class_id, student_id, registered_by_account_id, status, waitlist_position, charge_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(classId, studentId, accountId, status, waitlistPosition, chargeId);
    if (status === 'confirmed') {
      await tx.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(classId, studentId);
    }
  });

  const notice =
    status === 'confirmed'
      ? `${student.name} is registered for "${cls.class_name}".`
      : `${cls.class_name} is full - ${student.name} has been added to the waitlist (#${waitlistPosition}).`;
  return { ok: true, notice, status, waitlistPosition };
}

// Settles a cancelled registration's own charge: nothing paid yet clears
// the charge outright; something already paid only gets refunded if the
// class's own auto_refund_on_cancel is on (a real negative
// payment_payments row - utils/payments.js's own recordPayment); a paid-
// and-not-auto-refunded charge is left exactly as-is, for a Main Admin to
// handle by hand under a different policy.
async function settleChargeOnCancel(cls, chargeId, accountId) {
  if (!chargeId) return;
  const paid = await amountPaidForCharge(chargeId);
  if (paid <= 0) {
    await cancelCharge(chargeId);
  } else if (cls.auto_refund_on_cancel) {
    await recordPayment(chargeId, -paid, 'manual', accountId, 'Automatic refund: class registration cancelled.');
  }
}

// Promotes the earliest-waitlisted registration for a class to confirmed
// (a seat just opened up) and shifts every waitlisted registration behind
// it up by one position. No-ops (returns null) if nobody's waitlisted.
// Returns who to notify rather than notifying directly - notify() queries
// through the module-level db, which deadlocks the test suite's single
// PGlite connection if called from inside an open transaction (see
// utils/members.js's generateMemberCode for the same class of bug) - the
// caller notifies once the transaction has actually committed.
async function promoteNextWaitlisted(tx, classId) {
  const next = await tx
    .prepare("SELECT * FROM class_registrations WHERE class_id = ? AND status = 'waitlisted' ORDER BY waitlist_position ASC LIMIT 1")
    .get(classId);
  if (!next) return null;

  const cls = await tx.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  const student = await tx.prepare('SELECT * FROM members WHERE id = ?').get(next.student_id);
  // A promoted registration owes money starting now, same as registering
  // straight into an open seat would have - see chargeForConfirmedRegistration.
  const chargeId = await chargeForConfirmedRegistration(tx, cls, student, next.registered_by_account_id);

  await tx.prepare("UPDATE class_registrations SET status = 'confirmed', waitlist_position = NULL, charge_id = ? WHERE id = ?").run(chargeId, next.id);
  await tx.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(classId, next.student_id);
  await tx
    .prepare("UPDATE class_registrations SET waitlist_position = waitlist_position - 1 WHERE class_id = ? AND status = 'waitlisted' AND waitlist_position > ?")
    .run(classId, next.waitlist_position);

  return { accountId: next.registered_by_account_id, studentName: student.name };
}

// { ok: false, error } or { ok: true }
async function unregisterFromClass({ classId, studentId, accountId }) {
  const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (cls && !cls.allow_cancel) return { ok: false, error: 'Cancellation is not allowed for that class - contact an admin.' };

  const registration = await db
    .prepare("SELECT * FROM class_registrations WHERE class_id = ? AND student_id = ? AND status IN ('confirmed', 'waitlisted') ORDER BY id DESC LIMIT 1")
    .get(classId, studentId);

  let promoted = null;
  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM class_enrollments WHERE class_id = ? AND student_id = ?').run(classId, studentId);
    await tx
      .prepare("UPDATE class_registrations SET status = 'cancelled', cancelled_at = now_text() WHERE class_id = ? AND student_id = ? AND status IN ('confirmed', 'waitlisted')")
      .run(classId, studentId);

    if (registration && registration.status === 'waitlisted' && registration.waitlist_position != null) {
      await tx
        .prepare("UPDATE class_registrations SET waitlist_position = waitlist_position - 1 WHERE class_id = ? AND status = 'waitlisted' AND waitlist_position > ?")
        .run(classId, registration.waitlist_position);
    }
    if (registration && registration.status === 'confirmed') {
      promoted = await promoteNextWaitlisted(tx, classId);
    }
  });

  if (registration && registration.charge_id) {
    await settleChargeOnCancel(cls, registration.charge_id, accountId);
  }
  if (promoted) {
    await notifications.notify(promoted.accountId, 'class_waitlist_promoted', {
      title: `Off the waitlist: ${cls.class_name}`,
      body: `A spot opened up - ${promoted.studentName} is now confirmed for "${cls.class_name}".`,
      linkUrl: '/parent/classes',
    });
  }

  return { ok: true };
}

module.exports = { registerForClass, unregisterFromClass };
