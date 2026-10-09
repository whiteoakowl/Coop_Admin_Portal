// Accounting/Payments foundation (Community & Commerce track, item 9) -
// a payment ABSTRACTION, not a real payment processor integration. See
// supabase/migrations/20260825080000_payments_foundation.sql's own
// header comment for the full reasoning. Store (item 8) and Events'
// optional registration fee both create a charge through createCharge()
// rather than inventing their own "did they pay" flag.
const db = require('../db');

// `dbHandle` defaults to the module-level connection but must be passed
// explicitly as the transaction handle (`tx`) when called from inside
// db.withTransaction - the test suite's embedded PGlite engine has no
// connection pool, so a query against the outer `db` while a transaction
// on that same single connection is still open never returns (see
// utils/members.js's own generateMemberCode for the identical fix,
// written for this same class of bug).
async function createCharge(memberId, accountId, sourceType, sourceId, description, amountCents, dbHandle = db) {
  const info = await dbHandle
    .prepare('INSERT INTO payment_charges (member_id, account_id, source_type, source_id, description, amount_cents) VALUES (?, ?, ?, ?, ?, ?)')
    .run(memberId, accountId, sourceType, sourceId, description, amountCents);
  return info.lastInsertRowid;
}

async function getCharge(id) {
  return db.prepare('SELECT * FROM payment_charges WHERE id = ?').get(id);
}

// "Creating an invoice should look exactly like the screenshot" - the
// extra fields the screenshot's own form carries (Category, Due Date,
// Admin Notes, Auto-Park/Unpark) beyond what createCharge's own call
// sites elsewhere (store/event/class registration) ever pass. Kept as a
// separate call right after createCharge rather than widening that
// function's own positional signature, so every existing call site
// (utils/store.js, utils/events.js, utils/classRegistration.js) is
// untouched.
async function setChargeDetails(chargeId, { categoryId, invoiceDate, dueDate, adminNotes, autoParkFamily, emailFamily } = {}) {
  const sets = ['accounting_category_id = ?', 'due_date = ?', 'admin_notes = ?', 'auto_park_family = ?', 'email_family = ?', 'updated_at = now_text()'];
  const args = [categoryId || null, dueDate || null, adminNotes || null, autoParkFamily ? 1 : 0, emailFamily ? 1 : 0];
  if (invoiceDate) {
    sets.push('created_at = ?');
    args.push(invoiceDate);
  }
  await db.prepare(`UPDATE payment_charges SET ${sets.join(', ')} WHERE id = ?`).run(...args, chargeId);
  await recalculateParkedStatus((await getCharge(chargeId)).member_id);
}

// Same fields as setChargeDetails, plus description/amount - the Edit
// Invoice form's own Save (an existing charge, unlike createCharge's own
// "brand new row" case).
async function updateCharge(chargeId, { description, amountCents, categoryId, invoiceDate, dueDate, adminNotes, autoParkFamily, emailFamily } = {}) {
  const sets = ['description = ?', 'amount_cents = ?', 'accounting_category_id = ?', 'due_date = ?', 'admin_notes = ?', 'auto_park_family = ?', 'email_family = ?', 'updated_at = now_text()'];
  const args = [description, amountCents, categoryId || null, dueDate || null, adminNotes || null, autoParkFamily ? 1 : 0, emailFamily ? 1 : 0];
  if (invoiceDate) {
    sets.push('created_at = ?');
    args.push(invoiceDate);
  }
  await db.prepare(`UPDATE payment_charges SET ${sets.join(', ')} WHERE id = ?`).run(...args, chargeId);
  await recalculateParkedStatus((await getCharge(chargeId)).member_id);
}

// A real request: the invoice form's own "Auto-Park/Unpark Family if/when
// Unpaid/Paid?" checkbox. Scoped deliberately small: this only flips a
// visible badge (members.parked) on Accounting's own Accounts list/
// Account page - it doesn't block registration or portal access anywhere,
// which was never asked for. "Parked" means at least one of this
// member's own auto_park_family charges is still pending (unpaid) past
// its own due date; paying it off (or deleting/cancelling it) unparks
// them again, recomputed fresh every time rather than trusting a cached
// flag to stay right.
async function recalculateParkedStatus(memberId) {
  if (!memberId) return;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = await db
    .prepare("SELECT 1 FROM payment_charges WHERE member_id = ? AND status = 'pending' AND auto_park_family = true AND due_date IS NOT NULL AND due_date < ? LIMIT 1")
    .get(memberId, today);
  await db.prepare('UPDATE members SET parked = ? WHERE id = ?').run(!!overdue, memberId);
}

