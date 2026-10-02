// Shared helpers for every page's new semester+day combo picker (a real
// request: "I need to be able to switch between semester views on
// floaters, setup cleanup, attendance, classes etc. Drop down on all
// these pages should be fall 2026 - Monday, fall 2026 Wednesday.") -
// first written inline in routes/admin-volunteers.js for Floater
// Assignments, pulled out here once routes/admin-setup.js needed the
// exact same four functions rather than a copy-pasted duplicate.

// Reads an explicit ?semesterId= override off the query string - the
// combo picker's own selection, kept alive across every link/redirect on
// a page (via appendSemester below) so every admin action stays scoped to
// the exact semester being viewed instead of silently falling back to
// whatever Settings > Kiosk has active. undefined (not present at all)
// means "use the normal default" - every util function's own existing
// fallback to the active Kiosk semester, unchanged for any link/bookmark
// that predates this picker. 'none' (the picker's own value for an
// untagged combo) means "no semester," explicitly distinct from "not
// specified."
function comboSemesterId(req) {
  const v = req.query.semesterId;
  if (v === undefined) return undefined;
  if (v === '' || v === 'none') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

// The inverse of comboSemesterId, for building a redirect/link's own
// ?semesterId= value: undefined stays undefined (a params-object helper
// like manageUrl/subUrl already drops an undefined value, so there's
// nothing to carry forward), an explicit "no semester" becomes the
// picker's own 'none'.
function qsSemester(semesterId) {
  return semesterId === null ? 'none' : semesterId;
}

// Appends the current combo selection to a redirect/link URL so the next
// page load (after a POST action, or a sub-tab link) stays on the same
// semester+day combo instead of resetting to whatever the normal default
// would resolve to. No-ops when semesterId is undefined (the admin never
// picked an explicit combo, so there's nothing to carry forward).
function appendSemester(url, semesterId) {
  if (semesterId === undefined) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}semesterId=${qsSemester(semesterId)}`;
}

// The exact class_schedules row (if any) a day+resolved-semesterId pair
// corresponds to - the combo picker preselects by this id rather than by
// day/semesterId separately, so there's no risk of two combos somehow
// looking selected at once.
function findComboId(combos, day, semesterId) {
  const match = combos.find((c) => c.day === day && c.semesterId === (semesterId ?? null));
  return match ? match.id : null;
}

module.exports = { comboSemesterId, qsSemester, appendSemester, findComboId };
