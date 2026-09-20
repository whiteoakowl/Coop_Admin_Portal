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

// --- Product Options ("adding options to a product... a row for the
// option title and the individual price next to it, and box for qty and
// enable/disable button") - replaces the old plain sizes text with a
// real per-option price/stock/enabled row. See this migration's own
// header comment: 20260921010000_store_product_options.sql.

async function optionsForProduct(productId) {
  return db.prepare('SELECT * FROM store_product_options WHERE product_id = ? ORDER BY position, id').all(productId);
}

// Every option this product's own checkout should currently offer - only
// enabled ones, and only ones still in stock (an enabled option with
// quantity 0 is still "on" but has nothing left to sell).
async function availableOptionsForProduct(productId) {
  return (await optionsForProduct(productId)).filter((o) => o.enabled && (o.quantity == null || o.quantity > 0));
}

// Whole-list replace, same "clear and re-insert" shape utils/forums.js's
// own setSubscribers/updateCategorySettings already use for a short,
// admin-curated list - simpler than diffing which rows changed, and a
// past order already snapshotted its own option_name/unit_price_cents,
// so replacing the live rows underneath it changes nothing about what
// that order shows (option_id there is nullable and only ever used to
// link back to a STILL-current option, e.g. for stock decrementing).
async function setProductOptions(productId, options) {
  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM store_product_options WHERE product_id = ?').run(productId);
    let position = 0;
    for (const opt of options) {
      await tx
        .prepare('INSERT INTO store_product_options (product_id, name, price_cents, quantity, enabled, position) VALUES (?, ?, ?, ?, ?, ?)')
        .run(productId, opt.name, opt.priceCents, opt.quantity ?? null, opt.enabled ? 1 : 0, position);
      position += 1;
    }
  });
}

// Shared by both checkout paths: validates every item against live
// product/option rows (never trusting a client-sent price, availability,
// or option), decrements stock, and returns { totalCents, lineItems } or
// throws a plain Error with a message safe to show the buyer directly.
async function buildOrderLines(items, saleType) {
  let totalCents = 0;
  const lineItems = [];
  for (const { productId, quantity, optionId } of items) {
    const product = await getProduct(productId);
    if (!product || product.status !== 'active') throw new Error('That item is no longer available.');
    if (product.availability !== 'both' && product.availability !== saleType) {
      throw new Error(`"${product.name}" isn't available for ${saleType === 'online' ? 'online purchase' : 'in-person sale'}.`);
    }
    const options = await optionsForProduct(product.id);
    let unitPriceCents = product.price_cents;
    let chosenOptionId = null;
    let chosenOptionName = null;
    if (options.length > 0) {
      const option = optionId ? options.find((o) => o.id === Number(optionId) && o.enabled) : null;
      if (!option) throw new Error(`Choose an option for "${product.name}".`);
      if (option.quantity != null && quantity > option.quantity) {
        throw new Error(`Only ${option.quantity} of "${product.name} - ${option.name}" left in stock.`);
      }
      if (option.quantity != null) {
        await db.prepare('UPDATE store_product_options SET quantity = quantity - ? WHERE id = ?').run(quantity, option.id);
      }
      unitPriceCents = option.price_cents;
      chosenOptionId = option.id;
      chosenOptionName = option.name;
    } else if (product.inventory_count != null && quantity > product.inventory_count) {
      throw new Error(`Only ${product.inventory_count} of "${product.name}" left in stock.`);
    }
    if (options.length === 0 && product.inventory_count != null) {
      await db.prepare('UPDATE store_products SET inventory_count = inventory_count - ? WHERE id = ?').run(quantity, product.id);
    }
    totalCents += unitPriceCents * quantity;
    lineItems.push({ productId: product.id, quantity, unitPriceCents, optionId: chosenOptionId, optionName: chosenOptionName });
  }
  return { totalCents, lineItems };
}

