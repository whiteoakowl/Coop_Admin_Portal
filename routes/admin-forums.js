// Main Admin's Forum category management (Community & Commerce track,
// item 6) - mounted at /main-admin/forums (server.js). Structural setup
// (create/lock/archive/delete a category, including a private class
// forum, plus the Moderate/Archive review tabs) AND, as of a later
// request, the admin-side thread/post browser itself (see the "Admin
// thread/post browsing" section below) - day-to-day thread/post
// moderation for MEMBERS still happens in-context on routes/forums.js,
// gated the same manage_forum permission but not tied to the Main Admin
// portal, since a teacher moderating their own class forum shouldn't
// need Main Admin access to do it.
//
// A real request: "main admin portal chat should have the tabs new chat,
// moderate, archive. under new there should be an add category button,
// click and there will be a clean rounded, well balanced and centered
// popup that allows you to add or delete categories." This app already
// calls a category a "chat" everywhere else (the old +New Chat dialog,
// the nav label itself) - so "add category" and "new chat" are the same
// action, now moved into the Resource-Links-style add/delete popup
// instead of its own one-off dialog. "Archive" is covered by
// utils/forums.js's own archivedThreads() comment.
//
// A later request redefined "Moderate": "Moderate tab should have a list
// of the chat categories. when you click each category it show a pop up
// of the category's name, description, check box - allow comments,
// checkboxes - select which section can view or all, dropdown menu to
// select member to moderate." This replaced the tab's old raw
// forum_moderation_actions log table (utils/forums.js's own
// moderationLog() - left in place, just no longer rendered here) with
// the category-settings list+popup below.
//
// A further real request: "add category button should say add chat
// group. subcategory tab should say chat groups. edit button should be
// on chat group page. no moderation tab/subpage." Dropped the Moderate
// tab entirely - its per-category settings popup (name/description/
// allow comments/sections/moderator) now lives behind an Edit button on
// the chat group's own page (admin-forums-category.ejs) instead, so
// there's only ever one place to reach it.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const forums = require('../utils/forums');
const { activeMemberOptions } = require('../utils/members');
const { forumCategorySectionIds } = require('../utils/sections');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_forum'));

const FORUMS_TABS = ['new', 'archive'];

router.get('/', async (req, res) => {
  const activeTab = FORUMS_TABS.includes(req.query.tab) ? req.query.tab : 'new';
  const notice = req.query.notice || null;
  const error = req.query.error || null;

  let categories = [];
  let classes = [];
  let archived = [];
  if (activeTab === 'new') {
    categories = await forums.listCategories();
    classes = await db.prepare('SELECT id, class_name FROM classes ORDER BY LOWER(class_name)').all();
  } else {
    archived = await forums.archivedThreads();
  }

  res.render('admin-forums-list', { title: 'Chat', activeTab, categories, classes, archived, notice, error });
});

router.post('/', async (req, res) => {
  const name = (req.body.name || '').trim();
  const scope = req.body.scope === 'class' ? 'class' : 'general';
  if (!name) return res.redirect('/main-admin/forums?error=' + encodeURIComponent('Name is required.'));
  if (scope === 'class' && !req.body.classId) return res.redirect('/main-admin/forums?error=' + encodeURIComponent('Choose a class for a private class chat.'));
  await forums.createCategory({ name, description: (req.body.description || '').trim(), scope, classId: req.body.classId ? parseInt(req.body.classId, 10) : null });
  res.redirect('/main-admin/forums?notice=' + encodeURIComponent('Chat group added.'));
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
  res.redirect('/main-admin/forums?notice=' + encodeURIComponent('Chat group deleted.'));
});

// The chat group page's own Edit popup - see this file's own header
// comment (used to be the removed Moderate tab's popup, same fields,
// just reached from the group's own page now).
router.post('/:id/settings', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect(`/main-admin/forums/${req.params.id}?error=` + encodeURIComponent('Name is required.'));
  const sectionIds = [].concat(req.body.sectionIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  await forums.updateCategorySettings(req.params.id, {
    name,
    description: (req.body.description || '').trim(),
    allowComments: req.body.allowComments === 'on',
    sectionIds,
    moderatorMemberId: req.body.moderatorMemberId ? parseInt(req.body.moderatorMemberId, 10) : null,
  });
  res.redirect(`/main-admin/forums/${req.params.id}?notice=` + encodeURIComponent('Chat group settings updated.'));
});

