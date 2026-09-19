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

// Batch version of classSectionIds for the Student/Parent "Register for a
// Class" list (routes/student-portal.js) - that page used to call
// classSectionIds once per open class in a loop, a real N+1 (one query
// per class shown, on a page members hit often during registration
// windows). One IN (...) query instead, same shape as utils/
// adminPositions.js's own adminPositionTitlesForMembers. Returns
// { [classId]: [sectionId, ...] }; a class with no restriction rows is
// simply absent from the result (memberSatisfiesRestriction already
// treats "no entry"/undefined the same as an empty array - unrestricted).
async function classSectionIdsForClasses(classIds) {
  if (classIds.length === 0) return {};
  const placeholders = classIds.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT class_id AS "classId", section_id AS "sectionId" FROM class_sections WHERE class_id IN (${placeholders})`).all(...classIds);
  const byClass = {};
  for (const row of rows) {
    if (!byClass[row.classId]) byClass[row.classId] = [];
    byClass[row.classId].push(row.sectionId);
  }
  return byClass;
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

module.exports = { sectionIdsForMember, classSectionIds, classSectionIdsForClasses, eventSectionIds, forumCategorySectionIds, memberSatisfiesRestriction };
