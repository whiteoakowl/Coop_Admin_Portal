// Main Admin's Notification Type controls (Community & Commerce track,
// item 11) - mounted at /main-admin/notifications, gated the same as
// Newsletter (manage_communications). The only thing an admin controls
// here is auto_send_enabled per type - "admin control over which
// message types actually send automatically," per the handoff. The
// catalog of types itself is seeded from real callers (see
// supabase/migrations/20260825110000_notifications.sql), not editable
// here - a new type means a new real feature calling notify(), not a
// freeform admin-created row.
const express = require('express');
const router = express.Router();
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const notifications = require('../utils/notifications');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_communications'));

router.get('/', async (req, res) => {
  const types = await notifications.listTypes();
  res.render('admin-notifications', { title: 'Notifications', types, notice: req.query.notice || null });
});

router.post('/:key/auto-send', async (req, res) => {
  await notifications.setAutoSend(req.params.key, req.body.enabled === '1');
  res.redirect('/main-admin/notifications?notice=' + encodeURIComponent('Saved.'));
});

module.exports = router;
