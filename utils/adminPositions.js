// Settings-managed list of admin/leader position titles (e.g.
// "President", "Treasurer") - a real request: "Under this tab you can add
// a list of admin positions. This list will then appear on the member
// form as a choice in the admin position dropdown menu." Deliberately
// flat (no sections, no reordering) - just add/delete, ordered by
// insertion order via `position`, the simplest shape that satisfies the
// request. Mirrors utils/taskList.js's add/delete pair, just without that
// module's section nesting or barcode badge side effects (an admin
// position is a label on a badge, not a scannable item of its own).
const db = require('../db');

async function listAdminPositions() {
  return db.prepare('SELECT * FROM admin_positions ORDER BY position, LOWER(title)').all();
}

async function nextPosition() {
  const row = await db.prepare('SELECT MAX(position) AS "maxPos" FROM admin_positions').get();
  return (row && row.maxPos != null ? row.maxPos : -1) + 1;
}

// Title is unique (see the admin_positions.title UNIQUE constraint) - a
// duplicate add is silently treated as a no-op success (ON CONFLICT DO
// NOTHING) rather than a 500, the same "adding the same thing twice isn't
// an error" convention families' own add-family flow already follows.
async function addAdminPosition(title) {
  const trimmed = (title || '').trim();
  if (!trimmed) return null;
  const info = await db
    .prepare('INSERT INTO admin_positions (title, position) VALUES (?, ?) ON CONFLICT (title) DO NOTHING')
    .run(trimmed, await nextPosition());
  return info.lastInsertRowid || null;
}

// ON DELETE SET NULL on members.admin_position_id (see the migration's own
// comment) means this never needs to touch the members table itself -
// deleting a position off the list just clears anyone's selection back to
// "none" automatically at the database level.
async function deleteAdminPosition(id) {
  await db.prepare('DELETE FROM admin_positions WHERE id = ?').run(id);
}

module.exports = { listAdminPositions, addAdminPosition, deleteAdminPosition };
