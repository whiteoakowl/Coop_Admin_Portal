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
// double-sided (flip on the short edge - see the clarifying question this
// was designed against) is enough to get each pair onto the same
// physical sheet - no extra printer setup beyond "print both sides".
//
// The one piece that isn't automatic: flipping a sheet over to read its
// back mirrors it left-to-right, so a schedule card printed in the same
// DOM column as its member's name tag on the front would land under the
// WRONG name tag once the sheet is turned over. Reversing each row's
// column order on the back page (mirrorPage below) cancels that flip
// out, so cutting along the row/column grid lines always separates one
// member's matched front+back pair - including on a page's partial last
// row, where the single card's mirrored slot is explicitly padded with a
// blank rather than left to whatever the grid's auto-flow would do.
const COLS_PER_ROW = 2;
const CARDS_PER_PAGE = 8;

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

module.exports = { buildDuplexPages, mirrorPage, CARDS_PER_PAGE, COLS_PER_ROW };
