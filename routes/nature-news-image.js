// Nature News photo proxy, mounted at /nature-news (server.js) - shared
// across Student Portal's own submit/homepage-card views and Main
// Admin's approval queue, same "one authenticated proxy route, never a
// public bucket URL" reasoning as routes/babysitters.js's own comment.
// An APPROVED post's photo is visible to any signed-in portal account
// (it's about to show up on every student's homepage); a still-pending
// or rejected one is visible only to the student who submitted it or to
// Main Admin, so a not-yet-reviewed submission isn't exposed sitewide
// before anyone has reviewed it.
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { createStorageClient, downloadFile } = require('../utils/storage');
const { memberForAccount } = require('../utils/portalAuth');
const natureNews = require('../utils/natureNews');

const NATURE_NEWS_BUCKET = 'private-nature-news';
const NATURE_NEWS_DIR = path.join(__dirname, '..', 'private-uploads', 'nature-news');
const storageClient = createStorageClient();

async function canView(req, post) {
  if (!post) return false;
  if (post.status === 'approved') return !!req.portalAccount;
  if (!req.portalAccount) return false;
  if (req.portalRoles && req.portalRoles.some((r) => r.key === 'main_admin')) return true;
  const own = await memberForAccount(req.portalAccount.id);
  return !!own && own.id === post.member_id;
}

router.get('/:id/image', async (req, res) => {
  const post = await natureNews.getPost(req.params.id);
  if (!(await canView(req, post))) {
    if (!req.portalAccount) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    return res.status(404).render('404', { title: 'Not Found' });
  }
  if (storageClient) {
    const buffer = await downloadFile(storageClient, NATURE_NEWS_BUCKET, post.image_key);
    res.setHeader('Content-Type', 'image/*');
    return res.send(buffer);
  }
  const filePath = path.join(NATURE_NEWS_DIR, path.basename(post.image_key));
  if (!fs.existsSync(filePath)) return res.status(404).render('404', { title: 'Not Found' });
  res.sendFile(filePath);
});

module.exports = router;
