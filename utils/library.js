const db = require('../db');
const { todayISO, formatFriendlyTimestamp, formatDateLabel } = require('./dates');
const { lastNameOf } = require('./members');

async function findMemberByBarcode(barcode) {
  return db.prepare('SELECT * FROM members WHERE barcode = ? AND active = 1').get(barcode);
}

async function findItemByBarcode(barcode) {
  return db.prepare('SELECT * FROM library_items WHERE barcode = ?').get(barcode);
}

// Catalog list - each item also carries whether it's currently checked out,
// so the "All Titles" table can show a status column without a second
// lookup per row.
async function allItems(typeFilter) {
  const sql = `
    SELECT li.*,
      EXISTS(SELECT 1 FROM library_checkouts lc WHERE lc.item_id = li.id AND lc.checked_in_at IS NULL) AS checked_out
    FROM library_items li
    ${typeFilter ? 'WHERE li.type = ?' : ''}
    ORDER BY LOWER(li.title)
  `;
  const rows = typeFilter ? await db.prepare(sql).all(typeFilter) : await db.prepare(sql).all();
  return rows.map((r) => ({ ...r, checkedOut: !!r.checked_out }));
}

// Managed list of item types (mirrors utils used for roster categories) -
// picked from a dropdown when adding/editing an item rather than typed
// freeform.
async function allLibraryTypes() {
  return (await db.prepare('SELECT name FROM library_item_types ORDER BY LOWER(name)').all()).map((r) => r.name);
}

async function isKnownLibraryType(name) {
  return !!(await db.prepare('SELECT 1 FROM library_item_types WHERE name = ?').get(name));
}

async function createLibraryType(name) {
  await db.prepare('INSERT INTO library_item_types (name) VALUES (?) ON CONFLICT (name) DO NOTHING').run(name);
}

async function createItem(title, barcode, type) {
  const info = await db.prepare('INSERT INTO library_items (title, barcode, type) VALUES (?, ?, ?)').run(title, barcode, type || null);
  return info.lastInsertRowid;
}

async function updateItem(id, title, barcode, type) {
  await db.prepare('UPDATE library_items SET title = ?, barcode = ?, type = ? WHERE id = ?').run(title, barcode, type || null, id);
}

async function deleteItem(id) {
  await db.prepare('DELETE FROM library_items WHERE id = ?').run(id);
}

// An item is out if it has a checkout row with no return yet.
async function activeCheckoutForItem(itemId) {
  return db
    .prepare('SELECT * FROM library_checkouts WHERE item_id = ? AND checked_in_at IS NULL')
    .get(itemId);
}

async function checkoutItems(memberId, itemIds, dueDate) {
  const insert = db.prepare('INSERT INTO library_checkouts (member_id, item_id, due_date) VALUES (?, ?, ?)');
  for (const itemId of itemIds) await insert.run(memberId, itemId, dueDate || null);
}

async function returnCheckout(id) {
  await db.prepare("UPDATE library_checkouts SET checked_in_at = now_text() WHERE id = ?").run(id);
}

// Members page: every member who currently has at least one item checked
// out, grouped with what they're holding, when each was checked out, and
// its due date (if one was set at checkout time).
async function membersWithActiveCheckouts() {
  const rows = await db
    .prepare(
      `SELECT lc.id AS checkout_id, lc.checked_out_at, lc.due_date, m.id AS member_id, m.name AS member_name,
              li.title AS item_title
       FROM library_checkouts lc
       JOIN members m ON m.id = lc.member_id
       JOIN library_items li ON li.id = lc.item_id
       WHERE lc.checked_in_at IS NULL
       ORDER BY lc.checked_out_at`
    )
    .all();

  const today = todayISO();
  const byMember = new Map();
  for (const row of rows) {
    if (!byMember.has(row.member_id)) {
      byMember.set(row.member_id, { memberId: row.member_id, memberName: row.member_name, items: [] });
    }
    byMember.get(row.member_id).items.push({
      checkoutId: row.checkout_id,
      title: row.item_title,
      checkedOutAt: formatFriendlyTimestamp(row.checked_out_at),
      dueDate: row.due_date,
      dueDateLabel: row.due_date ? formatDateLabel(row.due_date) : null,
      overdue: !!row.due_date && row.due_date < today,
    });
  }
  // Sorted here (rather than in the SQL) because the row order above drives
  // each member's own items list (oldest checkout first) - re-sorting that
  // same array by last name would scramble it. member/lastNameOf import
  // note: byLastName itself expects a `.name` field; these grouped records
  // carry `memberName` instead, so the comparator is inlined.
  return Array.from(byMember.values()).sort(
    (a, b) =>
      lastNameOf(a.memberName).localeCompare(lastNameOf(b.memberName), undefined, { sensitivity: 'base' }) ||
      a.memberName.localeCompare(b.memberName, undefined, { sensitivity: 'base' })
  );
}

module.exports = {
  findMemberByBarcode,
  findItemByBarcode,
  allItems,
  allLibraryTypes,
  isKnownLibraryType,
  createLibraryType,
  createItem,
  updateItem,
  deleteItem,
  activeCheckoutForItem,
  checkoutItems,
  returnCheckout,
  membersWithActiveCheckouts,
};
