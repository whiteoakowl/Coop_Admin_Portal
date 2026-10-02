// Shared in-memory pagination helper for the Members/Logs/Library admin
// lists (Phase 4 audit item). Operates on an already-fetched array rather
// than doing a second SQL query with LIMIT/OFFSET - a co-op's total
// members, log entries, or library items are never large enough that the
// query itself is the bottleneck. What pagination fixes here is at the
// render layer: without it, years of accumulated history renders as one
// enormous DOM table on every page load, which is what actually gets slow
// (and unwieldy to scroll through) as a list grows - not the query behind
// it, and not something a second SQL round-trip would help with.
const DEFAULT_PAGE_SIZE = 50;

// Clamps a raw ?page= query value to a positive integer, defaulting to 1
// for anything missing, non-numeric, zero, or negative - the same
// "invalid input silently falls back to a safe default" convention every
// other query-string parameter in the app follows (see e.g. isValidDay
// callers), rather than 400ing on a hand-edited or stale bookmarked URL.
function parsePage(raw) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

// "View All" (a real request: "a view all button... more customizable
// than clicking next over and over") is just pageSize=Infinity handed to
// paginate() below - Math.ceil(totalItems / Infinity) is 0, clamped by
// the existing Math.max(1, ...) to a single page. This only recognizes
// the literal ?pageSize=all query value; anything else (missing,
// garbage) falls back to defaultSize, the same "invalid input is a safe
// default, not a 400" convention parsePage above already follows.
function parsePageSize(raw, defaultSize) {
  return raw === 'all' ? Infinity : defaultSize;
}

// A real bug report (Members list, Main Admin and Co-op Admin alike):
// "the dropdown for the last family on the page is sometimes putting
// part of the family on the next page. Families should stay together on
// the member list. Each member list page doesn't have to be an exact
// number of members." `items` already arrives family-grouped (utils/
// members.js's own sortMembersByFamily runs before this), but a plain
// fixed-size slice has no idea where one family's block ends and the
// next begins - a family that straddled the pageSize boundary got cut
// mid-group, and the page's own "+N more" accordion toggle (views/
// admin-members.ejs) under-counted since it only ever saw whichever
// slice of that family landed on its own page.
//
// Walks the whole list ONCE per request computing every page's real
// [start, end) boundary up front - a page boundary can only be known by
// actually walking forward from the previous one (does this page's
// natural pageSize-th item split a group, and if so by how much do we
// need to grow it?), not computed by simple arithmetic the way a
// uniform pageSize boundary can. Cheap for the same reason the rest of
// this file already is - see the header comment above.
function computeGroupAwarePageBoundaries(items, pageSize, groupKeyFn) {
  if (items.length === 0) return [[0, 0]];
  if (pageSize === Infinity) return [[0, items.length]];
  const boundaries = [];
  let start = 0;
  while (start < items.length) {
    let end = Math.min(start + pageSize, items.length);
    while (end < items.length && groupKeyFn(items[end]) === groupKeyFn(items[end - 1])) end += 1;
    boundaries.push([start, end]);
    start = end;
  }
  return boundaries;
}

// Slices `items` to the requested page, clamping to the last real page if
// the request is past the end (e.g. a bookmarked ?page=9 after the list
// shrank) rather than returning an empty page. `groupKeyFn(item)`, when
// given, keeps every run of consecutive items sharing the same key on
// one page together - growing that one page past pageSize rather than
// splitting the group, exactly the "doesn't have to be an exact number"
// tradeoff the real request above explicitly asked for. Omitted (the
// default), this behaves exactly as before - every other caller
// (Logs/Library/etc.) is unaffected.
function paginate(items, requestedPage, pageSize = DEFAULT_PAGE_SIZE, groupKeyFn = null) {
  const totalItems = items.length;
  if (groupKeyFn) {
    const boundaries = computeGroupAwarePageBoundaries(items, pageSize, groupKeyFn);
    const totalPages = Math.max(1, boundaries.length);
    const currentPage = Math.min(Math.max(1, requestedPage), totalPages);
    const [start, end] = boundaries[currentPage - 1];
    return {
      items: items.slice(start, end),
      currentPage,
      totalPages,
      totalItems,
      pageSize,
      hasPrev: currentPage > 1,
      hasNext: currentPage < totalPages,
      startIndex: totalItems === 0 ? 0 : start + 1,
      endIndex: end,
    };
  }
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(Math.max(1, requestedPage), totalPages);
  // (currentPage - 1) * pageSize, guarded: with pageSize=Infinity (View
  // All) currentPage is always 1 here (totalPages above collapses to 1),
  // so this "start of page" is always 0 - but 0 * Infinity is NaN in
  // JS, not 0, so the naive multiplication has to be skipped rather than
  // relied on to just work out.
  const start = pageSize === Infinity ? 0 : (currentPage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    currentPage,
    totalPages,
    totalItems,
    pageSize,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
    startIndex: totalItems === 0 ? 0 : start + 1,
    endIndex: Math.min(start + pageSize, totalItems),
  };
}

// The exact same family/solo grouping key utils/members.js's own
// sortMembersByFamily already uses to decide what counts as "one family
// block" in the first place - paginate()'s own group-keeping-together
// pass has to agree with it, or a page break could still land somewhere
// sortMembersByFamily never actually considered a boundary.
function memberFamilyGroupKey(member) {
  return member.family_id != null ? `f${member.family_id}` : `solo${member.id}`;
}

module.exports = { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE, memberFamilyGroupKey };
