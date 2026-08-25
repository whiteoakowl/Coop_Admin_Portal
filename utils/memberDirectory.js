// Member Directory (Community & Commerce track, item 5). Reads live from
// the existing members/families tables (Track A's domain - read-only
// here, never altered) rather than keeping a second copy of member data.
// See supabase/migrations/20260825050000_member_directory.sql's own
// comment for why the field catalog is a fixed allowlist rather than
// every members column.
const db = require('../db');

const DIRECTORY_FIELDS = [
  { key: 'photo', label: 'Photo' },
  { key: 'phone', label: 'Phone Number' },
  { key: 'email', label: 'Email' },
  { key: 'address', label: 'Address' },
  { key: 'grade_level', label: 'Grade Level' },
  { key: 'family', label: 'Family Name' },
];

// A field with no saved row is treated as off - a fresh install starts
// with nothing exposed until a Main Admin deliberately turns fields on,
// rather than defaulting to "everything visible."
async function getFieldSettings() {
  const rows = await db.prepare('SELECT field_key, visible FROM member_directory_field_settings').all();
  const visibleByKey = new Map(rows.map((r) => [r.field_key, r.visible === 1]));
  return DIRECTORY_FIELDS.map((f) => ({ ...f, visible: visibleByKey.get(f.key) || false }));
}

async function setFieldVisibility(visibleKeys) {
  const allowedKeys = new Set(DIRECTORY_FIELDS.map((f) => f.key));
  for (const field of DIRECTORY_FIELDS) {
    const visible = visibleKeys.includes(field.key) && allowedKeys.has(field.key) ? 1 : 0;
    await db
      .prepare(
        `INSERT INTO member_directory_field_settings (field_key, visible, updated_at) VALUES (?, ?, now_text())
         ON CONFLICT (field_key) DO UPDATE SET visible = excluded.visible, updated_at = now_text()`
      )
      .run(field.key, visible);
  }
}

async function isOptedOut(memberId) {
  return !!(await db.prepare('SELECT 1 FROM member_directory_opt_outs WHERE member_id = ?').get(memberId));
}

async function setOptedOut(memberId, optedOut) {
  if (optedOut) {
    await db.prepare('INSERT INTO member_directory_opt_outs (member_id) VALUES (?) ON CONFLICT (member_id) DO NOTHING').run(memberId);
  } else {
    await db.prepare('DELETE FROM member_directory_opt_outs WHERE member_id = ?').run(memberId);
  }
}

// Every active member not opted out, with their family's name attached
// (for the 'family' field, when a Main Admin has turned it on) - the raw
// row set a route then filters down to only the admin-enabled fields
// before ever rendering it.
async function listDirectoryMembers() {
  return db
    .prepare(
      `SELECT m.*, f.name AS family_name
       FROM members m
       LEFT JOIN families f ON f.id = m.family_id
       WHERE m.active = 1 AND m.id NOT IN (SELECT member_id FROM member_directory_opt_outs)
       ORDER BY LOWER(m.name)`
    )
    .all();
}

async function getDirectoryMember(id) {
  return db
    .prepare(
      `SELECT m.*, f.name AS family_name
       FROM members m
       LEFT JOIN families f ON f.id = m.family_id
       WHERE m.id = ? AND m.active = 1 AND m.id NOT IN (SELECT member_id FROM member_directory_opt_outs)`
    )
    .get(id);
}

module.exports = {
  DIRECTORY_FIELDS,
  getFieldSettings,
  setFieldVisibility,
  isOptedOut,
  setOptedOut,
  listDirectoryMembers,
  getDirectoryMember,
};
