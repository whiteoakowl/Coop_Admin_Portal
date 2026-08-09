const db = require('../db');
const { readRowsFromFile } = require('./spreadsheet');
const { ageFromBirthday } = require('./dates');

// Everywhere a member list sorts "alphabetically by last name" (the
// Members page's family groups, every roster view) - names are stored as
// a single "First Last" string, so the last name is just the final
// whitespace-separated token. Good enough for this app's real member
// names (no attempt at suffixes/multi-word surnames).
function lastNameOf(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}
function byLastName(a, b) {
  return (
    lastNameOf(a.name).localeCompare(lastNameOf(b.name), undefined, { sensitivity: 'base' }) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
}

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

// Every family an admin has created ("+ Add Family" on the Members page) -
// the full list backing the "Choose a Family" dropdown on the member form.
// A family only ever appears there once it's been added here first.
// memberCount (active members currently in that family) is included for
// the form's "The Anderson Family - 2 members" checklist display.
function allFamilies() {
  return db
    .prepare(
      `SELECT f.id, f.name, COUNT(m.id) AS memberCount
       FROM families f
       LEFT JOIN members m ON m.family_id = f.id AND m.active = 1
       GROUP BY f.id
       ORDER BY f.name COLLATE NOCASE`
    )
    .all();
}

// Directly assigns memberId to an existing family (or clears it with a
// null/blank familyId) - the single "Choose a Family" dropdown replaces
// the old "pick your other family members" checkbox list, so this is a
// plain assignment rather than a group-rebuild. Silently no-ops (leaves
// family_id untouched) if familyId doesn't match a real family, so a
// tampered/stale form value can't attach a member to a bogus id.
function setMemberFamily(memberId, familyId) {
  if (familyId == null) {
    db.prepare('UPDATE members SET family_id = NULL WHERE id = ?').run(memberId);
    return;
  }
  const exists = db.prepare('SELECT id FROM families WHERE id = ?').get(familyId);
  if (!exists) return;
  db.prepare('UPDATE members SET family_id = ? WHERE id = ?').run(familyId, memberId);
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

function rostersForMember(memberId) {
  return db
    .prepare(
      `SELECT r.* FROM rosters r
       JOIN roster_members rm ON rm.roster_id = r.id
       WHERE rm.member_id = ? ORDER BY r.name COLLATE NOCASE`
    )
    .all(memberId);
}

// Groups members by family (family_id, or a solo "family of one" for
// anyone without one), sorted alphabetically by the group's own sort
// name - the primary parent's name if one's been designated, otherwise
// whichever member's name sorts first. Within a group, the primary
// parent is always listed first, everyone else alphabetically after.
// Inactive members are kept out of the family grouping entirely (sunk
// to the bottom, plain alphabetical) so a former member doesn't drag
// their old family's sort position around.
function sortMembersByFamily(members) {
  const active = members.filter((m) => m.active);
  const inactive = members.filter((m) => !m.active).sort(byLastName);

  const groups = new Map();
  active.forEach((m) => {
    const key = m.family_id != null ? `f${m.family_id}` : `solo${m.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });

  const orderedGroups = Array.from(groups.values()).map((group) => {
    const primary = group.find((m) => m.is_primary_parent);
    group.sort((a, b) => {
      if (a === primary) return -1;
      if (b === primary) return 1;
      return byLastName(a, b);
    });
    // Groups themselves sort by the primary parent's (or, lacking one,
    // the alphabetically-first member's) last name - a family reads
    // together as one block, filed under its own surname.
    const sortName = lastNameOf((primary || group[0]).name);
    return { sortName, group };
  });
  orderedGroups.sort((a, b) => a.sortName.localeCompare(b.sortName, undefined, { sensitivity: 'base' }));

  return [...orderedGroups.flatMap((g) => g.group), ...inactive];
}

// Family is now a named entity (families.name, e.g. "Anderson") rather
// than a list of everyone else sharing family_id - a plain left join gets
// each member's family surname in one query instead of the old per-member
// familyOf() lookup. Shared by the Members page and any other member list
// that wants that same photo/type/family/rosters shape (e.g. the Design/
// Print hub's bulk print picker lists).
function membersWithDetails(typeFilter) {
  const allMembers = db
    .prepare('SELECT m.*, f.name AS family_name FROM members m LEFT JOIN families f ON f.id = m.family_id')
    .all();
  const members = typeFilter ? allMembers.filter((m) => m.member_type === typeFilter) : allMembers;
  return sortMembersByFamily(members).map((m) => ({
    ...m,
    rosters: rostersForMember(m.id),
    familyName: m.family_name || null,
  }));
}

module.exports = {
  parseNamesFromUpload,
  findMemberByName,
  activeParentOptions,
  familyGroupsByParent,
  loadFamilyMember,
  familyOf,
  hasInfantChild,
  allFamilies,
  setMemberFamily,
  membersWithMedicalNotes,
  setPrimaryParent,
  rostersForMember,
  sortMembersByFamily,
  membersWithDetails,
  lastNameOf,
  byLastName,
};
