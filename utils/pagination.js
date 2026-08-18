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

// Slices `items` to the requested page, clamping to the last real page if
// the request is past the end (e.g. a bookmarked ?page=9 after the list
// shrank) rather than returning an empty page.
function paginate(items, requestedPage, pageSize = DEFAULT_PAGE_SIZE) {
  const totalItems = items.length;
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

module.exports = { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE };
