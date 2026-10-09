// Main Admin's Accounting/Payments management (Community & Commerce
// track, item 9) - mounted at /main-admin/accounting (server.js), gated
// by manage_finances (already pre-seeded in db/bootstrapPg.js's own
// PORTAL_PERMISSIONS catalog). Recording a payment here is the ONLY
// place money ever "moves" in this app - there is no real payment
// processor integration, so every payment is an admin typing in what
// actually happened outside the app (cash handed over, a check
// deposited, a Venmo received).
//
// A real request added 7 subpages under this one feature - Accounts (the
// original list, below), Categories, Invoices, Payments, Adjustments,
// Logs, Settings - each its own real route (not ?tab= on one shared
// page), same shape as routes/main-admin-announcements.js's own
// Announcements/Email/Text. "Invoices" is one row per existing
// payment_charges row (the answered design question: "one invoice per
// existing charge" rather than a new order/invoice table); "Payments"
// and "Adjustments" both read payment_payments, just split by the sign
// payments.recalculateStatus already uses to tell a refund apart from a
// real payment; "Logs" reads the SAME audit_log rows
// routes/admin-audit-log.js's own Audit Log already writes (target_type
// 'payment_charge'), just pre-filtered to this one feature instead of
// making an admin pick that filter themselves; "Settings" is the one
// genuinely new small feature (a configurable Payment Methods list for
// the Record Payment dialog's own method dropdown, stored in the generic
// app_settings key/value table - no new schema needed).
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const payments = require('../utils/payments');
const auditLog = require('../utils/auditLog');
const { byLastName, primaryParentForBilling } = require('../utils/members');
const events = require('../utils/events');
const emailComposer = require('../utils/emailComposer');
const { appSetting, setAppSetting } = require('../utils/appSettings');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_finances'));

function toCents(dollarsString) {
  const n = Number(dollarsString);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const DEFAULT_PAYMENT_METHODS = ['Cash', 'Check', 'Venmo', 'Zelle', 'Other'];
async function paymentMethods() {
  const raw = await appSetting('accounting_payment_methods', null);
  if (!raw) return DEFAULT_PAYMENT_METHODS;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_PAYMENT_METHODS;
  } catch {
    return DEFAULT_PAYMENT_METHODS;
  }
}

// --- Accounts (the original list - every member who could actually be
// billed, plus a typed search that widens it to any of them). ---

// A real request: "primary parent is the only member listed on all
// account pages. Only primary parent is billed for all event signups and
// class registrations for the entire family." Every charge now resolves
// to a member's own primaryParentForBilling (utils/members.js), so a
// child or secondary parent never carries a real balance of their own -
// listing them here would just be a confusing, always-$0 account.
// Computed by resolving EVERY active member's own billed-to id and
// keeping only the members that id actually lands on (a family's real
// primary parent if one's designated, otherwise whichever parent/admin in
// it is used as the fallback, or the member themselves if they're not in
// a family/have no parent at all) - same resolution a real charge would
// use, rather than trusting the is_primary_parent flag alone and missing
// that fallback case.
async function billedMemberIds() {
  const allMembers = await db.prepare('SELECT id FROM members WHERE active = 1').all();
  const ids = new Set();
  for (const m of allMembers) ids.add(await primaryParentForBilling(m.id));
  return ids;
}

async function accountRows(q) {
  const eligibleIds = await billedMemberIds();
  let members = (await db.prepare('SELECT id, name FROM members WHERE active = 1').all()).filter((m) => eligibleIds.has(m.id)).sort(byLastName);
  if (q) {
    members = members.filter((m) => m.name.toLowerCase().includes(q));
  }
  const emailByMember = new Map(
    (await db.prepare('SELECT member_id, email FROM member_accounts').all()).map((r) => [r.member_id, r.email])
  );
  const rows = [];
  for (const m of members) rows.push({ ...m, email: emailByMember.get(m.id) || null, balanceCents: await payments.balanceForMember(m.id) });
  return rows;
}

async function billableMembers() {
  const eligibleIds = await billedMemberIds();
  return (await db.prepare('SELECT id, name FROM members WHERE active = 1').all()).filter((m) => eligibleIds.has(m.id)).sort(byLastName);
}

