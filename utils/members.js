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

// Every active parent-type member - the picker list on the public
// Absence/Late and Name Tag Request forms.
function activeParentOptions() {
  return db.prepare("SELECT id, name FROM members WHERE active = 1 AND member_type = 'parent' ORDER BY name COLLATE NOCASE").all();
}

// Every member is selectable on those forms - no separate opt-in list to
// manage. Groups the full student list by family: parent_id (the primary
// parent) plus member_parents (any additional parents/guardians), so a
// student linked to more than one parent shows up under each of them.
function familyGroupsByParent() {
  const primaryRows = db
    .prepare(
      `SELECT id, name, parent_id AS parentId
       FROM members
       WHERE active = 1 AND member_type = 'student' AND parent_id IS NOT NULL
       ORDER BY name COLLATE NOCASE`
    )
    .all();
  const additionalRows = db
    .prepare(
      `SELECT m.id, m.name, mp.parent_id AS parentId
       FROM member_parents mp
       JOIN members m ON m.id = mp.student_id
       WHERE m.active = 1 AND m.member_type = 'student'
       ORDER BY m.name COLLATE NOCASE`
    )
    .all();
  const byParent = {};
  const seen = new Set();
  [...primaryRows, ...additionalRows].forEach((r) => {
    const key = `${r.parentId}|${r.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!byParent[r.parentId]) byParent[r.parentId] = [];
    byParent[r.parentId].push({ id: r.id, name: r.name });
  });
  return byParent;
}

// Confirms memberId is really part of parentId's family (themselves, or a
// student linked via either parent_id or member_parents) before letting a
// form submission touch that record.
function loadFamilyMember(memberId, parentId) {
  if (memberId === parentId) {
    return db.prepare("SELECT * FROM members WHERE id = ? AND active = 1 AND member_type = 'parent'").get(parentId);
  }
  const direct = db
    .prepare("SELECT * FROM members WHERE id = ? AND parent_id = ? AND active = 1 AND member_type = 'student'")
    .get(memberId, parentId);
  if (direct) return direct;
  return db
    .prepare(
      `SELECT m.* FROM members m
       JOIN member_parents mp ON mp.student_id = m.id
       WHERE m.id = ? AND mp.parent_id = ? AND m.active = 1 AND m.member_type = 'student'`
    )
    .get(memberId, parentId);
}

function additionalParentIdsForStudent(studentId) {
  return db.prepare('SELECT parent_id FROM member_parents WHERE student_id = ?').all(studentId).map((r) => r.parent_id);
}

// Every parent (primary + additional) linked to a student, as full member
// rows - used wherever a profile needs to show "who are this kid's
// parents" rather than just the one primary link.
function allParentsForStudent(student) {
  const ids = new Set(additionalParentIdsForStudent(student.id));
  if (student.parent_id) ids.add(student.parent_id);
  if (ids.size === 0) return [];
  const placeholders = [...ids].map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM members WHERE id IN (${placeholders}) ORDER BY name COLLATE NOCASE`)
    .all(...ids);
}

// Replaces a student's full additional-parent list in one pass (the
// primary parent_id is a separate column, saved separately).
function setAdditionalParents(studentId, parentIds) {
  db.prepare('DELETE FROM member_parents WHERE student_id = ?').run(studentId);
  const link = db.prepare('INSERT OR IGNORE INTO member_parents (student_id, parent_id) VALUES (?, ?)');
  for (const parentId of parentIds) {
    if (parentId !== studentId) link.run(studentId, parentId);
  }
}

module.exports = {
  parseNamesFromUpload,
  findMemberByName,
  activeParentOptions,
  familyGroupsByParent,
  loadFamilyMember,
  additionalParentIdsForStudent,
  allParentsForStudent,
  setAdditionalParents,
};
