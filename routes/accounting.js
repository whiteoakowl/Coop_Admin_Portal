// Member-facing Accounting (Community & Commerce track, item 9), mounted
// at /accounting (server.js). Would naturally live as a tab inside the
// Parent Portal, but routes/parent-portal.js and views/parent-*.ejs are
// on Track A's hard-boundary list - a sibling top-level page instead,
// same reasoning as Member Directory/Forums/Custom Forms. Open to any
// signed-in portal account, not just parents, since a student or any
// other role's family could carry a charge too (an event registration
// fee, a store order).
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth } = require('../middleware/portalAuth');
const { memberForAccount } = require('../utils/portalAuth');
const { primaryParentForBilling } = require('../utils/members');
const payments = require('../utils/payments');

router.use(requirePortalAuth);

// A real request: "this will be the same account view on parent portal
// too" - same Invoices/Payments/Adjustments tables and year filter as
// the Main Admin Account page (utils/payments.js's own
// accountOverviewForMember), just read-only and always scoped to this
// account's own family. Only the family's primaryParentForBilling ever
// carries a real charge now ("only primary parent is billed... for the
// entire family"), so there's exactly one account to show here, not one
// per family member.
// A real request: "total for payments, invoices and adjustments should
// be bottom right of each of those sections" - summed over exactly the
// rows shown (already narrowed to the picked yearFilter).
function sumCents(rows, field) {
  return rows.reduce((sum, r) => sum + Math.abs(r[field]), 0);
}

router.get('/', async (req, res) => {
  const self = await memberForAccount(req.portalAccount.id);
  const member = self ? await db.prepare('SELECT * FROM members WHERE id = ?').get(await primaryParentForBilling(self.id)) : null;
  const overview = member ? await payments.accountOverviewForMember(member.id, req.query.year || 'current') : null;
  res.render('accounting-home', {
    title: 'Accounting',
    member,
    ...(overview || {}),
    invoicesTotalCents: overview ? sumCents(overview.invoices, 'amount_cents') : 0,
    paymentsTotalCents: overview ? sumCents(overview.paymentRows, 'amount_cents') : 0,
    adjustmentsTotalCents: overview ? sumCents(overview.refundRows, 'amount_cents') + sumCents(overview.cancelledCharges, 'amount_cents') : 0,
    formatCents: payments.formatCents,
  });
});

module.exports = router;
