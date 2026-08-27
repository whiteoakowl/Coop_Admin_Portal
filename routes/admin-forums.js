// Main Admin's Forum category management (Community & Commerce track,
// item 6) - mounted at /main-admin/forums (server.js). Structural setup
// only (create/lock/archive/delete a category, including a private class
// forum, plus the Moderate/Archive review tabs); day-to-day thread/post
// moderation happens in-context on routes/forums.js itself, gated the
// same manage_forum permission but not tied to the Main Admin portal,
// since a teacher moderating their own class forum shouldn't need Main
// Admin access to do it.
//
// A real request: "main admin portal chat should have the tabs new chat,
// moderate, archive. under new there should be an add category button,
// click and there will be a clean rounded, well balanced and centered
// popup that allows you to add or delete categories." This app already
// calls a category a "chat" everywhere else (the old +New Chat dialog,
// the nav label itself) - so "add category" and "new chat" are the same
// action, now moved into the Resource-Links-style add/delete popup
// instead of its own one-off dialog. "Moderate" folds in what used to be
// the separate /moderation-log page; "Archive" is covered by
// utils/forums.js's own archivedThreads() comment.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const forums = require('../utils/forums');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_forum'));

const FORUMS_TABS = ['new', 'moderate', 'archive'];

router.get('/', async (req, res) => {
  const activeTab = FORUMS_TABS.includes(req.query.tab) ? req.query.tab : 'new';
  const notice = req.query.notice || null;
  const error = req.query.error || null;

  let categories = [];
  let classes = [];
  let moderationEntries = [];
  let archived = [];
  if (activeTab === 'new') {
    categories = await forums.listCategories();
    classes = await db.prepare('SELECT id, class_name FROM classes ORDER BY LOWER(class_name)').all();
  } else if (activeTab === 'moderate') {
    moderationEntries = await forums.moderationLog();
  } else {
    archived = await forums.archivedThreads();
  }

  res.render('admin-forums-list', { title: 'Chat', activeTab, categories, classes, moderationEntries, archived, notice, error });
});

router.post('/', async (req, res) => {
  const name = (req.body.name || '').trim();
  const scope = req.body.scope === 'class' ? 'class' : 'general';
  if (!name) return res.redirect('/main-admin/forums?error=' + encodeURIComponent('Name is required.'));
  if (scope === 'class' && !req.body.classId) return res.redirect('/main-admin/forums?error=' + encodeURIComponent('Choose a class for a private class chat.'));
  await forums.createCategory({ name, description: (req.body.description || '').trim(), scope, classId: req.body.classId ? parseInt(req.body.classId, 10) : null });
  res.redirect('/main-admin/forums?notice=' + encodeURIComponent('Category added.'));
});

router.post('/:id/lock', async (req, res) => {
  await forums.setCategoryLocked(req.params.id, true);
  res.redirect('/main-admin/forums?notice=' + encodeURIComponent('Chat locked - only moderators can post new threads.'));
});

router.post('/:id/unlock', async (req, res) => {
  await forums.setCategoryLocked(req.params.id, false);
  res.redirect('/main-admin/forums?notice=' + encodeURIComponent('Chat unlocked.'));
});

router.post('/:id/delete', async (req, res) => {
  await forums.deleteCategory(req.params.id);
  res.redirect('/main-admin/forums?notice=' + encodeURIComponent('Category deleted.'));
});

// Archive tab's own "restore" action - see archivedThreads()'s comment in
// utils/forums.js for why this is a thread-level, not category-level,
// operation. Namespaced under /threads/ so it can never collide with the
// category routes above, which all key off :id directly.
router.post('/threads/:threadId/unarchive', async (req, res) => {
  await forums.setThreadArchived(req.params.threadId, false, req.portalAccount.id);
  res.redirect('/main-admin/forums?tab=archive&notice=' + encodeURIComponent('Chat restored from archive.'));
});

module.exports = router;
