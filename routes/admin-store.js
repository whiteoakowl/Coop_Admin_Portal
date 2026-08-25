// Main Admin's Store management (Community & Commerce track, item 8) -
// mounted at /main-admin/store (server.js), gated the same way every
// other Track B admin section is (manage_store, already pre-seeded in
// db/bootstrapPg.js). Recording an in-person sale is its own dedicated
// action, not a status toggle on an online order - see
// supabase/migrations/20260825090000_store.sql's own comment on why
// that's structural, not just a string an admin could get wrong.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { imageFileFilter } = require('../utils/uploads');
const { createStorageClient, uploadFile, deleteFile, publicUrl, generateKey } = require('../utils/storage');
const store = require('../utils/store');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_store'));

const STORE_IMAGES_BUCKET = 'store-images';
const STORE_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'store');
if (!createStorageClient() && !fs.existsSync(STORE_IMAGE_DIR)) fs.mkdirSync(STORE_IMAGE_DIR, { recursive: true });

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES }, fileFilter: imageFileFilter });

function imageUrl(key) {
  if (!key) return null;
  return createStorageClient() ? publicUrl(STORE_IMAGES_BUCKET, key) : `/uploads/store/${key}`;
}

router.get('/', async (req, res) => {
  const products = await store.listProducts();
  res.render('admin-store-list', { title: 'Store', products: products.map((p) => ({ ...p, imageUrl: imageUrl(p.image_key) })), notice: req.query.notice || null });
});

router.post('/', async (req, res) => {
  const name = (req.body.name || '').trim();
  const priceCents = Math.round(Number(req.body.price || 0) * 100);
  if (!name || !Number.isFinite(priceCents) || priceCents < 0) {
    return res.redirect('/main-admin/store?notice=' + encodeURIComponent('Name and a valid price are required.'));
  }
  const id = await store.createProduct(
    { name, description: (req.body.description || '').trim(), priceCents, inventoryCount: req.body.inventoryCount ? parseInt(req.body.inventoryCount, 10) : null, availability: ['online', 'in_person', 'both'].includes(req.body.availability) ? req.body.availability : 'both' },
    req.portalAccount.id
  );
  res.redirect(`/main-admin/store/${id}/edit`);
});

async function loadEditor(req, res) {
  const product = await store.getProduct(req.params.id);
  if (!product) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-store-edit', { title: product.name, product, imageUrl: imageUrl(product.image_key), error: req.query.error || null, notice: req.query.notice || null });
}
router.get('/:id/edit', loadEditor);

router.post('/:id', async (req, res) => {
  const id = req.params.id;
  const name = (req.body.name || '').trim();
  const priceCents = Math.round(Number(req.body.price || 0) * 100);
  if (!name || !Number.isFinite(priceCents) || priceCents < 0) {
    return res.redirect(`/main-admin/store/${id}/edit?error=` + encodeURIComponent('Name and a valid price are required.'));
  }
  await store.updateProduct(id, {
    name,
    description: (req.body.description || '').trim(),
    priceCents,
    inventoryCount: req.body.inventoryCount ? parseInt(req.body.inventoryCount, 10) : null,
    availability: ['online', 'in_person', 'both'].includes(req.body.availability) ? req.body.availability : 'both',
  });
  res.redirect(`/main-admin/store/${id}/edit?notice=` + encodeURIComponent('Saved.'));
});

router.post('/:id/status', async (req, res) => {
  const status = req.body.status;
  if (!['draft', 'active', 'archived'].includes(status)) return res.redirect(`/main-admin/store/${req.params.id}/edit`);
  await store.setProductStatus(req.params.id, status);
  res.redirect(`/main-admin/store/${req.params.id}/edit?notice=` + encodeURIComponent(`Marked ${status}.`));
});

router.post('/:id/delete', async (req, res) => {
  await store.deleteProduct(req.params.id);
  res.redirect('/main-admin/store?notice=' + encodeURIComponent('Product deleted.'));
});

router.post('/:id/image', upload.single('image'), async (req, res) => {
  const id = req.params.id;
  if (!req.file) return res.redirect(`/main-admin/store/${id}/edit?error=` + encodeURIComponent('Please choose an image file.'));
  const client = createStorageClient();
  let key;
  try {
    if (client) {
      key = await uploadFile(client, STORE_IMAGES_BUCKET, req.file.buffer, req.file.originalname, req.file.mimetype);
    } else {
      key = generateKey(req.file.originalname);
      fs.writeFileSync(path.join(STORE_IMAGE_DIR, key), req.file.buffer);
    }
  } catch (err) {
    return res.redirect(`/main-admin/store/${id}/edit?error=` + encodeURIComponent(`Upload failed: ${err.message}`));
  }
  const product = await store.getProduct(id);
  if (product && product.image_key) {
    if (client) await deleteFile(client, STORE_IMAGES_BUCKET, product.image_key);
    else {
      const oldPath = path.join(STORE_IMAGE_DIR, product.image_key);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }
  await store.setProductImage(id, key);
  res.redirect(`/main-admin/store/${id}/edit?notice=` + encodeURIComponent('Image updated.'));
});

router.get('/orders/all', async (req, res) => {
  const orders = await store.allOrders();
  const products = await store.listProducts({ availability: 'in_person' });
  const members = await db.prepare('SELECT id, name FROM members WHERE active = 1 ORDER BY LOWER(name)').all();
  res.render('admin-store-orders', { title: 'Orders', orders, products, members, error: req.query.error || null, notice: req.query.notice || null });
});

router.post('/orders/in-person', async (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  const productId = parseInt(req.body.productId, 10);
  const quantity = Math.max(1, parseInt(req.body.quantity, 10) || 1);
  if (!memberId || !productId) {
    return res.redirect('/main-admin/store/orders/all?error=' + encodeURIComponent('Choose a member and a product.'));
  }
  try {
    const orderId = await store.recordInPersonSale(memberId, req.portalAccount.id, [{ productId, quantity }]);
    res.redirect(`/main-admin/store/orders/all?notice=` + encodeURIComponent(`Recorded order #${orderId}.`));
  } catch (err) {
    res.redirect('/main-admin/store/orders/all?error=' + encodeURIComponent(err.message));
  }
});

router.post('/orders/:id/fulfill', async (req, res) => {
  await store.fulfillOrder(req.params.id);
  res.redirect('/main-admin/store/orders/all?notice=' + encodeURIComponent('Marked fulfilled.'));
});

router.post('/orders/:id/cancel', async (req, res) => {
  await store.cancelOrder(req.params.id);
  res.redirect('/main-admin/store/orders/all?notice=' + encodeURIComponent('Order cancelled.'));
});

module.exports = router;
