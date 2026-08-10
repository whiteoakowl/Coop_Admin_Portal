// Global admin search (Phase 4 audit item). A single query box that finds
// a member by name or barcode and, for each match, surfaces which of the
// other three areas (Attendance, Floater Assignments, Library) they show
// up in - plus a separate section for Library items themselves, which
// aren't tied to any one member. "Search across Members/Attendance/
// Floater/Library" is scoped this way (member lookup + cross-links,
// rather than four independent free-text searches) because Attendance and
// Floater Assignments aren't themselves free-text-searchable data - a
// roster/volunteer-list entry has no title or description, only a member
// it points at - so a member's name is already the only meaningful search
// key for those two areas.
//
// Filters an already-fetched member/item list in JS rather than a SQL
// LIKE query - the same in-memory-substring-match approach
// utils/schedule.js's scheduleList() already uses for its own name
// search, and it sidesteps LIKE's %/_ wildcard-escaping edge case
// entirely (a search for "50%" behaves exactly like searching for the
// literal text "50%", not a wildcard). Cheap either way at this app's
// scale - member and library-item counts are always small.
//
// Per-member cross-link checks are a handful of narrow EXISTS/COUNT
// queries rather than one large join, since the result set here is
// always small (at most MAX_RESULTS matches) - the cost of a few extra
// small, already-indexed-by-member_id queries is negligible next to the
// readability of keeping each concern separate.
const db = require('../db');

const MAX_RESULTS = 20;

function matches(haystack, q) {
  return (haystack || '').toLowerCase().includes(q);
}

function searchMembers(q) {
  const all = db.prepare('SELECT id, name, member_type, barcode FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE').all();
  return all
    .filter((m) => matches(m.name, q) || matches(m.barcode, q))
    .slice(0, MAX_RESULTS)
    .map((m) => ({
      id: m.id,
      name: m.name,
      memberType: m.member_type,
      hasAttendance: !!db.prepare('SELECT 1 FROM attendance WHERE member_id = ? LIMIT 1').get(m.id),
      isFloater: !!db.prepare('SELECT 1 FROM volunteer_members WHERE member_id = ? LIMIT 1').get(m.id),
      activeLibraryCheckouts: db
        .prepare('SELECT COUNT(*) AS c FROM library_checkouts WHERE member_id = ? AND checked_in_at IS NULL')
        .get(m.id).c,
    }));
}

function searchLibraryItems(q) {
  const all = db.prepare('SELECT id, title, barcode, type FROM library_items ORDER BY title COLLATE NOCASE').all();
  return all
    .filter((i) => matches(i.title, q) || matches(i.barcode, q))
    .slice(0, MAX_RESULTS)
    .map((i) => ({
      id: i.id,
      title: i.title,
      barcode: i.barcode,
      type: i.type,
      checkedOut: !!db.prepare('SELECT 1 FROM library_checkouts WHERE item_id = ? AND checked_in_at IS NULL').get(i.id),
    }));
}

function globalSearch(query) {
  const trimmed = (query || '').trim();
  if (!trimmed) return { query: '', members: [], libraryItems: [] };
  const q = trimmed.toLowerCase();
  return {
    query: trimmed, // original casing, for display (e.g. "Results for 'Smith'")
    members: searchMembers(q),
    libraryItems: searchLibraryItems(q),
  };
}

module.exports = { globalSearch, MAX_RESULTS };
