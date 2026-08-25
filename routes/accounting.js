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
const { requirePortalAuth } = require('../middleware/portalAuth');
const { familyForAccount } = require('../utils/portalAuth');
const payments = require('../utils/payments');

router.use(requirePortalAuth);

router.get('/', async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  const members = [];
  for (const m of family) {
    members.push({
      member: m,
      balanceCents: await payments.balanceForMember(m.id),
      charges: await payments.chargesForMember(m.id),
      receipts: await payments.receiptHistoryForMember(m.id),
    });
  }
  res.render('accounting-home', { title: 'Accounting', members, formatCents: payments.formatCents });
});

module.exports = router;
