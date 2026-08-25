// Main Admin's Audit Log (Community & Commerce track, item 13) - mounted
// at /main-admin/audit-log, gated by view_audit_log (a new permission -
// separate from every action it records, since who did what financially
// or moderation-wise is more sensitive than any single feature's own
// management permission). Read-only - entries are never edited or
// deleted here, only ever written by utils/auditLog.js's record() from
// the admin routes that actually performed the audited action.
const express = require('express');
const router = express.Router();
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const auditLog = require('../utils/auditLog');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('view_audit_log'));

router.get('/', async (req, res) => {
  const targetType = req.query.targetType || null;
  const entries = await auditLog.list({ targetType });
  const targetTypes = await auditLog.targetTypes();
  res.render('admin-audit-log', { title: 'Audit Log', entries, targetTypes, targetType });
});

module.exports = router;
