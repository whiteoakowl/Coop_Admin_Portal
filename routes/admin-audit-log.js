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
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE } = require('../utils/pagination');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('view_audit_log'));

router.get('/', async (req, res) => {
  const targetType = req.query.targetType || null;
  // limit: null - every matching entry, not just the most recent 200 -
  // paginate() below slices it at render time instead (see utils/
  // pagination.js's own header comment on why that's the right layer
  // for this, not a second SQL round-trip with its own LIMIT/OFFSET).
  const allEntries = await auditLog.list({ targetType, limit: null });
  const targetTypes = await auditLog.targetTypes();
  const pageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  const pagination = paginate(allEntries, parsePage(req.query.page), pageSize);
  res.render('admin-audit-log', {
    title: 'Audit Log',
    entries: pagination.items,
    pagination,
    viewingAll: pageSize === Infinity,
    baseHref: `/main-admin/audit-log?${targetType ? `targetType=${encodeURIComponent(targetType)}&` : ''}`,
    targetTypes,
    targetType,
  });
});

module.exports = router;
