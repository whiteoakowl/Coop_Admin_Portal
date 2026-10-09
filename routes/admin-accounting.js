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
const { formatTimestamp } = require('../utils/dates');

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
  let members = (await db.prepare('SELECT id, name, parked FROM members WHERE active = 1').all()).filter((m) => eligibleIds.has(m.id)).sort(byLastName);
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
    allMembers: await billableMembers(),
    notice: req.query.notice || null,
    error: req.query.error || null,
    formatCents: payments.formatCents,
  });
});

async function recipientAccountIdsForMembers(memberIds) {
  const accounts = await db.prepare("SELECT id, member_id FROM member_accounts WHERE status IN ('active', 'pending')").all();
  const accountIdsByMember = new Map();
  for (const a of accounts) {
    if (!accountIdsByMember.has(a.member_id)) accountIdsByMember.set(a.member_id, []);
    accountIdsByMember.get(a.member_id).push(a.id);
  }
  return memberIds.flatMap((id) => accountIdsByMember.get(id) || []);
}

router.get('/export.csv', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const rows = await accountRows(q);
  const lines = [
    toCsvRow(['Member', 'Email', 'Balance']),
    ...rows.map((m) => toCsvRow([m.name, m.email || '', payments.formatCents(m.balanceCents)])),
  ];
  sendCsv(res, 'accounting-accounts.csv', lines);
});

