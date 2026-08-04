// Shared by both the Volunteers and Setup/Cleanup features, which each
// have exactly two fixed lists: one for Monday, one for Wednesday.

const DAYS = ['monday', 'wednesday'];
const DAY_LABELS = { monday: 'Monday', wednesday: 'Wednesday' };

function isValidDay(day) {
  return DAYS.includes(day);
}

module.exports = { DAYS, DAY_LABELS, isValidDay };
