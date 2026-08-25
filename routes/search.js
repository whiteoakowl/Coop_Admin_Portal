// Global Search (Community & Commerce track, item 14), mounted at
// /search (server.js). Members-only - genuinely last, per the handoff's
// own framing, and simplest to reason about permission-wise as a
// signed-in-only feature (most of what it searches is members-only
// anyway). See utils/globalSearch.js's own header comment for how
// permission-awareness is enforced (reusing each feature's own already-
// access-checked listing function, never re-deriving access rules here).
const express = require('express');
const router = express.Router();
const { requirePortalAuth } = require('../middleware/portalAuth');
const { familyForAccount } = require('../utils/portalAuth');
const globalSearch = require('../utils/globalSearch');

router.use(requirePortalAuth);

router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  let results = [];
  if (q) {
    const family = await familyForAccount(req.portalAccount.id);
    const roleIds = req.portalRoles.map((r) => r.id);
    results = await globalSearch.search(q, { family, roleIds });
  }
  res.render('search-results', { title: 'Search', q, results });
});

module.exports = router;