// A real request: "past due check box should be a button that says email
// all past due invoices" - the old "Email All Invoices" button's own
// behavior (only members who currently owe something), just renamed to
// say what it actually does and no longer tied to a filter checkbox.
router.post('/email-all-past-due-invoices', async (req, res) => {
  const rows = (await accountRows('')).filter((m) => m.balanceCents > 0);
  const recipientAccountIds = await recipientAccountIdsForMembers(rows.map((m) => m.id));
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

// A real request: "Email all invoices button will send all" - genuinely
// every billable member on the Accounts list below, not just the ones
// currently past due (that's Email All Past Due Invoices' own job now).
router.post('/email-all-invoices', async (req, res) => {
  const rows = await accountRows('');
  const recipientAccountIds = await recipientAccountIdsForMembers(rows.map((m) => m.id));
  if (!recipientAccountIds.length) {
    return res.redirect('/main-admin/accounting?notice=' + encodeURIComponent('No billable members yet - nothing to send.'));
  }
  await emailComposer.createAndSend({
    subject: 'Accounting Statement',
    bodyHtml: '<p>Visit the Accounting page in your portal for a full breakdown of your account.</p>',
    recipientAccountIds,
    sentByAccountId: req.portalAccount.id,
    sentByPortal: 'main_admin',
  });
  res.redirect('/main-admin/accounting?notice=' + encodeURIComponent(`Sent an accounting statement to ${recipientAccountIds.length} account(s).`));
});

// --- Categories (moved here from a modal dialog so it's a real subpage,
// same event_accounting_categories table/functions (utils/events.js) the
// Events Finance tab's own dropdown still reads from). ---

router.get('/categories', async (req, res) => {
  res.render('admin-accounting-categories', {
    title: 'Category/Fiscal Year',
    accountingCategories: await events.listAccountingCategories(),
    fiscalYears: await events.listFiscalYears(),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.post('/accounting-categories', async (req, res) => {
  const name = (req.body.name || '').trim();
  const code = (req.body.code || '').trim();
  if (!name) return res.redirect('/main-admin/accounting/categories?error=' + encodeURIComponent('Category title is required.'));
  await events.createAccountingCategory(name, code);
  res.redirect('/main-admin/accounting/categories?notice=' + encodeURIComponent('Accounting category added.'));
});

router.post('/accounting-categories/:id/update', async (req, res) => {
  const name = (req.body.name || '').trim();
  const code = (req.body.code || '').trim();
  if (!name) return res.redirect('/main-admin/accounting/categories?error=' + encodeURIComponent('Category title is required.'));
  await events.updateAccountingCategory(req.params.id, name, code);
  res.redirect('/main-admin/accounting/categories?notice=' + encodeURIComponent('Accounting category updated.'));
});

router.post('/accounting-categories/:id/delete', async (req, res) => {
  await events.deleteAccountingCategory(req.params.id);
  res.redirect('/main-admin/accounting/categories?notice=' + encodeURIComponent('Accounting category removed.'));
});

// --- Fiscal Years (same subpage - "Category/Fiscal Year"). ---

router.post('/fiscal-years', async (req, res) => {
  const startDate = (req.body.startDate || '').trim();
  const endDate = (req.body.endDate || '').trim();
  if (!startDate || !endDate) return res.redirect('/main-admin/accounting/categories?error=' + encodeURIComponent('Start date and end date are both required.'));
  await events.createFiscalYear(startDate, endDate);
  res.redirect('/main-admin/accounting/categories?notice=' + encodeURIComponent('Fiscal year added.'));
});

router.post('/fiscal-years/:id/delete', async (req, res) => {
  await events.deleteFiscalYear(req.params.id);
  res.redirect('/main-admin/accounting/categories?notice=' + encodeURIComponent('Fiscal year removed.'));
});

// --- Invoices (one row per existing payment_charges row - the answered
// design question). ---

const INVOICE_STATUSES = ['pending', 'paid', 'cancelled', 'refunded', 'partially_refunded'];

// "Family (read-only, 'Kalna, Kara')" (the reference screenshot) - the
// billed member's own name, "Last, First" rather than this app's usual
// stored "First Last", matching that screenshot exactly.
function familyLabel(name) {
  const parts = (name || '').trim().split(/\s+/);
  if (parts.length < 2) return name || '';
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(' ');
  return `${last}, ${first}`;
}

async function accountIdsForMember(memberId) {
  return (await db.prepare("SELECT id FROM member_accounts WHERE member_id = ? AND status IN ('active', 'pending')").all(memberId)).map((a) => a.id);
}

// "Email Family?" (the reference screenshot) - a real notification, not
// just a form choice that goes nowhere, reusing the same in-app
// notification abstraction every other email feature in this app already
// uses (utils/emailComposer.js).
async function emailFamilyAboutInvoice(memberId, description, amountCents, sentByAccountId) {
  const recipientAccountIds = await accountIdsForMember(memberId);
  if (!recipientAccountIds.length) return;
  await emailComposer.createAndSend({
    subject: 'New Invoice - ' + description,
    bodyHtml: `<p>A new invoice has been added to your account: <strong>${description}</strong> &mdash; ${payments.formatCents(amountCents)}. Visit the Accounting page in your portal for details.</p>`,
    recipientAccountIds,
    sentByAccountId,
    sentByPortal: 'main_admin',
  });
}

// "Creating an invoice should look exactly like the screenshot" - a real
// full page now (Family/Category/Date/Due Date/Auto-Park/Description/
// Admin Notes/Amount/+Split Invoice/Email Family), reached by picking a
// member first (same "which member?" pattern +Payment/+Adjustment on the
// Accounts page already use) rather than the old small "New Invoice"
// dialog (member+description+amount only).
router.get('/invoices/new', async (req, res) => {
  const memberId = Number(req.query.memberId);
  const member = memberId ? await db.prepare('SELECT id, name FROM members WHERE id = ?').get(memberId) : null;
  if (!member) return res.redirect('/main-admin/accounting/invoices?error=' + encodeURIComponent('Pick a member first.'));
  res.render('admin-accounting-invoice-form', {
    title: 'New Invoice',
    charge: null,
    member,
    familyLabel: familyLabel(member.name),
    categories: await events.listAccountingCategories(),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.get('/invoices/:id/edit', async (req, res) => {
  const charge = await payments.getCharge(req.params.id);
  if (!charge) return res.status(404).render('404', { title: 'Not Found' });
  const member = await db.prepare('SELECT id, name FROM members WHERE id = ?').get(charge.member_id);
  res.render('admin-accounting-invoice-form', {
    title: `Edit Invoice #${charge.id}`,
    charge,
    member,
    familyLabel: familyLabel(member.name),
    categories: await events.listAccountingCategories(),
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

// "+ Split Invoice" (the reference screenshot) - one or more additional
// description/amount line items beyond the form's own primary Description/
// Amount fields, all sharing the same member/category/dates/notes/auto-
// park/email choice. splitDescription[]/splitAmount[] are parallel arrays
// from the repeatable rows public/js/accounting-invoice-form.js adds.
function splitLineItems(body) {
  const descriptions = [].concat(body.splitDescription || []);
  const amounts = [].concat(body.splitAmount || []);
  const items = [];
  for (let i = 0; i < descriptions.length; i++) {
    const description = (descriptions[i] || '').trim();
    const amountCents = toCents(amounts[i]);
    if (description && amountCents > 0) items.push({ description, amountCents });
  }
  return items;
}

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
    return res.redirect(`/main-admin/accounting/invoices/new?memberId=${memberId}&error=` + encodeURIComponent('Description and a positive amount are required.'));
  }
  const details = {
    categoryId: req.body.categoryId ? Number(req.body.categoryId) : null,
    invoiceDate: (req.body.date || '').trim() || null,
    dueDate: (req.body.dueDate || '').trim() || null,
    adminNotes: (req.body.adminNotes || '').trim() || null,
    autoParkFamily: req.body.autoParkFamily === '1',
    emailFamily: req.body.emailFamily === 'yes',
  };
  const lineItems = [{ description, amountCents }, ...splitLineItems(req.body)];
  for (const item of lineItems) {
    const chargeId = await payments.createCharge(memberId, req.portalAccount.id, 'manual', null, item.description, item.amountCents);
    await payments.setChargeDetails(chargeId, details);
  }
  if (details.emailFamily) {
    const totalCents = lineItems.reduce((sum, i) => sum + i.amountCents, 0);
    await emailFamilyAboutInvoice(memberId, description, totalCents, req.portalAccount.id);
  }
  res.redirect('/main-admin/accounting/invoices?notice=' + encodeURIComponent(lineItems.length > 1 ? `${lineItems.length} invoices added.` : 'Invoice added.'));
});

router.post('/invoices/:id/update', async (req, res) => {
  const charge = await payments.getCharge(req.params.id);
  if (!charge) return res.status(404).render('404', { title: 'Not Found' });
  const description = (req.body.description || '').trim();
  const amountCents = toCents(req.body.amount);
  if (!description || amountCents <= 0) {
    return res.redirect(`/main-admin/accounting/invoices/${charge.id}/edit?error=` + encodeURIComponent('Description and a positive amount are required.'));
  }
  const details = {
    categoryId: req.body.categoryId ? Number(req.body.categoryId) : null,
    invoiceDate: (req.body.date || '').trim() || null,
    dueDate: (req.body.dueDate || '').trim() || null,
    adminNotes: (req.body.adminNotes || '').trim() || null,
    autoParkFamily: req.body.autoParkFamily === '1',
    emailFamily: req.body.emailFamily === 'yes',
  };
  await payments.updateCharge(charge.id, { description, amountCents, ...details });
  const extraItems = splitLineItems(req.body);
  for (const item of extraItems) {
    const chargeId = await payments.createCharge(charge.member_id, req.portalAccount.id, 'manual', null, item.description, item.amountCents);
    await payments.setChargeDetails(chargeId, details);
  }
  if (details.emailFamily) {
    await emailFamilyAboutInvoice(charge.member_id, description, amountCents, req.portalAccount.id);
  }
  res.redirect('/main-admin/accounting/invoices?notice=' + encodeURIComponent('Invoice updated.'));
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
  const entries = await auditLog.list({ targetType: 'payment_charge' });
  // A real request: "make sure all accounting dates are 9/12/2026,
  // 12:15pm" - same formatTimestamp label every other Accounting page now
  // uses (utils/payments.js's own dateLabel), applied here too since this
  // page reads audit_log rows directly rather than through that file.
  for (const e of entries) e.dateLabel = formatTimestamp(e.created_at);
  res.render('admin-accounting-logs', {
    title: 'Accounting Logs',
    entries,
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
  const member = await db.prepare('SELECT id, name, parked FROM members WHERE id = ?').get(req.params.memberId);
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
  await payments.recordPayment(charge.id, amountCents, 'manual', req.portalAccount.id, note, isRefund ? req.body.adjustmentType : null);
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
