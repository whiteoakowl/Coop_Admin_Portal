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
const notificationTemplates = require('../utils/notificationTemplates');
const auditLog = require('../utils/auditLog');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_communications'));

router.get('/', async (req, res) => {
  const types = await notifications.listTypes();
  // A real request: "Add a text/email notification settings card. There
  // you can change the default message for different things like
  // floater assignments, class wait list, event waitlist, event
  // registration, class registration, etc." - same page as the existing
  // per-type auto-send on/off table above (this page had no link into
  // it from anywhere before this - the Settings hub card added for this
  // feature is its first real entry point).
  const templates = await notificationTemplates.allTemplates();
  res.render('admin-notifications', { title: 'Notifications', types, templates, notice: req.query.notice || null });
});

router.post('/:key/auto-send', async (req, res) => {
  const enabled = req.body.enabled === '1';
  await notifications.setAutoSend(req.params.key, enabled);
  await auditLog.record(req.portalAccount.id, 'notification_auto_send_toggled', 'notification_type', null, `${req.params.key}: ${enabled ? 'on' : 'off'}`);
  res.redirect('/main-admin/notifications?notice=' + encodeURIComponent('Saved.'));
});

router.post('/templates/:templateKey', async (req, res) => {
  if (!notificationTemplates.TEMPLATE_DEFINITIONS[req.params.templateKey]) return res.status(404).send('Not found');
  await notificationTemplates.updateTemplate(req.params.templateKey, req.body.subject || '', req.body.body || '');
  await auditLog.record(req.portalAccount.id, 'notification_message_template_updated', 'notification_message_template', null, req.params.templateKey);
  res.redirect('/main-admin/notifications?notice=' + encodeURIComponent('Message saved.'));
});

module.exports = router;
