// Shared "is this member allowed into this section-restricted thing"
// checks - reused by Parent/Student/Teacher Portal class registration
// (class_sections), member/public Events (event_sections), and Chat
// category visibility (forum_category_sections). A class/event/category
// with NO rows in its own join table is unrestricted (open to everyone) -
// that's the "empty means unrestricted" convention every one of those
// migrations documents on its own join table, checked here once instead
// of every call site re-deriving it.
const db = require('../db');

async function sectionIdsForMember(memberId) {
  const rows = await db.prepare('SELECT section_id FROM member_sections WHERE member_id = ?').all(memberId);
  return new Set(rows.map((r) => r.section_id));
}

// `joinTable` is 'class_sections', 'event_sections', or
// 'forum_category_sections' - all three share the exact same
// (thing_id, section_id) shape, just a different first column name, so
// this one function covers any of them.
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

async function forumCategorySectionIds(categoryId) {
  return restrictedSectionIds('forum_category_sections', 'category_id', categoryId);
}

// True if `memberSectionIds` (a Set, from sectionIdsForMember) satisfies
// `restrictionIds` (an array, from classSectionIds/eventSectionIds) -
// unrestricted (empty array) always passes; otherwise the member needs
// to hold at least one of the listed sections.
function memberSatisfiesRestriction(memberSectionIds, restrictionIds) {
  if (!restrictionIds || restrictionIds.length === 0) return true;
  return restrictionIds.some((id) => memberSectionIds.has(id));
}

module.exports = { sectionIdsForMember, classSectionIds, eventSectionIds, forumCategorySectionIds, memberSatisfiesRestriction };
