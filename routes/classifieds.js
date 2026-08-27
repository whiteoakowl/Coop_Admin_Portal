// Member/public-facing Classifieds (Community & Commerce track, item 4),
// mounted at /classifieds (server.js). Same shape as routes/directory.js
// right alongside it - see that file's own header comment for the
// reasoning this mirrors.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth } = require('../middleware/portalAuth');
const { familyForAccount } = require('../utils/portalAuth');
const classifieds = require('../utils/classifieds');

function withImageUrl(listing) {
  return { ...listing, imageUrl: listing.image_key ? `/uploads/classifieds/${listing.image_key}` : null };
}

router.get('/', async (req, res) => {
  const active = await classifieds.listListings({ status: 'active' });
  const visible = req.portalAccount ? active : active.filter((l) => l.visibility === 'public');
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  res.render('classifieds-list', { title: 'Classifieds', settings, listings: visible.map(withImageUrl) });
});

router.get('/mine', requirePortalAuth, async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  const familyIds = family.map((m) => m.id);
  const mine = [];
  for (const memberId of familyIds) {
    mine.push(...(await classifieds.listingsForMember(memberId)));
  }
  const categories = await classifieds.listCategories();
  res.render('classifieds-mine', { title: 'My Classifieds', family, categories, listings: mine.map(withImageUrl), notice: req.query.notice || null, error: req.query.error || null });
});

// A real request: "Members must choose a category when creating a
// listing" - categoryId is required on both create and update below,
// same as title.
router.post('/', requirePortalAuth, async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  const memberId = parseInt(req.body.memberId, 10);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect('/classifieds/mine?error=' + encodeURIComponent('You can only post a listing for yourself or your own family.'));
  }
  const title = (req.body.title || '').trim();
  if (!title) {
    return res.redirect('/classifieds/mine?error=' + encodeURIComponent('Title is required.'));
  }
  const categoryId = parseInt(req.body.categoryId, 10) || null;
  if (!categoryId) {
    return res.redirect('/classifieds/mine?error=' + encodeURIComponent('Please choose a category.'));
  }
  await classifieds.submitListing(
    {
      title,
      description: (req.body.description || '').trim(),
      categoryId,
      price: (req.body.price || '').trim(),
      visibility: req.body.visibility === 'public' ? 'public' : 'members',
    },
    memberId,
    req.portalAccount.id
  );
  res.redirect('/classifieds/mine?notice=' + encodeURIComponent('Submitted for admin review.'));
});

router.post('/:id/update', requirePortalAuth, async (req, res) => {
  const listing = await classifieds.getListing(req.params.id);
  const family = await familyForAccount(req.portalAccount.id);
  if (!listing || !family.some((m) => m.id === listing.member_id)) {
    return res.redirect('/classifieds/mine?error=' + encodeURIComponent('That listing was not found.'));
  }
  const title = (req.body.title || '').trim();
  if (!title) {
    return res.redirect('/classifieds/mine?error=' + encodeURIComponent('Title is required.'));
  }
  const categoryId = parseInt(req.body.categoryId, 10) || null;
  if (!categoryId) {
    return res.redirect('/classifieds/mine?error=' + encodeURIComponent('Please choose a category.'));
  }
  await classifieds.updateListing(listing.id, {
    title,
    description: (req.body.description || '').trim(),
    categoryId,
    price: (req.body.price || '').trim(),
    visibility: req.body.visibility === 'public' ? 'public' : 'members',
  });
  res.redirect('/classifieds/mine?notice=' + encodeURIComponent('Listing updated.'));
});

router.post('/:id/sold', requirePortalAuth, async (req, res) => {
  const listing = await classifieds.getListing(req.params.id);
  const family = await familyForAccount(req.portalAccount.id);
  if (!listing || !family.some((m) => m.id === listing.member_id)) {
    return res.redirect('/classifieds/mine?error=' + encodeURIComponent('That listing was not found.'));
  }
  await classifieds.setListingStatus(listing.id, 'sold', req.portalAccount.id);
  res.redirect('/classifieds/mine?notice=' + encodeURIComponent('Marked sold.'));
});

router.post('/:id/archive', requirePortalAuth, async (req, res) => {
  const listing = await classifieds.getListing(req.params.id);
  const family = await familyForAccount(req.portalAccount.id);
  if (!listing || !family.some((m) => m.id === listing.member_id)) {
    return res.redirect('/classifieds/mine?error=' + encodeURIComponent('That listing was not found.'));
  }
  await classifieds.setListingStatus(listing.id, 'archived', req.portalAccount.id);
  res.redirect('/classifieds/mine?notice=' + encodeURIComponent('Listing archived.'));
});

router.get('/:id', async (req, res) => {
  const listing = await classifieds.getListing(req.params.id);
  if (!listing || listing.status !== 'active') return res.status(404).render('404', { title: 'Not Found' });
  if (listing.visibility === 'members' && !req.portalAccount) {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  res.render('classifieds-detail', { title: listing.title, settings, listing: withImageUrl(listing) });
});

module.exports = router;
