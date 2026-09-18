// Store (Community & Commerce track, item 8). Checkout - both online and
// in-person - is wired through utils/payments.js's own charge/payment
// abstraction rather than a parallel "did they pay" flag. See
// supabase/migrations/20260825090000_store.sql for the schema and its
// own comments on why an in-person sale is structurally distinct from an
// online order, not just a status string; see
// supabase/migrations/20260918030000_store_categories_and_sizes.sql for
// categories and per-product sizes.
const db = require('../db');
const payments = require('./payments');

function parseSizes(sizes) {
  if (!sizes) return [];
  return sizes.split(',').map((s) => s.trim()).filter(Boolean);
}

async function listCategories() {
  return db.prepare('SELECT * FROM store_categories ORDER BY name').all();
}

async function getCategory(id) {
  return db.prepare('SELECT * FROM store_categories WHERE id = ?').get(id);
}

async function addCategory(name) {
  const info = await db.prepare('INSERT INTO store_categories (name) VALUES (?)').run(name);
  return info.lastInsertRowid;
}

async function renameCategory(id, name) {
  await db.prepare('UPDATE store_categories SET name = ? WHERE id = ?').run(name, id);
}

async function deleteCategory(id) {
  await db.prepare('DELETE FROM store_categories WHERE id = ?').run(id);
}

async function listProducts({ status, availability, categoryId } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('p.status = ?');
    params.push(status);
  }
  if (availability) {
    clauses.push("(p.availability = ? OR p.availability = 'both')");
    params.push(availability);
  }
  if (categoryId) {
    clauses.push('p.category_id = ?');
    params.push(categoryId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT p.*, c.name AS "categoryName" FROM store_products p LEFT JOIN store_categories c ON c.id = p.category_id ${where} ORDER BY p.name`).all(...params);
}

async function getProduct(id) {
  return db.prepare('SELECT p.*, c.name AS "categoryName" FROM store_products p LEFT JOIN store_categories c ON c.id = p.category_id WHERE p.id = ?').get(id);
}

async function createProduct(data, accountId) {
  const info = await db
    .prepare('INSERT INTO store_products (name, description, price_cents, inventory_count, availability, category_id, sizes, created_by_account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(data.name, data.description || null, data.priceCents, data.inventoryCount ?? null, data.availability, data.categoryId ?? null, data.sizes || null, accountId);
  return info.lastInsertRowid;
}

async function updateProduct(id, data) {
  await db
    .prepare('UPDATE store_products SET name = ?, description = ?, price_cents = ?, inventory_count = ?, availability = ?, category_id = ?, sizes = ?, updated_at = now_text() WHERE id = ?')
    .run(data.name, data.description || null, data.priceCents, data.inventoryCount ?? null, data.availability, data.categoryId ?? null, data.sizes || null, id);
}

async function setProductStatus(id, status) {
  await db.prepare('UPDATE store_products SET status = ?, updated_at = now_text() WHERE id = ?').run(status, id);
}

async function setProductImage(id, imageKey) {
  await db.prepare('UPDATE store_products SET image_key = ?, updated_at = now_text() WHERE id = ?').run(imageKey, id);
}

async function deleteProduct(id) {
  await db.prepare('DELETE FROM store_products WHERE id = ?').run(id);
}

// Shared by both checkout paths: validates every item against live
// product rows (never trusting a client-sent price, availability, or
// size), decrements inventory, and returns { totalCents, lineItems } or
// throws a plain Error with a message safe to show the buyer directly.
async function buildOrderLines(items, saleType) {
  let totalCents = 0;
  const lineItems = [];
  for (const { productId, quantity, size } of items) {
    const product = await getProduct(productId);
    if (!product || product.status !== 'active') throw new Error('That item is no longer available.');
    if (product.availability !== 'both' && product.availability !== saleType) {
      throw new Error(`"${product.name}" isn't available for ${saleType === 'online' ? 'online purchase' : 'in-person sale'}.`);
    }
    const availableSizes = parseSizes(product.sizes);
    let chosenSize = null;
    if (availableSizes.length > 0) {
      if (!size || !availableSizes.includes(size)) throw new Error(`Choose a size for "${product.name}".`);
      chosenSize = size;
    }
    if (product.inventory_count != null && quantity > product.inventory_count) {
      throw new Error(`Only ${product.inventory_count} of "${product.name}" left in stock.`);
    }
    if (product.inventory_count != null) {
      await db.prepare('UPDATE store_products SET inventory_count = inventory_count - ? WHERE id = ?').run(quantity, product.id);
    }
    totalCents += product.price_cents * quantity;
    lineItems.push({ productId: product.id, quantity, unitPriceCents: product.price_cents, size: chosenSize });
  }
  return { totalCents, lineItems };
}