router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  res.render('admin-accounting-list', {
    title: 'Accounts',
    members: await accountRows(q),
    q: req.query.q || '',
    pastDueOnly: req.query.pastDueOnly === '1',
    allMembers: await billableMembers(),
    notice: req.query.notice || null,
    error: req.query.error || null,
    formatCents: payments.formatCents,
  });
});

router.get('/export.csv', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const rows = await accountRows(q);
  const lines = [
    toCsvRow(['Member', 'Email', 'Balance']),
    ...rows.map((m) => toCsvRow([m.name, m.email || '', payments.formatCents(m.balanceCents)])),
  ];
  sendCsv(res, 'accounting-accounts.csv', lines);
});

// A real request: "email all invoices" - a one-click reminder to every
// member who currently owes something, reusing utils/emailComposer.js's
// own createAndSend (the SAME "no real outbound SMTP, just an in-app
// notification + a logged campaign" abstraction every other email/text
// feature in this app already uses - see that module's own header).
router.post('/email-all-invoices', async (req, res) => {
  const rows = (await accountRows('')).filter((m) => m.balanceCents > 0);
  const accounts = await db.prepare('SELECT id, member_id FROM member_accounts WHERE status IN (\'active\', \'pending\')').all();
  const accountIdsByMember = new Map();
  for (const a of accounts) {
    if (!accountIdsByMember.has(a.member_id)) accountIdsByMember.set(a.member_id, []);
    accountIdsByMember.get(a.member_id).push(a.id);
  }
  const recipientAccountIds = rows.flatMap((m) => accountIdsByMember.get(m.id) || []);
  if (!recipientAccountIds.length) {
    return res.redirect('/main-admin/accounting?notice=' + encodeURIComponent('No members currently have a balance due - nothing to send.'));
  }
  await emailComposer.createAndSend({
    subject: 'Accounting Statement - Balance Due',
    bodyHtml: '<p>You have an outstanding balance on your account. Visit the Accounting page in your portal for a full breakdown of what’s owed.</p>',
    recipientAccountIds,
    sentByAccountId: req.portalAccount.id,
    sentByPortal: 'main_admin',
  });
  res.redirect('/main-admin/accounting?notice=' + encodeURIComponent(`Sent a balance-due reminder to ${recipientAccountIds.length} account(s).`));
});

// --- Categories (moved here from a modal dialog so it's a real subpage,
// same event_accounting_categories table/functions (utils/events.js) the
// Events Finance tab's own dropdown still reads from). ---

