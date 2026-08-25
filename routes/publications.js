// Member/public-facing Publications/Articles (Community & Commerce
// track, item 12), mounted at /publications (server.js). Only
// status='published' items are ever queried here - a draft 404s even by
// direct URL. Visibility works the same as routes/photos.js: 'public'
// is browsable signed-out, 'members' (the default) requires sign-in.
const express = require('express');
const router = express.Router();
const db = require('../db');
const publications = require('../utils/publications');

router.get('/', async (req, res) => {
  const items = req.portalAccount
    ? await publications.listPublications({ status: 'published' })
    : await publications.listPublications({ status: 'published', visibility: 'public' });
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  res.render('publications-list', { title: 'Publications', settings, items });
});

router.get('/:id', async (req, res) => {
  const item = await publications.getPublication(req.params.id);
  if (!item || item.status !== 'published') return res.status(404).render('404', { title: 'Not Found' });
  if (item.visibility === 'members' && !req.portalAccount) {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  res.render('publications-detail', { title: item.title, settings, item });
});

module.exports = router;
