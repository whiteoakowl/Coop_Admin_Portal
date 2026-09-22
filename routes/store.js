// Member-facing Store (Community & Commerce track, item 8), mounted at
// /store (server.js). Members-only, any signed-in portal account - no
// public storefront (unlike Events/Directory/Classifieds' own public
// toggle), matching the handoff's own "member checkout" framing. An
// online purchase always starts unpaid; a Main Admin records the real
// payment afterward through Accounting (utils/payments.js) - there is no
// "pay now" button anywhere in this app.
const express = require('express');
const router = express.Router();
const { createStorageClient, publicUrl } = require('../utils/storage');
const { requirePortalAuth } = require('../middleware/portalAuth');
const { familyForAccount } = require('../utils/portalAuth');
const store = require('../utils/store');

const STORE_IMAGES_BUCKET = 'store-images';
const storageClient = createStorageClient();

function imageUrl(imageKey) {
  if (!imageKey) return null;
  return storageClient ? publicUrl(STORE_IMAGES_BUCKET, imageKey) : `/uploads/store/${imageKey}`;
}
function withImageUrl(product) {
  return { ...product, imageUrl: imageUrl(product.image_key) };
}

router.use(requirePortalAuth);

// A real request: "change shop product card to look similar [to a
// reference design: image left, In Stock/Out of Stock badge, price and
// stock count on one row, a prominent order button]." A product WITH
// options is in stock as long as at least one of its enabled options
// still has room (or is unlimited - quantity null); a stock COUNT is
// only shown for the simple no-options case, where inventory_count is a
// single real number rather than one per option.
async function withStockInfo(product) {
  const groups = await store.optionGroupsForProduct(product.id);
  const hasOptions = groups.length > 0;
  // In stock only if every group still has at least one enabled, in-stock
  // value to pick from - a group with nothing left to choose makes the
  // whole product unbuyable, same as buildOrderLines' own "Choose a
  // {group} for..." requirement.
  const inStock = hasOptions
    ? groups.every((g) => g.values.some((v) => v.enabled && (v.quantity == null || v.quantity > 0)))
    : product.inventory_count == null || product.inventory_count > 0;
  const stockCount = !hasOptions && product.inventory_count != null ? product.inventory_count : null;
  return { ...withImageUrl(product), inStock, stockCount };
}

router.get('/', async (req, res) => {
  const products = await store.listProducts({ status: 'active', availability: 'online' });
  res.render('store-list', { title: 'Store', products: await Promise.all(products.map(withStockInfo)) });
});

router.get('/orders', async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  const orders = [];
  for (const m of family) orders.push(...(await store.ordersForMember(m.id)));
  orders.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  res.render('store-orders', { title: 'My Orders', orders });
});

router.get('/orders/:id', async (req, res) => {
  const order = await store.getOrder(req.params.id);
  if (!order) return res.status(404).render('404', { title: 'Not Found' });
  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === order.member_id)) {
    return res.status(403).render('403', { title: 'Not Authorized', message: "That's not your order.", backHref: '/store/orders', backLabel: 'Back to My Orders' });
  }
  res.render('store-order-detail', { title: `Order #${order.id}`, order });
});

router.get('/:id', async (req, res) => {
  const product = await store.getProduct(req.params.id);
  if (!product || product.status !== 'active' || (product.availability !== 'online' && product.availability !== 'both')) {
    return res.status(404).render('404', { title: 'Not Found' });
  }
  const family = await familyForAccount(req.portalAccount.id);
  const optionGroups = await store.availableOptionGroupsForProduct(product.id);
  res.render('store-detail', { title: product.name, product: withImageUrl(product), optionGroups, family, error: req.query.error || null });
});

router.post('/:id/buy', async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  const memberId = parseInt(req.body.memberId, 10);
  if (!family.some((m) => m.id === memberId)) {
    return res.redirect(`/store/${req.params.id}?error=` + encodeURIComponent('You can only buy for yourself or your own family.'));
  }
  const quantity = Math.max(1, parseInt(req.body.quantity, 10) || 1);
  // One <select> per option group (views/store-detail.ejs) - see
  // routes/admin-store.js's own in-person sale route for why
  // Object.values() (not assuming an array) is the safe way to read this
  // regardless of whether express's qs parser treated the group-id keys
  // as object keys or array indices.
  const optionValueIds = Object.values(req.body.optionValues || {})
    .map((id) => parseInt(id, 10))
    .filter(Boolean);
  try {
    const orderId = await store.placeOnlineOrder(memberId, req.portalAccount.id, [{ productId: req.params.id, quantity, optionValueIds }]);
    res.redirect(`/store/orders/${orderId}`);
  } catch (err) {
    res.redirect(`/store/${req.params.id}?error=` + encodeURIComponent(err.message));
  }
});

module.exports = router;
