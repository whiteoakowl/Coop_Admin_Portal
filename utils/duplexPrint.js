// Shared page-chunking logic for "front and back" duplex card printing -
// a sheet's front holds name tags, the very next page in the document
// holds the matching schedule cards, so printing double-sided puts a
// member's name tag and schedule card on opposite sides of the same
// physical card, ready to cut apart with scissors.
//
// Name tags and schedule cards share the same physical size (see
// BADGE_WIDTH/BADGE_HEIGHT in utils/nameTagBadge.js and CARD_WIDTH/
// CARD_HEIGHT in utils/scheduleCardBadge.js) and the same 2-column x
// 4-row-per-sheet grid (.badge-sheet in styles.css), so a front sheet's
// card at a given row/column always has a same-size card waiting at that
// same row/column on the very next page - which is what makes physical
// front/back alignment possible at all.
//
// A real duplex print job alternates front/back/front/back... one sheet
// at a time (odd pages are fronts, even pages are backs), so laying out
// [front, back, front, back, ...] pages in one document and printing it
// double-sided (flip on the LONG edge - a portrait Letter page's own
// vertical edge, the standard default duplex setting for portrait
// content in every major OS print dialog) is enough to get each pair
// onto the same physical sheet - no extra printer setup beyond "print
// both sides".
//
// A real bug report - "mirror back and front needs much better
// alignment for printing" - traced back to every user-facing print
// instruction (this file used to say it here too) telling people to
// flip on the SHORT edge instead, which physically mirrors top-to-bottom
// (row order) rather than left-to-right (column order). mirrorPage below
// has always reversed COLUMN order within each row - correct for a
// long-edge flip - so the instructions and the actual math disagreed
// with each other; whichever one a given admin's printer/driver actually
// matched, the other was silently wrong. See views/admin-cards-duplex-
// print.ejs and admin-design.ejs's own hint text, now corrected to match.
//
// The one piece that isn't automatic: flipping a sheet over its long
// (vertical) edge to read its back mirrors it left-to-right, so a
// schedule card printed in the same DOM column as its member's name tag
// on the front would land under the WRONG name tag once the sheet is
// turned over. Reversing each row's column order on the back page
// (mirrorPage below) cancels that flip out, so cutting along the
// row/column grid lines always separates one member's matched
// front+back pair - including on a page's partial last row, where the
// single card's mirrored slot is explicitly padded with a blank rather
// than left to whatever the grid's auto-flow would do.
const COLS_PER_ROW = 2;
const CARDS_PER_PAGE = 8;

// A real bug report: "name tags and schedule cards front and back
// they aren't lining up just right... off by height a little bit" -
// front/back page geometry is already pixel-exact (both sides share this
// same fixed grid, see mirrorPage above for the one piece that isn't
// automatic), so residual drift is real physical printer/paper-feed
// registration error on the second duplex pass, not anything fixable in
// CSS. Per that same report's own fallback ask, views/admin-cards-duplex-
// print.ejs scales the schedule card (the side physically flipped
// against its name tag front) down by this factor - see partials/
// name-tag-badge.ejs's safeInset for how - leaving real blank paper
// margin on every side so a few points of registration drift lands in
// that margin instead of cutting into real content. 0.92 was picked to
// be clearly more forgiving than the ~2-4% of the card's own
// width/height the tightest default schedule-card field already sits
// from an edge (see utils/scheduleCardBadge.js's DEFAULT_LAYOUT), without
// shrinking the card's actual content enough to hurt readability.
const SCHEDULE_CARD_SAFE_INSET = 0.92;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Reverses column order within each row of a page's cards, padding a
// partial last row with nulls so column position - not just item count -
// stays correct once the sheet is turned over.
function mirrorPage(pageCards) {
  const mirrored = [];
  chunk(pageCards, COLS_PER_ROW).forEach((row) => {
    for (let col = COLS_PER_ROW - 1; col >= 0; col--) {
      mirrored.push(row[col] !== undefined ? row[col] : null);
    }
  });
  return mirrored;
}

// Splits a flat list of { nameTag, scheduleCard } pairs into parallel
// front/back page arrays - frontPages[i] and backPages[i] are printed
// onto the same physical sheet. Each backPages[i] entry is either a card
// ({ html, bgCss }) or null for a blank filler slot (see mirrorPage).
function buildDuplexPages(pairs) {
  const pages = chunk(pairs, CARDS_PER_PAGE);
  const frontPages = pages.map((page) => page.map((p) => p.nameTag));
  const backPages = pages.map((page) => mirrorPage(page.map((p) => p.scheduleCard)));
  return { frontPages, backPages };
}

module.exports = { buildDuplexPages, mirrorPage, CARDS_PER_PAGE, COLS_PER_ROW, SCHEDULE_CARD_SAFE_INSET };
