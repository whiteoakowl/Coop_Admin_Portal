// Main Admin's own read-back view of what Contact Admins (routes/
// contact-admins.js) actually collects - nothing previously rendered the
// contact_admin_messages table at all, so a message had no way to actually
// be seen once submitted. Mounted at /main-admin/contact-admin-messages
// (server.js), gated the same way admin-newsletter.js already is
// (manage_communications - a department inbox is a communications
// concern, not a membership one).
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_communications'));

router.get('/', async (req, res) => {
  const showArchived = req.query.archived === '1';
  const messages = await db
    .prepare(
      `SELECT * FROM contact_admin_messages WHERE archived = ? ORDER BY created_at DESC`
    )
    .all(showArchived ? 1 : 0);
  res.render('admin-contact-admin-messages', {
    title: 'Contact Admin Messages',
    messages,
    showArchived,
    notice: req.query.notice || null,
  });
});

router.post('/:id/archive', async (req, res) => {
  await db.prepare('UPDATE contact_admin_messages SET archived = 1 WHERE id = ?').run(req.params.id);
  res.redirect('/main-admin/contact-admin-messages?notice=' + encodeURIComponent('Message archived.'));
});

router.post('/:id/unarchive', async (req, res) => {
  await db.prepare('UPDATE contact_admin_messages SET archived = 0 WHERE id = ?').run(req.params.id);
  res.redirect('/main-admin/contact-admin-messages?archived=1&notice=' + encodeURIComponent('Message restored.'));
});

module.exports = router;
