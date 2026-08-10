// Pure comparison helper for the Home dashboard's "Today's Attendance"
// KPI cards (Phase 4 audit item). Given today's count for a stat and the
// same stat from the previous session, returns a simple up/down/flat
// direction plus the raw delta so the view can render a small trend
// indicator next to each number.
//
// Deliberately neutral - no "good"/"bad" judgment baked in here. Checked-
// out trending up isn't obviously better or worse than trending down, and
// baking metric-specific value judgments into this shared helper would
// make it wrong for at least one of the four stats it's used for. It just
// describes the movement, the same way any other dashboard trend arrow
// does; the view is free to style direction 'up'/'down' however makes
// sense per metric if that's ever wanted.
function computeTrend(current, previous) {
  if (previous === null || previous === undefined) return null;
  const delta = current - previous;
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  return { direction, delta };
}

module.exports = { computeTrend };
