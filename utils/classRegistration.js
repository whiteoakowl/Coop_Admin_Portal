// Shared class-registration logic (register/cancel a student into a
// class, with waitlist + capacity + section-restriction + pricing/charge
// + cancellation policy) - a real request extended this beyond Parent
// Portal (the only place a parent could register a child) to also let a
// student register themselves. Rather than duplicate this whole
// transaction in both routes/parent-portal.js and routes/student-
// portal.js, both call these functions - `registrantType` ('parent' or
// 'student') is who's registering, since only the parent path checks the
// Co-op Class Settings' own global enableParentVolunteerRegistration
// switch (teacher/assistant self-signup is a different flow entirely -
// class_staff, not class_registrations - see routes/teacher-portal.js,
// which checks the same global switch itself).
//
// A real request rebuilt the old per-class Settings tab: "we can
// schedule members to register through the timed settings [Registration
// Schedule] now - delete [allow_parent_register/allow_teacher_register/
// allow_student_register/allow_cancel] completely." Registration
// eligibility is now just: the class's own registration_open (Class
// Details' own Close Registration checkbox), Registration Schedule's
// role-scoped windows (isRegistrationOpenForAccount), the global
// Enable Parent/Volunteer Registration switch for the parent path only,
// and the Co-op Class Settings' own global Cancellation Policy in place
// of the old per-class allow_cancel.
const db = require('../db');
const { sectionIdsForMember, classSectionIds, memberSatisfiesRestriction } = require('./sections');
const { ageGroupList, classGlobalSettings } = require('./classSchedule');
const { ageAsOfDate, todayISO } = require('./dates');
const { createCharge, amountPaidForCharge, cancelCharge, recordPayment } = require('./payments');
const { isRegistrationOpenForAccount } = require('./registrationWindows');
const notifications = require('./notifications');

