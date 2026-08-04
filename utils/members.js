const db = require('../db');
const { readRowsFromFile } = require('./spreadsheet');

// Names-only file (.csv/.txt), one name per line or name in the first column.
function parseNamesFile(buffer) {
  const text = buffer.toString('utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.split(',')[0].trim().replace(/^"|"$/g, ''))
    .filter((name) => name && name.toLowerCase() !== 'name');
}

// Same names-only import, but also accepts .xlsx (SheetJS can't be pointed
// at raw text the way parseNamesFile is, so route by extension).
function parseNamesFromUpload(buffer, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (ext !== 'xlsx') return parseNamesFile(buffer);

  return readRowsFromFile(buffer)
    .map((row) => {
      const firstKey = Object.keys(row)[0];
      return firstKey ? String(row[firstKey]).trim() : '';
    })
    .filter((name) => name && name.toLowerCase() !== 'name');
}

// Finds an existing active member by exact name, or creates one. Barcode
// scanners here read a person's name directly, so a new member's barcode
// defaults to their name unless that value is already taken.
function findOrCreateMemberByName(name) {
  const existing = db.prepare('SELECT * FROM members WHERE active = 1 AND name = ? COLLATE NOCASE').get(name);
  if (existing) return { member: existing, created: false };

  let barcode = name;
  if (db.prepare('SELECT id FROM members WHERE barcode = ?').get(barcode)) {
    barcode = `${name} (${Date.now().toString(36)})`;
  }
  const info = db.prepare('INSERT INTO members (name, barcode) VALUES (?, ?)').run(name, barcode);
  return { member: { id: info.lastInsertRowid, name, barcode }, created: true };
}

// Looks up an existing active member by exact name - never creates one.
// Used everywhere except the Members page itself, which is the only place
// new members get added to the system. An optional memberType restricts the
// match to just 'student' or 'parent' profiles (e.g. Floater Assignments
// and Setup/Cleanup only ever match parents).
function findMemberByName(name, memberType) {
  if (memberType) {
    return (
      db
        .prepare('SELECT * FROM members WHERE active = 1 AND member_type = ? AND name = ? COLLATE NOCASE')
        .get(memberType, name) || null
    );
  }
  return db.prepare('SELECT * FROM members WHERE active = 1 AND name = ? COLLATE NOCASE').get(name) || null;
}

module.exports = { parseNamesFile, parseNamesFromUpload, findOrCreateMemberByName, findMemberByName };
