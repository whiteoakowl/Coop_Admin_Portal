// Settings behind Main Admin > Members > Settings > Grade Level Settings
// sub-tab - a real request: "Here is a list of graded levels. Next to
// each grade level is a date picker and another column for age... Each
// row will say, if student is (age), by (date/calendar picker), then
// they will be in (grade level)." Stored the same small generic key/
// value way utils/membershipHandbook.js already does (one JSON blob
// under appSetting/setAppSetting), not a dedicated table - this is a
// reference list an admin fills in and reads, not wired into the Grade
// Level dropdown on the member form itself (still its own manual
// per-member choice, unrelated to this table).
const { appSetting, setAppSetting } = require('./appSettings');
const { GRADE_LEVELS } = require('./classSchedule');

const SETTINGS_KEY = 'grade_level_age_rules';

// Always returns exactly one row per GRADE_LEVELS entry, in that same
// order, so the view can render a clean, stable row list regardless of
// what's been saved so far (an unset row just has null age/cutoffDate).
async function listGradeLevelRules() {
  const raw = await appSetting(SETTINGS_KEY, null);
  let saved = {};
  if (raw) {
    try {
      saved = JSON.parse(raw) || {};
    } catch {
      saved = {};
    }
  }
  return GRADE_LEVELS.map((gradeLevel) => {
    const row = saved[gradeLevel] || {};
    const age = parseInt(row.age, 10);
    return {
      gradeLevel,
      age: Number.isInteger(age) && age >= 0 ? age : null,
      cutoffDate: row.cutoffDate || null,
    };
  });
}

// Full reconcile from the settings form's own parallel gradeLevel[]/age[]/
// cutoffDate[] arrays (one form, one Save button, every row submitted
// together - see routes/main-admin-members.js's own POST handler).
async function saveGradeLevelRules(rows) {
  const toSave = {};
  for (const row of rows) {
    if (!GRADE_LEVELS.includes(row.gradeLevel)) continue;
    const age = parseInt(row.age, 10);
    toSave[row.gradeLevel] = {
      age: Number.isInteger(age) && age >= 0 ? age : null,
      cutoffDate: row.cutoffDate || null,
    };
  }
  await setAppSetting(SETTINGS_KEY, JSON.stringify(toSave));
}

module.exports = { listGradeLevelRules, saveGradeLevelRules };