// Co-op Class Settings' own "When a class is restricted by age(s)"
// setting: either the class's own start date, or a fixed Month/Day
// cutoff applied in the calendar year of the class's own start date (the
// "academic year to which the class is assigned") - falls back to today
// if the class has no start date at all, so age restriction still works
// for a class nobody's put dates on yet.
function ageReferenceDateForClass(cls, settings) {
  if (settings.ageRestrictionMode === 'fixed_date' && cls.start_date) {
    const year = cls.start_date.slice(0, 4);
    const month = String(settings.ageRestrictionMonth).padStart(2, '0');
    const day = String(settings.ageRestrictionDay).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return cls.start_date || todayISO();
}

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
async function registerForClass({ classId, studentId, accountId, portalRoles, registrantType }) {
  const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls || !cls.registration_open) return { ok: false, error: 'Registration is not open for that class.' };

  const settings = await classGlobalSettings();
  if (registrantType === 'parent' && !settings.enableParentVolunteerRegistration) {
    return { ok: false, error: 'Parent registration is not enabled right now.' };
  }

  const restriction = await classSectionIds(classId);
  if (!(await isRegistrationOpenForAccount(portalRoles, { day: cls.day, sectionIds: restriction }))) {
    return { ok: false, error: 'Registration is not open for your account yet.' };
  }
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
  // A real request: "grade and age should have a checkbox that says lock
  // class by grade or lock class by age" - grade and age were previously
  // always BOTH enforced together whenever either was selected; these
  // two independent toggles (default on, preserving that old behavior)
  // let an admin choose which selection actually gates registration for
  // a given class, e.g. showing an age range for information only while
  // registration only checks grade.
  const allowedGrades = ageGroupList(cls.age_group);
  if (cls.lock_by_grade && allowedGrades.length && !allowedGrades.includes(student.grade_level)) {
    return { ok: false, error: `${student.name} isn't in an eligible grade level for this class.` };
  }
  // A real request: "grade selection and age selection should be
  // separate menus of choices" - an independent numeric-age restriction
  // alongside the grade one above, same "only restricts if non-empty,
  // both gates must pass" shape utils/events.js's own ageGroupAllowsMember/
  // ageBucketAllowsMember pair already uses.
  const allowedAges = ageGroupList(cls.numeric_ages);
  if (cls.lock_by_age && allowedAges.length) {
    const age = ageAsOfDate(student.birthday, ageReferenceDateForClass(cls, settings));
    if (age == null || !allowedAges.includes(String(age))) {
      return { ok: false, error: `${student.name} isn't an eligible age for this class.` };
    }
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
// relevant Co-op Class Settings credit-adjustment switch is on (a real
// negative payment_payments row - utils/payments.js's own
// recordPayment); a paid-and-not-auto-refunded charge is left exactly
// as-is, for a Main Admin to handle by hand under a different policy.
// A real request folded the old per-class auto_refund_on_cancel into two
// GLOBAL settings instead, split by who removed the student - "When
// students are removed from a class by PARENT or when class is
// cancelled by SYSTEM..." vs "...for any reason by ADMIN" - see
// adminRemoveStudentFromClass below for the admin-initiated path.
async function settleChargeOnCancel(chargeId, accountId, autoCredit) {
  if (!chargeId) return;
  const paid = await amountPaidForCharge(chargeId);
  if (paid <= 0) {
    await cancelCharge(chargeId);
  } else if (autoCredit) {
    await recordPayment(chargeId, -paid, 'manual', accountId, 'Automatic credit adjustment: class registration removed.');
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

// A real request replaced the old per-class allow_cancel checkbox with a
// global cancellation-window policy, matching a similar co-op class
// management product's own "Allow families to cancel class
// registrations" setting: Through the End of the Class (any time up to
// end_date, or always if the class has no end_date), Only Prior to the
// Class Start Date, or Never.
function cancellationAllowed(cls, policy) {
  if (policy === 'never') return false;
  const today = todayISO();
  if (policy === 'before_start') return !cls.start_date || today < cls.start_date;
  return !cls.end_date || today <= cls.end_date; // 'through_end' (default)
}

// { ok: false, error } or { ok: true }
async function unregisterFromClass({ classId, studentId, accountId }) {
  const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  const settings = await classGlobalSettings();
  if (cls && !cancellationAllowed(cls, settings.cancellationPolicy)) {
    return { ok: false, error: 'Cancellation is not allowed for that class - contact an admin.' };
  }

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
    await settleChargeOnCancel(registration.charge_id, accountId, settings.autoCreditOnParentOrSystemRemoval);
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

// A real request: "when students are removed from a class... or a class
// is cancelled or deleted for any reason by ADMIN" gets its own, separate
// credit-adjustment setting from the parent/system path above. Co-op
// Admin's own roster-removal route (routes/admin-class-schedule.js) still
// does the actual enrollment removal itself (setEnrollment - it has its
// own roster/floater-sync side effects this doesn't need to duplicate);
// this only handles the class_registrations/billing side of it, the same
// bookkeeping unregisterFromClass already does for a parent's own
// cancellation, which setEnrollment alone never touched.
async function adminRemoveStudentFromClass(classId, studentId, adminAccountId) {
  const registration = await db
    .prepare("SELECT * FROM class_registrations WHERE class_id = ? AND student_id = ? AND status IN ('confirmed', 'waitlisted') ORDER BY id DESC LIMIT 1")
    .get(classId, studentId);
  if (!registration) return;

  let promoted = null;
  await db.withTransaction(async (tx) => {
    await tx.prepare("UPDATE class_registrations SET status = 'cancelled', cancelled_at = now_text() WHERE id = ?").run(registration.id);
    if (registration.status === 'waitlisted' && registration.waitlist_position != null) {
      await tx
        .prepare("UPDATE class_registrations SET waitlist_position = waitlist_position - 1 WHERE class_id = ? AND status = 'waitlisted' AND waitlist_position > ?")
        .run(classId, registration.waitlist_position);
    }
    if (registration.status === 'confirmed') {
      promoted = await promoteNextWaitlisted(tx, classId);
    }
  });

  if (registration.charge_id) {
    const settings = await classGlobalSettings();
    await settleChargeOnCancel(registration.charge_id, adminAccountId, settings.autoCreditOnAdminRemoval);
  }
  if (promoted) {
    const cls = await db.prepare('SELECT class_name FROM classes WHERE id = ?').get(classId);
    await notifications.notify(promoted.accountId, 'class_waitlist_promoted', {
      title: `Off the waitlist: ${cls.class_name}`,
      body: `A spot opened up - ${promoted.studentName} is now confirmed for "${cls.class_name}".`,
      linkUrl: '/parent/classes',
    });
  }
}

module.exports = { registerForClass, unregisterFromClass, adminRemoveStudentFromClass };
