// Main Admin's own Classifieds moderation (Community & Commerce track,
// item 4) - mounted at /main-admin/classifieds (server.js). Same shape
// as routes/admin-directory.js right alongside it, gated by its own
// manage_classifieds permission rather than manage_directory - a
// classifieds ad isn't a business directory entry, and the handoff's own
// permission catalog only pre-seeded manage_directory for the member/
// business directories, so this is a genuinely new capability, not a
// reuse of an existing one.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { imageFileFilter } = require('../utils/uploads');
const { createStorageClient, uploadFile, deleteFile, publicUrl, generateKey } = require('../utils/storage');
const classifieds = require('../utils/classifieds');
const auditLog = require('../utils/auditLog');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_classifieds'));

const CLASSIFIEDS_IMAGES_BUCKET = 'classifieds-images';
const CLASSIFIEDS_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'classifieds');
if (!createStorageClient() && !fs.existsSync(CLASSIFIEDS_IMAGE_DIR)) fs.mkdirSync(CLASSIFIEDS_IMAGE_DIR, { recursive: true });

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES }, fileFilter: imageFileFilter });

function imageUrl(key) {
  if (!key) return null;
  return createStorageClient() ? publicUrl(CLASSIFIEDS_IMAGES_BUCKET, key) : `/uploads/classifieds/${key}`;
}

router.get('/', async (req, res) => {
  const listings = await classifieds.listListings();
  res.render('admin-classifieds-list', { title: 'Classifieds', listings, notice: req.query.notice || null });
});

async function loadEditor(req, res) {
  const listing = await classifieds.getListing(req.params.id);
  if (!listing) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-classifieds-edit', { title: listing.title, listing, imageUrl: imageUrl(listing.image_key), error: req.query.error || null, notice: req.query.notice || null });
}
router.get('/:id/edit', loadEditor);

router.post('/:id', async (req, res) => {
  const id = req.params.id;
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect(`/main-admin/classifieds/${id}/edit?error=` + encodeURIComponent('Title is required.'));
  await classifieds.updateListing(id, {
    title,
    description: (req.body.description || '').trim(),
    category: (req.body.category || '').trim(),
    price: (req.body.price || '').trim(),
    visibility: req.body.visibility === 'public' ? 'public' : 'members',
  });
  res.redirect(`/main-admin/classifieds/${id}/edit?notice=` + encodeURIComponent('Saved.'));
});

router.post('/:id/status', async (req, res) => {
  const status = req.body.status;
  if (!['pending', 'active', 'sold', 'archived'].includes(status)) return res.redirect('/main-admin/classifieds');
  await classifieds.setListingStatus(req.params.id, status, req.portalAccount.id);
  await auditLog.record(req.portalAccount.id, 'listing_status_changed', 'classifieds_listing', req.params.id, status);
  res.redirect('/main-admin/classifieds?notice=' + encodeURIComponent(status === 'active' ? 'Approved.' : `Marked ${status}.`));
});

router.post('/:id/delete', async (req, res) => {
  await classifieds.deleteListing(req.params.id);
  res.redirect('/main-admin/classifieds?notice=' + encodeURIComponent('Listing deleted.'));
});

router.post('/:id/image', upload.single('image'), async (req, res) => {
  const id = req.params.id;
  if (!req.file) return res.redirect(`/main-admin/classifieds/${id}/edit?error=` + encodeURIComponent('Please choose an image file.'));
  const client = createStorageClient();
  let key;
  try {
    if (client) {
      key = await uploadFile(client, CLASSIFIEDS_IMAGES_BUCKET, req.file.buffer, req.file.originalname, req.file.mimetype);
    } else {
      key = generateKey(req.file.originalname);
      fs.writeFileSync(path.join(CLASSIFIEDS_IMAGE_DIR, key), req.file.buffer);
    }
  } catch (err) {
    return res.redirect(`/main-admin/classifieds/${id}/edit?error=` + encodeURIComponent(`Upload failed: ${err.message}`));
  }
  const listing = await classifieds.getListing(id);
  if (listing && listing.image_key) {
    if (client) await deleteFile(client, CLASSIFIEDS_IMAGES_BUCKET, listing.image_key);
    else {
      const oldPath = path.join(CLASSIFIEDS_IMAGE_DIR, listing.image_key);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }
  await classifieds.setListingImage(id, key);
  res.redirect(`/main-admin/classifieds/${id}/edit?notice=` + encodeURIComponent('Image updated.'));
});

module.exports = router;
