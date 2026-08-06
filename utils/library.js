const db = require('../db');

function findMemberByBarcode(barcode) {
  return db.prepare('SELECT * FROM members WHERE barcode = ? AND active = 1').get(barcode);
}

function findItemByBarcode(barcode) {
  return db.prepare('SELECT * FROM library_items WHERE barcode = ?').get(barcode);
}

function allItems(typeFilter) {
  if (typeFilter) {
    return db.prepare('SELECT * FROM library_items WHERE type = ? ORDER BY title COLLATE NOCASE').all(typeFilter);
  }
  return db.prepare('SELECT * FROM library_items ORDER BY title COLLATE NOCASE').all();
}

function distinctTypes() {
  return db
    .prepare("SELECT DISTINCT type FROM library_items WHERE type IS NOT NULL AND type != '' ORDER BY type COLLATE NOCASE")
    .all()
    .map((r) => r.type);
}

function createItem(title, barcode, type) {
  const info = db.prepare('INSERT INTO library_items (title, barcode, type) VALUES (?, ?, ?)').run(title, barcode, type || null);
  return info.lastInsertRowid;
}

function updateItem(id, title, barcode, type) {
  db.prepare('UPDATE library_items SET title = ?, barcode = ?, type = ? WHERE id = ?').run(title, barcode, type || null, id);
}

function deleteItem(id) {
  db.prepare('DELETE FROM library_items WHERE id = ?').run(id);
}

// An item is out if it has a checkout row with no return yet.
function activeCheckoutForItem(itemId) {
  return db
    .prepare('SELECT * FROM library_checkouts WHERE item_id = ? AND checked_in_at IS NULL')
    .get(itemId);
}

function checkoutItems(memberId, itemIds) {
  const insert = db.prepare('INSERT INTO library_checkouts (member_id, item_id) VALUES (?, ?)');
  for (const itemId of itemIds) insert.run(memberId, itemId);
}

function returnCheckout(id) {
  db.prepare("UPDATE library_checkouts SET checked_in_at = datetime('now') WHERE id = ?").run(id);
}

// Members page: every member who currently has at least one item checked
// out, grouped with what they're holding and when each was checked out.
function membersWithActiveCheckouts() {
  const rows = db
    .prepare(
      `SELECT lc.id AS checkout_id, lc.checked_out_at, m.id AS member_id, m.name AS member_name,
              li.title AS item_title
       FROM library_checkouts lc
       JOIN members m ON m.id = lc.member_id
       JOIN library_items li ON li.id = lc.item_id
       WHERE lc.checked_in_at IS NULL
       ORDER BY m.name COLLATE NOCASE, lc.checked_out_at`
    )
    .all();

  const byMember = new Map();
  for (const row of rows) {
    if (!byMember.has(row.member_id)) {
      byMember.set(row.member_id, { memberId: row.member_id, memberName: row.member_name, items: [] });
    }
    byMember.get(row.member_id).items.push({
      checkoutId: row.checkout_id,
      title: row.item_title,
      checkedOutAt: row.checked_out_at,
    });
  }
  return Array.from(byMember.values());
}

module.exports = {
  findMemberByBarcode,
  findItemByBarcode,
  allItems,
  distinctTypes,
  createItem,
  updateItem,
  deleteItem,
  activeCheckoutForItem,
  checkoutItems,
  returnCheckout,
  membersWithActiveCheckouts,
};