async function insertOrderItems(orderId, lineItems) {
  for (const li of lineItems) {
    await db
      .prepare('INSERT INTO store_order_items (order_id, product_id, quantity, unit_price_cents, option_id, option_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(orderId, li.productId, li.quantity, li.unitPriceCents, li.optionId || null, li.optionName || null);
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

// "Store Order page, button called fulfillment totals. Popup, show
// counts for all order that need to be filled" - 'paid' is already what
// "needs fulfillment" means throughout this file (fulfillOrder() above
// only ever moves a 'paid' order to 'fulfilled'), grouped by product +
// option since that's the shape a bulk prep run actually needs counted
// in ("product title, option, qty").
async function fulfillmentTotals() {
  const rows = await db
    .prepare(
      `SELECT COALESCE(p.name, 'Deleted product') AS "productName", i.option_name AS "optionName", SUM(i.quantity) AS qty
       FROM store_order_items i
       JOIN store_orders o ON o.id = i.order_id
       LEFT JOIN store_products p ON p.id = i.product_id
       WHERE o.status = 'paid'
       GROUP BY p.name, i.option_name
       ORDER BY p.name, i.option_name`
    )
    .all();
  return rows.map((r) => ({ productName: r.productName, optionName: r.optionName, qty: Number(r.qty) }));
}

// "Store, analytics sub page. Shows graph of total sales with filter
// drop down for today, this week, month, 3 months, 6 month, 12 months,
// all time. Shows sale totals for each product and product option in a
// card." Only 'paid'/'fulfilled' orders count as a real sale (same
// standard the rest of this file already uses - a still-'pending' online
// order hasn't actually been paid for, and a 'cancelled' one never was).
const ANALYTICS_RANGE_DAYS = { today: 1, week: 7, month: 30, '3months': 90, '6months': 180, '12months': 365, all: null };

function sinceTimestamp(range) {
  const days = ANALYTICS_RANGE_DAYS[range];
  if (!days) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

async function salesAnalytics(range) {
  const since = sinceTimestamp(range);
  const params = since ? [since] : [];
  const orderRows = await db
    .prepare(
      `SELECT o.created_at, o.total_cents FROM store_orders o
       WHERE o.status IN ('paid', 'fulfilled') ${since ? 'AND o.created_at >= ?' : ''}
       ORDER BY o.created_at`
    )
    .all(...params);

  // Daily buckets stay readable through a month of data; a longer range
  // switches to monthly buckets instead of cramming in a bar per day.
  const useMonthly = !ANALYTICS_RANGE_DAYS[range] || ANALYTICS_RANGE_DAYS[range] > 31;
  const buckets = new Map();
  for (const row of orderRows) {
    const key = useMonthly ? row.created_at.slice(0, 7) : row.created_at.slice(0, 10);
    buckets.set(key, (buckets.get(key) || 0) + Number(row.total_cents));
  }
  const dailyTotals = Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, totalCents]) => ({ date, totalCents }));

  const itemRows = await db
    .prepare(
      `SELECT COALESCE(p.name, 'Deleted product') AS "productName", i.option_name AS "optionName", SUM(i.quantity) AS qty, SUM(i.quantity * i.unit_price_cents) AS "totalCents"
       FROM store_order_items i
       JOIN store_orders o ON o.id = i.order_id
       LEFT JOIN store_products p ON p.id = i.product_id
       WHERE o.status IN ('paid', 'fulfilled') ${since ? 'AND o.created_at >= ?' : ''}
       GROUP BY p.name, i.option_name
       ORDER BY "totalCents" DESC`
    )
    .all(...params);

  return {
    totalCents: orderRows.reduce((sum, r) => sum + Number(r.total_cents), 0),
    orderCount: orderRows.length,
    dailyTotals,
    bucketedByMonth: useMonthly,
    byProductOption: itemRows.map((r) => ({ productName: r.productName, optionName: r.optionName, qty: Number(r.qty), totalCents: Number(r.totalCents) })),
  };
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
  optionsForProduct,
  availableOptionsForProduct,
  setProductOptions,
  placeOnlineOrder,
  recordInPersonSale,
  fulfillOrder,
  fulfillmentTotals,
  salesAnalytics,
  ANALYTICS_RANGE_DAYS,
  cancelOrder,
  getOrder,
  ordersForMember,
  allOrders,
};
