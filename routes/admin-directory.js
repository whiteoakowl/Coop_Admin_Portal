// Main Admin's own Business Directory moderation (Community & Commerce
// track, item 4) - mounted at /main-admin/directory (server.js), gated
// the same way routes/admin-events.js already is. A sibling router, not
// an edit to the off-limits routes/main-admin.js.
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

router.get('/', async (req, res) => {
  const listings = await directory.listListings();
  res.render('admin-directory-list', { title: 'Business Directory', listings, notice: req.query.notice || null });
});

async function loadEditor(req, res) {
  const listing = await directory.getListing(req.params.id);
  if (!listing) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-directory-edit', { title: listing.business_name, listing, imageUrl: imageUrl(listing.image_key), error: req.query.error || null, notice: req.query.notice || null });
}
router.get('/:id/edit', loadEditor);

router.post('/:id', async (req, res) => {
  const id = req.params.id;
  const businessName = (req.body.businessName || '').trim();
  if (!businessName) return res.redirect(`/main-admin/directory/${id}/edit?error=` + encodeURIComponent('Business name is required.'));
  await directory.updateListing(id, {
    businessName,
    description: (req.body.description || '').trim(),
    category: (req.body.category || '').trim(),
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
  res.redirect('/main-admin/directory?notice=' + encodeURIComponent(status === 'active' ? 'Approved.' : `Marked ${status}.`));
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
