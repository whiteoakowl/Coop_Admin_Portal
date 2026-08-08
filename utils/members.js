const db = require('../db');
const { readRowsFromFile } = require('./spreadsheet');
const { ageFromBirthday } = require('./dates');

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

// Every other active member sharing memberId's family_id (any type -
// family is symmetric and not restricted to parent/student). Empty if the
// member isn't connected to anyone.
function familyOf(memberId) {
  const self = db.prepare('SELECT family_id FROM members WHERE id = ?').get(memberId);
  if (!self || self.family_id == null) return [];
  return db
    .prepare('SELECT * FROM members WHERE family_id = ? AND id != ? AND active = 1 ORDER BY name COLLATE NOCASE')
    .all(self.family_id, memberId);
}

// True if any of memberId's family members is 2 years old or younger -
// used to flag a parent as having an infant on floater lists, since a
// floater with an infant may need a different kind of coverage.
function hasInfantChild(memberId) {
  return familyOf(memberId).some((m) => {
    const age = ageFromBirthday(m.birthday);
    return age !== null && age <= 2;
  });
}

// Every other member of each parent's family group, keyed by parent id -
// the public forms render the parent's own checkbox separately, then
// this list, so it deliberately excludes the parent themselves (no more
// "children only" restriction now that family is a symmetric group
// rather than a parent->child link).
function familyGroupsByParent() {
  const parents = db.prepare("SELECT id, name FROM members WHERE active = 1 AND member_type = 'parent'").all();
  const byParent = {};
  for (const p of parents) {
    byParent[p.id] = familyOf(p.id).map((m) => ({ id: m.id, name: m.name }));
  }
  return byParent;
}

// Confirms memberId is really part of parentId's family (themselves, or
// anyone sharing their family_id) before letting a form submission touch
// that record.
function loadFamilyMember(memberId, parentId) {
  if (memberId === parentId) {
    return db.prepare("SELECT * FROM members WHERE id = ? AND active = 1 AND member_type = 'parent'").get(parentId);
  }
  const parent = db.prepare('SELECT family_id FROM members WHERE id = ? AND active = 1').get(parentId);
  if (!parent || parent.family_id == null) return null;
  return db.prepare('SELECT * FROM members WHERE id = ? AND active = 1 AND family_id = ?').get(memberId, parent.family_id);
}

function nextFamilyId() {
  return db.prepare('SELECT COALESCE(MAX(family_id), 0) + 1 AS next FROM members').get().next;
}

// Rebuilds memberId's family group to be exactly {memberId} + otherIds -
// this is a direct "here's who's in my family now" action, not a merge:
// anyone previously grouped with memberId but not in otherIds is dropped
// from the group (and if that leaves their old group down to one person,
// that person is cleared too, since a family of one isn't a family).
// Reuses an existing family_id found among the new group's members if
// there is one (preferring memberId's own), so connecting into an
// existing family doesn't fragment it.
function setFamilyMembers(memberId, otherIds) {
  const uniqueOtherIds = [...new Set(otherIds)].filter((id) => id !== memberId);
  const oldFamilyId = (db.prepare('SELECT family_id FROM members WHERE id = ?').get(memberId) || {}).family_id;

  // Detach anyone who was in memberId's old group but isn't in the new
  // list *before* touching memberId's own family_id - the new group often
  // reuses the same family_id number (nothing new, just re-saving), so
  // doing this after would make a dropped member indistinguishable from
  // one who's staying.
  if (oldFamilyId != null) {
    const stayingIds = new Set([memberId, ...uniqueOtherIds]);
    const oldGroupIds = db.prepare('SELECT id FROM members WHERE family_id = ?').all(oldFamilyId).map((r) => r.id);
    const droppedIds = oldGroupIds.filter((id) => !stayingIds.has(id));
    if (droppedIds.length > 0) {
      const placeholders = droppedIds.map(() => '?').join(',');
      db.prepare(`UPDATE members SET family_id = NULL WHERE id IN (${placeholders})`).run(...droppedIds);
    }
  }

  if (uniqueOtherIds.length === 0) {
    db.prepare('UPDATE members SET family_id = NULL WHERE id = ?').run(memberId);
  } else {
    const groupIds = [memberId, ...uniqueOtherIds];
    const placeholders = groupIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, family_id FROM members WHERE id IN (${placeholders})`).all(...groupIds);
    const selfFamilyId = (rows.find((r) => r.id === memberId) || {}).family_id;
    const anyFamilyId = (rows.find((r) => r.family_id != null) || {}).family_id;
    const familyId = selfFamilyId != null ? selfFamilyId : anyFamilyId != null ? anyFamilyId : nextFamilyId();
    db.prepare(`UPDATE members SET family_id = ? WHERE id IN (${placeholders})`).run(familyId, ...groupIds);
  }

  // If dropping members left the old group down to just one person left,
  // that person isn't meaningfully "family" anymore either.
  if (oldFamilyId != null) {
    const remaining = db.prepare('SELECT id FROM members WHERE family_id = ?').all(oldFamilyId);
    if (remaining.length === 1) db.prepare('UPDATE members SET family_id = NULL WHERE id = ?').run(remaining[0].id);
  }
}

// Only one member per family can be "primary" - marking a new one clears
// the flag off anyone else sharing the same family_id first. A member
// with no family yet can still be marked (harmless - they just sort as
// their own one-person "family" either way).
function setPrimaryParent(memberId, isPrimary) {
  const member = db.prepare('SELECT family_id FROM members WHERE id = ?').get(memberId);
  if (!member) return;
  if (isPrimary && member.family_id != null) {
    db.prepare('UPDATE members SET is_primary_parent = 0 WHERE family_id = ?').run(member.family_id);
  }
  db.prepare('UPDATE members SET is_primary_parent = ? WHERE id = ?').run(isPrimary ? 1 : 0, memberId);
}

// Every active member (any type) with something written in Allergies &
// Medical Notes - the Allergies/Medical log's one data source, shared by
// the Logs tab and the popup button on roster/class view pages.
function membersWithMedicalNotes() {
  return db
    .prepare(
      `SELECT id, name, member_type, grade_level, medical_notes FROM members
       WHERE active = 1 AND medical_notes IS NOT NULL AND TRIM(medical_notes) != ''
       ORDER BY name COLLATE NOCASE`
    )
    .all();
}

module.exports = {
  parseNamesFromUpload,
  findMemberByName,
  activeParentOptions,
  familyGroupsByParent,
  loadFamilyMember,
  familyOf,
  hasInfantChild,
  setFamilyMembers,
  membersWithMedicalNotes,
  setPrimaryParent,
};
