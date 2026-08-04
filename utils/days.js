// Shared by both the Volunteers and Setup/Cleanup features, which each
// have exactly two fixed lists: one for Monday, one for Wednesday.

const DAYS = ['monday', 'wednesday'];
const DAY_LABELS = { monday: 'Monday', wednesday: 'Wednesday' };

function isValidDay(day) {
  return DAYS.includes(day);
}

// The co-op only meets Monday and Wednesday, so homepage links that don't
// ask which day (Floater Assignments, Setup/Cleanup) auto-pick whichever
// of the two is soonest: today if it's a meeting day, otherwise the next
// upcoming one.
function defaultDay() {
  const dow = new Date().getDay(); // 0=Sun..6=Sat
  if (dow === 1) return 'monday';
  if (dow === 2 || dow === 3) return 'wednesday';
  return 'monday';
}

module.exports = { DAYS, DAY_LABELS, isValidDay, defaultDay };
