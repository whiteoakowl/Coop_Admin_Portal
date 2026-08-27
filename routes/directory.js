// Member/public-facing Business Directory (Community & Commerce track,
// item 4), mounted at /directory (server.js). Browsing an approved
// listing works the same public/members split as Events; submitting a
// new listing (or managing your own) requires sign-in and only ever acts
// on behalf of the signed-in account's own family, the same pattern
// routes/events.js already established (utils/portalAuth.js's shared
// familyForAccount).
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth } = require('../middleware/portalAuth');
const { familyForAccount } = require('../utils/portalAuth');
const directory = require('../utils/directory');

function withImageUrl(listing) {
  return { ...listing, imageUrl: listing.image_key ? `/uploads/directory/${listing.image_key}` : null };
}

router.get('/', async (req, res) => {
  const active = await directory.listListings({ status: 'active' });
  const visible = req.portalAccount ? active : active.filter((l) => l.visibility === 'public');
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  res.render('directory-list', { title: 'Business Directory', settings, listings: visible.map(withImageUrl) });
});

router.get('/mine', requirePortalAuth, async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  const familyIds = family.map((m) => m.id);
  const mine = [];
  for (const memberId of familyIds) {
    mine.push(...(await directory.listingsForMember(memberId)));
  }
  const categories = await directory.listCategories();
  res.render('directory-mine', { title: 'My Directory Listings', family, categories, listings: mine.map(withImageUrl), notice: req.query.notice || null, error: req.query.error || null });
});

router.post('/', requirePortalAuth, async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  const memberId = parseInt(req.body.memberId, 10);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect('/directory/mine?error=' + encodeURIComponent('You can only submit a listing for yourself or your own family.'));
  }
  const businessName = (req.body.businessName || '').trim();
  if (!businessName) {
    return res.redirect('/directory/mine?error=' + encodeURIComponent('Business name is required.'));
  }
  await directory.submitListing(
    {
      businessName,
      description: (req.body.description || '').trim(),
      categoryId: parseInt(req.body.categoryId, 10) || null,
      phone: (req.body.phone || '').trim(),
      email: (req.body.email || '').trim(),
      website: (req.body.website || '').trim(),
      address: (req.body.address || '').trim(),
      visibility: req.body.visibility === 'public' ? 'public' : 'members',
    },
    memberId,
    req.portalAccount.id
  );
  res.redirect('/directory/mine?notice=' + encodeURIComponent('Submitted for admin review.'));
});

router.post('/:id/update', requirePortalAuth, async (req, res) => {
  const listing = await directory.getListing(req.params.id);
  const family = await familyForAccount(req.portalAccount.id);
  if (!listing || !family.some((m) => m.id === listing.member_id)) {
    return res.redirect('/directory/mine?error=' + encodeURIComponent('That listing was not found.'));
  }
  const businessName = (req.body.businessName || '').trim();
  if (!businessName) {
    return res.redirect('/directory/mine?error=' + encodeURIComponent('Business name is required.'));
  }
  await directory.updateListing(listing.id, {
    businessName,
    description: (req.body.description || '').trim(),
    categoryId: parseInt(req.body.categoryId, 10) || null,
    phone: (req.body.phone || '').trim(),
    email: (req.body.email || '').trim(),
    website: (req.body.website || '').trim(),
    address: (req.body.address || '').trim(),
    visibility: req.body.visibility === 'public' ? 'public' : 'members',
  });
  res.redirect('/directory/mine?notice=' + encodeURIComponent('Listing updated.'));
});

router.post('/:id/archive', requirePortalAuth, async (req, res) => {
  const listing = await directory.getListing(req.params.id);
  const family = await familyForAccount(req.portalAccount.id);
  if (!listing || !family.some((m) => m.id === listing.member_id)) {
    return res.redirect('/directory/mine?error=' + encodeURIComponent('That listing was not found.'));
  }
  await directory.setListingStatus(listing.id, 'archived', req.portalAccount.id);
  res.redirect('/directory/mine?notice=' + encodeURIComponent('Listing archived.'));
});

router.get('/:id', async (req, res) => {
  const listing = await directory.getListing(req.params.id);
  if (!listing || listing.status !== 'active') return res.status(404).render('404', { title: 'Not Found' });
  if (listing.visibility === 'members' && !req.portalAccount) {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  res.render('directory-detail', { title: listing.business_name, settings, listing: withImageUrl(listing) });
});

module.exports = router;
