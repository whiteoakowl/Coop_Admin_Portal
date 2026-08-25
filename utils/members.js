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
// First Name and Last Name are the first two columns/cells (whatever
// they're actually titled - this has always matched by position, not
// header text), joined into the single "First Last" string every member
// is stored as. Positional rather than header-matched because the plain
// .csv/.txt path below has no header-to-value mapping to key off of.
function parseNamesFile(buffer) {
  const text = buffer.toString('utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '')))
    .filter((cells) => cells[0] && cells[0].toLowerCase() !== 'first name')
    .map((cells) => [cells[0], cells[1]].filter(Boolean).join(' '));
}

// Same names-only import, but also accepts .xlsx (SheetJS can't be pointed
// at raw text the way parseNamesFile is, so route by extension). Async
// because readRowsFromFile is - see utils/spreadsheet.js for why.
async function parseNamesFromUpload(buffer, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (ext !== 'xlsx') return parseNamesFile(buffer);

  return (await readRowsFromFile(buffer))
    .map((row) => {
      const [firstKey, lastKey] = Object.keys(row);
      const first = firstKey ? String(row[firstKey] ?? '').trim() : '';
      const last = lastKey ? String(row[lastKey] ?? '').trim() : '';
      return [first, last].filter(Boolean).join(' ');
    })
    .filter(Boolean);
}

// Looks up an existing active member by exact name - never creates one.
// Used everywhere except the Members page itself, which is the only place
// new members get added to the system. An optional memberType restricts the
// match to just 'student' or 'parent' profiles (e.g. Floater Assignments
// and Setup/Cleanup only ever match parents) - or pass an array (e.g.
// ['parent', 'admin']) to match any of several types at once.
async function findMemberByName(name, memberType) {
  if (memberType) {
    const types = Array.isArray(memberType) ? memberType : [memberType];
    return (
      (await db
        .prepare(`SELECT * FROM members WHERE active = 1 AND member_type IN (${types.map(() => '?').join(', ')}) AND LOWER(name) = LOWER(?)`)
        .get(...types, name)) || null
    );
  }
  return (await db.prepare('SELECT * FROM members WHERE active = 1 AND LOWER(name) = LOWER(?)').get(name)) || null;
}

// Every active parent-type member - the picker list on the public
// Absence/Late and Name Tag Request forms.
async function activeParentOptions() {
  return (await db.prepare("SELECT id, name FROM members WHERE active = 1 AND member_type = 'parent'").all()).sort(byLastName);
}

// Same as activeParentOptions above, plus admin/leader members - a real
// request: "admins and parents should show up in the dropdown menu for
// setup/cleanup team member lists." Setup/Cleanup teams are co-op-staffed
// (leader, member, and "add member" pickers alike), and admins are
// regularly the ones actually running a team, so scoping this OUT of
// activeParentOptions itself (rather than just adding 'admin' to that
// function's own WHERE clause) keeps the public Absence/Late and Name Tag
// Request forms parent-only, unaffected - those are the two call sites
// activeParentOptions' own comment already documents, and neither should
// suddenly start offering admin/staff accounts to the public.
async function activeParentAndAdminOptions() {
  return (await db.prepare("SELECT id, name FROM members WHERE active = 1 AND member_type IN ('parent', 'admin')").all()).sort(byLastName);
}

// Every active member, any type - a real request: "the drop down menu of
// names should include all members admin, primary parent, parent and
// student" for the Name Tag Request form specifically, since a student
// old enough to notice a lost tag or a schedule change shouldn't need a
// parent to submit the request for them. Deliberately its own function
// rather than widening activeParentAndAdminOptions itself, for the exact
// same reason that one exists separately from activeParentOptions -
// Absence/Late (routes/absence.js) shares activeParentAndAdminOptions and
// stays parent+admin-only; only Name Tag moves to every member type.
async function activeMemberOptions() {
  return (await db.prepare('SELECT id, name, member_type FROM members WHERE active = 1').all()).sort(byLastName);
}

// Every other active member sharing memberId's family_id (any type -
// family is symmetric and not restricted to parent/student). Empty if the
// member isn't connected to anyone.
async function familyOf(memberId) {
  const self = await db.prepare('SELECT family_id FROM members WHERE id = ?').get(memberId);
  if (!self || self.family_id == null) return [];
  return (await db.prepare('SELECT * FROM members WHERE family_id = ? AND id != ? AND active = 1').all(self.family_id, memberId)).sort(byLastName);
}

// True if any of memberId's family members is 2 years old or younger -
// used to flag a parent as having an infant on floater lists, since a
// floater with an infant may need a different kind of coverage.
async function hasInfantChild(memberId) {
  return (await familyOf(memberId)).some((m) => {
    const age = ageFromBirthday(m.birthday);
    return age !== null && age <= 2;
  });
}

// Every other member of each parent's (or admin's - see
// activeParentAndAdminOptions' own comment) family group, keyed by parent
// id - the public forms render the parent's own checkbox separately, then
// this list, so it deliberately excludes the parent themselves (no more
// "children only" restriction now that family is a symmetric group
// rather than a parent->child link).
async function familyGroupsByParent() {
  const parents = (
    await db.prepare("SELECT id, name FROM members WHERE active = 1 AND member_type IN ('parent', 'admin')").all()
  ).sort(byLastName);
  const byParent = {};
  for (const p of parents) {
    byParent[p.id] = (await familyOf(p.id)).map((m) => ({ id: m.id, name: m.name }));
  }
  return byParent;
}

// Same shape/purpose as familyGroupsByParent above, but for the Name Tag
// Request form's own wider activeMemberOptions() picker (any member type,
// not just parent/admin) - takes the already-fetched member list instead
// of re-querying its own, since the caller needs that same list for the
// picker dropdown anyway.
async function familyGroupsByMember(members) {
  const byMember = {};
  for (const m of members) {
    byMember[m.id] = (await familyOf(m.id)).map((x) => ({ id: x.id, name: x.name }));
  }
  return byMember;
}

// Confirms memberId is really part of parentId's family (themselves, or
// anyone sharing their family_id) before letting a form submission touch
// that record. parentId is whatever was picked from a parents-picker
// dropdown (activeParentAndAdminOptions, familyGroupsByParent above) - an
// admin, not just a literal 'parent'-type member, is a valid pick there.
async function loadFamilyMember(memberId, parentId) {
  if (memberId === parentId) {
    return db.prepare("SELECT * FROM members WHERE id = ? AND active = 1 AND member_type IN ('parent', 'admin')").get(parentId);
  }
  const parent = await db.prepare('SELECT family_id FROM members WHERE id = ? AND active = 1').get(parentId);
  if (!parent || parent.family_id == null) return null;
  return db.prepare('SELECT * FROM members WHERE id = ? AND active = 1 AND family_id = ?').get(memberId, parent.family_id);
}

// Same as loadFamilyMember above, except the self-selection branch allows
// ANY active member type, not just parent/admin - Name Tag Request's own
// activeMemberOptions() picker lets a student pick themselves too, and
// this is what actually validates that pick server-side once the form is
// submitted. Kept separate from loadFamilyMember itself (rather than
// widening it in place) so Absence/Late, which still shares that
// function, is provably unaffected - its own picker never offers a
// student's id as requesterId to begin with, but this way there's no
// ambiguity about it either.
async function loadFamilyMemberAnyType(memberId, requesterId) {
  if (memberId === requesterId) {
    return db.prepare('SELECT * FROM members WHERE id = ? AND active = 1').get(requesterId);
  }
  const requester = await db.prepare('SELECT family_id FROM members WHERE id = ? AND active = 1').get(requesterId);
  if (!requester || requester.family_id == null) return null;
  return db.prepare('SELECT * FROM members WHERE id = ? AND active = 1 AND family_id = ?').get(memberId, requester.family_id);
}

// Every family an admin has created ("+ Add Family" on the Members page) -
// the full list backing the "Choose a Family" dropdown on the member form.
// A family only ever appears there once it's been added here first.
// memberCount (active members currently in that family) is included for
// the form's "The Anderson Family - 2 members" checklist display.
async function allFamilies() {
  return db
    .prepare(
      `SELECT f.id, f.name, COUNT(m.id) AS "memberCount"
       FROM families f
       LEFT JOIN members m ON m.family_id = f.id AND m.active = 1
       GROUP BY f.id
       ORDER BY LOWER(f.name)`
    )
    .all();
}

// Directly assigns memberId to an existing family (or clears it with a
// null/blank familyId) - the single "Choose a Family" dropdown replaces
// the old "pick your other family members" checkbox list, so this is a
// plain assignment rather than a group-rebuild. Silently no-ops (leaves
// family_id untouched) if familyId doesn't match a real family, so a
// tampered/stale form value can't attach a member to a bogus id.
async function setMemberFamily(memberId, familyId) {
  if (familyId == null) {
    await db.prepare('UPDATE members SET family_id = NULL WHERE id = ?').run(memberId);
    return;
  }
  const exists = await db.prepare('SELECT id FROM families WHERE id = ?').get(familyId);
  if (!exists) return;
  await db.prepare('UPDATE members SET family_id = ? WHERE id = ?').run(familyId, memberId);
}

// Only one member per family can be "primary" - marking a new one clears
// the flag off anyone else sharing the same family_id first. A member
// with no family yet can still be marked (harmless - they just sort as
// their own one-person "family" either way).
async function setPrimaryParent(memberId, isPrimary) {
  const member = await db.prepare('SELECT family_id FROM members WHERE id = ?').get(memberId);
  if (!member) return;
  if (isPrimary && member.family_id != null) {
    await db.prepare('UPDATE members SET is_primary_parent = 0 WHERE family_id = ?').run(member.family_id);
  }
  await db.prepare('UPDATE members SET is_primary_parent = ? WHERE id = ?').run(isPrimary ? 1 : 0, memberId);
}

// Every active member (any type) with something written in Allergies &
// Medical Notes - the Allergies/Medical log's one data source, shared by
// the Logs tab and the popup button on roster/class view pages.
async function membersWithMedicalNotes() {
  return (
    await db
      .prepare(
        `SELECT id, name, member_type, grade_level, medical_notes FROM members
         WHERE active = 1 AND medical_notes IS NOT NULL AND TRIM(medical_notes) != ''`
      )
      .all()
  ).sort(byLastName);
}

async function rostersForMember(memberId) {
  return db
    .prepare(
      `SELECT r.* FROM rosters r
       JOIN roster_members rm ON rm.roster_id = r.id
       WHERE rm.member_id = ? ORDER BY LOWER(r.name)`
    )
    .all(memberId);
}

// Same data as calling rostersForMember once per id, but as one query -
// membersWithDetails (the Members list, every member on the page at
// once) used to call rostersForMember in a .map(), one extra query per
// row. Returns a Map so a caller iterating members can just
// `.get(m.id) || []` instead of re-filtering a flat list per member.
async function rostersByMemberIds(memberIds) {
  const byId = new Map();
  if (memberIds.length === 0) return byId;
  const placeholders = memberIds.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT rm.member_id AS "memberId", r.* FROM rosters r
       JOIN roster_members rm ON rm.roster_id = r.id
       WHERE rm.member_id IN (${placeholders}) ORDER BY LOWER(r.name)`
    )
    .all(...memberIds);
  for (const row of rows) {
    const { memberId, ...roster } = row;
    if (!byId.has(memberId)) byId.set(memberId, []);
    byId.get(memberId).push(roster);
  }
  return byId;
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

// Every member id who teaches at least one class (class_staff.role =
// 'teacher') - a Set so membersWithDetails can do an O(1) lookup per
// member instead of a per-member query. Assistants don't count as
// teachers here (a separate role in the same table) - the Design/Print
// hub's "Teachers Only" filter is specifically for who to hand a class
// roster/mailing label to as the instructor of record.
async function teacherMemberIds() {
  const rows = await db.prepare("SELECT DISTINCT member_id FROM class_staff WHERE role = 'teacher'").all();
  return new Set(rows.map((r) => r.member_id));
}

// Family is now a named entity (families.name, e.g. "Anderson") rather
// than a list of everyone else sharing family_id - a plain left join gets
// each member's family surname in one query instead of the old per-member
// familyOf() lookup. Shared by the Members page and any other member list
// that wants that same photo/type/family/rosters shape (e.g. the Design/
// Print hub's bulk print picker lists).
async function membersWithDetails(typeFilter, familyId) {
  const allMembers = await db.prepare('SELECT m.*, f.name AS family_name FROM members m LEFT JOIN families f ON f.id = m.family_id').all();
  let members = typeFilter ? allMembers.filter((m) => m.member_type === typeFilter) : allMembers;
  if (familyId) members = members.filter((m) => m.family_id === familyId);
  const sorted = sortMembersByFamily(members);
  const rostersById = await rostersByMemberIds(sorted.map((m) => m.id));
  const teacherIds = await teacherMemberIds();
  return sorted.map((m) => ({
    ...m,
    rosters: rostersById.get(m.id) || [],
    familyName: m.family_name || null,
    isTeacher: teacherIds.has(m.id),
  }));
}

// Every member's permanent 6-digit ID, assigned once here at creation and
// never touched again afterward (not even if their name later changes) -
// see db/schema.sql's member_code column comment. barcode is set to match
// it at creation time too, so every member's printed barcode is the same
// fixed length regardless of how long their name is (db/index.js's
// migration backfills this same way for every member who predates it).
async function generateMemberCode() {
  const exists = db.prepare('SELECT 1 FROM members WHERE member_code = ?');
  let code;
  do {
    code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  } while (await exists.get(code));
  return code;
}

module.exports = {
  parseNamesFromUpload,
  findMemberByName,
  activeParentOptions,
  activeParentAndAdminOptions,
  activeMemberOptions,
  familyGroupsByParent,
  familyGroupsByMember,
  loadFamilyMember,
  loadFamilyMemberAnyType,
  familyOf,
  hasInfantChild,
  allFamilies,
  setMemberFamily,
  membersWithMedicalNotes,
  setPrimaryParent,
  rostersForMember,
  rostersByMemberIds,
  sortMembersByFamily,
  membersWithDetails,
  lastNameOf,
  byLastName,
  generateMemberCode,
};