// Archive tab's own "restore" action - see archivedThreads()'s comment in
// utils/forums.js for why this is a thread-level, not category-level,
// operation. Namespaced under /threads/ so it can never collide with the
// category routes above, which all key off :id directly.
router.post('/threads/:threadId/unarchive', async (req, res) => {
  await forums.setThreadArchived(req.params.threadId, false, req.portalAccount.id);
  res.redirect('/main-admin/forums?tab=archive&notice=' + encodeURIComponent('Chat restored from archive.'));
});

// --- Admin thread/post browsing ---
// A real request: "when you click on the chat category it should open an
// admin view of the threads in that category. for some reason it goes to
// the student portal, it should stay in the main admin portal. admin
// chat category view shows a list of each thread to click on to read
// with an archive button at the end. admin can click on each thread to
// read the post and comments. trash and edit button next to each post
// and comment for admin to edit." The New tab's category cards used to
// link straight to /forums/:id - the member-facing router (routes/
// forums.js), which picks its own portal chrome off the account's own
// portalRoles and can land on Student Portal's nav for an account that
// also holds a student role, regardless of where the admin actually
// navigated from. These routes give Main Admin its own dedicated,
// always-Main-Admin-chrome thread browser instead, reusing utils/forums.js
// exactly like routes/forums.js does - manage_forum (required for this
// whole router, see router.use above) already covers every action here,
// there's no separate per-category moderator check the way routes/
// forums.js needs (a Main Admin came through the gate above already).
router.get('/:id', async (req, res) => {
  const category = await forums.getCategory(req.params.id);
  if (!category) return res.status(404).render('404', { title: 'Not Found' });
  const threads = await forums.listThreads(category.id);
  // Feeds the page's own Edit popup (this file's own header comment) -
  // the same name/description/allow comments/sections/moderator fields
  // the removed Moderate tab used to edit.
  const allSections = await db.prepare('SELECT * FROM sections ORDER BY LOWER(name)').all();
  const members = await activeMemberOptions();
  const sectionIds = await forumCategorySectionIds(category.id);
  res.render('admin-forums-category', {
    title: category.name,
    category,
    threads,
    allSections,
    members,
    sectionIds,
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

router.get('/threads/:threadId', async (req, res) => {
  const thread = await forums.getThread(req.params.threadId);
  if (!thread) return res.status(404).render('404', { title: 'Not Found' });
  const category = await forums.getCategory(thread.category_id);
  const posts = await forums.listPosts(thread.id);
  res.render('admin-forums-thread', { title: thread.title, category, thread, posts, error: req.query.error || null });
});

router.post('/threads/:threadId/archive', async (req, res) => {
  const thread = await forums.getThread(req.params.threadId);
  await forums.setThreadArchived(req.params.threadId, true, req.portalAccount.id);
  res.redirect(thread ? `/main-admin/forums/${thread.category_id}` : '/main-admin/forums');
});

router.post('/threads/:threadId/posts/:postId/remove', async (req, res) => {
  await forums.removePost(req.params.postId, req.portalAccount.id);
  res.redirect(`/main-admin/forums/threads/${req.params.threadId}`);
});

router.post('/threads/:threadId/posts/:postId/restore', async (req, res) => {
  await forums.restorePost(req.params.postId, req.portalAccount.id);
  res.redirect(`/main-admin/forums/threads/${req.params.threadId}`);
});

router.post('/threads/:threadId/posts/:postId/edit', async (req, res) => {
  const body = (req.body.body || '').trim();
  if (!body) return res.redirect(`/main-admin/forums/threads/${req.params.threadId}?error=` + encodeURIComponent('A message is required.'));
  await forums.editPost(req.params.postId, body);
  await forums.logEdit(req.portalAccount.id, req.params.postId);
  res.redirect(`/main-admin/forums/threads/${req.params.threadId}`);
});

module.exports = router;
