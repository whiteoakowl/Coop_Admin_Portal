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
}

async function recordPayment(chargeId, amountCents, method, recordedByAccountId, note) {
  await db.prepare('INSERT INTO payment_payments (charge_id, amount_cents, method, recorded_by_account_id, note) VALUES (?, ?, ?, ?, ?)').run(chargeId, amountCents, method || 'manual', recordedByAccountId, note || null);
  await recalculateStatus(chargeId);
}

async function cancelCharge(chargeId) {
  await db.prepare("UPDATE payment_charges SET status = 'cancelled', updated_at = now_text() WHERE id = ?").run(chargeId);
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

async function receiptHistoryForMember(memberId) {
  return db
    .prepare(
      `SELECT p.*, c.description AS "chargeDescription" FROM payment_payments p
       JOIN payment_charges c ON c.id = p.charge_id
       WHERE c.member_id = ? ORDER BY p.created_at DESC`
    )
    .all(memberId);
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
  amountPaidForCharge,
  recordPayment,
  cancelCharge,
  chargesForMember,
  balanceForMember,
  receiptHistoryForMember,
  formatCents,
};
