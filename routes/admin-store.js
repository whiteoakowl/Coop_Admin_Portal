// Main Admin's Store management (Community & Commerce track, item 8) -
// mounted at /main-admin/store (server.js), gated the same way every
// other Track B admin section is (manage_store, already pre-seeded in
// db/bootstrapPg.js). Tabs: Products, Orders, Archived, Settings - same
// ?tab= convention as Classifieds/Chat/Events. Recording an in-person
// sale is its own dedicated multi-item action, not a status toggle on an
// online order - see supabase/migrations/20260825090000_store.sql's own
// comment on why that's structural, not just a string an admin could get
// wrong.
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
const auditLog = require('../utils/auditLog');
const { byLastName } = require('../utils/members');

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

function withImage(p) {
  return { ...p, imageUrl: imageUrl(p.image_key), sizeList: store.parseSizes(p.sizes) };
}

const STORE_TABS = ['products', 'orders', 'archived', 'settings'];

router.get('/', async (req, res) => {
  const activeTab = STORE_TABS.includes(req.query.tab) ? req.query.tab : 'products';
  const categories = await store.listCategories();
  const selectedCategory = req.query.category ? parseInt(req.query.category, 10) : null;

  let products = [];
  let archived = [];
  let orders = [];
  let saleProducts = [];
  let members = [];

  if (activeTab === 'products') {
    products = (await store.listProducts({ categoryId: selectedCategory })).filter((p) => p.status !== 'archived').map(withImage);
  } else if (activeTab === 'archived') {
    archived = (await store.listProducts({ status: 'archived' })).map(withImage);
  } else if (activeTab === 'orders') {
    orders = await store.allOrders();
    saleProducts = (await store.listProducts({ status: 'active', availability: 'in_person' })).map(withImage);
    members = (await db.prepare('SELECT id, name FROM members WHERE active = 1').all()).sort(byLastName);
  }

  res.render('admin-store-list', {
    title: 'Shop',
    activeTab,
    categories,
    selectedCategory,
    products,
    archived,
    orders,
    saleProducts,
    members,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/', async (req, res) => {
  const name = (req.body.name || '').trim();
  const priceCents = Math.round(Number(req.body.price || 0) * 100);
  if (!name || !Number.isFinite(priceCents) || priceCents < 0) {
    return res.redirect('/main-admin/store?notice=' + encodeURIComponent('Name and a valid price are required.'));
  }
  const id = await store.createProduct(
    {
      name,
      description: (req.body.description || '').trim(),
      priceCents,
      inventoryCount: req.body.inventoryCount ? parseInt(req.body.inventoryCount, 10) : null,
      availability: ['online', 'in_person', 'both'].includes(req.body.availability) ? req.body.availability : 'both',
      categoryId: req.body.categoryId ? parseInt(req.body.categoryId, 10) : null,
      sizes: (req.body.sizes || '').trim(),
    },
    req.portalAccount.id
  );
  res.redirect(`/main-admin/store/${id}/edit`);
});

// These must be registered before the bare POST '/:id' below - '/:id'
// matches a single path segment just like these literal paths do, and
// Express tries routes in registration order, so 'POST /categories'
// would otherwise be swallowed by 'POST /:id' with id='categories' (same
// reasoning as routes/admin-classifieds.js's own category routes).
router.post('/categories', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/store?tab=settings&error=' + encodeURIComponent('Category name is required.'));
  await store.addCategory(name);
  res.redirect('/main-admin/store?tab=settings&notice=' + encodeURIComponent(`Added "${name}".`));
});

router.post('/categories/:id', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/main-admin/store?tab=settings&error=' + encodeURIComponent('Category name is required.'));
  await store.renameCategory(req.params.id, name);
  res.redirect('/main-admin/store?tab=settings&notice=' + encodeURIComponent('Renamed.'));
});

router.post('/categories/:id/delete', async (req, res) => {
  await store.deleteCategory(req.params.id);
  res.redirect('/main-admin/store?tab=settings&notice=' + encodeURIComponent('Category removed.'));
});

// Also two-segment paths, same non-collision reasoning as '/categories'
// above (kept here anyway, grouped with the rest of Orders, for anyone
// reading top to bottom).
router.get('/orders/:id', async (req, res) => {
  const order = await store.getOrder(req.params.id);
  if (!order) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-store-order-detail', { title: `Order #${order.id}`, order, error: req.query.error || null, notice: req.query.notice || null });
});

