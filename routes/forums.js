// Member-facing Forums (Community & Commerce track, item 6), mounted at
// /forums (server.js). Members-only for every route - no public option,
// same reasoning as Member Directory. A 'class' category is additionally
// restricted to that class's own teacher/assistants/enrolled students/
// their parents, and any category can ALSO be restricted to specific
// Sections (utils/forums.js's canAccessCategory) - checked on every route
// that touches a category or thread, not just the listing page, so a
// direct URL to a private class thread can't bypass it.
//
// Moderation (edit-any/remove/lock/pin/archive/move) lives in this same
// router rather than a separate admin-only one, gated per-action by
// EITHER req.portalPermissions.has('manage_forum') (can be granted to any
// role - a teacher moderating their own class forum, a coop_admin, not
// just Main Admin, matching how Main Admin's own Roles & Permissions
// screen already treats permissions as independent of portal) OR being
// the one member Main Admin Chat's own Moderate tab assigned to
// moderate THIS specific category (utils/forums.js's own
// isCategoryModerator) - e.g. a parent volunteer moderating a single
// interest-group chat without needing a sitewide permission grant.
// Category management (create/lock/delete/moderator assignment) is Main
// Admin-only structural setup and lives in routes/admin-forums.js
// instead.
const express = require('express');
const router = express.Router();
const { requirePortalAuth } = require('../middleware/portalAuth');
const { memberForAccount, familyForAccount } = require('../utils/portalAuth');
const forums = require('../utils/forums');
const notifications = require('../utils/notifications');

router.use(requirePortalAuth);

async function canModerate(req) {
  if (req.portalPermissions.has('manage_forum')) return true;
  if (!req.category) return false;
  const self = await memberForAccount(req.portalAccount.id);
  return forums.isCategoryModerator(req.category, self ? self.id : null);
}

// Loads req.category (verifying it exists and the account's family can
// access it) and req.family for every route that needs either - the
// single place category-access denial happens, so no individual route
// can forget to re-check it.
async function loadCategory(req, res, next) {
  const category = await forums.getCategory(req.params.categoryId);
  if (!category) return res.status(404).render('404', { title: 'Not Found' });
  const family = await familyForAccount(req.portalAccount.id);
  if (!(await forums.canAccessCategory(category, family))) {
    return res.status(403).render('403', { title: 'Not Authorized', message: "You don't have access to this chat.", backHref: '/forums', backLabel: 'Back to Chat' });
  }
  req.category = category;
  req.family = family;
  next();
}

// Same as loadCategory, but starting from a thread id - loads the
// thread's own category and re-runs the identical access check.
async function loadThread(req, res, next) {
  const thread = await forums.getThread(req.params.threadId);
  if (!thread) return res.status(404).render('404', { title: 'Not Found' });
  const category = await forums.getCategory(thread.category_id);
  const family = await familyForAccount(req.portalAccount.id);
  if (!(await forums.canAccessCategory(category, family))) {
    return res.status(403).render('403', { title: 'Not Authorized', message: "You don't have access to this chat.", backHref: '/forums', backLabel: 'Back to Chat' });
  }
  req.thread = thread;
  req.category = category;
  next();
}

router.get('/', async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  const categories = await forums.accessibleCategories(family);
  res.render('forums-list', { title: 'Chat', categories });
});

router.get('/:categoryId', loadCategory, async (req, res) => {
  const threads = await forums.listThreads(req.category.id);
  res.render('forums-category', { title: req.category.name, category: req.category, threads, canModerate: await canModerate(req) });
});

router.get('/:categoryId/new', loadCategory, async (req, res) => {
  if (req.category.is_locked && !(await canModerate(req))) {
    return res.status(403).render('403', { title: 'Not Authorized', message: 'This chat is locked - only moderators can start new threads.', backHref: `/forums/${req.category.id}`, backLabel: 'Back' });
  }
  res.render('forums-new-thread', { title: `New Thread - ${req.category.name}`, category: req.category, error: req.query.error || null });
});

router.post('/:categoryId/threads', loadCategory, async (req, res) => {
  if (req.category.is_locked && !(await canModerate(req))) {
    return res.status(403).render('403', { title: 'Not Authorized', message: 'This chat is locked.', backHref: `/forums/${req.category.id}`, backLabel: 'Back' });
  }
  const title = (req.body.title || '').trim();
  const body = (req.body.body || '').trim();
  if (!title || !body) {
    return res.redirect(`/forums/${req.category.id}/new?error=` + encodeURIComponent('Title and a message are both required.'));
  }
  const self = await memberForAccount(req.portalAccount.id);
  const threadId = await forums.createThread(req.category.id, title, body, self.id, req.portalAccount.id);
  res.redirect(`/forums/threads/${threadId}`);
});

router.get('/threads/:threadId', loadThread, async (req, res) => {
  const posts = await forums.listPosts(req.thread.id);
  const self = await memberForAccount(req.portalAccount.id);
  res.render('forums-thread', {
    title: req.thread.title,
    category: req.category,
    thread: req.thread,
    posts,
    canModerate: await canModerate(req),
    selfMemberId: self ? self.id : null,
    error: req.query.error || null,
  });
});

