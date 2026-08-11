// Shared "scan or type a name" member lookup for the Class Check-In
// kiosk flow (routes/kiosk-class-checkin.js) - the one kiosk surface
// where staff explicitly need a third input method beyond a barcode
// scanner or a phone's barcode-scanning camera app (both of which just
// type the scanned barcode into the same input field, exactly like a
// keyboard): typing a member's name by hand when neither is available.
//
// Barcode match comes first and is exact, same as every other kiosk scan
// endpoint. Only when that fails does this try an exact, case-insensitive
// name match - deliberately not a substring/fuzzy match, since "in class
// roster, one specific present kid" ambiguity matters less than "in the
// whole co-op" ambiguity, but exact-match still keeps this predictable
// and testable rather than guessing at partial input.
const db = require('../db');

// Returns { member, ambiguous }. `member` is null if nothing matched (or
// if the name matched more than one active member - `ambiguous` is true
// in that case so the caller can show a specific, actionable error rather
// than silently guessing which one was meant).
async function findMemberByBarcodeOrName(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return { member: null, ambiguous: false };

  const byBarcode = await db.prepare('SELECT * FROM members WHERE barcode = ? AND active = 1').get(trimmed);
  if (byBarcode) return { member: byBarcode, ambiguous: false };

  const byName = await db.prepare('SELECT * FROM members WHERE active = 1 AND LOWER(name) = LOWER(?)').all(trimmed);
  if (byName.length === 1) return { member: byName[0], ambiguous: false };
  if (byName.length > 1) return { member: null, ambiguous: true };

  return { member: null, ambiguous: false };
}

module.exports = { findMemberByBarcodeOrName };
