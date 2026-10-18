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
const db = require('../db');
const { appSetting, setAppSetting } = require('./appSettings');
const { GRADE_LEVELS } = require('./classSchedule');
const { ageAsOfDate } = require('./dates');

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

// A real request: "Save grade level settings button and apply to all
// members button should be on the same row" - "Apply to All Members"
// didn't exist yet (this whole reference list was never wired into any
// member's own grade_level field - see this file's own header comment);
// this is that missing action. For every active student with a real
// birthday on file, finds the configured rule whose own age/cutoffDate
// pair matches that student's age AS OF that rule's cutoffDate (the
// exact "if student is (age), by (date), then they will be in (grade
// level)" sentence the rows themselves spell out) and sets grade_level
// to it - a student who matches no rule (no birthday, or no rule's own
// age lines up) is left untouched rather than cleared, since "no match"
// isn't the same as "no grade." Returns how many members were actually
// changed, for the page's own confirmation notice.
async function applyGradeLevelRulesToAllMembers() {
  const rules = (await listGradeLevelRules()).filter((r) => r.age != null && r.cutoffDate);
  if (rules.length === 0) return 0;
  const students = await db.prepare("SELECT id, birthday, grade_level FROM members WHERE active = 1 AND member_type = 'student' AND birthday IS NOT NULL").all();
  let updated = 0;
  for (const student of students) {
    const match = rules.find((r) => ageAsOfDate(student.birthday, r.cutoffDate) === r.age);
    if (match && match.gradeLevel !== student.grade_level) {
      await db.prepare('UPDATE members SET grade_level = ? WHERE id = ?').run(match.gradeLevel, student.id);
      updated++;
    }
  }
  return updated;
}

module.exports = { listGradeLevelRules, saveGradeLevelRules, applyGradeLevelRulesToAllMembers };