// The In-Person Sale cart: one dialog listing every sellable product with
// its own quantity + size picker, so an admin can ring up several
// different items (and sizes) for one member in a single action instead
// of repeating this form once per product. The view submits one
// items[<row index>][...] group per product, each carrying its own
// productId field - the row index is just a sequential 0, 1, 2... array
// position, never the product's own id. (A bracket key that IS numeric,
// e.g. items[<productId>][quantity], gets silently reinterpreted by
// express's qs-based urlencoded parser as an array index instead of an
// object key, scrambling which item a quantity belongs to - this shape
// avoids that trap entirely.) Only products with a quantity > 0 actually
// become order lines.
router.post('/orders/in-person', async (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  if (!memberId) return res.redirect('/main-admin/store?tab=orders&error=' + encodeURIComponent('Choose a member.'));
  const itemsInput = Array.isArray(req.body.items) ? req.body.items : Object.values(req.body.items || {});
  const items = itemsInput
    .map((v) => ({ productId: parseInt((v || {}).productId, 10), quantity: parseInt((v || {}).quantity, 10) || 0, size: ((v || {}).size || '').trim() || null }))
    .filter((i) => i.productId && i.quantity > 0);
  if (items.length === 0) {
    return res.redirect('/main-admin/store?tab=orders&error=' + encodeURIComponent('Add a quantity for at least one product.'));
  }
  try {
    const orderId = await store.recordInPersonSale(memberId, req.portalAccount.id, items);
    res.redirect(`/main-admin/store/orders/${orderId}?notice=` + encodeURIComponent('Sale recorded.'));
  } catch (err) {
    res.redirect('/main-admin/store?tab=orders&error=' + encodeURIComponent(err.message));
  }
});

router.post('/orders/:id/fulfill', async (req, res) => {
  await store.fulfillOrder(req.params.id);
  const base = req.body.redirectTo || '/main-admin/store?tab=orders';
  res.redirect(`${base}${base.includes('?') ? '&' : '?'}notice=` + encodeURIComponent('Marked fulfilled.'));
});

router.post('/orders/:id/cancel', async (req, res) => {
  await store.cancelOrder(req.params.id);
  await auditLog.record(req.portalAccount.id, 'order_cancelled', 'store_order', req.params.id, null);
  const base = req.body.redirectTo || '/main-admin/store?tab=orders';
  res.redirect(`${base}${base.includes('?') ? '&' : '?'}notice=` + encodeURIComponent('Order cancelled.'));
});

async function loadEditor(req, res) {
  const product = await store.getProduct(req.params.id);
  if (!product) return res.status(404).render('404', { title: 'Not Found' });
  const categories = await store.listCategories();
  res.render('admin-store-edit', { title: product.name, product, categories, imageUrl: imageUrl(product.image_key), error: req.query.error || null, notice: req.query.notice || null });
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
    categoryId: req.body.categoryId ? parseInt(req.body.categoryId, 10) : null,
    sizes: (req.body.sizes || '').trim(),
  });
  res.redirect(`/main-admin/store/${id}/edit?notice=` + encodeURIComponent('Saved.'));
});

router.post('/:id/status', async (req, res) => {
  const status = req.body.status;
  if (!['draft', 'active', 'archived'].includes(status)) return res.redirect('/main-admin/store');
  await store.setProductStatus(req.params.id, status);
  const backTab = status === 'archived' ? 'archived' : 'products';
  const from = req.body.redirectTo;
  if (from) return res.redirect(`${from}${from.includes('?') ? '&' : '?'}notice=` + encodeURIComponent(`Marked ${status}.`));
  res.redirect(`/main-admin/store?tab=${backTab}&notice=` + encodeURIComponent(`Marked ${status}.`));
});

router.post('/:id/delete', async (req, res) => {
  const product = await store.getProduct(req.params.id);
  await store.deleteProduct(req.params.id);
  await auditLog.record(req.portalAccount.id, 'product_deleted', 'store_product', req.params.id, product?.name);
  const backTab = product && product.status === 'archived' ? 'archived' : 'products';
  res.redirect(`/main-admin/store?tab=${backTab}&notice=` + encodeURIComponent('Product deleted.'));
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

module.exports = router;