router.get('/categories', async (req, res) => {
  res.render('admin-accounting-categories', {
    title: 'Accounting Categories',
    accountingCategories: await events.listAccountingCategories(),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.post('/accounting-categories', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/accounting/categories?error=' + encodeURIComponent('Accounting category name is required.'));
  await events.createAccountingCategory(name);
  res.redirect('/main-admin/accounting/categories?notice=' + encodeURIComponent('Accounting category added.'));
});

router.post('/accounting-categories/:id/update', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/accounting/categories?error=' + encodeURIComponent('Accounting category name is required.'));
  await events.updateAccountingCategory(req.params.id, name);
  res.redirect('/main-admin/accounting/categories?notice=' + encodeURIComponent('Accounting category updated.'));
});

router.post('/accounting-categories/:id/delete', async (req, res) => {
  await events.deleteAccountingCategory(req.params.id);
  res.redirect('/main-admin/accounting/categories?notice=' + encodeURIComponent('Accounting category removed.'));
});

// --- Invoices (one row per existing payment_charges row - the answered
// design question). ---

const INVOICE_STATUSES = ['pending', 'paid', 'cancelled', 'refunded', 'partially_refunded'];

router.get('/invoices', async (req, res) => {
  const status = INVOICE_STATUSES.includes(req.query.status) ? req.query.status : '';
  let invoices = await payments.allCharges(status || undefined);
  const memberId = req.query.memberId ? Number(req.query.memberId) : null;
  if (memberId) invoices = invoices.filter((c) => c.member_id === memberId);
  res.render('admin-accounting-invoices', {
    title: 'Invoices',
    invoices,
    status,
    memberId,
    allMembers: await billableMembers(),
    notice: req.query.notice || null,
    error: req.query.error || null,
    formatCents: payments.formatCents,
  });
});

router.post('/invoices', async (req, res) => {
  const memberId = Number(req.body.memberId);
  const description = (req.body.description || '').trim();
  const amountCents = toCents(req.body.amount);
  if (!memberId || !description || amountCents <= 0) {
    return res.redirect('/main-admin/accounting/invoices?error=' + encodeURIComponent('Member, description, and a positive amount are required.'));
  }
  await payments.createCharge(memberId, req.portalAccount.id, 'manual', null, description, amountCents);
  res.redirect('/main-admin/accounting/invoices?notice=' + encodeURIComponent('Invoice added.'));
});

// A real request: "add a trash icon at the end of each row" (Invoices),
// also reused by Adjustments' own Cancelled Charges rows (`back`
// decides which subpage to return to).
router.post('/invoices/:id/delete', async (req, res) => {
  const charge = await payments.getCharge(req.params.id);
  if (!charge) return res.status(404).render('404', { title: 'Not Found' });
  const memberId = charge.member_id;
  await payments.deleteCharge(charge.id);
  await auditLog.record(req.portalAccount.id, 'charge_deleted', 'payment_charge', charge.id, charge.description);
  const back =
    req.body.back === 'adjustments' ? '/main-admin/accounting/adjustments' : req.body.back === 'member' ? `/main-admin/accounting/members/${memberId}` : '/main-admin/accounting/invoices';
  res.redirect(back + '?notice=' + encodeURIComponent('Invoice deleted.'));
});

// --- Payments (payment_payments rows with amount_cents > 0 - money
// actually received). ---

router.get('/payments', async (req, res) => {
  res.render('admin-accounting-payments', {
    title: 'Payments',
    rows: await payments.allPayments('payment'),
    notice: req.query.notice || null,
    error: req.query.error || null,
    formatCents: payments.formatCents,
  });
});

// A real request: "add a trash button" (Payments), also reused by
// Adjustments' own Refunds rows (`back` decides which subpage to return
// to) - both read/write the same payment_payments table.
router.post('/payments/:id/delete', async (req, res) => {
  const payment = await payments.getPayment(req.params.id);
  if (!payment) return res.status(404).render('404', { title: 'Not Found' });
  const isRefund = payment.amount_cents < 0;
  const charge = await payments.getCharge(payment.charge_id);
  await payments.deletePayment(payment.id);
  await auditLog.record(req.portalAccount.id, isRefund ? 'refund_deleted' : 'payment_deleted', 'payment_charge', payment.charge_id, payments.formatCents(Math.abs(payment.amount_cents)));
  const back =
    req.body.back === 'adjustments'
      ? '/main-admin/accounting/adjustments'
      : req.body.back === 'member'
        ? `/main-admin/accounting/members/${charge ? charge.member_id : ''}`
        : '/main-admin/accounting/payments';
  res.redirect(back + '?notice=' + encodeURIComponent(isRefund ? 'Refund deleted.' : 'Payment deleted.'));
});

// --- Adjustments (payment_payments rows with amount_cents < 0 - refunds
// and corrections - plus cancelled charges, both ways a charge's
// original bill gets walked back after the fact). ---

router.get('/adjustments', async (req, res) => {
  const refunds = await payments.allPayments('refund');
  const cancelled = await payments.allCharges('cancelled');
  res.render('admin-accounting-adjustments', {
    title: 'Adjustments',
    refunds,
    cancelled,
    notice: req.query.notice || null,
    error: req.query.error || null,
    formatCents: payments.formatCents,
  });
});

// --- Logs (the same audit_log rows Main Admin's own Audit Log already
// writes - routes/admin-audit-log.js - pre-filtered to this feature's own
// target_type). ---

router.get('/logs', async (req, res) => {
  res.render('admin-accounting-logs', {
    title: 'Accounting Logs',
    entries: await auditLog.list({ targetType: 'payment_charge' }),
  });
});

// --- Settings (Payment Methods - the Record Payment dialog's own method
// dropdown reads this list instead of a hardcoded 'manual'). ---

router.get('/settings', async (req, res) => {
  res.render('admin-accounting-settings', {
    title: 'Accounting Settings',
    methods: await paymentMethods(),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.post('/settings/payment-methods', async (req, res) => {
  const names = (req.body.methods || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) return res.redirect('/main-admin/accounting/settings?error=' + encodeURIComponent('At least one payment method is required.'));
  await setAppSetting('accounting_payment_methods', JSON.stringify(names));
  res.redirect('/main-admin/accounting/settings?notice=' + encodeURIComponent('Payment methods updated.'));
});

// --- A single member's own account (charges/payments) - unchanged
// routes, just now reachable from several subpages above instead of only
// the Accounts list. ---

// A real request: "first table shows invoices, 2nd table shows
// payments, 3rd table shows adjustments, credits and refunds. Filter
// dropdown to view which account year. Current, all or the individual
// years for accounting." year is 'current' (default, this calendar
// year), 'all', or a 4-digit year string from payments.yearsForMember.
router.get('/members/:memberId', async (req, res) => {
  const member = await db.prepare('SELECT id, name FROM members WHERE id = ?').get(req.params.memberId);
  if (!member) return res.status(404).render('404', { title: 'Not Found' });
  const overview = await payments.accountOverviewForMember(member.id, req.query.year || 'current');

  res.render('admin-accounting-member', {
    title: member.name,
    member,
    ...overview,
    autoprint: req.query.autoprint === '1',
    methods: await paymentMethods(),
    notice: req.query.notice || null,
    error: req.query.error || null,
    formatCents: payments.formatCents,
  });
});

router.post('/members/:memberId/charges', async (req, res) => {
  const description = (req.body.description || '').trim();
  const amountCents = toCents(req.body.amount);
  if (!description || amountCents <= 0) {
    return res.redirect(`/main-admin/accounting/members/${req.params.memberId}?error=` + encodeURIComponent('Description and a positive amount are required.'));
  }
  await payments.createCharge(req.params.memberId, req.portalAccount.id, 'manual', null, description, amountCents);
  res.redirect(`/main-admin/accounting/members/${req.params.memberId}?notice=` + encodeURIComponent('Charge added.'));
});

router.post('/charges/:id/payments', async (req, res) => {
  const charge = await payments.getCharge(req.params.id);
  if (!charge) return res.status(404).render('404', { title: 'Not Found' });
  const isRefund = req.body.direction === 'refund';
  const amountCents = toCents(req.body.amount) * (isRefund ? -1 : 1);
  if (amountCents === 0) {
    return res.redirect(`/main-admin/accounting/members/${charge.member_id}?error=` + encodeURIComponent('Enter a nonzero amount.'));
  }
  // payment_payments.method is a real DB CHECK constraint (manual vs. a
  // future stripe_placeholder - the payment PATHWAY, never "Cash" vs.
  // "Venmo"), so Settings' own configurable Payment Methods list (how
  // the money actually arrived) folds into the free-text note instead -
  // this still reaches the audit trail/receipt history exactly where an
  // admin would look for it, just without inventing a schema change for
  // what amounts to a label on the same note field.
  const methodLabel = (req.body.method || '').trim();
  const note = [methodLabel, (req.body.note || '').trim()].filter(Boolean).join(' - ');
  await payments.recordPayment(charge.id, amountCents, 'manual', req.portalAccount.id, note);
  await auditLog.record(req.portalAccount.id, isRefund ? 'refund_recorded' : 'payment_recorded', 'payment_charge', charge.id, `${payments.formatCents(Math.abs(amountCents))}${note ? ' - ' + note : ''}`);
  res.redirect(`/main-admin/accounting/members/${charge.member_id}?notice=` + encodeURIComponent(isRefund ? 'Refund recorded.' : 'Payment recorded.'));
});

router.post('/charges/:id/cancel', async (req, res) => {
  const charge = await payments.getCharge(req.params.id);
  if (!charge) return res.status(404).render('404', { title: 'Not Found' });
  await payments.cancelCharge(charge.id);
  await auditLog.record(req.portalAccount.id, 'charge_cancelled', 'payment_charge', charge.id, charge.description);
  res.redirect(`/main-admin/accounting/members/${charge.member_id}?notice=` + encodeURIComponent('Charge cancelled.'));
});

module.exports = router;
