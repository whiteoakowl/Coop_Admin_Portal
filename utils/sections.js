// Shared "is this member allowed into this section-restricted thing"
// checks - reused by Parent/Student/Teacher Portal class registration
// (class_sections) and member/public Events (event_sections). A class or
// event with NO rows in its own join table is unrestricted (open to
// everyone) - that's the "empty means unrestricted" convention both
// migrations document on their own join tables, checked here once
// instead of every call site re-deriving it.
const db = require('../db');

async function sectionIdsForMember(memberId) {
  const rows = await db.prepare('SELECT section_id FROM member_sections WHERE member_id = ?').all(memberId);
  return new Set(rows.map((r) => r.section_id));
}

// `joinTable` is 'class_sections' or 'event_sections' - both share the
// exact same (thing_id, section_id) shape, just a different first column
// name, so this one function covers either.
async function restrictedSectionIds(joinTable, idColumn, thingId) {
  const rows = await db.prepare(`SELECT section_id FROM ${joinTable} WHERE ${idColumn} = ?`).all(thingId);
  return rows.map((r) => r.section_id);
}

async function classSectionIds(classId) {
  return restrictedSectionIds('class_sections', 'class_id', classId);
}

async function eventSectionIds(eventId) {
  return restrictedSectionIds('event_sections', 'event_id', eventId);
}

// True if `memberSectionIds` (a Set, from sectionIdsForMember) satisfies
// `restrictionIds` (an array, from classSectionIds/eventSectionIds) -
// unrestricted (empty array) always passes; otherwise the member needs
// to hold at least one of the listed sections.
function memberSatisfiesRestriction(memberSectionIds, restrictionIds) {
  if (!restrictionIds || restrictionIds.length === 0) return true;
  return restrictionIds.some((id) => memberSectionIds.has(id));
}

module.exports = { sectionIdsForMember, classSectionIds, eventSectionIds, memberSatisfiesRestriction };