async function insertOrderItems(orderId, lineItems) {
  for (const li of lineItems) {
    await db.prepare('INSERT INTO store_order_items (order_id, product_id, quantity, unit_price_cents, size) VALUES (?, ?, ?, ?, ?)').run(orderId, li.productId, li.quantity, li.unitPriceCents, li.size || null);
  }
}

// Member-facing online checkout - the order and its charge both start
// unpaid; a Main Admin records the real payment later through Accounting,
// same as every other charge in this app.
async function placeOnlineOrder(memberId, accountId, items) {
  const { totalCents, lineItems } = await buildOrderLines(items, 'online');
  const orderInfo = await db.prepare("INSERT INTO store_orders (member_id, placed_by_account_id, sale_type, total_cents) VALUES (?, ?, 'online', ?)").run(memberId, accountId, totalCents);
  const orderId = orderInfo.lastInsertRowid;
  await insertOrderItems(orderId, lineItems);
  const chargeId = await payments.createCharge(memberId, accountId, 'store_order', orderId, `Store order #${orderId}`, totalCents);
  await db.prepare('UPDATE store_orders SET charge_id = ? WHERE id = ?').run(chargeId, orderId);
  return orderId;
}

// Admin-only, in-person sale - paid in full in the very same action that
// creates it, since real money already changed hands before the admin
// ever opens this form. memberId can be any member, including one with
// no portal account. items can be several different products/sizes in
// one cart, not just one line.
async function recordInPersonSale(memberId, recordingAccountId, items) {
  const { totalCents, lineItems } = await buildOrderLines(items, 'in_person');
  const orderInfo = await db.prepare("INSERT INTO store_orders (member_id, placed_by_account_id, sale_type, status, total_cents) VALUES (?, ?, 'in_person', 'paid', ?)").run(memberId, recordingAccountId, totalCents);
  const orderId = orderInfo.lastInsertRowid;
  await insertOrderItems(orderId, lineItems);
  const chargeId = await payments.createCharge(memberId, recordingAccountId, 'store_order', orderId, `In-person purchase #${orderId}`, totalCents);
  await payments.recordPayment(chargeId, totalCents, 'manual', recordingAccountId, 'Recorded at time of in-person sale');
  await db.prepare('UPDATE store_orders SET charge_id = ? WHERE id = ?').run(chargeId, orderId);
  return orderId;
}

async function fulfillOrder(id) {
  await db.prepare("UPDATE store_orders SET status = 'fulfilled', fulfilled_at = now_text() WHERE id = ? AND status = 'paid'").run(id);
}

// Restores any inventory the order held and cancels its linked charge -
// a cancelled order should never still show as owed in Accounting.
async function cancelOrder(id) {
  const order = await getOrder(id);
  if (!order || order.status === 'cancelled') return;
  for (const item of order.items) {
    if (item.product_id) await db.prepare('UPDATE store_products SET inventory_count = inventory_count + ? WHERE id = ? AND inventory_count IS NOT NULL').run(item.quantity, item.product_id);
  }
  await db.prepare("UPDATE store_orders SET status = 'cancelled', cancelled_at = now_text() WHERE id = ?").run(id);
  if (order.charge_id) await payments.cancelCharge(order.charge_id);
}

async function getOrder(id) {
  const order = await db.prepare('SELECT o.*, m.name AS "memberName" FROM store_orders o JOIN members m ON m.id = o.member_id WHERE o.id = ?').get(id);
  if (!order) return null;
  order.items = await db
    .prepare(`SELECT i.*, p.name AS "productName" FROM store_order_items i LEFT JOIN store_products p ON p.id = i.product_id WHERE i.order_id = ?`)
    .all(id);
  return order;
}

async function ordersForMember(memberId) {
  return db.prepare('SELECT * FROM store_orders WHERE member_id = ? ORDER BY created_at DESC').all(memberId);
}

async function allOrders() {
  return db.prepare('SELECT o.*, m.name AS "memberName" FROM store_orders o JOIN members m ON m.id = o.member_id ORDER BY o.created_at DESC').all();
}

module.exports = {
  parseSizes,
  listCategories,
  getCategory,
  addCategory,
  renameCategory,
  deleteCategory,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  setProductStatus,
  setProductImage,
  deleteProduct,
  placeOnlineOrder,
  recordInPersonSale,
  fulfillOrder,
  cancelOrder,
  getOrder,
  ordersForMember,
  allOrders,
};
