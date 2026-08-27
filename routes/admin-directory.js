// Main Admin's own Business Directory moderation (Community & Commerce
// track, item 4) - mounted at /main-admin/directory (server.js), gated
// the same way routes/admin-events.js already is. A sibling router, not
// an edit to the off-limits routes/main-admin.js.
//
// A real request: "Business Directory gets tabs: Directory, Requests,
// Archive. Directory tab gets the same Add Category popup pattern
// (admin-only add/delete categories)." Same shape as routes/admin-
// classifieds.js's own Categories/Requests/Archive tabs (see that file's
// own header comment) - here the "Categories" tab is just named
// "Directory" per this feature's own wording, since it's also where an
// admin browses the live directory itself, not just its categories.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { imageFileFilter } = require('../utils/uploads');
const { createStorageClient, uploadFile, deleteFile, publicUrl, generateKey } = require('../utils/storage');
const directory = require('../utils/directory');
const auditLog = require('../utils/auditLog');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_directory'));

const DIRECTORY_IMAGES_BUCKET = 'directory-images';
const DIRECTORY_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'directory');
if (!createStorageClient() && !fs.existsSync(DIRECTORY_IMAGE_DIR)) fs.mkdirSync(DIRECTORY_IMAGE_DIR, { recursive: true });

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES }, fileFilter: imageFileFilter });

function imageUrl(key) {
  if (!key) return null;
  return createStorageClient() ? publicUrl(DIRECTORY_IMAGES_BUCKET, key) : `/uploads/directory/${key}`;
}

const DIRECTORY_TABS = ['directory', 'requests', 'archive'];

router.get('/', async (req, res) => {
  const activeTab = DIRECTORY_TABS.includes(req.query.tab) ? req.query.tab : 'directory';
  const categories = await directory.listCategories();

  let groups = [];
  let archived = [];
  let requests = [];
  if (activeTab === 'directory') groups = await directory.activeListingsByCategory();
  else if (activeTab === 'archive') archived = await directory.archivedListings();
  else requests = await directory.listListings({ status: 'pending' });

  res.render('admin-directory-list', {
    title: 'Business Directory',
    activeTab,
    categories,
    groups,
    archived,
    requests,
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

async function loadEditor(req, res) {
  const listing = await directory.getListing(req.params.id);
  if (!listing) return res.status(404).render('404', { title: 'Not Found' });
  const categories = await directory.listCategories();
  res.render('admin-directory-edit', { title: listing.business_name, listing, categories, imageUrl: imageUrl(listing.image_key), error: req.query.error || null, notice: req.query.notice || null });
}
router.get('/:id/edit', loadEditor);

// These two must be registered before the bare POST /:id below - see
// routes/admin-classifieds.js's own comment on the same ordering
// requirement ('/:id' matches a single path segment just like these
// literal paths do, and Express tries routes in registration order).
router.post('/categories', async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect('/main-admin/directory?error=' + encodeURIComponent('Category name is required.'));
  await directory.addCategory(title);
  res.redirect('/main-admin/directory?notice=' + encodeURIComponent(`Added "${title}".`));
});

router.post('/categories/:id/delete', async (req, res) => {
  await directory.deleteCategory(parseInt(req.params.id, 10));
  res.redirect('/main-admin/directory?notice=' + encodeURIComponent('Category removed.'));
});

router.post('/:id', async (req, res) => {
  const id = req.params.id;
  const businessName = (req.body.businessName || '').trim();
  if (!businessName) return res.redirect(`/main-admin/directory/${id}/edit?error=` + encodeURIComponent('Business name is required.'));
  await directory.updateListing(id, {
    businessName,
    description: (req.body.description || '').trim(),
    categoryId: parseInt(req.body.categoryId, 10) || null,
    phone: (req.body.phone || '').trim(),
    email: (req.body.email || '').trim(),
    website: (req.body.website || '').trim(),
    address: (req.body.address || '').trim(),
    visibility: req.body.visibility === 'public' ? 'public' : 'members',
  });
  res.redirect(`/main-admin/directory/${id}/edit?notice=` + encodeURIComponent('Saved.'));
});

router.post('/:id/status', async (req, res) => {
  const status = req.body.status;
  if (!['pending', 'active', 'archived'].includes(status)) return res.redirect('/main-admin/directory');
  await directory.setListingStatus(req.params.id, status, req.portalAccount.id);
  await auditLog.record(req.portalAccount.id, 'listing_status_changed', 'directory_listing', req.params.id, status);
  const backTab = status === 'archived' ? 'archive' : status === 'pending' ? 'requests' : 'directory';
  res.redirect(`/main-admin/directory?tab=${backTab}&notice=` + encodeURIComponent(status === 'active' ? 'Approved.' : `Marked ${status}.`));
});

// The Requests tab's own "deny" - same "nothing worth keeping once a
// submission is rejected" reasoning as utils/resourceLinks.js's own
// denyResourceLink and routes/admin-classifieds.js's own POST /:id/deny.
router.post('/:id/deny', async (req, res) => {
  await directory.deleteListing(req.params.id);
  res.redirect('/main-admin/directory?tab=requests&notice=' + encodeURIComponent('Request denied.'));
});

router.post('/:id/delete', async (req, res) => {
  await directory.deleteListing(req.params.id);
  res.redirect('/main-admin/directory?notice=' + encodeURIComponent('Listing deleted.'));
});

router.post('/:id/image', upload.single('image'), async (req, res) => {
  const id = req.params.id;
  if (!req.file) return res.redirect(`/main-admin/directory/${id}/edit?error=` + encodeURIComponent('Please choose an image file.'));
  const client = createStorageClient();
  let key;
  try {
    if (client) {
      key = await uploadFile(client, DIRECTORY_IMAGES_BUCKET, req.file.buffer, req.file.originalname, req.file.mimetype);
    } else {
      key = generateKey(req.file.originalname);
      fs.writeFileSync(path.join(DIRECTORY_IMAGE_DIR, key), req.file.buffer);
    }
  } catch (err) {
    return res.redirect(`/main-admin/directory/${id}/edit?error=` + encodeURIComponent(`Upload failed: ${err.message}`));
  }
  const listing = await directory.getListing(id);
  if (listing && listing.image_key) {
    if (client) await deleteFile(client, DIRECTORY_IMAGES_BUCKET, listing.image_key);
    else {
      const oldPath = path.join(DIRECTORY_IMAGE_DIR, listing.image_key);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }
  await directory.setListingImage(id, key);
  res.redirect(`/main-admin/directory/${id}/edit?notice=` + encodeURIComponent('Image updated.'));
});

module.exports = router;
