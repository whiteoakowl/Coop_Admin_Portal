// Main Admin's Accounting/Payments management (Community & Commerce
// track, item 9) - mounted at /main-admin/accounting (server.js), gated
// by manage_finances (already pre-seeded in db/bootstrapPg.js's own
// PORTAL_PERMISSIONS catalog). Recording a payment here is the ONLY
// place money ever "moves" in this app - there is no real payment
// processor integration, so every payment is an admin typing in what
// actually happened outside the app (cash handed over, a check
// deposited, a Venmo received).
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const payments = require('../utils/payments');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_finances'));

function toCents(dollarsString) {
  const n = Number(dollarsString);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// Every active member with a nonzero balance or any charge history at
// all - a member who's never had a charge doesn't clutter this list.
router.get('/', async (req, res) => {
  const members = await db.prepare("SELECT id, name FROM members WHERE active = 1 AND id IN (SELECT DISTINCT member_id FROM payment_charges) ORDER BY LOWER(name)").all();
  const rows = [];
  for (const m of members) rows.push({ ...m, balanceCents: await payments.balanceForMember(m.id) });
  const allMembers = await db.prepare('SELECT id, name FROM members WHERE active = 1 ORDER BY LOWER(name)').all();
  res.render('admin-accounting-list', { title: 'Accounting', members: rows, allMembers, notice: req.query.notice || null, formatCents: payments.formatCents });
});

router.get('/members/:memberId', async (req, res) => {
  const member = await db.prepare('SELECT id, name FROM members WHERE id = ?').get(req.params.memberId);
  if (!member) return res.status(404).render('404', { title: 'Not Found' });
  const charges = await payments.chargesForMember(member.id);
  const balanceCents = await payments.balanceForMember(member.id);
  res.render('admin-accounting-member', { title: member.name, member, charges, balanceCents, notice: req.query.notice || null, error: req.query.error || null, formatCents: payments.formatCents });
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
  await payments.recordPayment(charge.id, amountCents, 'manual', req.portalAccount.id, (req.body.note || '').trim());
  res.redirect(`/main-admin/accounting/members/${charge.member_id}?notice=` + encodeURIComponent(isRefund ? 'Refund recorded.' : 'Payment recorded.'));
});

router.post('/charges/:id/cancel', async (req, res) => {
  const charge = await payments.getCharge(req.params.id);
  if (!charge) return res.status(404).render('404', { title: 'Not Found' });
  await payments.cancelCharge(charge.id);
  res.redirect(`/main-admin/accounting/members/${charge.member_id}?notice=` + encodeURIComponent('Charge cancelled.'));
});

module.exports = router;
