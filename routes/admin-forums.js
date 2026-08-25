// Main Admin's Forum category management (Community & Commerce track,
// item 6) - mounted at /main-admin/forums (server.js). Structural setup
// only (create/lock/delete a category, including a private class forum);
// day-to-day thread/post moderation happens in-context on routes/
// forums.js itself, gated the same manage_forum permission but not tied
// to the Main Admin portal, since a teacher moderating their own class
// forum shouldn't need Main Admin access to do it.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const forums = require('../utils/forums');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_forum'));

router.get('/', async (req, res) => {
  const categories = await forums.listCategories();
  const classes = await db.prepare('SELECT id, class_name FROM classes ORDER BY LOWER(class_name)').all();
  res.render('admin-forums-list', { title: 'Forums', categories, classes, notice: req.query.notice || null, error: req.query.error || null });
});

router.post('/', async (req, res) => {
  const name = (req.body.name || '').trim();
  const scope = req.body.scope === 'class' ? 'class' : 'general';
  if (!name) return res.redirect('/main-admin/forums?error=' + encodeURIComponent('Name is required.'));
  if (scope === 'class' && !req.body.classId) return res.redirect('/main-admin/forums?error=' + encodeURIComponent('Choose a class for a private class forum.'));
  await forums.createCategory({ name, description: (req.body.description || '').trim(), scope, classId: req.body.classId ? parseInt(req.body.classId, 10) : null });
  res.redirect('/main-admin/forums?notice=' + encodeURIComponent('Forum created.'));
});

router.post('/:id/lock', async (req, res) => {
  await forums.setCategoryLocked(req.params.id, true);
  res.redirect('/main-admin/forums?notice=' + encodeURIComponent('Forum locked - only moderators can post new threads.'));
});

router.post('/:id/unlock', async (req, res) => {
  await forums.setCategoryLocked(req.params.id, false);
  res.redirect('/main-admin/forums?notice=' + encodeURIComponent('Forum unlocked.'));
});

router.post('/:id/delete', async (req, res) => {
  await forums.deleteCategory(req.params.id);
  res.redirect('/main-admin/forums?notice=' + encodeURIComponent('Forum deleted.'));
});

router.get('/moderation-log', async (req, res) => {
  const entries = await forums.moderationLog();
  res.render('admin-forums-log', { title: 'Forum Moderation Log', entries });
});

module.exports = router;
