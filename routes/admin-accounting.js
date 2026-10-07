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
const { byLastName } = require('../utils/members');
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

// --- Accounts (the original list - every member with a balance/charge
// history, plus a typed search that widens it to any active member). ---

// Every active member with a nonzero balance or any charge history at
// all - a member who's never had a charge doesn't clutter this list by
// default. A real request: "same row as search member there is a search
// bar for typing member name" - typing a name here (q) widens the list to
// every active member matching it, charge history or not, since the
// whole point of searching is also "to add a first charge for someone
// new" (the old version of this used a <select> of every member just for
// that; a typed search bar finds them the same way the rest of the site
// already searches members).
async function accountRows(q) {
  let members;
  if (q) {
    members = (await db.prepare('SELECT id, name FROM members WHERE active = 1').all()).filter((m) => m.name.toLowerCase().includes(q)).sort(byLastName);
  } else {
    members = (await db.prepare('SELECT id, name FROM members WHERE active = 1 AND id IN (SELECT DISTINCT member_id FROM payment_charges)').all()).sort(byLastName);
  }
  const emailByMember = new Map(
    (await db.prepare('SELECT member_id, email FROM member_accounts').all()).map((r) => [r.member_id, r.email])
  );
  const rows = [];
  for (const m of members) rows.push({ ...m, email: emailByMember.get(m.id) || null, balanceCents: await payments.balanceForMember(m.id) });
  return rows;
}

router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  res.render('admin-accounting-list', {
    title: 'Accounts',
    members: await accountRows(q),
    q: req.query.q || '',
    pastDueOnly: req.query.pastDueOnly === '1',
    allMembers: (await db.prepare('SELECT id, name FROM members WHERE active = 1').all()).sort(byLastName),
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
    allMembers: (await db.prepare('SELECT id, name FROM members WHERE active = 1').all()).sort(byLastName),
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

router.get('/members/:memberId', async (req, res) => {
  const member = await db.prepare('SELECT id, name FROM members WHERE id = ?').get(req.params.memberId);
  if (!member) return res.status(404).render('404', { title: 'Not Found' });
  const charges = await payments.chargesForMember(member.id);
  const balanceCents = await payments.balanceForMember(member.id);
  res.render('admin-accounting-member', {
    title: member.name,
    member,
    charges,
    balanceCents,
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