router.post('/threads/:threadId/posts', loadThread, async (req, res) => {
  const moderator = await canModerate(req);
  if ((req.thread.status !== 'active' || req.thread.is_locked) && !moderator) {
    return res.redirect(`/forums/threads/${req.thread.id}?error=` + encodeURIComponent('This thread is locked.'));
  }
  // Moderate tab's own "allow comments" checkbox (utils/forums.js's
  // updateCategorySettings) - a category with it off is announcement-
  // only: moderators can still reply, everyone else can only read.
  if (!req.category.allow_comments && !moderator) {
    return res.redirect(`/forums/threads/${req.thread.id}?error=` + encodeURIComponent('Comments are turned off for this chat.'));
  }
  const body = (req.body.body || '').trim();
  if (!body) return res.redirect(`/forums/threads/${req.thread.id}?error=` + encodeURIComponent('A message is required.'));
  const self = await memberForAccount(req.portalAccount.id);
  await forums.addPost(req.thread.id, body, self.id, req.portalAccount.id);
  // Notify the thread's own starter, not the replier - and never notify
  // someone replying to their own thread.
  if (req.thread.account_id && req.thread.account_id !== req.portalAccount.id) {
    await notifications.notify(req.thread.account_id, 'forum_reply', { title: `New reply: ${req.thread.title}`, body: 'Someone replied to your thread.', linkUrl: `/forums/threads/${req.thread.id}` });
  }
  res.redirect(`/forums/threads/${req.thread.id}`);
});

router.post('/threads/:threadId/posts/:postId/edit', loadThread, async (req, res) => {
  const post = await forums.getPost(req.params.postId);
  const self = await memberForAccount(req.portalAccount.id);
  const isAuthor = post && self && post.member_id === self.id;
  if (!post || (!isAuthor && !(await canModerate(req)))) {
    return res.status(403).render('403', { title: 'Not Authorized', message: 'You can only edit your own posts.', backHref: `/forums/threads/${req.thread.id}`, backLabel: 'Back' });
  }
  const body = (req.body.body || '').trim();
  if (!body) return res.redirect(`/forums/threads/${req.thread.id}?error=` + encodeURIComponent('A message is required.'));
  await forums.editPost(post.id, body);
  if (!isAuthor) await forums.logEdit(req.portalAccount.id, post.id);
  res.redirect(`/forums/threads/${req.thread.id}`);
});

async function requireModerator(req, res, next) {
  if (!(await canModerate(req))) return res.status(403).render('403', { title: 'Not Authorized', message: "You don't have permission to moderate chats.", backHref: '/forums', backLabel: 'Back to Chat' });
  next();
}

router.post('/threads/:threadId/posts/:postId/remove', loadThread, requireModerator, async (req, res) => {
  await forums.removePost(req.params.postId, req.portalAccount.id);
  res.redirect(`/forums/threads/${req.thread.id}`);
});

router.post('/threads/:threadId/posts/:postId/restore', loadThread, requireModerator, async (req, res) => {
  await forums.restorePost(req.params.postId, req.portalAccount.id);
  res.redirect(`/forums/threads/${req.thread.id}`);
});

router.post('/threads/:threadId/pin', loadThread, requireModerator, async (req, res) => {
  await forums.setThreadPinned(req.thread.id, true, req.portalAccount.id);
  res.redirect(`/forums/threads/${req.thread.id}`);
});
router.post('/threads/:threadId/unpin', loadThread, requireModerator, async (req, res) => {
  await forums.setThreadPinned(req.thread.id, false, req.portalAccount.id);
  res.redirect(`/forums/threads/${req.thread.id}`);
});
router.post('/threads/:threadId/lock', loadThread, requireModerator, async (req, res) => {
  await forums.setThreadLocked(req.thread.id, true, req.portalAccount.id);
  res.redirect(`/forums/threads/${req.thread.id}`);
});
router.post('/threads/:threadId/unlock', loadThread, requireModerator, async (req, res) => {
  await forums.setThreadLocked(req.thread.id, false, req.portalAccount.id);
  res.redirect(`/forums/threads/${req.thread.id}`);
});
router.post('/threads/:threadId/archive', loadThread, requireModerator, async (req, res) => {
  await forums.setThreadArchived(req.thread.id, true, req.portalAccount.id);
  res.redirect(`/forums/threads/${req.thread.id}`);
});
router.post('/threads/:threadId/unarchive', loadThread, requireModerator, async (req, res) => {
  await forums.setThreadArchived(req.thread.id, false, req.portalAccount.id);
  res.redirect(`/forums/threads/${req.thread.id}`);
});

router.post('/threads/:threadId/move', loadThread, requireModerator, async (req, res) => {
  const newCategoryId = parseInt(req.body.categoryId, 10);
  const target = await forums.getCategory(newCategoryId);
  if (!target) return res.redirect(`/forums/threads/${req.thread.id}?error=` + encodeURIComponent('That chat does not exist.'));
  await forums.moveThread(req.thread.id, newCategoryId, req.portalAccount.id);
  res.redirect(`/forums/threads/${req.thread.id}`);
});

module.exports = router;