async function amountPaidForCharge(chargeId) {
  return Number((await db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payment_payments WHERE charge_id = ?').get(chargeId)).s);
}

// Recomputes and saves a charge's own status from its real payment rows
// - never set directly by a route. A charge already 'cancelled' stays
// cancelled regardless of what's been paid against it (a cancelled
// order/registration shouldn't flip back to "paid" just because a
// payment row exists for it - that payment is a refund waiting to
// happen, tracked, but the charge itself is done).
async function recalculateStatus(chargeId) {
  const charge = await getCharge(chargeId);
  if (!charge || charge.status === 'cancelled') return;
  const paid = await amountPaidForCharge(chargeId);
  // A refund row (any negative payment_payments amount) is what tells
  // "not yet paid" apart from "was paid, then refunded" - both can net
  // to the same running total otherwise.
  const hasRefund = await db.prepare('SELECT 1 FROM payment_payments WHERE charge_id = ? AND amount_cents < 0').get(chargeId);
  let status;
  if (paid >= charge.amount_cents) status = 'paid';
  else if (paid <= 0) status = hasRefund ? 'refunded' : 'pending';
  else status = hasRefund ? 'partially_refunded' : 'pending';
  await db.prepare('UPDATE payment_charges SET status = ?, updated_at = now_text() WHERE id = ?').run(status, chargeId);
  await recalculateParkedStatus(charge.member_id);
}

// A real request: "accounting adjustment categories refund, exemption,
// credit, discount." Only meaningful for a refund-direction row
// (amount_cents < 0) - null for a plain payment received.
const ADJUSTMENT_TYPES = ['refund', 'exemption', 'credit', 'discount'];

async function recordPayment(chargeId, amountCents, method, recordedByAccountId, note, adjustmentType) {
  const type = amountCents < 0 && ADJUSTMENT_TYPES.includes(adjustmentType) ? adjustmentType : null;
  await db
    .prepare('INSERT INTO payment_payments (charge_id, amount_cents, method, recorded_by_account_id, note, adjustment_type) VALUES (?, ?, ?, ?, ?, ?)')
    .run(chargeId, amountCents, method || 'manual', recordedByAccountId, note || null, type);
  await recalculateStatus(chargeId);
}

async function cancelCharge(chargeId) {
  const charge = await getCharge(chargeId);
  await db.prepare("UPDATE payment_charges SET status = 'cancelled', updated_at = now_text() WHERE id = ?").run(chargeId);
  if (charge) await recalculateParkedStatus(charge.member_id);
}

// A real request: "add a trash icon" to Invoices/Adjustments rows - a
// genuine delete, not another way to cancel. Safe to remove outright:
// payment_payments.charge_id is ON DELETE CASCADE (its own rows go with
// it), and every source record that can point at a charge
// (store_orders/class_registrations/event_registrations/class_staff)
// does so with ON DELETE SET NULL, so deleting a charge here just clears
// that link rather than breaking anything.
async function deleteCharge(chargeId) {
  const charge = await getCharge(chargeId);
  await db.prepare('DELETE FROM payment_charges WHERE id = ?').run(chargeId);
  if (charge) await recalculateParkedStatus(charge.member_id);
}

async function getPayment(id) {
  return db.prepare('SELECT * FROM payment_payments WHERE id = ?').get(id);
}

// A real request: "add a trash button" to Payments/Adjustments rows -
// removing a mis-recorded payment or refund. recalculateStatus afterward
// puts the charge's own status back to whatever its remaining real
// payment rows say it should be (e.g. a charge goes back to 'pending'
// once the payment that made it 'paid' is deleted).
async function deletePayment(id) {
  const payment = await getPayment(id);
  if (!payment) return null;
  await db.prepare('DELETE FROM payment_payments WHERE id = ?').run(id);
  await recalculateStatus(payment.charge_id);
  return payment;
}

async function chargesForMember(memberId) {
  const charges = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ? ORDER BY created_at DESC').all(memberId);
  for (const c of charges) c.amountPaid = await amountPaidForCharge(c.id);
  return charges;
}

// Net balance owed across every still-pending charge for a member -
// always summed live from real rows, never a cached running total. Only
// 'pending' charges ever contribute: 'paid' is already fully settled
// (nothing left owed by definition), and any charge touched by a refund
// ('refunded'/'partially_refunded') is being actively unwound by an
// admin, not re-billed - the refund itself is the resolution, tracked in
// receiptHistoryForMember(), not a reason to show a balance due again.
async function balanceForMember(memberId) {
  const charges = await db.prepare("SELECT id, amount_cents FROM payment_charges WHERE member_id = ? AND status = 'pending'").all(memberId);
  let owed = 0;
  for (const c of charges) {
    const paid = await amountPaidForCharge(c.id);
    owed += Math.max(0, c.amount_cents - paid);
  }
  return owed;
}

// Every charge across every member - Accounting's own Invoices subpage
// (one invoice per existing payment_charges row, per the answered design
// question: "one invoice per existing charge" rather than inventing a
// separate order/invoice table). `status` optionally narrows to one of
// payment_charges' own CHECK-constraint values.
async function allCharges(status) {
  const charges = status
    ? await db.prepare('SELECT c.*, m.name AS "memberName" FROM payment_charges c JOIN members m ON m.id = c.member_id WHERE c.status = ? ORDER BY c.created_at DESC').all(status)
    : await db.prepare('SELECT c.*, m.name AS "memberName" FROM payment_charges c JOIN members m ON m.id = c.member_id ORDER BY c.created_at DESC').all();
  for (const c of charges) c.amountPaid = await amountPaidForCharge(c.id);
  return charges;
}

// Every real payment/refund row across every member, for Accounting's own
// Payments and Adjustments subpages - "payments" (money actually
// received, amount_cents > 0) and "adjustments" (refunds/corrections,
// amount_cents < 0) read the exact same payment_payments table, just
// split by that sign the way recalculateStatus above already does to
// tell a refund apart from a payment.
async function allPayments(direction) {
  const cmp = direction === 'refund' ? '<' : '>';
  return db
    .prepare(
      `SELECT p.*, c.member_id AS "member_id", m.name AS "memberName", c.description AS "chargeDescription" FROM payment_payments p
       JOIN payment_charges c ON c.id = p.charge_id
       JOIN members m ON m.id = c.member_id
       WHERE p.amount_cents ${cmp} 0 ORDER BY p.created_at DESC`
    )
    .all();
}

// Every calendar year (newest first) a member has any charge or payment
// recorded in - backs the Account page's own "Current / All / a given
// year" filter dropdown (a real request). created_at is always
// now_text()'s own 'YYYY-MM-DD HH:MM:SS' shape, so slicing the first 4
// characters is a real year, not a guess.
async function yearsForMember(memberId) {
  const chargeYears = await db.prepare('SELECT DISTINCT substr(created_at, 1, 4) AS y FROM payment_charges WHERE member_id = ?').all(memberId);
  const paymentYears = await db
    .prepare('SELECT DISTINCT substr(p.created_at, 1, 4) AS y FROM payment_payments p JOIN payment_charges c ON c.id = p.charge_id WHERE c.member_id = ?')
    .all(memberId);
  const years = new Set([...chargeYears, ...paymentYears].map((r) => r.y));
  return [...years].sort((a, b) => b.localeCompare(a));
}

async function receiptHistoryForMember(memberId) {
  return db
    .prepare(
      `SELECT p.*, c.description AS "chargeDescription" FROM payment_payments p
       JOIN payment_charges c ON c.id = p.charge_id
       WHERE c.member_id = ? ORDER BY p.created_at DESC`
    )
    .all(memberId);
}

// The one member-level Account view (Invoices / Payments / Adjustments,
// Credits & Refunds, each narrowed by `yearFilter`) - shared by the Main
// Admin Account page and the member-facing /accounting page (a real
// request: "this will be the same account view on parent portal too"),
// so the two never drift. `yearFilter` is 'current' (default, this
// calendar year), 'all', or a 4-digit year string from yearsForMember.
async function accountOverviewForMember(memberId, yearFilter = 'current') {
  const currentYear = String(new Date().getFullYear());
  const inYear = (createdAt) => (yearFilter === 'all' ? true : createdAt.slice(0, 4) === (yearFilter === 'current' ? currentYear : yearFilter));

  const allCharges = await chargesForMember(memberId);
  const invoices = allCharges.filter((c) => inYear(c.created_at));
  const history = await receiptHistoryForMember(memberId);
  const paymentRows = history.filter((p) => p.amount_cents > 0 && inYear(p.created_at));
  const refundRows = history.filter((p) => p.amount_cents < 0 && inYear(p.created_at));
  const cancelledCharges = allCharges.filter((c) => c.status === 'cancelled' && inYear(c.created_at));

  return {
    invoices,
    paymentRows,
    refundRows,
    cancelledCharges,
    years: await yearsForMember(memberId),
    yearFilter,
    balanceCents: await balanceForMember(memberId),
  };
}

// The one place this app formats a cents integer as a dollar string -
// every view uses this rather than each rolling its own toFixed(2).
function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

module.exports = {
  createCharge,
  getCharge,
  setChargeDetails,
  updateCharge,
  recalculateParkedStatus,
  amountPaidForCharge,
  recordPayment,
  ADJUSTMENT_TYPES,
  cancelCharge,
  deleteCharge,
  getPayment,
  deletePayment,
  chargesForMember,
  balanceForMember,
  allCharges,
  allPayments,
  yearsForMember,
  receiptHistoryForMember,
  accountOverviewForMember,
  formatCents,
};
